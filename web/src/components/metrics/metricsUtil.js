// Pure helpers shared by the metrics components (frontend-metrics owned).
// No Vue imports here so everything can be unit-tested with plain Node.

/** Clamp n into [lo, hi]. */
export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** True for finite numbers (rejects null/undefined/NaN/strings). */
export function isNum(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Round a positive value up to a "nice" maximum that reads well on Mbps dials:
 * {1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8} x 10^n  (e.g. 517 -> 600, 230 -> 250, 1040 -> 1200).
 */
export function niceCeil(value) {
  if (!isNum(value) || value <= 0) return 1;
  const base = 10 ** Math.floor(Math.log10(value));
  for (const s of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    const candidate = s * base;
    if (candidate >= value - 1e-9) return round(candidate, 6);
  }
  return 10 * base;
}

/**
 * Linear axis from 0 with a step from {1, 2, 2.5, 5} x 10^n giving at most targetCount+1
 * intervals. The max is rounded UP to a whole step so the top tick equals the axis max.
 * niceScale(517.5) -> { max: 600, step: 200, ticks: [0, 200, 400, 600] }
 */
export function niceScale(rawMax, targetCount = 4) {
  const value = isNum(rawMax) && rawMax > 0 ? rawMax : 1;
  const base = 10 ** Math.floor(Math.log10(value / targetCount));
  let step = base;
  for (const s of [1, 2, 2.5, 5, 10]) {
    step = s * base;
    if (Math.ceil(value / step - 1e-9) <= targetCount + 1) break;
  }
  const max = round(Math.ceil(value / step - 1e-9) * step, 6);
  const ticks = [];
  for (let i = 0; i * step <= max + 1e-9; i++) ticks.push(round(i * step, 6));
  return { max, step, ticks };
}

/** Round n to d decimals (number). */
export function round(n, d = 1) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/**
 * Number-only text for millisecond values used in testid'd elements: '2.5', '12', '—'.
 * Mirrors formatMs() without the unit.
 */
export function msValue(n) {
  if (!isNum(n)) return '—';
  return n < 10 ? n.toFixed(1) : String(Math.round(n));
}

/**
 * Internet latency quality (DESIGN.md §3.5) -> key used for tone classes.
 * loss is optional (percent).
 */
export function latencyQuality(ms, lossPct = 0) {
  if (!isNum(ms)) return 'none';
  const loss = isNum(lossPct) ? lossPct : 0;
  if (ms >= 100 || loss >= 5) return 'poor';
  if (ms < 20 && loss < 1) return 'excellent';
  if (ms < 50 && loss < 2) return 'good';
  return 'fair';
}

export const QUALITY_LABELS = { excellent: 'Excellent', good: 'Good', fair: 'Fair', poor: 'Poor', none: '—' };

/** Text tone class per quality key (token-based, re-themes automatically). */
export const QUALITY_TEXT = {
  excellent: 'text-success-fg',
  good: 'text-success-fg',
  fair: 'text-warning-fg',
  poor: 'text-danger-fg',
  none: 'text-muted',
};

/**
 * Compact duration: 45000 -> '45s', 372000 -> '6m 12s', 11520000 -> '3h 12m', 2 days -> '2d 4h'.
 */
export function shortDuration(ms) {
  if (!isNum(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** Relative future time: 'in 9 min', 'in 45 s', 'in 2 h', 'now'. */
export function formatIn(iso, now = Date.now()) {
  const t = toMs(iso);
  if (t == null) return null;
  const diff = t - now;
  if (diff <= 1000) return 'now';
  const s = Math.round(diff / 1000);
  if (s < 60) return `in ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `in ${h} h ${rem} min` : `in ${h} h`;
}

/** Short relative past time used where space is tight: 'now', '42s ago', '3m ago', '2h ago', '3d ago'. */
export function agoShort(iso, now = Date.now()) {
  const t = toMs(iso);
  if (t == null) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** ISO string | number | Date -> ms epoch (or null). */
export function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

const pad2 = (n) => String(n).padStart(2, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'HH:mm' in local time. */
export function clock(v) {
  const t = toMs(v);
  if (t == null) return '—';
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 'Oct 17' in local time. */
export function monthDay(v) {
  const t = toMs(v);
  if (t == null) return '—';
  const d = new Date(t);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** 'Fri 10:40' in local time. */
export function dayClock(v) {
  const t = toMs(v);
  if (t == null) return '—';
  const d = new Date(t);
  return `${DAYS[d.getDay()]} ${clock(t)}`;
}

/** Local-day key 'YYYY-MM-DD' used for grouping. */
export function dayKey(v) {
  const t = toMs(v);
  if (t == null) return '';
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 'Today' / 'Yesterday' / 'Oct 15' for a timestamp relative to now. */
export function dayLabel(v, now = Date.now()) {
  const key = dayKey(v);
  if (key === dayKey(now)) return 'Today';
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (key === dayKey(y.getTime())) return 'Yesterday';
  return monthDay(v);
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TIME_STEPS = [5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR,
  DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY];

/**
 * Time axis ticks aligned to local clock boundaries.
 * Returns [{ t, label }] with at most maxTicks entries inside [start, end].
 */
export function timeTicks(start, end, maxTicks = 5) {
  if (!isNum(start) || !isNum(end) || end <= start) return [];
  const span = end - start;
  const count = Math.max(2, maxTicks);
  const step = TIME_STEPS.find((s) => span / s <= count) ?? Math.ceil(span / count / DAY) * DAY;
  // Align the first tick to the step boundary in local time.
  const tzOffset = new Date(start).getTimezoneOffset() * MIN;
  let first;
  if (step >= DAY) {
    const d = new Date(start);
    d.setHours(0, 0, 0, 0);
    first = d.getTime();
    while (first < start) first += step >= 7 * DAY ? DAY : step;
  } else {
    first = Math.ceil((start - tzOffset) / step) * step + tzOffset;
  }
  const fmt = span <= DAY + HOUR ? clock : span <= 4 * DAY ? dayClock : monthDay;
  const ticks = [];
  for (let t = first; t <= end && ticks.length < count + 1; t += step) {
    // Day-aligned steps across DST changes: re-snap to local midnight.
    let tt = t;
    if (step >= DAY) {
      const d = new Date(t + 2 * HOUR);
      d.setHours(0, 0, 0, 0);
      tt = d.getTime();
    }
    ticks.push({ t: tt, label: fmt(tt) });
  }
  return ticks;
}

/** Median of numeric array (null when empty). */
export function median(values) {
  const v = values.filter(isNum).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Split a chronological list of points into contiguous runs. A new run starts when the
 * gap between two consecutive points exceeds maxGapMs.
 */
export function splitRuns(points, getT, maxGapMs) {
  const runs = [];
  let cur = [];
  let prevT = null;
  for (const p of points) {
    const t = getT(p);
    if (prevT != null && isNum(maxGapMs) && t - prevT > maxGapMs) {
      runs.push(cur);
      cur = [];
    }
    cur.push(p);
    prevT = t;
  }
  if (cur.length) runs.push(cur);
  return runs;
}

/**
 * Derive internet-down intervals [{ start, end }] (ms) from events (any order).
 * An unmatched trailing internet_down extends to `now` when currentlyDown.
 */
export function downIntervals(events, now = Date.now(), currentlyDown = false) {
  const evs = (events || [])
    .filter((e) => e && (e.type === 'internet_down' || e.type === 'internet_restored'))
    .map((e) => ({ type: e.type, t: toMs(e.at), downtimeMs: e.data?.downtimeMs }))
    .filter((e) => e.t != null)
    .sort((a, b) => a.t - b.t);
  const out = [];
  let open = null;
  for (const e of evs) {
    if (e.type === 'internet_down') {
      if (open == null) open = e.t;
    } else if (open != null) {
      out.push({ start: open, end: e.t });
      open = null;
    } else if (isNum(e.downtimeMs) && e.downtimeMs > 0) {
      // Restore without a matching down in the window: reconstruct from downtime.
      out.push({ start: e.t - e.downtimeMs, end: e.t });
    }
  }
  if (open != null) out.push({ start: open, end: currentlyDown ? now : open });
  return out.filter((iv) => iv.end > iv.start);
}

/**
 * Index of the point whose x is nearest to `x` in a sorted array of xs (binary search).
 */
export function nearestIndex(xs, x) {
  if (!xs.length) return -1;
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) lo = mid;
    else hi = mid;
  }
  return Math.abs(xs[lo] - x) <= Math.abs(xs[hi] - x) ? lo : hi;
}

/** Percent change from prev to cur, rounded to integer (null when not computable). */
export function pctChange(cur, prev) {
  if (!isNum(cur) || !isNum(prev) || prev === 0) return null;
  return Math.round(((cur - prev) / prev) * 100);
}

/**
 * formatRelative-style text that never says "in …" for past events whose timestamps are slightly
 * ahead of this browser's clock (server/browser clock skew): future -> 'just now'.
 */
export function pastRelative(formatRelative, iso, now = Date.now()) {
  const t = toMs(iso);
  if (t == null) return '—';
  return formatRelative(Math.min(t, now), now);
}
