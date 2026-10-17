// Mock drop-ins for net/sys.js, net/discovery.js, net/pinger.js, net/throughput.js (PLAN.md §2.1–2.5, §7.3).
// Deterministic (tick counters + sine waves, no Math.random), no network access, no child processes.

import { MOCK_NETWORK, findMockDevice } from './devices.js';
import { presentDevices, isMockDeviceOnline, normalizeMacLoose } from './state.js';

const round1 = (n) => Math.round(n * 10) / 10;
const nowIso = () => new Date().toISOString();

function safeCall(tag, fn, ...args) {
  if (typeof fn !== 'function') return;
  try {
    const r = fn(...args);
    if (r && typeof r.catch === 'function') r.catch((e) => console.warn(`[${tag}] callback failed:`, e?.message || e));
  } catch (e) {
    console.warn(`[${tag}] callback failed:`, e?.message || e);
  }
}

// ---------------------------------------------------------------------------------------------------------
// sys.js

/** @returns {Promise<object>} the fixed mock NetworkInfo (§7.1). */
export async function getNetworkInfo() {
  return { ...MOCK_NETWORK };
}

// ---------------------------------------------------------------------------------------------------------
// discovery.js

const MOCK_SCAN_DURATION_MS = 40;

function toRawDevice(row) {
  return {
    mac: row.mac,
    ip: row.ip,
    hostname: row.hostname,
    vendor: row.vendor,
    alive: true,
    inArp: !row.isSelf, // real discovery reports self with inArp:false
    ttl: row.ttl,
    isSelf: row.isSelf,
    isGateway: row.isGateway,
  };
}

/** Current simulated scan result: every present device that is not in the offline set (self always). */
export function mockScan() {
  return presentDevices().filter((d) => isMockDeviceOnline(d.mac)).map(toRawDevice);
}

export function createDiscovery({ network, intervalMs = 30000, concurrency = 64, pingTimeoutMs = 700, onDevices, onScanStart } = {}) {
  // Accepted for signature parity. onScanStart is deliberately not called: a 40 ms mock scan every
  // second would only make the "Scanning" indicator flicker (and double the SSE `network` traffic).
  void network; void concurrency; void pingTimeoutMs; void onScanStart;
  let timer = null;
  let inFlight = null;
  let stopped = true;

  function scanNow() {
    if (inFlight) return inFlight;
    const started = Date.now();
    inFlight = new Promise((resolve) => {
      setTimeout(() => {
        const raw = mockScan();
        inFlight = null;
        safeCall('mock-discovery', onDevices, raw, { scannedAt: nowIso(), durationMs: Date.now() - started });
        resolve(raw);
      }, MOCK_SCAN_DURATION_MS);
    });
    return inFlight;
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      scanNow();
      timer = setInterval(() => { scanNow(); }, intervalMs);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    scanNow,
  };
}

// ---------------------------------------------------------------------------------------------------------
// pinger.js

/**
 * One deterministic sample for `mac` at round `tick`.
 * rtt = round1(base + jitter * sin(tick*0.7 + idx)); rows with lossEvery lose every Nth tick.
 */
export function mockPingSample(mac, tick) {
  const found = findMockDevice(mac);
  if (!found || !isMockDeviceOnline(mac)) return { alive: false, rttMs: null, ttl: null };
  const { row, idx } = found;
  if (row.isSelf) return { alive: true, rttMs: 0.1, ttl: row.ttl }; // self is normally not a target
  if (row.lossEvery > 0 && tick % row.lossEvery === 0) return { alive: false, rttMs: null, ttl: null };
  const rtt = Math.max(0.1, round1(row.baseLatencyMs + row.jitterMs * Math.sin(tick * 0.7 + idx)));
  return { alive: true, rttMs: rtt, ttl: row.ttl };
}

/** Mock of net/pinger.js ping(). */
export async function ping(ip, { timeoutMs = 1000 } = {}) {
  void timeoutMs;
  const row = presentDevices().find((d) => d.ip === ip);
  if (!row) return { alive: false, rttMs: null, ttl: null };
  return mockPingSample(row.mac, 1);
}

export function createPinger({ intervalMs = 10000, timeoutMs = 1000, concurrency = 16, onSample } = {}) {
  void timeoutMs; void concurrency;
  let targets = [];
  let timer = null;
  let stopped = true;
  let tick = 0;

  async function pingNow() {
    tick += 1;
    const at = nowIso();
    for (const t of targets) {
      const mac = normalizeMacLoose(t.mac) || t.mac;
      const s = mockPingSample(mac, tick);
      safeCall('mock-pinger', onSample, { mac, ip: t.ip, alive: s.alive, rttMs: s.rttMs, ttl: s.ttl, at });
    }
  }

  return {
    setTargets(list) {
      targets = Array.isArray(list) ? list.filter((t) => t && t.mac).map((t) => ({ mac: t.mac, ip: t.ip ?? null })) : [];
    },
    start() {
      if (!stopped) return;
      stopped = false;
      pingNow();
      timer = setInterval(() => { pingNow(); }, intervalMs);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    pingNow,
  };
}

// ---------------------------------------------------------------------------------------------------------
// throughput.js

/** Mock counters: monotonically increasing bytes derived from the same wave as the samples. */
export async function readCounters(ifaceName) {
  void ifaceName;
  const t = Date.now();
  return { rxBytes: Math.round((t / 1000) * 3_000_000), txBytes: Math.round((t / 1000) * 375_000), at: t };
}

/** rx = round1(24 + 8 sin(tick/5)), tx = round1(3 + sin(tick/7)); first sample immediately on start (tick 0). */
export function mockThroughputSample(tick) {
  return { rxMbps: round1(24 + 8 * Math.sin(tick / 5)), txMbps: round1(3 + Math.sin(tick / 7)) };
}

export function createThroughputMonitor({ ifaceName, intervalMs = 2000, onSample } = {}) {
  void ifaceName;
  let timer = null;
  let stopped = true;
  let tick = 0;

  function emit() {
    const s = mockThroughputSample(tick);
    tick += 1;
    safeCall('mock-throughput', onSample, { ...s, at: nowIso() });
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      emit();
      timer = setInterval(emit, intervalMs);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
