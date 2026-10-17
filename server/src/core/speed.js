// Speed test controller (PLAN §6.3): one test at a time, auto schedule, startup test,
// throttled progress broadcasts, abort on mock reset.

const PROGRESS_MIN_GAP_MS = 95; // "≥100 ms apart" with a little tolerance for timer jitter
const round1 = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 10) / 10 : null);

// The startup test waits for the first discovery + fingerprint pass to drain (a saturated link makes the
// 400 ms TCP probes time out and the weaker results would stay cached), but never longer than this.
const STARTUP_DEFER_MAX_MS = 90_000;
const STARTUP_DEFER_POLL_MS = 2_000;

/**
 * @param {object} o
 * @param {() => boolean} [o.shouldDeferStartup]  true while the startup test should keep waiting
 */
export function createSpeedController({ runSpeedTest, state, store, eventLog, timings, mock = false, shouldDeferStartup = null }) {
  let abortController = null;
  let currentRun = null;
  let followUpQueued = false;
  let autoTimer = null;
  let startupTimer = null;
  let started = false;
  let lastIdMs = 0;

  const intervalMs = () => (store.getSettings().speedTestIntervalMin || 0) * 60_000;

  // ------------------------------------------------------------------ scheduling
  function clearAuto() { if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; } }

  /** Schedule the next auto test `fromMs + interval` (or clear when auto is off). */
  function scheduleNext(fromMs = Date.now()) {
    clearAuto();
    const iv = intervalMs();
    if (!started || iv <= 0) {
      if (state.getSpeed().nextAutoAt !== null) state.setSpeed({ nextAutoAt: null });
      return;
    }
    const at = Math.max(Date.now() + 1000, fromMs + iv);
    state.setSpeed({ nextAutoAt: new Date(at).toISOString() });
    autoTimer = setTimeout(onAutoDue, at - Date.now());
    autoTimer.unref?.();
  }

  function onAutoDue() {
    autoTimer = null;
    if (state.getSpeed().running) return; // completion of the running test reschedules
    if (state.getInternet().status === 'down') { scheduleNext(Date.now()); return; }
    const r = run('auto');
    if (!r.ok) scheduleNext(Date.now());
  }

  /** Settings changed: recompute nextAutoAt from the last test end (or from now, e.g. after a mock reset). */
  function reschedule({ fromNow = false } = {}) {
    if (fromNow) { scheduleNext(Date.now()); return; }
    const last = state.getSpeed().last;
    const lastMs = last ? Date.parse(last.at) : NaN;
    scheduleNext(Number.isFinite(lastMs) ? lastMs : Date.now());
  }

  // ------------------------------------------------------------------ running
  /**
   * Start a test. Returns { ok: true } or { ok: false, error: 'speedtest_running'|'internet_down' }.
   * The test itself runs asynchronously.
   */
  function run(trigger = 'manual', { ignoreInternetDown = false } = {}) {
    if (state.getSpeed().running) return { ok: false, error: 'speedtest_running' };
    if (!ignoreInternetDown && state.getInternet().status === 'down') return { ok: false, error: 'internet_down' };
    cancelStartup(); // a test is running anyway

    clearAuto();
    const ac = new AbortController();
    abortController = ac;
    const startedAt = Date.now();
    let lastProgressAt = 0;

    state.setSpeed({ running: true, progress: { phase: 'latency', percent: 0, currentMbps: null }, lastError: null });

    const onProgress = (p) => {
      if (ac.signal.aborted || !p) return;
      const progress = {
        phase: ['latency', 'download', 'upload'].includes(p.phase) ? p.phase : 'latency',
        percent: Math.max(0, Math.min(100, Math.round(Number(p.percent) || 0))),
        currentMbps: round1(p.currentMbps),
      };
      const now = Date.now();
      const silent = now - lastProgressAt < PROGRESS_MIN_GAP_MS;
      if (!silent) lastProgressAt = now;
      state.setSpeed({ progress }, { silent });
    };

    currentRun = Promise.resolve()
      .then(() => runSpeedTest({ onProgress, signal: ac.signal }))
      .then((raw) => {
        if (ac.signal.aborted) return;
        onSuccess(raw, trigger, startedAt);
      })
      .catch((err) => {
        if (ac.signal.aborted || err?.name === 'AbortError') return;
        onFailure(err, trigger);
      })
      .finally(() => {
        if (abortController === ac) abortController = null;
        currentRun = null;
        if (ac.signal.aborted) return; // reset() already cleaned up state
        if (followUpQueued) {
          followUpQueued = false;
          const r = run('manual', { ignoreInternetDown: true });
          if (r.ok) return;
        }
        scheduleNext(Date.now());
      });
    return { ok: true };
  }

  function onSuccess(raw, trigger, startedAt) {
    let nowMs = Date.now();
    if (nowMs <= lastIdMs) nowMs = lastIdMs + 1; // unique ids even for back-to-back tests
    lastIdMs = nowMs;
    const result = {
      id: `st_${nowMs}`,
      at: new Date(nowMs).toISOString(),
      trigger,
      downloadMbps: round1(raw?.downloadMbps) ?? 0,
      uploadMbps: round1(raw?.uploadMbps) ?? 0,
      pingMs: round1(raw?.pingMs),
      jitterMs: round1(raw?.jitterMs),
      colo: raw?.colo ?? null,
      durationMs: typeof raw?.durationMs === 'number' ? Math.round(raw.durationMs) : Date.now() - startedAt,
      bytesDown: typeof raw?.bytesDown === 'number' ? raw.bytesDown : null,
      bytesUp: typeof raw?.bytesUp === 'number' ? raw.bytesUp : null,
    };
    store.addSpeedResult(result);
    const threshold = store.getSettings().speedThresholdMbps;
    const slow = result.downloadMbps < threshold;
    state.setSpeed({ running: false, progress: null, last: result, lastError: null });
    eventLog.add({
      type: 'speedtest_complete',
      level: slow ? 'warning' : 'info',
      message: `Speed test: ${result.downloadMbps.toFixed(1)} Mbps down / ${result.uploadMbps.toFixed(1)} Mbps up`
        + (slow ? ` (below ${threshold} Mbps)` : ''),
      data: result,
    });
    state.recomputeAlerts();
  }

  function onFailure(err, trigger) {
    const message = String(err?.message || err || 'speedtest_failed');
    const at = new Date().toISOString();
    console.warn(`[speed] ${trigger} test failed: ${message}`);
    state.setSpeed({ running: false, progress: null, lastError: { message, at } });
    eventLog.add({ type: 'speedtest_failed', level: 'warning', message: `Speed test failed: ${message}`, data: { trigger } });
  }

  /** Mock effect: start a manual test, or queue exactly one follow-up if one is running. */
  function requestMockRun() {
    if (state.getSpeed().running) { followUpQueued = true; return { ok: true, queued: true }; }
    return run('manual', { ignoreInternetDown: true });
  }

  /** Abort a running test and clear transient state (mock reset). */
  function abort() {
    followUpQueued = false;
    cancelStartup();
    if (abortController) { try { abortController.abort(); } catch { /* ignore */ } }
    abortController = null;
    state.setSpeed({ running: false, progress: null, lastError: null }, { silent: true });
  }

  // ------------------------------------------------------------------ lifecycle
  function start() {
    if (started) return;
    started = true;
    const isStale = () => {
      const last = state.getSpeed().last;
      const iv = intervalMs();
      const lastMs = last ? Date.parse(last.at) : NaN;
      return !last || !Number.isFinite(lastMs) || (iv > 0 && Date.now() - lastMs > iv);
    };
    // If a startup test will run, let it own the first slot (auto would otherwise fire right away).
    reschedule({ fromNow: mock || isStale() });
    const firstDueAt = Date.now() + timings.startupSpeedTestDelayMs;
    const onStartupDue = () => {
      startupTimer = null;
      if (!started || state.getSpeed().running) return;
      if (!(mock || isStale())) return;
      let defer = false;
      try { defer = typeof shouldDeferStartup === 'function' && Boolean(shouldDeferStartup()); } catch { defer = false; }
      if (defer && Date.now() - firstDueAt < STARTUP_DEFER_MAX_MS) {
        startupTimer = setTimeout(onStartupDue, STARTUP_DEFER_POLL_MS);
        startupTimer.unref?.();
        return;
      }
      const r = run('startup');
      if (!r.ok && r.error === 'internet_down') console.warn('[speed] startup test skipped: internet down');
    };
    startupTimer = setTimeout(onStartupDue, timings.startupSpeedTestDelayMs);
    startupTimer.unref?.();
  }

  /** Drop a pending startup test (mock reset: PLAN §7.4 "no test right after a reset"). */
  function cancelStartup() {
    if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  }

  function stop() {
    started = false;
    clearAuto();
    if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
    if (abortController) { try { abortController.abort(); } catch { /* ignore */ } }
  }

  return { start, stop, run, requestMockRun, abort, cancelStartup, reschedule, isRunning: () => Boolean(currentRun) };
}
