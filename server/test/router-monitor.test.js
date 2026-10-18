// Unit tests for core/routerStore.js and router/monitor.js with injected fake syslog/SNMP implementations.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRouterStore, validateRouterConfig, sanitizeRouterConfig, LOG_CAP } from '../src/core/routerStore.js';
import { createRouterMonitor, isWanPort } from '../src/router/monitor.js';
import { parseSyslog } from '../src/router/syslog.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'netmon-router-'));

// ------------------------------------------------------------------------------------------ store

test('validateRouterConfig accepts partial patches and rejects bad values', () => {
  assert.deepEqual(validateRouterConfig({ snmp: { enabled: true, community: 'abc' } }),
    { ok: true, value: { snmp: { enabled: true, community: 'abc' } } });
  const bad = validateRouterConfig({ syslog: { port: 70000, source: 'router' }, snmp: { intervalSec: 1, host: '10.0.0.256', nope: 1 }, other: {} });
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.errors).sort(),
    ['other', 'snmp.host', 'snmp.intervalSec', 'snmp.nope', 'syslog.port', 'syslog.source']);
  assert.equal(validateRouterConfig({ snmp: { community: 'tab\there' } }).ok, false);
  assert.equal(validateRouterConfig([]).ok, false);
});

test('sanitizeRouterConfig keeps valid fields and defaults the rest', () => {
  const c = sanitizeRouterConfig({ syslog: { enabled: true, port: 'x' }, snmp: { host: '10.0.0.1', intervalSec: 30 } });
  assert.deepEqual(c, {
    syslog: { enabled: true, port: 514, source: '' },
    snmp: { enabled: false, host: '10.0.0.1', community: '', intervalSec: 30 },
  });
});

test('store persists config and log, never exposes the community, env wins', () => {
  const dir = tmpDir();
  const s = createRouterStore({ dataDir: dir, env: {} });
  s.load();
  s.updateConfig({ snmp: { enabled: true, community: 'hunter2' } });
  s.addLogEntry({ at: 'a', severity: 6, severityName: 'info', message: 'one' });
  s.addLogEntry({ at: 'b', severity: 3, severityName: 'err', message: 'two WAN down', app: 'net' });
  s.flush();
  assert.equal(fs.statSync(path.join(dir, 'router.json')).mode & 0o777, 0o600);

  const pub = s.publicConfig();
  assert.equal(JSON.stringify(pub).includes('hunter2'), false);
  assert.equal(pub.snmp.communitySet, true);

  const s2 = createRouterStore({ dataDir: dir, env: { NETMON_SNMP_COMMUNITY: 'from-env' } });
  s2.load();
  assert.equal(s2.getConfig().snmp.community, 'from-env');
  assert.equal(s2.publicConfig().snmp.communityFromEnv, true);
  assert.deepEqual(s2.getLog().map((e) => e.message), ['two WAN down', 'one']); // newest first
  assert.deepEqual(s2.getLog({ maxSeverity: 3 }).map((e) => e.message), ['two WAN down']);
  assert.deepEqual(s2.getLog({ q: 'net' }).map((e) => e.message), ['two WAN down']);
  s2.clearLog();
  assert.equal(s2.logCount(), 0);
});

test('store caps the log and sets aside a corrupt config', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'router.json'), '{not json');
  const s = createRouterStore({ dataDir: dir, env: {} });
  s.load();
  assert.equal(s.getConfig().syslog.enabled, false);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('router.json.corrupt-')));
  for (let i = 0; i < LOG_CAP + 10; i++) s.addLogEntry({ severity: 6, message: `m${i}` });
  assert.equal(s.logCount(), LOG_CAP);
  assert.equal(s.getLog({ limit: 1 })[0].message, `m${LOG_CAP + 9}`);
});

// ------------------------------------------------------------------------------------------ monitor

function harness({ config = {}, gateway = '10.0.0.1' } = {}) {
  const routerStore = createRouterStore({ dataDir: tmpDir(), env: {} });
  routerStore.updateConfig(config);
  const events = [];
  const broadcasts = [];
  const receivers = [];
  const clients = [];
  let clock = 1_000_000;
  let sample = null; // what the fake pollRouter returns (or an Error to throw)
  const monitor = createRouterMonitor({
    routerStore,
    eventLog: { add: (e) => events.push(e) },
    broadcast: (type, data) => broadcasts.push({ type, data }),
    getGateway: () => gateway,
    now: () => clock,
    createSyslogReceiver: (opts) => {
      const r = { opts, started: false, stopped: false, start: async () => { r.started = true; }, stop: () => { r.stopped = true; } };
      receivers.push(r);
      return r;
    },
    createSnmpClient: (opts) => { const c = { ...opts, closed: false, close: () => { c.closed = true; } }; clients.push(c); return c; },
    pollRouter: async () => { if (sample instanceof Error) throw sample; return structuredClone(sample); },
  });
  return {
    monitor, routerStore, events, broadcasts, receivers, clients,
    tick: (ms) => { clock += ms; },
    setSample: (s) => { sample = s; },
    deliver: (line, from = gateway) => {
      const r = receivers.at(-1);
      if (r.opts.accept(from)) r.opts.onMessage(parseSyslog(line), { address: from });
      else r.opts.onDropped(from);
    },
  };
}

const iface = (index, inOctets, outOctets, extra = {}) => ({
  index, name: `eth${index}`, descr: `eth${index}`, alias: null, operStatus: 'up', speedMbps: 1000, inOctets, outOctets, ...extra,
});
const flush = () => new Promise((r) => setImmediate(r));

test('nothing runs while disabled', async (t) => {
  const h = harness();
  t.after(() => h.monitor.stop());
  await h.monitor.apply();
  assert.equal(h.receivers.length, 0);
  assert.equal(h.clients.length, 0);
  const snap = h.monitor.getSnapshot();
  assert.equal(snap.status.syslog.enabled, false);
  assert.deepEqual(snap.log, []);
});

test('syslog: lines from the gateway are stored and broadcast, others counted as dropped', async (t) => {
  const h = harness({ config: { syslog: { enabled: true } } });
  t.after(() => h.monitor.stop());
  await h.monitor.apply();
  assert.equal(h.receivers.length, 1);
  assert.equal(h.receivers[0].opts.port, 514);
  assert.equal(h.monitor.getPublic().status.syslog.listening, true);

  h.deliver('<134>DHCP Server allocated IP address 10.0.0.9');
  h.deliver('<134>spoofed', '10.0.0.66');
  const log = h.broadcasts.filter((b) => b.type === 'routerLog');
  assert.equal(log.length, 1);
  assert.equal(log[0].data.message, 'DHCP Server allocated IP address 10.0.0.9');
  const st = h.monitor.getPublic().status.syslog;
  assert.equal(st.received, 1);
  assert.equal(st.dropped, 1);
  assert.equal(st.lastDroppedFrom, '10.0.0.66');
  assert.equal(h.monitor.getSnapshot().log.length, 1);
});

test('syslog: WAN changes raise one event per transition; critical lines raise an event', async (t) => {
  const h = harness({ config: { syslog: { enabled: true } } });
  t.after(() => h.monitor.stop());
  await h.monitor.apply();
  h.deliver('<131>Online Detection: WAN is offline');
  h.deliver('<131>Online Detection: WAN is offline');
  h.deliver('<134>Online Detection: WAN is online');
  h.deliver('<130>kernel panic averted');
  assert.deepEqual(h.events.map((e) => [e.type, e.level]), [
    ['router_wan_down', 'warning'], ['router_wan_up', 'info'], ['router_log_critical', 'warning'],
  ]);
});

test('syslog: a port change restarts the receiver, an unchanged config does not, disabling stops it', async (t) => {
  const h = harness({ config: { syslog: { enabled: true } } });
  t.after(() => h.monitor.stop());
  await h.monitor.apply();
  h.routerStore.updateConfig({ syslog: { port: 5514 } });
  await h.monitor.apply();
  assert.equal(h.receivers[0].stopped, true);
  assert.equal(h.receivers[1].opts.port, 5514);
  await h.monitor.apply();
  assert.equal(h.receivers.length, 2);
  h.routerStore.updateConfig({ syslog: { enabled: false } });
  await h.monitor.apply();
  assert.equal(h.receivers[1].stopped, true);
  assert.equal(h.monitor.getPublic().status.syslog.listening, false);
});

test('syslog: bind failure surfaces as status.error and an event', async (t) => {
  const routerStore = createRouterStore({ dataDir: tmpDir(), env: {} });
  routerStore.updateConfig({ syslog: { enabled: true } });
  const events = [];
  let attempts = 0;
  const monitor = createRouterMonitor({
    routerStore, eventLog: { add: (e) => events.push(e) }, broadcast: () => {}, getGateway: () => '10.0.0.1',
    createSyslogReceiver: () => ({ start: async () => { attempts++; throw new Error('UDP 514 is already in use by another program'); }, stop() {} }),
    createSnmpClient: () => ({ close() {} }), pollRouter: async () => ({}),
  });
  t.after(() => monitor.stop());
  await monitor.apply();
  const st = monitor.getPublic().status.syslog;
  assert.equal(st.listening, false);
  assert.match(st.error, /already in use/);
  assert.equal(events[0].type, 'router_syslog_error');
  await monitor.apply(); // retried
  assert.equal(attempts, 2);
});

test('snmp: needs a community; polls the gateway; computes bit rates; survives counter resets', async (t) => {
  const h = harness({ config: { snmp: { enabled: true } } });
  t.after(() => h.monitor.stop());
  await h.monitor.apply();
  assert.equal(h.clients.length, 0);
  assert.match(h.monitor.getPublic().status.snmp.error, /community/);

  h.setSample({ system: { name: 'gw' }, interfaces: [iface(2, 1_000n, 2_000n)], counterBits: 64 });
  h.routerStore.updateConfig({ snmp: { community: 'ro' } });
  await h.monitor.apply();
  await flush();
  assert.equal(h.clients.length, 1);
  assert.equal(h.clients[0].host, '10.0.0.1');
  assert.equal(h.clients[0].community, 'ro');
  let pub = h.monitor.getPublic();
  assert.equal(pub.status.snmp.ok, true);
  assert.equal(pub.ports[0].inBps, null); // first sample: no rate yet
  assert.equal(h.events.at(-1).type, 'router_snmp_ok');
  assert.equal(JSON.stringify(pub).includes('"ro"'), false);
});

test('snmp: rates from consecutive samples, a 32-bit wrap, a counter reset, then error and recovery', async (t) => {
  const h = harness({ config: { snmp: { enabled: true, community: 'ro', intervalSec: 5 } } });
  t.after(() => h.monitor.stop());
  t.mock.timers.enable({ apis: ['setTimeout'] });

  h.setSample({ system: { name: 'gw' }, interfaces: [iface(2, 0n, 0n), iface(3, 4_294_967_000n, 0n)], counterBits: 32 });
  await h.monitor.apply();
  await flush();

  // 5 s later: port 2 moved 6.25 MB in / 1.25 MB out (10 / 2 Mbps); port 3 wrapped its 32-bit counter.
  h.tick(5000);
  h.setSample({ system: { name: 'gw' }, interfaces: [iface(2, 6_250_000n, 1_250_000n), iface(3, 704n, 0n)], counterBits: 32 });
  t.mock.timers.tick(5000);
  await flush(); await flush();
  let ports = h.monitor.getPublic().ports;
  assert.equal(ports[0].inBps, 10_000_000);
  assert.equal(ports[0].outBps, 2_000_000);
  assert.equal(ports[1].inBps, Math.round(((2 ** 32 - 4_294_967_000 + 704) * 8) / 5));

  // Router rebooted: 64-bit counters went backwards -> no rate rather than a huge number.
  h.tick(5000);
  h.setSample({ system: { name: 'gw' }, interfaces: [iface(2, 10n, 10n)], counterBits: 64 });
  t.mock.timers.tick(5000);
  await flush(); await flush();
  ports = h.monitor.getPublic().ports;
  assert.equal(ports[0].inBps, null);

  // Poll failure: error status + one event; recovery: an ok event.
  h.tick(5000);
  h.setSample(new Error('No SNMP response from 10.0.0.1'));
  t.mock.timers.tick(5000);
  await flush(); await flush();
  assert.equal(h.monitor.getPublic().status.snmp.ok, false);
  h.tick(5000);
  t.mock.timers.tick(5000);
  await flush(); await flush();
  assert.equal(h.events.filter((e) => e.type === 'router_snmp_error').length, 1);
  h.setSample({ system: { name: 'gw' }, interfaces: [iface(2, 20n, 20n)], counterBits: 64 });
  h.tick(5000);
  t.mock.timers.tick(5000);
  await flush(); await flush();
  assert.equal(h.events.at(-1).type, 'router_snmp_ok');
  assert.match(h.events.at(-1).message, /recovered/);
});

test('isWanPort: default route wins; names are a vendor-neutral fallback', () => {
  const eth = (index, name, alias = null) => ({ index, name, alias, descr: name });
  assert.equal(isWanPort(eth(7, 'igb0'), 7), true); // no tell-tale name, but it carries the default route
  assert.equal(isWanPort(eth(8, 'igb1'), 7), false);
  for (const name of ['wan', 'WAN/LAN1', 'pppoe-wan', 'ppp0', 'wwan0', 'lte1', 'Internet', 'uplink']) {
    assert.equal(isWanPort(eth(1, name), null), true, name);
  }
  for (const name of ['eth0', 'br-lan', 'lan1', 'swan', 'bridge0']) assert.equal(isWanPort(eth(1, name), null), false, name);
});

test('snmp: the default-route port is flagged wan even without a WAN-like name', async (t) => {
  const h = harness({ config: { snmp: { enabled: true, community: 'ro' } } });
  t.after(() => h.monitor.stop());
  h.setSample({ system: {}, interfaces: [iface(1, 0n, 0n), iface(2, 0n, 0n)], counterBits: 64, defaultRouteIfIndex: 2 });
  await h.monitor.apply();
  await flush();
  assert.deepEqual(h.monitor.getPublic().ports.map((p) => [p.name, p.wan, p.defaultRoute]), [['eth1', false, false], ['eth2', true, true]]);
});

test('snmp: a WAN port going down is reported once', async (t) => {
  const h = harness({ config: { snmp: { enabled: true, community: 'ro', intervalSec: 5 } } });
  t.after(() => h.monitor.stop());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const wan = (operStatus) => ({ system: {}, interfaces: [iface(2, 0n, 0n, { alias: 'WAN', operStatus }), iface(4, 0n, 0n, { alias: 'LAN', operStatus })], counterBits: 64 });
  h.setSample(wan('up'));
  await h.monitor.apply();
  await flush();
  for (const s of ['down', 'down', 'up']) {
    h.setSample(wan(s));
    h.tick(5000);
    t.mock.timers.tick(5000);
    await flush(); await flush();
  }
  assert.deepEqual(h.events.filter((e) => e.type.startsWith('router_wan')).map((e) => e.type), ['router_wan_down', 'router_wan_up']);
});

test('snmp: changing host or community rebuilds the client; disabling closes it', async (t) => {
  const h = harness({ config: { snmp: { enabled: true, community: 'ro' } } });
  t.after(() => h.monitor.stop());
  h.setSample({ system: {}, interfaces: [], counterBits: 64 });
  await h.monitor.apply();
  h.routerStore.updateConfig({ snmp: { host: '10.0.0.2' } });
  await h.monitor.apply();
  assert.equal(h.clients[0].closed, true);
  assert.equal(h.clients[1].host, '10.0.0.2');
  await h.monitor.apply(); // unchanged: no new client
  assert.equal(h.clients.length, 2);
  h.routerStore.updateConfig({ snmp: { enabled: false } });
  await h.monitor.apply();
  assert.equal(h.clients[1].closed, true);
  assert.deepEqual(h.monitor.getPublic().ports, []);
});

test('testSnmp uses overrides and reports failures without touching the running client', async (t) => {
  const h = harness();
  t.after(() => h.monitor.stop());
  assert.match((await h.monitor.testSnmp({})).error, /community/);
  h.setSample({ system: { name: 'gw' }, interfaces: [iface(2, 0n, 0n, { alias: 'WAN' })], counterBits: 64 });
  const ok = await h.monitor.testSnmp({ community: 'probe', host: '10.0.0.9' });
  assert.equal(ok.ok, true);
  assert.equal(ok.host, '10.0.0.9');
  assert.deepEqual(ok.ports, [{ name: 'eth2', alias: 'WAN', operStatus: 'up', wan: true }]);
  assert.equal(h.clients[0].closed, true);
  h.setSample(new Error('timeout'));
  assert.deepEqual(await h.monitor.testSnmp({ community: 'x' }), { ok: false, host: '10.0.0.1', error: 'timeout' });
});
