// Central in-memory state. An EventEmitter that:
//   - holds network / internet / isp / speed / alerts state,
//   - delegates the device list to a device source (core/devices.js) attached with setDeviceSource(),
//   - assembles the snapshot (PLAN §3),
//   - emits 'broadcast' (type, data) for every SSE-worthy change (index.js forwards to the SSE hub),
//   - emits 'internet:down' / 'internet:restored' ({ downtimeMs }) on transitions.

import { EventEmitter } from 'node:events';
import { computeAlerts, alertsKey } from './alerts.js';

const SNAPSHOT_SPEED_HISTORY = 50;
const SNAPSHOT_EVENTS = 100;

export function createState({ store, timings, eventLog, mock = false }) {
  const state = new EventEmitter();
  state.setMaxListeners(50);

  const startedAt = new Date().toISOString();
  let network = null; // NetworkInfo + { scanning, lastScanAt, firstScanDone }
  let internet = {
    status: 'unknown', since: startedAt, lastCheckedAt: null, latencyMs: null,
    consecutiveFailures: 0, target: null, error: null,
  };
  let lastOnlineAt = null;
  let isp = null;
  let speed = { running: false, progress: null, last: null, lastError: null, nextAutoAt: null };
  let alerts = [];
  let alertsSig = alertsKey(alerts);
  let deviceSource = { list: () => [], get: () => null };
  let topologySource = null; // () => { [mac]: Override } (core/topology.js store), set by index.js
  let routerSource = null; // () => router snapshot (router/monitor.js), set by index.js

  const broadcast = (type, data) => {
    try { state.emit('broadcast', type, data); } catch (err) { console.warn(`[state] broadcast ${type} failed: ${err.message}`); }
  };

  // ---------------------------------------------------------------- devices
  state.setDeviceSource = (src) => { deviceSource = src; };
  state.getDevices = () => deviceSource.list();
  state.getDevice = (mac) => deviceSource.get(mac);

  // ---------------------------------------------------------------- topology
  state.setTopologySource = (fn) => { topologySource = typeof fn === 'function' ? fn : null; };
  state.getTopology = () => {
    let overrides = {};
    try { overrides = topologySource?.() ?? {}; } catch (err) { console.warn(`[state] topology source failed: ${err.message}`); }
    return { overrides };
  };

  // ---------------------------------------------------------------- router integration
  state.setRouterSource = (fn) => { routerSource = typeof fn === 'function' ? fn : null; };
  state.getRouter = () => {
    try { return routerSource?.() ?? null; } catch (err) { console.warn(`[state] router source failed: ${err.message}`); return null; }
  };

  // ---------------------------------------------------------------- network
  state.getNetwork =() => (network ? { ...network } : null);
  /** Set the NetworkInfo. `reset` (network change): scan bookkeeping starts over (firstScanDone false). */
  state.setNetworkInfo = (info, { reset = false } = {}) => {
    if (!info) { network = null; broadcast('network', null); return; }
    const changed = !network || network.iface !== info.iface || network.ip !== info.ip || network.gateway !== info.gateway
      || network.cidr !== info.cidr || network.mac !== info.mac;
    const base = { scanning: false, lastScanAt: null, firstScanDone: false };
    network = reset ? { ...base, ...info } : { ...base, ...(network || {}), ...info };
    if (changed || reset) broadcast('network', state.getNetwork());
  };
  /** Patch scan bookkeeping fields (scanning, lastScanAt, firstScanDone). */
  state.patchNetwork = (patch, { silent = false } = {}) => {
    if (!network) return;
    network = { ...network, ...patch };
    if (!silent) broadcast('network', state.getNetwork());
  };
  state.isFirstScanDone = () => Boolean(network?.firstScanDone);

  // ---------------------------------------------------------------- internet
  state.getInternet = () => ({ ...internet });
  state.setInternet = (next) => {
    if (!next || typeof next !== 'object') return;
    const prevStatus = internet.status;
    const prevSince = internet.since;
    internet = {
      status: next.status ?? 'unknown',
      since: next.since ?? internet.since,
      lastCheckedAt: next.lastCheckedAt ?? null,
      latencyMs: next.latencyMs ?? null,
      consecutiveFailures: next.consecutiveFailures ?? 0,
      target: next.target ?? null,
      error: next.error ?? null,
    };
    if (internet.status === 'up') lastOnlineAt = internet.lastCheckedAt ?? new Date().toISOString();
    broadcast('internet', state.getInternet());

    if (internet.status === 'down' && prevStatus !== 'down') {
      eventLog.add({
        type: 'internet_down', level: 'critical',
        message: 'Internet connection lost',
        data: { error: internet.error, lastOnlineAt },
      });
      state.emit('internet:down');
    } else if (internet.status === 'up' && prevStatus === 'down') {
      const downSince = Date.parse(prevSince);
      const downtimeMs = Number.isFinite(downSince) ? Math.max(0, Date.now() - downSince) : null;
      eventLog.add({
        type: 'internet_restored', level: 'info',
        message: downtimeMs != null ? `Internet connection restored after ${formatDowntime(downtimeMs)}` : 'Internet connection restored',
        data: { downtimeMs },
      });
      state.emit('internet:restored', { downtimeMs });
    }
    if (internet.status !== prevStatus) state.recomputeAlerts();
  };

  // ---------------------------------------------------------------- isp
  state.getIsp = () => (isp ? { ...isp } : null);
  state.setIsp = (next) => {
    if (!next) return;
    isp = { ...next };
    broadcast('isp', state.getIsp());
  };

  // ---------------------------------------------------------------- speed
  state.getSpeed = () => ({ ...speed });
  /** Merge into the speed state; broadcasts `speed` (without history) unless silent. */
  state.setSpeed = (patch, { silent = false } = {}) => {
    speed = { ...speed, ...patch };
    if (!silent) broadcast('speed', state.getSpeed());
  };

  // ---------------------------------------------------------------- alerts
  state.getAlerts = () => alerts.map((a) => ({ ...a }));
  state.recomputeAlerts = () => {
    let next;
    try {
      next = computeAlerts({
        internet, speed, devices: deviceSource.list(), settings: store.getSettings(),
        firstScanDone: state.isFirstScanDone(), previous: alerts, lastOnlineAt,
      });
    } catch (err) {
      console.warn(`[state] computeAlerts failed: ${err.message}`);
      return;
    }
    const sig = alertsKey(next);
    alerts = next;
    if (sig !== alertsSig) {
      alertsSig = sig;
      broadcast('alerts', state.getAlerts());
    }
  };
  /** Forget previous alert state entirely (mock reset). */
  state.resetAlerts = () => { alerts = []; alertsSig = alertsKey(alerts); };

  // ---------------------------------------------------------------- snapshot
  state.getSnapshot = () => ({
    mock,
    serverTime: new Date().toISOString(),
    network: state.getNetwork(),
    devices: deviceSource.list(),
    internet: state.getInternet(),
    speed: { ...state.getSpeed(), history: store.getSpeedHistory().slice(-SNAPSHOT_SPEED_HISTORY) },
    isp: state.getIsp(),
    alerts: state.getAlerts(),
    settings: store.getSettings(),
    events: eventLog.list(SNAPSHOT_EVENTS),
    topology: state.getTopology(),
    router: state.getRouter(),
  });

  state.broadcast = broadcast;
  state.mock = mock;
  state.startedAt = startedAt;
  state.timings = timings;
  return state;
}

function formatDowntime(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}
