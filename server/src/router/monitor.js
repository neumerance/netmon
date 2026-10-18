// Router integration runtime: runs the syslog receiver and the SNMP poller according to routerStore's
// config, turns counter samples into per-port bit rates, raises events for WAN changes, and pushes
// `router` (status + ports) and `routerLog` (one new line) SSE messages through `broadcast`.
//
// Implementation factories are injected (real: router/syslog.js + router/snmp.js, mock: mock/router.js)
// so this module does no I/O of its own.

import { detectWanChange } from './syslog.js';

const STATUS_BROADCAST_MS = 1000;
const SNAPSHOT_LOG_LINES = 200;
// Fallback when the router has no SNMP route table: interface names routers commonly use for the internet side.
export const WAN_NAME_RE = /\b(wan\d*|ppp\w*|internet|uplink\d*|wwan\d*|lte\d*|dsl\d*)\b/i;

/** Internet-facing port? The default route's interface when known, else a name match. */
export function isWanPort(iface, defaultRouteIfIndex) {
  if (defaultRouteIfIndex != null && iface.index === defaultRouteIfIndex) return true;
  return WAN_NAME_RE.test([iface.name, iface.alias, iface.descr].filter(Boolean).join(' '));
}

function counterDelta(cur, prev, bits) {
  if (cur == null || prev == null) return null;
  let d = cur - prev;
  if (d >= 0n) return d;
  if (bits === 32) { d += 2n ** 32n; return d >= 0n ? d : null; } // a single 32-bit wrap
  return null; // 64-bit counters do not wrap in practice: the router rebooted / counters were reset
}

/**
 * @param {object} deps
 * @param {object} deps.routerStore          core/routerStore.js
 * @param {object} deps.eventLog             core/events.js
 * @param {(type: string, data: any) => void} deps.broadcast
 * @param {() => string|null} deps.getGateway  current default gateway IPv4
 * @param {Function} deps.createSyslogReceiver  router/syslog.js signature
 * @param {Function} deps.createSnmpClient      router/snmp.js signature
 * @param {Function} deps.pollRouter            router/snmp.js signature
 * @param {() => number} [deps.now]
 */
export function createRouterMonitor({ routerStore, eventLog, broadcast, getGateway, createSyslogReceiver, createSnmpClient, pollRouter, now = Date.now }) {
  const status = {
    syslog: { enabled: false, listening: false, port: null, source: null, error: null, lastMessageAt: null, received: 0, dropped: 0, lastDroppedFrom: null },
    snmp: { enabled: false, host: null, ok: null, error: null, lastPollAt: null, system: null, counterBits: null },
  };
  let ports = [];
  let prevSample = new Map(); // ifIndex -> { inOctets, outOctets, at }
  const wanState = new Map(); // syslog WAN name / SNMP port name -> 'up' | 'down'

  let receiver = null;
  let receiverKey = null;
  let syslogGen = 0;

  let client = null;
  let clientKey = null;
  let pollTimer = null;
  let pollInFlight = false;
  let snmpGen = 0;
  let snmpErrorLogged = false;

  let statusTimer = null;
  let stopped = false;

  const iso = (ms) => new Date(ms).toISOString();
  const syslogSource = () => routerStore.getConfig().syslog.source || getGateway() || null;
  const snmpHost = (cfg) => cfg.snmp.host || getGateway() || null;

  function publicState() {
    return { config: routerStore.publicConfig(), status: structuredClone(status), ports: ports.map((p) => ({ ...p })) };
  }

  function broadcastStatus() {
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
    broadcast('router', publicState());
  }

  /** Coalesce bursts (a log storm) into one `router` message per second. */
  function scheduleStatus() {
    if (statusTimer || stopped) return;
    statusTimer = setTimeout(broadcastStatus, STATUS_BROADCAST_MS);
    statusTimer.unref?.();
  }

  function noteWan(name, state, detail, data) {
    if (wanState.get(name) === state) return;
    wanState.set(name, state);
    eventLog.add({
      type: state === 'down' ? 'router_wan_down' : 'router_wan_up',
      level: state === 'down' ? 'warning' : 'info',
      message: `Router: ${name} is ${state}${detail ? ` — ${detail}` : ''}`.slice(0, 300),
      data: { wan: name, state, ...data },
    });
  }

  // ---------------------------------------------------------------- syslog

  function onSyslog(parsed, rinfo) {
    const at = now();
    const entry = routerStore.addLogEntry({
      at: iso(at), from: rinfo.address, severity: parsed.severity, severityName: parsed.severityName,
      facility: parsed.facility, host: parsed.host, app: parsed.app, sentAt: parsed.sentAt, message: parsed.message,
    });
    status.syslog.received += 1;
    status.syslog.lastMessageAt = entry.at;
    broadcast('routerLog', entry);
    scheduleStatus();

    const wan = detectWanChange(parsed.message);
    if (wan) noteWan(wan.wan, wan.state, parsed.message, { source: 'syslog' });
    else if (parsed.severity <= 2) {
      eventLog.add({ type: 'router_log_critical', level: 'warning', message: `Router: ${parsed.message}`.slice(0, 300),
        data: { severity: parsed.severityName, app: parsed.app } });
    }
  }

  function onDropped(address) {
    status.syslog.dropped += 1;
    status.syslog.lastDroppedFrom = address;
    scheduleStatus();
  }

  async function applySyslog(cfg) {
    const s = cfg.syslog;
    const key = s.enabled ? String(s.port) : null;
    status.syslog.enabled = s.enabled;
    status.syslog.port = s.port;
    status.syslog.source = syslogSource();
    if (key === receiverKey && (receiver || !s.enabled)) return;

    const gen = ++syslogGen;
    if (receiver) { receiver.stop(); receiver = null; }
    receiverKey = key;
    status.syslog.listening = false;
    status.syslog.error = null;
    if (!s.enabled) return;

    const r = createSyslogReceiver({
      port: s.port,
      // Read the allowed source on every datagram so a gateway change applies without a restart.
      accept: (address) => address === syslogSource(),
      onMessage: onSyslog,
      onDropped,
    });
    try {
      await r.start();
      if (gen !== syslogGen || stopped) { r.stop(); return; }
      receiver = r;
      status.syslog.listening = true;
      console.log(`[router] syslog listening on UDP ${s.port}, accepting ${status.syslog.source || 'nothing yet (no gateway)'}`);
    } catch (err) {
      if (gen !== syslogGen) return;
      receiverKey = null; // retry on the next apply()
      status.syslog.error = err?.message || String(err);
      console.warn(`[router] syslog: ${status.syslog.error}`);
      eventLog.add({ type: 'router_syslog_error', level: 'warning', message: `Router log receiver could not start: ${status.syslog.error}` });
    }
  }

  // ---------------------------------------------------------------- SNMP

  function computePorts(sample, at, bits, defaultRouteIfIndex) {
    const next = new Map();
    const out = [];
    for (const it of sample) {
      const prev = prevSample.get(it.index);
      const dt = prev ? (at - prev.at) / 1000 : 0;
      const din = prev && dt > 0 ? counterDelta(it.inOctets, prev.inOctets, bits) : null;
      const dout = prev && dt > 0 ? counterDelta(it.outOctets, prev.outOctets, bits) : null;
      out.push({
        index: it.index, name: it.name, descr: it.descr, alias: it.alias, operStatus: it.operStatus, speedMbps: it.speedMbps,
        wan: isWanPort(it, defaultRouteIfIndex),
        defaultRoute: defaultRouteIfIndex != null && it.index === defaultRouteIfIndex,
        inBps: din == null ? null : Math.round((Number(din) * 8) / dt),
        outBps: dout == null ? null : Math.round((Number(dout) * 8) / dt),
        inOctets: it.inOctets == null ? null : String(it.inOctets),
        outOctets: it.outOctets == null ? null : String(it.outOctets),
      });
      next.set(it.index, { inOctets: it.inOctets, outOctets: it.outOctets, at });
    }
    prevSample = next;
    return out;
  }

  async function pollOnce(gen) {
    if (pollInFlight || !client) return;
    pollInFlight = true;
    const c = client;
    try {
      const res = await pollRouter(c);
      if (gen !== snmpGen) return;
      const at = now();
      const firstOk = status.snmp.ok !== true;
      ports = computePorts(res.interfaces, at, res.counterBits, res.defaultRouteIfIndex ?? null);
      status.snmp = { ...status.snmp, ok: true, error: null, lastPollAt: iso(at), system: res.system, counterBits: res.counterBits };
      if (firstOk) {
        eventLog.add({
          type: 'router_snmp_ok', level: 'info',
          message: snmpErrorLogged
            ? `Router SNMP polling recovered (${c.host})`
            : `Connected to router ${res.system?.name || c.host} over SNMP (${ports.length} ports)`,
          data: { host: c.host },
        });
        snmpErrorLogged = false;
      }
      for (const p of ports) {
        if (p.wan && (p.operStatus === 'up' || p.operStatus === 'down')) {
          // Only report changes: the first sample just records the state.
          const key = `port:${p.index}`;
          if (wanState.has(key) && wanState.get(key) !== p.operStatus) {
            wanState.set(key, p.operStatus);
            eventLog.add({
              type: p.operStatus === 'down' ? 'router_wan_down' : 'router_wan_up',
              level: p.operStatus === 'down' ? 'warning' : 'info',
              message: `Router: internet port ${p.alias || p.name} is ${p.operStatus}`,
              data: { port: p.name, state: p.operStatus, source: 'snmp' },
            });
          } else wanState.set(key, p.operStatus);
        }
      }
    } catch (err) {
      if (gen !== snmpGen) return;
      const msg = err?.message || String(err);
      const wasOk = status.snmp.ok === true;
      status.snmp = { ...status.snmp, ok: false, error: msg, lastPollAt: iso(now()) };
      ports = ports.map((p) => ({ ...p, inBps: null, outBps: null }));
      prevSample = new Map();
      if (wasOk || !snmpErrorLogged) {
        eventLog.add({ type: 'router_snmp_error', level: 'warning', message: `Router SNMP polling failed: ${msg}`, data: { host: c.host } });
        snmpErrorLogged = true;
      }
    } finally {
      pollInFlight = false;
    }
    if (gen === snmpGen) broadcastStatus();
  }

  function schedulePoll(gen, intervalSec) {
    if (gen !== snmpGen || stopped) return;
    pollTimer = setTimeout(async () => {
      await pollOnce(gen);
      schedulePoll(gen, intervalSec);
    }, intervalSec * 1000);
    pollTimer.unref?.();
  }

  function applySnmp(cfg) {
    const s = cfg.snmp;
    const host = snmpHost(cfg);
    const ready = s.enabled && host && s.community;
    const key = ready ? `${host}|${s.community}|${s.intervalSec}` : null;
    status.snmp.enabled = s.enabled;
    status.snmp.host = host;
    if (key === clientKey && (client || !ready)) {
      if (s.enabled && !s.community) status.snmp.error = 'Set the SNMP community to start polling';
      return;
    }

    const gen = ++snmpGen;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (client) { client.close(); client = null; }
    clientKey = key;
    ports = [];
    prevSample = new Map();
    status.snmp = { ...status.snmp, ok: null, error: null, lastPollAt: null, system: null, counterBits: null };
    if (!s.enabled) return;
    if (!host) { status.snmp.error = 'No default gateway found; set the router address'; return; }
    if (!s.community) { status.snmp.error = 'Set the SNMP community to start polling'; return; }

    client = createSnmpClient({ host, community: s.community });
    // First sample now, the second one (the first rates) after one interval.
    pollOnce(gen).then(() => schedulePoll(gen, s.intervalSec));
  }

  // ---------------------------------------------------------------- lifecycle

  /** (Re)apply the stored config. Safe to call often (config change, network change). */
  async function apply() {
    if (stopped) return;
    const cfg = routerStore.getConfig();
    applySnmp(cfg);
    await applySyslog(cfg);
    broadcastStatus();
  }

  /**
   * One-off SNMP check for the setup form: { host?, community? } override the stored values.
   * @returns {Promise<{ ok: true, host, system, ports } | { ok: false, host, error }>}
   */
  async function testSnmp({ host, community } = {}) {
    const cfg = routerStore.getConfig();
    const h = host || snmpHost(cfg);
    const com = community || cfg.snmp.community;
    if (!h) return { ok: false, host: null, error: 'No default gateway found; set the router address' };
    if (!com) return { ok: false, host: h, error: 'Enter the SNMP community' };
    const c = createSnmpClient({ host: h, community: com, timeoutMs: 2500, retries: 0 });
    try {
      const res = await pollRouter(c);
      return {
        ok: true, host: h, system: res.system,
        ports: res.interfaces.map((i) => ({ name: i.name, alias: i.alias, operStatus: i.operStatus, wan: isWanPort(i, res.defaultRouteIfIndex ?? null) })),
      };
    } catch (err) {
      return { ok: false, host: h, error: err?.message || String(err) };
    } finally {
      c.close();
    }
  }

  function stop() {
    stopped = true;
    syslogGen++;
    snmpGen++;
    if (statusTimer) clearTimeout(statusTimer);
    if (pollTimer) clearTimeout(pollTimer);
    if (receiver) receiver.stop();
    if (client) client.close();
    receiver = null;
    client = null;
  }

  return {
    apply,
    stop,
    testSnmp,
    getPublic: publicState,
    getSnapshot: () => ({ ...publicState(), log: routerStore.getLog({ limit: SNAPSHOT_LOG_LINES }) }),
  };
}
