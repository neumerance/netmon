// NetMon server bootstrap: wires real (net/, internet/, fingerprint/) or mock (mock/) modules
// into core state, exposes the REST + SSE API and serves the built web app.
//
// Env: PORT (default 4000), HOST (default 127.0.0.1), NETMON_MOCK=1 (mock mode),
//      NETMON_DATA_DIR (default server/data),
//      NETMON_ALLOW_LAN=1 (required to bind a non-loopback HOST without a token),
//      NETMON_TOKEN (shared secret required on every /api request; recommended with a LAN HOST),
//      NETMON_ALLOWED_HOSTS (comma-separated extra Host names, e.g. a reverse-proxy name).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { REAL_TIMINGS } from './core/timings.js';
import { createStore } from './core/store.js';
import { createEventLog } from './core/events.js';
import { createState } from './core/state.js';
import { createDeviceManager } from './core/devices.js';
import { createSpeedController } from './core/speed.js';
import { createSseHub } from './core/sse.js';
import { createApiRouter } from './routes/api.js';
import { createApiGuard, isLoopbackHost } from './core/guard.js';
import { createTopologyStore, MOCK_DEFAULT_OVERRIDES } from './core/topology.js';

const VERSION = '1.0.0';
const MOCK = process.env.NETMON_MOCK === '1';
const PORT = Number.parseInt(process.env.PORT, 10) || 4000;
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.NETMON_TOKEN ? String(process.env.NETMON_TOKEN) : null;
const ALLOW_LAN = process.env.NETMON_ALLOW_LAN === '1';
const EXTRA_HOSTS = String(process.env.NETMON_ALLOWED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);
const LOOPBACK_BIND = isLoopbackHost(HOST);

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(here, '..');
const DATA_DIR = path.resolve(process.env.NETMON_DATA_DIR || path.join(SERVER_ROOT, 'data'));
const WEB_DIST = path.resolve(SERVER_ROOT, '..', 'web', 'dist');

// A bug in one module must never take the whole monitor down.
process.on('unhandledRejection', (reason) => {
  console.warn(`[netmon] unhandled rejection: ${reason?.stack || reason}`);
});
process.on('uncaughtException', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`[netmon] port ${PORT} on ${HOST} is already in use`);
    process.exit(1);
  }
  console.warn(`[netmon] uncaught exception: ${err?.stack || err}`);
});

/** Load the implementation modules (dynamic imports so mock mode never loads real network code). */
async function loadImpl() {
  if (MOCK) return import('./mock/index.js');
  const [sys, discovery, pinger, throughput, fingerprint, probe, speedtest, isp] = await Promise.all([
    import('./net/sys.js'),
    import('./net/discovery.js'),
    import('./net/pinger.js'),
    import('./net/throughput.js'),
    import('./net/fingerprint/index.js'),
    import('./internet/probe.js'),
    import('./internet/speedtest.js'),
    import('./internet/isp.js'),
  ]);
  return {
    getNetworkInfo: sys.getNetworkInfo,
    createDiscovery: discovery.createDiscovery,
    createPinger: pinger.createPinger,
    createThroughputMonitor: throughput.createThroughputMonitor,
    createFingerprinter: fingerprint.createFingerprinter,
    createProbe: probe.createProbe,
    runSpeedTest: speedtest.runSpeedTest,
    fetchIsp: isp.fetchIsp,
    tcpPresence: pinger.tcpPresence,
  };
}

/** Same LAN attachment? (fields that change when Wi-Fi roams, a hotspot is joined or DHCP renumbers). */
function sameNetwork(a, b) {
  if (!a || !b) return false;
  return a.iface === b.iface && a.ip === b.ip && a.cidr === b.cidr && a.gateway === b.gateway && (a.mac ?? null) === (b.mac ?? null);
}

/** Call a module factory, logging (not throwing) on failure. */
function safeCreate(name, fn) {
  try {
    return fn() ?? null;
  } catch (err) {
    console.warn(`[netmon] failed to create ${name}: ${err?.stack || err}`);
    return null;
  }
}

function safeCall(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.catch === 'function') r.catch((err) => console.warn(`[netmon] ${name} failed: ${err?.message || err}`));
    return r;
  } catch (err) {
    console.warn(`[netmon] ${name} failed: ${err?.message || err}`);
    return undefined;
  }
}

async function main() {
  // An unauthenticated control API on the LAN is opt-in (PLAN: bind 127.0.0.1 by default).
  if (!LOOPBACK_BIND && !TOKEN && !ALLOW_LAN) {
    console.error(`[netmon] refusing to listen on non-loopback HOST=${HOST} without protection: anyone on the LAN could`
      + ' change settings, delete saved devices, run speed tests and trigger port scans.\n'
      + '  Set NETMON_TOKEN=<secret> (clients send it as X-NetMon-Token, ?token= or cookie netmon_token),'
      + ' or NETMON_ALLOW_LAN=1 to accept the risk.');
    process.exit(1);
  }
  if (!LOOPBACK_BIND) {
    console.warn(`[netmon] WARNING: listening on ${HOST}: the NetMon API is reachable from other machines`
      + (TOKEN ? ' (token required).' : ' WITHOUT authentication (NETMON_ALLOW_LAN=1).'));
  }

  const impl = await loadImpl();
  const timings = { ...REAL_TIMINGS, ...(MOCK ? impl.MOCK_TIMINGS : {}) };

  // ---------------------------------------------------------------- core
  const store = createStore({ dataDir: DATA_DIR });
  store.load();

  let state = null;
  const eventLog = createEventLog({ store, onEvent: (ev) => state?.broadcast('event', ev) });
  state = createState({ store, timings, eventLog, mock: MOCK });

  // Topology overrides ("Connected via" + pinned map positions) live in their own <dataDir>/topology.json.
  // Mock mode starts with the iPhone, Pixel 8 and LG TV under the Deco M5 (docs/TOPOLOGY.md §7.4).
  const topology = createTopologyStore({ dataDir: DATA_DIR, defaults: MOCK ? MOCK_DEFAULT_OVERRIDES : {} });
  topology.load();
  state.setTopologySource(() => topology.getOverrides());

  const sseHub = createSseHub({ getSnapshot: () => state.getSnapshot() });
  state.on('broadcast', (type, data) => sseHub.broadcast(type, data));

  // Mock: seed speed history when empty (boot and after reset).
  const seedHistoryIfEmpty = () => {
    if (!MOCK || typeof impl.seedSpeedHistory !== 'function') return;
    if (store.getSpeedHistory().length) return;
    for (const r of safeCall('seedSpeedHistory', () => impl.seedSpeedHistory(Date.now())) || []) store.addSpeedResult(r);
  };
  seedHistoryIfEmpty();
  const history = store.getSpeedHistory();
  state.setSpeed({ last: history.at(-1) ?? null }, { silent: true });

  // ---------------------------------------------------------------- network
  let network = null;
  try {
    network = await impl.getNetworkInfo();
  } catch (err) {
    console.warn(`[netmon] no usable network interface (${err?.message || err}); LAN monitoring disabled`);
  }
  state.setNetworkInfo(network);

  // Modules are referenced lazily by the device manager (it is created first so callbacks exist).
  let discovery = null;
  let pinger = null;
  let throughput = null;
  let fingerprinter = null;

  const isNetworkBusy = () => Boolean(state.getSpeed().running);
  const devices = createDeviceManager({
    store, state, eventLog, timings,
    getNetwork: () => state.getNetwork(),
    getFingerprinter: () => fingerprinter,
    getPinger: () => pinger,
    presenceProbe: typeof impl.tcpPresence === 'function' ? (ip, ports) => impl.tcpPresence(ip, ports) : null,
    isNetworkBusy,
  });
  state.setDeviceSource(devices);

  fingerprinter = safeCreate('fingerprinter', () => impl.createFingerprinter({
    getSettings: store.getSettings,
    onResult: devices.applyFingerprint,
    passiveBrowseMs: timings.fingerprintPassiveBrowseMs,
    getNetwork: () => state.getNetwork(),
    isNetworkBusy,
  }));

  // LAN modules are (re)built for the current network; a generation counter makes results of a scan
  // that was still running on the previous network harmless.
  let lanGen = 0;
  let lanStarted = false;
  const createLan = (net) => {
    const gen = ++lanGen;
    discovery = safeCreate('discovery', () => impl.createDiscovery({
      network: net,
      intervalMs: timings.scanIntervalMs,
      onDevices: (list, meta) => { if (gen === lanGen) devices.applyScan(list, meta); },
      onScanStart: () => { if (gen === lanGen) devices.onScanStart(); },
    }));
    if (!pinger) {
      pinger = safeCreate('pinger', () => impl.createPinger({
        intervalMs: timings.pingIntervalMs, onSample: devices.applyPingSample,
      }));
      if (pinger && lanStarted) safeCall('pinger.start', () => pinger.start());
    }
    if (!throughput) {
      throughput = safeCreate('throughput', () => impl.createThroughputMonitor({
        ifaceName: net.iface, intervalMs: timings.throughputIntervalMs, onSample: devices.applySelfThroughput,
      }));
      if (throughput && lanStarted) safeCall('throughput.start', () => throughput.start());
    }
    if (discovery && lanStarted) safeCall('discovery.start', () => discovery.start());
  };
  if (network) createLan(network);

  const probe = safeCreate('probe', () => impl.createProbe({
    intervalMs: timings.probeIntervalMs, timeoutMs: timings.probeTimeoutMs, onStatus: state.setInternet,
  }));

  const speed = createSpeedController({
    runSpeedTest: (opts) => impl.runSpeedTest(opts), state, store, eventLog, timings, mock: MOCK,
    // Real mode: let the first discovery + fingerprint pass finish before saturating the link.
    shouldDeferStartup: MOCK ? null : () => Boolean(state.getNetwork()) && (!state.isFirstScanDone() || devices.isFingerprinting()),
  });

  // ---------------------------------------------------------------- ISP
  let ispTimer = null;
  let ispInFlight = null;
  let ispFailLogged = false;
  const refreshIsp = () => {
    if (ispInFlight) return ispInFlight;
    ispInFlight = Promise.resolve()
      .then(() => impl.fetchIsp())
      .then((isp) => { ispFailLogged = false; state.setIsp(isp); })
      .catch((err) => {
        if (!ispFailLogged) console.warn(`[isp] lookup failed: ${err?.message || err}`);
        ispFailLogged = true;
      })
      .finally(() => { ispInFlight = null; });
    return ispInFlight;
  };
  state.on('internet:restored', () => refreshIsp());

  // ---------------------------------------------------------------- network changes
  // Wi-Fi roaming, joining a hotspot, DHCP renumbering or an interface that was not up at boot:
  // re-read the primary interface periodically and rebuild LAN monitoring when it changes.
  let netTimer = null;
  let netCheckInFlight = false;
  const checkNetwork = async () => {
    if (netCheckInFlight) return;
    netCheckInFlight = true;
    try {
      let next = null;
      try { next = await impl.getNetworkInfo(); } catch { next = null; }
      const cur = state.getNetwork();
      if (!next || sameNetwork(cur, next)) return; // no interface right now: keep the last one (pings just fail)
      console.log(`[netmon] network ${cur ? `changed: ${cur.iface} ${cur.cidr} gw ${cur.gateway} → ` : 'found: '}`
        + `${next.iface} ${next.cidr} gw ${next.gateway}`);
      if (discovery) { safeCall('discovery.stop', () => discovery.stop()); discovery = null; }
      if (throughput && cur?.iface !== next.iface) { safeCall('throughput.stop', () => throughput.stop()); throughput = null; }
      state.setNetworkInfo(next, { reset: true });
      devices.onNetworkChanged();
      createLan(next);
      if (fingerprinter?.setNetwork) safeCall('fingerprinter.setNetwork', () => fingerprinter.setNetwork(next));
      eventLog.add({
        type: 'network_changed', level: 'info',
        message: cur ? `Network changed: now on ${next.iface} ${next.cidr}` : `Network found: ${next.iface} ${next.cidr}`,
        data: { from: cur ? { iface: cur.iface, ip: cur.ip, cidr: cur.cidr, gateway: cur.gateway } : null,
          to: { iface: next.iface, ip: next.ip, cidr: next.cidr, gateway: next.gateway } },
      });
      refreshIsp();
    } catch (err) {
      console.warn(`[netmon] network check failed: ${err?.stack || err}`);
    } finally {
      netCheckInFlight = false;
    }
  };

  // ---------------------------------------------------------------- mock control
  const applyMockState = async (patch) => {
    const { state: mockState, effects = {} } = impl.applyMockState(patch);
    if (effects.reset) {
      speed.abort(); // also drops a pending startup test
      store.resetAll();
      topology.reset({ scope: 'all' }); // back to the mock "Connected via" defaults, no pinned positions
      devices.reset();
      state.resetAlerts();
      seedHistoryIfEmpty();
      state.setSpeed({ running: false, progress: null, lastError: null, last: store.getSpeedHistory().at(-1) ?? null }, { silent: true });
      speed.reschedule({ fromNow: true }); // no test right after a reset (PLAN §7.4)
      state.recomputeAlerts();
      sseHub.broadcast('snapshot', state.getSnapshot());
      sseHub.broadcast('settings', store.getSettings());
      sseHub.broadcast('topology', { overrides: topology.getOverrides() });
      if (probe) safeCall('probe.checkNow', () => probe.checkNow());
    }
    if (effects.reprobe && probe) safeCall('probe.checkNow', () => probe.checkNow());
    if (effects.runSpeedTest) speed.requestMockRun();
    if (effects.rescan || effects.reset) {
      // Respond only once the simulated LAN has been rescanned and typed, so the state right after
      // the 200 is deterministic (no 404 on PUT /devices, no "Identifying…" rows after a reset).
      const scans = [];
      if (discovery) scans.push(Promise.resolve(safeCall('discovery.scanNow', () => discovery.scanNow())));
      if (pinger) scans.push(Promise.resolve(safeCall('pinger.pingNow', () => pinger.pingNow())));
      let t;
      await Promise.race([Promise.allSettled(scans), new Promise((r) => { t = setTimeout(r, 2000); })]);
      clearTimeout(t);
      await devices.whenIdle(2000);
    }
    return mockState;
  };

  // ---------------------------------------------------------------- HTTP
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  // Token mode: opening http://host:port/?token=<secret> once stores it as a same-site cookie so the web
  // app's fetch + EventSource calls carry it.
  if (TOKEN) {
    app.use((req, res, next) => {
      if (!req.path.startsWith('/api') && typeof req.query.token === 'string' && req.query.token === TOKEN) {
        res.cookie('netmon_token', TOKEN, { httpOnly: true, sameSite: 'strict', maxAge: 365 * 24 * 3600 * 1000 });
      }
      next();
    });
  }
  app.use('/api', createApiGuard({ host: HOST, allowLan: !LOOPBACK_BIND, token: TOKEN, extraHosts: EXTRA_HOSTS }));
  app.use('/api', createApiRouter({
    state, store, devices, speed, eventLog, sseHub, topology, mock: MOCK, version: VERSION,
    applyMockState: MOCK ? applyMockState : null,
    onSettingsChanged: (prev, next, changedKeys) => {
      if (changedKeys.includes('speedTestIntervalMin')) speed.reschedule();
      state.recomputeAlerts();
    },
  }));

  // Static web app with SPA fallback (checked per request so a later `npm run build` needs no restart).
  const staticMw = express.static(WEB_DIST, { index: 'index.html', maxAge: '1h', setHeaders: (res, file) => {
    if (file.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
  } });
  app.use((req, res, next) => (fs.existsSync(WEB_DIST) ? staticMw(req, res, next) : next()));
  app.get('*', (req, res) => {
    const index = path.join(WEB_DIST, 'index.html');
    if (fs.existsSync(index)) {
      res.setHeader('Cache-Control', 'no-cache');
      return res.sendFile(index);
    }
    res.status(503).type('text/plain').send(
      'NetMon web UI is not built yet.\n\nRun "npm run build" in the project root, then reload.\n'
      + 'For development use "npm run dev" (or "npm run dev:mock") and open http://localhost:5173\n',
    );
  });
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.warn(`[http] ${req.method} ${req.originalUrl}: ${err?.message || err}`);
    if (!res.headersSent) res.status(500).json({ error: 'internal', message: 'Internal server error' });
  });

  // ---------------------------------------------------------------- start everything
  eventLog.add({
    type: 'server_started', level: 'info',
    message: `NetMon started (${MOCK ? 'mock' : 'real'} mode)`
      + (network ? ` on ${network.iface} ${network.cidr}` : ' — no network interface found'),
    data: { mock: MOCK, network: network ? { iface: network.iface, ip: network.ip, cidr: network.cidr } : null },
  });

  devices.start();
  for (const [name, mod] of [['fingerprinter', fingerprinter], ['discovery', discovery], ['pinger', pinger],
    ['throughput', throughput], ['probe', probe]]) {
    if (mod) safeCall(`${name}.start`, () => mod.start());
  }
  lanStarted = true;
  netTimer = setInterval(checkNetwork, timings.networkCheckMs || 15000);
  netTimer.unref?.();
  speed.start();
  refreshIsp();
  ispTimer = setInterval(refreshIsp, timings.ispRefreshMs);
  ispTimer.unref?.();

  const server = app.listen(PORT, HOST, () => {
    console.log(`NetMon listening on http://${HOST}:${PORT} (${MOCK ? 'mock' : 'real'})`);
  });
  server.keepAliveTimeout = 65_000;

  // ---------------------------------------------------------------- shutdown
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[netmon] ${signal} received, shutting down`);
    clearInterval(ispTimer);
    clearInterval(netTimer);
    lanGen++;
    speed.stop();
    devices.stop();
    for (const [name, mod] of [['probe', probe], ['throughput', throughput], ['pinger', pinger],
      ['discovery', discovery], ['fingerprinter', fingerprinter]]) {
      if (mod) safeCall(`${name}.stop`, () => mod.stop());
    }
    sseHub.closeAll();
    store.flush();
    topology.flush();
    server.close();
    // A PUT/DELETE /api/topology (or a device save) on a still-open keep-alive connection can land after
    // the flush above and only schedule a debounced write; flush again right before exiting.
    setTimeout(() => {
      try { store.flush(); } catch { /* ignore */ }
      try { topology.flush(); } catch { /* ignore */ }
      process.exit(0);
    }, 300).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(`[netmon] fatal startup error: ${err?.stack || err}`);
  process.exit(1);
});
