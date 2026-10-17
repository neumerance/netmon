// Internet speed test against Cloudflare's public speed endpoints (the same ones speed.cloudflare.com uses).
//
//   latency : 20 sequential GET /__down?bytes=0 (after one warm-up). Time-to-headers minus the server
//             processing time reported in `Server-Timing`. pingMs = median, jitterMs = mean |successive diff|.
//   download: 4 parallel streams of GET /__down?bytes=N (sizes ramp 1 MB -> 10 MB -> 25 MB) for ~8 s or until a
//             total byte cap. Bytes are counted per chunk as they arrive.
//   upload  : 4 parallel workers POSTing to /__up, request size adapted so each POST takes ~0.75 s, for ~6 s
//             or until a byte cap. Each request's bytes are spread over its (start + 1 RTT, end) interval.
//
// Both throughput phases feed a time-bucketed timeline (100 ms buckets). The reported speed is the
// 90th percentile of 1-second rolling-window rates after a short warm-up, which excludes TCP slow-start and
// the ramp-down tail (methodology recommended in docs/NETWORK_NOTES.md §7).
//
// Interface (PLAN.md §2.7):
//   runSpeedTest({ onProgress, signal }) -> Promise<SpeedTestRaw>
//   SpeedTestRaw = { downloadMbps, uploadMbps, pingMs, jitterMs, colo, durationMs, bytesDown, bytesUp }
//   onProgress({ phase, percent /* overall 0..100 */, currentMbps }) at most every 200 ms.
//   Rejects DOMException 'AbortError' when `signal` aborts, Error('speedtest_failed: ...') on network failure.

import { randomFillSync } from 'node:crypto';

const BASE = 'https://speed.cloudflare.com';
const HEADERS = { Referer: 'https://speed.cloudflare.com/', 'User-Agent': 'NetMon/1.0 (speed test)' };

export const SPEEDTEST_DEFAULTS = Object.freeze({
  latencyCount: 20,
  latencyTimeoutMs: 3000,
  streams: 4,
  downloadDurationMs: 8000,
  downloadMaxBytes: 400e6, // cap total download traffic (~3.2 s at 1 Gbps)
  downloadSizes: [1e6, 10e6, 25e6], // per-request ramp; last size repeats
  uploadDurationMs: 6000,
  uploadMaxBytes: 150e6,
  uploadMinSize: 256e3,
  uploadMaxSize: 25e6,
  uploadTargetRequestMs: 750,
  requestTimeoutMs: 15000, // hard cap for any single request
  bucketMs: 100,
  windowMs: 1000,
  warmupMs: 1000, // ignore the first second of each throughput phase (slow start)
  progressIntervalMs: 200,
});

// Overall progress allotment per phase (PLAN.md: latency 0-10, download 10-60, upload 60-100).
const PHASE_RANGE = { latency: [0, 10], download: [10, 60], upload: [60, 100] };

const round1 = (n) => Math.round(n * 10) / 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function abortError() {
  return new DOMException('Speed test aborted', 'AbortError');
}

class SpeedTestError extends Error {
  constructor(message) {
    super(`speedtest_failed: ${message}`);
    this.name = 'SpeedTestError';
  }
}

function describeError(err) {
  if (!err) return 'unknown error';
  if (err.name === 'TimeoutError') return 'timeout';
  const cause = err.cause;
  if (cause && (cause.code || cause.message)) return cause.code || cause.message;
  return err.message || String(err);
}

/** Combine several AbortSignals (Node 20 has AbortSignal.any). */
function anySignal(signals) {
  const list = signals.filter(Boolean);
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  const ctrl = new AbortController();
  for (const s of list) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

function cacheBuster() {
  return `r=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Sum of `dur=` values in a Server-Timing header (server-side processing time, ms). */
function serverTimingMs(header) {
  if (!header) return 0;
  let total = 0;
  for (const m of header.matchAll(/dur=([\d.]+)/g)) total += Number(m[1]) || 0;
  return total;
}

function coloFromHeaders(headers) {
  const colo = headers.get('colo');
  if (colo && /^[A-Z]{3}$/i.test(colo.trim())) return colo.trim().toUpperCase();
  const ray = headers.get('cf-ray'); // e.g. "8c5e1f2d3a4b5c6d-SJC"
  const m = ray && ray.match(/-([A-Z]{3})$/i);
  return m ? m[1].toUpperCase() : null;
}

function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

function median(values) {
  return percentile(values, 0.5);
}

/**
 * Time-bucketed byte timeline for one throughput phase. `t` values are ms relative to phase start.
 */
class Timeline {
  constructor(bucketMs) {
    this.bucketMs = bucketMs;
    this.buckets = [];
    this.total = 0;
  }

  add(t, bytes) {
    const i = Math.max(0, Math.floor(t / this.bucketMs));
    while (this.buckets.length <= i) this.buckets.push(0);
    this.buckets[i] += bytes;
    this.total += bytes;
  }

  /** Spread `bytes` uniformly across [t0, t1]. */
  addSpread(t0, t1, bytes) {
    if (t1 <= t0) return this.add(t1, bytes);
    const b = this.bucketMs;
    let t = t0;
    while (t < t1) {
      const edge = Math.min(t1, (Math.floor(t / b) + 1) * b);
      this.add(t, (bytes * (edge - t)) / (t1 - t0));
      t = edge;
    }
  }

  /** Rate (Mbps) over the window of `windowMs` ending at bucket index `endIdx` (exclusive). */
  windowMbps(endIdx, windowMs) {
    const n = Math.max(1, Math.round(windowMs / this.bucketMs));
    const start = Math.max(0, endIdx - n);
    let bytes = 0;
    for (let i = start; i < endIdx; i++) bytes += this.buckets[i] || 0;
    const sec = ((endIdx - start) * this.bucketMs) / 1000;
    return sec > 0 ? (bytes * 8) / sec / 1e6 : 0;
  }

  /** Rolling rate over the last `windowMs` before `tNow` (ms). For live progress. */
  currentMbps(tNow, windowMs) {
    // Only count fully elapsed buckets so the in-progress bucket does not drag the number down.
    const endIdx = Math.floor(tNow / this.bucketMs);
    if (endIdx <= 0) return null;
    return this.windowMbps(endIdx, Math.min(windowMs, endIdx * this.bucketMs));
  }

  /**
   * Final speed: P90 of 1 s rolling windows that end after `warmupMs` and no later than `endMs`.
   * Falls back to the plain average when the phase was too short for rolling windows.
   */
  resultMbps({ warmupMs, windowMs, endMs, startMs = 0 }) {
    const lastIdx = Math.min(this.buckets.length, Math.floor(endMs / this.bucketMs));
    const firstEnd = Math.ceil(Math.max(warmupMs, windowMs) / this.bucketMs);
    const rates = [];
    for (let end = firstEnd; end <= lastIdx; end++) rates.push(this.windowMbps(end, windowMs));
    if (rates.length >= 3) return percentile(rates, 0.9);
    const sec = Math.max(1, endMs - startMs) / 1000;
    return (this.total * 8) / sec / 1e6;
  }
}

/**
 * Throttled, exception-safe progress reporter. Emits at most once per `intervalMs`. Regular updates inside
 * the interval are dropped; `important` updates (phase starts / phase results) are deferred to the end of
 * the interval instead of being dropped, unless superseded by a newer update. `flush()` emits a pending one.
 */
function makeReporter(onProgress, intervalMs) {
  let last = -Infinity;
  let lastPercent = 0;
  let pending = null;
  let pendingTimer = null;

  const emit = (p) => {
    last = performance.now();
    try {
      onProgress(p);
    } catch (err) {
      console.error('[speedtest] onProgress handler threw:', err);
    }
  };

  const report = (phase, fraction, currentMbps, important = false) => {
    if (typeof onProgress !== 'function') return;
    const [a, b] = PHASE_RANGE[phase];
    const f = Math.min(1, Math.max(0, fraction));
    // Overall percent never goes backwards.
    lastPercent = Math.max(lastPercent, Math.round(a + (b - a) * f));
    const p = {
      phase,
      percent: lastPercent,
      currentMbps: currentMbps == null || !Number.isFinite(currentMbps) ? null : round1(currentMbps),
    };
    const wait = last + intervalMs - performance.now();
    if (wait <= 0) {
      clearTimeout(pendingTimer);
      pending = null;
      pendingTimer = null;
      emit(p);
    } else if (important || pending) {
      pending = p;
      if (!pendingTimer) {
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          const q = pending;
          pending = null;
          if (q) emit(q);
        }, wait);
      }
    }
  };
  report.cancel = () => {
    clearTimeout(pendingTimer);
    pendingTimer = null;
    pending = null;
  };
  return report;
}

// ---------------------------------------------------------------------------------------------------------
// Phase 1: latency
// ---------------------------------------------------------------------------------------------------------

async function measureLatency({ signal, report, cfg, meta }) {
  const samples = [];
  let lastError = null;
  // Warm-up request establishes DNS + TCP + TLS on a pooled socket; it is not counted.
  for (let i = 0; i <= cfg.latencyCount; i++) {
    if (signal.aborted) throw abortError();
    const t0 = performance.now();
    try {
      const res = await fetch(`${BASE}/__down?bytes=0&${cacheBuster()}`, {
        headers: HEADERS,
        cache: 'no-store',
        signal: anySignal([signal, AbortSignal.timeout(cfg.latencyTimeoutMs)]),
      });
      const ttfb = performance.now() - t0;
      await res.arrayBuffer(); // 0-byte body; consume to free the socket
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!meta.colo) meta.colo = coloFromHeaders(res.headers);
      if (i > 0) {
        const server = serverTimingMs(res.headers.get('server-timing'));
        // Subtract server processing time, but never below a sane floor (bogus headers).
        const net = ttfb - server;
        samples.push(net > ttfb * 0.1 ? net : ttfb);
      }
    } catch (err) {
      if (signal.aborted) throw abortError();
      lastError = err;
    }
    report('latency', i / cfg.latencyCount, null);
  }
  if (samples.length < 3) {
    throw new SpeedTestError(`latency probe failed (${describeError(lastError)})`);
  }
  let diffSum = 0;
  for (let i = 1; i < samples.length; i++) diffSum += Math.abs(samples[i] - samples[i - 1]);
  return {
    pingMs: round1(median(samples)),
    jitterMs: round1(samples.length > 1 ? diffSum / (samples.length - 1) : 0),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Phase 2: download
// ---------------------------------------------------------------------------------------------------------

async function measureDownload({ signal, report, cfg, meta }) {
  const phaseCtrl = new AbortController(); // aborted at the deadline / cap to cut in-flight streams
  const phaseSignal = anySignal([signal, phaseCtrl.signal]);
  const tl = new Timeline(cfg.bucketMs);
  const t0 = performance.now();
  let stopped = false;
  let errors = 0;
  let lastError = null;

  const stop = () => {
    if (!stopped) {
      stopped = true;
      phaseCtrl.abort();
    }
  };
  const elapsed = () => performance.now() - t0;
  const deadlineTimer = setTimeout(stop, cfg.downloadDurationMs);

  const ticker = setInterval(() => {
    const e = elapsed();
    const frac = Math.max(e / cfg.downloadDurationMs, tl.total / cfg.downloadMaxBytes);
    report('download', frac, tl.currentMbps(e, cfg.windowMs));
  }, cfg.progressIntervalMs);

  async function worker(id) {
    let step = 0;
    while (!stopped) {
      const size = cfg.downloadSizes[Math.min(step, cfg.downloadSizes.length - 1)];
      step++;
      try {
        const res = await fetch(`${BASE}/__down?bytes=${size}&${cacheBuster()}`, {
          headers: HEADERS,
          cache: 'no-store',
          signal: anySignal([phaseSignal, AbortSignal.timeout(cfg.requestTimeoutMs)]),
        });
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          throw new Error(`HTTP ${res.status}`);
        }
        if (!meta.colo) meta.colo = coloFromHeaders(res.headers);
        for await (const chunk of res.body) {
          tl.add(elapsed(), chunk.byteLength);
          if (tl.total >= cfg.downloadMaxBytes) {
            stop();
            break;
          }
        }
      } catch (err) {
        if (signal.aborted) throw abortError();
        if (stopped) break; // our own deadline abort
        errors++;
        lastError = err;
        if (errors > cfg.streams * 3) {
          stop();
          break;
        }
        await sleep(200 * Math.min(errors, 5));
      }
    }
    return id;
  }

  try {
    await Promise.all(Array.from({ length: cfg.streams }, (_, i) => worker(i)));
  } finally {
    clearTimeout(deadlineTimer);
    clearInterval(ticker);
    stop();
  }
  if (signal.aborted) throw abortError();
  const endMs = elapsed();
  if (tl.total < 100e3) {
    throw new SpeedTestError(`download failed (${describeError(lastError)})`);
  }
  const mbps = tl.resultMbps({ warmupMs: cfg.warmupMs, windowMs: cfg.windowMs, endMs });
  report('download', 1, mbps, true);
  return { downloadMbps: round1(mbps), bytesDown: Math.round(tl.total) };
}

// ---------------------------------------------------------------------------------------------------------
// Phase 3: upload
// ---------------------------------------------------------------------------------------------------------

/** Random (incompressible) payload, allocated per test (released with the phase). */
function makeUploadBuffer(size) {
  return randomFillSync(new Uint8Array(size));
}

async function measureUpload({ signal, report, cfg, rttMs }) {
  const phaseCtrl = new AbortController();
  const phaseSignal = anySignal([signal, phaseCtrl.signal]);
  const tl = new Timeline(cfg.bucketMs);
  const buf = makeUploadBuffer(cfg.uploadMaxSize);
  const t0 = performance.now();
  const elapsed = () => performance.now() - t0;
  let launching = true; // stop launching new requests after the deadline / cap
  let sentBytes = 0; // bytes of completed requests
  let launchedBytes = 0;
  let errors = 0;
  let lastError = null;
  let lastCompletionMs = 0;

  const deadlineTimer = setTimeout(() => {
    launching = false;
  }, cfg.uploadDurationMs);
  // Grace period for in-flight requests after the deadline, then cut them.
  const hardTimer = setTimeout(() => phaseCtrl.abort(), cfg.uploadDurationMs + 4000);

  const ticker = setInterval(() => {
    const e = elapsed();
    const frac = Math.max(e / cfg.uploadDurationMs, sentBytes / cfg.uploadMaxBytes);
    // Upload progress is only observable per completed request, so the live rate is the timeline rate over
    // the 2 s before the latest completion (slightly conservative while requests are in flight).
    const live = lastCompletionMs > 0 ? tl.currentMbps(lastCompletionMs, 2000) : null;
    report('upload', Math.min(frac, 0.99), live);
  }, cfg.progressIntervalMs);

  async function worker(id) {
    let size = cfg.uploadMinSize;
    while (launching && !phaseSignal.aborted) {
      if (launchedBytes + size > cfg.uploadMaxBytes) {
        launching = false;
        break;
      }
      launchedBytes += size;
      const start = elapsed();
      try {
        const res = await fetch(`${BASE}/__up?${cacheBuster()}`, {
          method: 'POST',
          headers: { ...HEADERS, 'Content-Type': 'application/octet-stream' },
          body: buf.subarray(0, size),
          cache: 'no-store',
          signal: anySignal([phaseSignal, AbortSignal.timeout(cfg.requestTimeoutMs)]),
        });
        await res.arrayBuffer(); // empty body
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const end = elapsed();
        const confirmed = Number(res.headers.get('cf-meta-upload-bytes'));
        const bytes = Number.isFinite(confirmed) && confirmed > 0 ? confirmed : size;
        // The request duration includes ~1 RTT for the response; exclude it from the transfer interval.
        const xferStart = Math.min(end - 1, start + rttMs);
        tl.addSpread(xferStart, end, bytes);
        sentBytes += bytes;
        lastCompletionMs = Math.max(lastCompletionMs, end);
        const durMs = Math.max(1, end - xferStart);
        const bytesPerMs = bytes / durMs;
        // Adapt the next request size so each POST takes ~uploadTargetRequestMs.
        size = Math.round(
          Math.min(cfg.uploadMaxSize, Math.max(cfg.uploadMinSize, bytesPerMs * cfg.uploadTargetRequestMs)),
        );
      } catch (err) {
        launchedBytes -= size;
        if (signal.aborted) throw abortError();
        if (phaseCtrl.signal.aborted) break; // grace period expired
        errors++;
        lastError = err;
        if (errors > cfg.streams * 3) {
          launching = false;
          break;
        }
        await sleep(200 * Math.min(errors, 5));
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: cfg.streams }, (_, i) => worker(i)));
  } finally {
    clearTimeout(deadlineTimer);
    clearTimeout(hardTimer);
    clearInterval(ticker);
    phaseCtrl.abort();
  }
  if (signal.aborted) throw abortError();
  if (sentBytes <= 0) {
    throw new SpeedTestError(`upload failed (${describeError(lastError)})`);
  }
  // Only consider windows up to the start of the ramp-down: the deadline (after which no new requests start).
  const endMs = Math.min(lastCompletionMs, cfg.uploadDurationMs);
  const mbps = tl.resultMbps({ warmupMs: cfg.warmupMs, windowMs: cfg.windowMs, endMs: Math.max(endMs, 1) });
  report('upload', 1, mbps, true);
  return { uploadMbps: round1(mbps), bytesUp: Math.round(sentBytes) };
}

// ---------------------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------------------

/**
 * Run a full latency + download + upload test.
 * @param {{ onProgress?: (p:{phase:string,percent:number,currentMbps:number|null})=>void, signal?: AbortSignal,
 *           options?: Partial<typeof SPEEDTEST_DEFAULTS> }} [opts]
 *   `options` is an optional extension (not in PLAN) for tuning/testing; core does not need it.
 */
export async function runSpeedTest({ onProgress, signal, options } = {}) {
  const cfg = { ...SPEEDTEST_DEFAULTS, ...(options || {}) };
  const sig = signal || new AbortController().signal;
  if (sig.aborted) throw abortError();

  const report = makeReporter(onProgress, cfg.progressIntervalMs);
  const meta = { colo: null };
  const tStart = performance.now();

  let pingMs, jitterMs, downloadMbps, bytesDown, uploadMbps, bytesUp;
  try {
    report('latency', 0, null, true);
    ({ pingMs, jitterMs } = await measureLatency({ signal: sig, report, cfg, meta }));

    report('download', 0, null, true);
    ({ downloadMbps, bytesDown } = await measureDownload({ signal: sig, report, cfg, meta }));

    report('upload', 0, null, true);
    ({ uploadMbps, bytesUp } = await measureUpload({ signal: sig, report, cfg, rttMs: pingMs }));
  } finally {
    // Never deliver a deferred progress event after the promise settles.
    report.cancel();
  }

  return {
    downloadMbps,
    uploadMbps,
    pingMs,
    jitterMs,
    colo: meta.colo,
    durationMs: Math.round(performance.now() - tStart),
    bytesDown,
    bytesUp,
  };
}

// Exported for unit checks.
export const _internal = { Timeline, percentile, median, serverTimingMs, coloFromHeaders };
