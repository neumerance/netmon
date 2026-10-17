// Internet reachability probe.
//
// Every `intervalMs` we try a tiny HTTPS request to Cloudflare (1.1.1.1/cdn-cgi/trace), falling back to
// Google's generate_204 endpoint. One success marks the internet "up"; `failuresForDown` consecutive
// failed checks (both targets failing counts as one failed check) mark it "down". This debounces brief
// blips so the UI does not flash a critical alarm on a single lost request.
//
// Interface (PLAN.md §2.7):
//   createProbe({ intervalMs, timeoutMs, failuresForDown, onStatus }) -> { start(), stop(), checkNow() }
//   onStatus(InternetStatus) is called after EVERY check.

const TARGETS = [
  { name: '1.1.1.1', url: 'https://1.1.1.1/cdn-cgi/trace' },
  { name: 'google.com', url: 'https://www.google.com/generate_204' },
];

/**
 * Perform one HTTP check against a target. Resolves { ok: true, latencyMs } or { ok: false, error }.
 * Never throws.
 */
async function checkTarget(target, timeoutMs, signal = null) {
  const t0 = performance.now();
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await fetch(target.url, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'manual',
      headers: { 'User-Agent': 'NetMon/1.0 (connectivity probe)' },
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    const latencyMs = performance.now() - t0; // time to response headers ~= HTTP RTT
    // Always consume / cancel the body so the keep-alive socket is released.
    try {
      if (res.body) await res.body.cancel();
    } catch {
      /* ignore */
    }
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, latencyMs: Math.round(latencyMs) };
    }
    return { ok: false, error: `${target.name}: HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: `${target.name}: ${describeError(err)}` };
  }
}

function describeError(err) {
  if (!err) return 'unknown error';
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout';
  // undici wraps the real reason in err.cause (ENOTFOUND, ECONNREFUSED, ENETUNREACH, ...)
  const cause = err.cause;
  if (cause && (cause.code || cause.message)) return cause.code || cause.message;
  return err.message || String(err);
}

export function createProbe({ intervalMs = 5000, timeoutMs = 3000, failuresForDown = 2, onStatus } = {}) {
  /** @type {{status:'unknown'|'up'|'down', since:string|null, lastCheckedAt:string|null, latencyMs:number|null,
   *          consecutiveFailures:number, target:string|null, error:string|null}} */
  let state = {
    status: 'unknown',
    since: null,
    lastCheckedAt: null,
    latencyMs: null,
    consecutiveFailures: 0,
    target: null,
    error: null,
  };
  let timer = null;
  let running = false;
  let inFlight = null; // Promise<InternetStatus> while a check is running (checks never overlap)

  async function runCheck() {
    // All targets in parallel; the first success wins and the others are aborted, so a failing check
    // takes at most timeoutMs (sequential targets doubled the time to raise "internet down").
    let result = null;
    const errors = [];
    const ac = new AbortController();
    await new Promise((resolve) => {
      let pending = TARGETS.length;
      TARGETS.forEach((target, i) => {
        checkTarget(target, timeoutMs, ac.signal).then((r) => {
          if (r.ok && !result) {
            result = { ...r, target: target.name };
            ac.abort();
            resolve();
          } else if (!r.ok) {
            errors[i] = r.error;
          }
          if (--pending === 0) resolve();
        });
      });
    });

    const nowIso = new Date().toISOString();
    const prevStatus = state.status;
    let next;
    if (result) {
      next = {
        status: 'up',
        latencyMs: result.latencyMs,
        consecutiveFailures: 0,
        target: result.target,
        error: null,
      };
    } else {
      const failures = state.consecutiveFailures + 1;
      // Stay in the previous state (unknown/up) until the failure threshold is reached.
      const status = failures >= failuresForDown ? 'down' : prevStatus;
      next = {
        status,
        latencyMs: null,
        consecutiveFailures: failures,
        target: null,
        error: errors.filter(Boolean).join('; ') || 'unreachable',
      };
    }
    state = {
      ...next,
      since: next.status !== prevStatus ? nowIso : state.since,
      lastCheckedAt: nowIso,
    };
    const snapshot = { ...state };
    if (typeof onStatus === 'function') {
      try {
        onStatus(snapshot);
      } catch (err) {
        console.error('[probe] onStatus handler threw:', err);
      }
    }
    return snapshot;
  }

  function checkNow() {
    if (!inFlight) {
      inFlight = runCheck().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  // Checks start every intervalMs (measured from the previous check's start, so a slow failing
  // check does not stretch the cadence).
  function scheduleNext(startedAt = Date.now()) {
    if (!running) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      const t0 = Date.now();
      await checkNow();
      scheduleNext(t0);
    }, Math.max(250, intervalMs - (Date.now() - startedAt)));
    // Do not keep the process alive just for the probe (the HTTP server does that).
    timer.unref?.();
  }

  return {
    start() {
      if (running) return;
      running = true;
      // First check immediately so the UI leaves "unknown" quickly, then every intervalMs after completion.
      const t0 = Date.now();
      checkNow().finally(() => scheduleNext(t0));
    },
    stop() {
      running = false;
      clearTimeout(timer);
      timer = null;
    },
    checkNow,
    /** Current status without triggering a check (convenience; not part of the PLAN contract). */
    getStatus() {
      return { ...state };
    },
  };
}
