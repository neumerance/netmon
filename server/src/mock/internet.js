// Mock drop-ins for internet/probe.js, internet/speedtest.js, internet/isp.js (PLAN.md §2.7, §7.3),
// plus seedSpeedHistory(). Deterministic, no network.

import { MOCK_ISP } from './devices.js';
import { isInternetDown, getTargetSpeeds } from './state.js';

const round1 = (n) => Math.round(n * 10) / 10;
const nowIso = () => new Date().toISOString();

export const MOCK_PROBE_LATENCY_MS = 14;

// ---------------------------------------------------------------------------------------------------------
// probe.js

export function createProbe({ intervalMs = 5000, timeoutMs = 3000, failuresForDown = 2, onStatus } = {}) {
  void timeoutMs;
  let timer = null;
  let stopped = true;
  const st = {
    status: 'unknown', since: nowIso(), lastCheckedAt: null, latencyMs: null,
    consecutiveFailures: 0, target: null, error: null,
  };

  function setStatus(next) {
    if (st.status !== next) {
      st.status = next;
      st.since = st.lastCheckedAt;
    }
  }

  // Evaluated synchronously from the world state so a checkNow() right after applyMockState() reflects it.
  function check() {
    st.lastCheckedAt = nowIso();
    if (isInternetDown()) {
      st.consecutiveFailures += 1;
      st.latencyMs = null;
      st.target = null;
      st.error = 'mock: internet unreachable';
      if (st.consecutiveFailures >= failuresForDown) setStatus('down');
    } else {
      st.consecutiveFailures = 0;
      st.latencyMs = MOCK_PROBE_LATENCY_MS;
      st.target = '1.1.1.1';
      st.error = null;
      setStatus('up');
    }
    const snapshot = { ...st };
    if (typeof onStatus === 'function') {
      try { onStatus({ ...snapshot }); } catch (e) { console.warn('[mock-probe] onStatus failed:', e?.message || e); }
    }
    return snapshot;
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      check();
      timer = setInterval(check, intervalMs);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    async checkNow() {
      return check();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// speedtest.js

const TOTAL_MS = 2000;
const STEP_MS = 100;
const LATENCY_END_MS = 300;
const DOWNLOAD_END_MS = 1300;

function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name === 'AbortError') return reason;
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}

/** Ramp toward target: starts at 40 % of target, eases out to exactly target at frac = 1. */
function ramp(target, frac) {
  const f = Math.min(1, Math.max(0, frac));
  return round1(target * (1 - 0.6 * (1 - f) * (1 - f)));
}

/** Progress at elapsed ms t (0..2000) — PLAN §7.3 phase/percent mapping. */
export function mockSpeedProgress(t, { downloadMbps, uploadMbps }) {
  if (t < LATENCY_END_MS) {
    return { phase: 'latency', percent: round1((t / LATENCY_END_MS) * 10), currentMbps: null };
  }
  if (t < DOWNLOAD_END_MS) {
    const f = (t - LATENCY_END_MS) / (DOWNLOAD_END_MS - LATENCY_END_MS);
    return { phase: 'download', percent: round1(10 + f * 50), currentMbps: ramp(downloadMbps, f) };
  }
  const f = Math.min(1, (t - DOWNLOAD_END_MS) / (TOTAL_MS - DOWNLOAD_END_MS));
  return { phase: 'upload', percent: round1(60 + f * 40), currentMbps: ramp(uploadMbps, f) };
}

export function runSpeedTest({ onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError(signal)); return; }

    let timer = null;
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      fn(v);
    };
    const onAbort = () => finish(reject, abortError(signal));
    signal?.addEventListener?.('abort', onAbort, { once: true });

    const progress = (p) => {
      if (typeof onProgress !== 'function') return;
      try { onProgress(p); } catch (e) { console.warn('[mock-speedtest] onProgress failed:', e?.message || e); }
    };

    if (isInternetDown()) {
      timer = setTimeout(() => finish(reject, new Error('speedtest_failed: internet unreachable')), 300);
      return;
    }

    // Targets are captured when the test starts (a later downloadMbps change queues a follow-up test in core).
    const target = getTargetSpeeds();
    let step = 0;
    const tickFn = () => {
      if (done) return;
      const t = step * STEP_MS;
      if (step > 0 && isInternetDown()) {
        finish(reject, new Error('speedtest_failed: internet unreachable'));
        return;
      }
      if (t >= TOTAL_MS) {
        progress({ phase: 'upload', percent: 100, currentMbps: round1(target.uploadMbps) });
        const downloadMbps = round1(target.downloadMbps);
        const uploadMbps = round1(target.uploadMbps);
        finish(resolve, {
          downloadMbps, uploadMbps, pingMs: 12.0, jitterMs: 1.5, colo: 'SJC', durationMs: TOTAL_MS,
          bytesDown: Math.round(downloadMbps * 125000 * 1),
          bytesUp: Math.round(uploadMbps * 125000 * 0.7),
        });
        return;
      }
      progress(mockSpeedProgress(t, target));
      step += 1;
      timer = setTimeout(tickFn, STEP_MS);
    };
    tickFn();
  });
}

// ---------------------------------------------------------------------------------------------------------
// isp.js

export function fetchIsp({ timeoutMs = 5000 } = {}) {
  void timeoutMs;
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (isInternetDown()) reject(new Error('isp_failed: internet unreachable'));
      else resolve({ ...MOCK_ISP, fetchedAt: nowIso() });
    }, 50);
  });
}

// ---------------------------------------------------------------------------------------------------------
// speed history seed

/** 24 'auto' results spaced 15 min apart, oldest first, ending 15 min before `now` (PLAN §7.3). */
export function seedSpeedHistory(now = Date.now()) {
  const base = typeof now === 'number' ? now : new Date(now).getTime();
  const out = [];
  for (let i = 0; i < 24; i++) {
    const downloadMbps = round1(430 + ((i * 7) % 40));
    const uploadMbps = round1(38 + (i % 5));
    out.push({
      id: `st_seed_${i}`,
      at: new Date(base - (24 - i) * 15 * 60 * 1000).toISOString(),
      trigger: 'auto',
      downloadMbps,
      uploadMbps,
      pingMs: round1(11 + (i % 4)),
      jitterMs: 1.2,
      colo: 'SJC',
      durationMs: TOTAL_MS,
      bytesDown: Math.round(downloadMbps * 125000 * 1),
      bytesUp: Math.round(uploadMbps * 125000 * 0.7),
    });
  }
  return out;
}
