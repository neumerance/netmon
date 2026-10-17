// Formatting helpers (PLAN.md §8.3). Pure functions, no Vue imports — safe to unit-test in Node.
// Conventions: `null`/`undefined`/NaN render as an em dash '—'. Speeds are decimal Mbps.

export const DASH = '—';

function isNum(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function toNum(n) {
  if (n === null || n === undefined || n === '') return null;
  const v = typeof n === 'number' ? n : Number(n);
  return Number.isFinite(v) ? v : null;
}

function toMs(iso) {
  if (iso === null || iso === undefined || iso === '') return null;
  if (iso instanceof Date) return iso.getTime();
  if (typeof iso === 'number') return Number.isFinite(iso) ? iso : null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Trim a fixed-decimal string's trailing ".0" ('40.0' -> '40'). */
function trimZero(s) {
  return s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

/**
 * Number part of a Mbps value: '452', '7.4', '—'. Values >= 1000 are expressed in Gbps
 * ('1.25'); pair with mbpsUnit(n) for the unit label.
 */
export function formatMbpsValue(n) {
  const v = toNum(n);
  if (v === null) return DASH;
  if (v >= 1000) return trimZero((v / 1000).toFixed(2));
  if (v < 10) return trimZero(v.toFixed(1));
  return String(Math.round(v));
}

/** Unit that matches formatMbpsValue(n): 'Gbps' for >= 1000, else 'Mbps'. */
export function mbpsUnit(n) {
  const v = toNum(n);
  return v !== null && v >= 1000 ? 'Gbps' : 'Mbps';
}

/** Full string incl. unit: '452 Mbps', '7.4 Mbps', '1.25 Gbps', '—'. */
export function formatMbps(n) {
  const v = toNum(n);
  if (v === null) return DASH;
  return `${formatMbpsValue(v)} ${mbpsUnit(v)}`;
}

/** Milliseconds number part: '2.5', '14', '—'. */
export function formatMsValue(n) {
  const v = toNum(n);
  if (v === null) return DASH;
  if (v < 10) return trimZero(v.toFixed(1));
  return String(Math.round(v));
}

/** '2.5 ms', '14 ms', '—'. */
export function formatMs(n) {
  const v = toNum(n);
  if (v === null) return DASH;
  return `${formatMsValue(v)} ms`;
}

/** '0%', '5%', '2.5%', '—'. Input is already 0..100. */
export function formatPercent(n) {
  const v = toNum(n);
  if (v === null) return DASH;
  if (Number.isInteger(v)) return `${v}%`;
  const s = Math.abs(v) < 10 ? trimZero(v.toFixed(1)) : String(Math.round(v));
  return `${s}%`;
}

/**
 * Relative time: 'just now' (<10 s), '42 s ago', '3 min ago', '2 h ago', '3 d ago'.
 * Future times: 'in 42 s', 'in 3 min', ... ('in a moment' for <10 s).
 */
export function formatRelative(iso, now = Date.now()) {
  const t = toMs(iso);
  if (t === null) return DASH;
  const nowMs = toMs(now) ?? Date.now();
  const diff = nowMs - t;
  const abs = Math.abs(diff);
  const future = diff < 0;
  if (abs < 10_000) return future ? 'in a moment' : 'just now';
  let unit;
  if (abs < 60_000) unit = `${Math.floor(abs / 1000)} s`;
  else if (abs < 3_600_000) unit = `${Math.floor(abs / 60_000)} min`;
  else if (abs < 86_400_000) unit = `${Math.floor(abs / 3_600_000)} h`;
  else unit = `${Math.floor(abs / 86_400_000)} d`;
  return future ? `in ${unit}` : `${unit} ago`;
}

/** Duration: '45 s', '3 min', '1 h 12 min', '2 d 3 h'. Negative/invalid -> '—'. */
export function formatDuration(ms) {
  const v = toNum(ms);
  if (v === null || v < 0) return DASH;
  const s = Math.floor(v / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) {
    const rm = m % 60;
    return rm ? `${h} h ${rm} min` : `${h} h`;
  }
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d} d ${rh} h` : `${d} d`;
}

/** Compact duration for live counters: '6m 12s', '3h 12m', '45s'. */
export function formatDurationShort(ms) {
  const v = toNum(ms);
  if (v === null || v < 0) return DASH;
  const s = Math.floor(v / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Locale time 'HH:MM:SS' (24 h). */
export function formatTime(iso) {
  const t = toMs(iso);
  if (t === null) return DASH;
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

/** Locale clock 'HH:MM' (24 h) — compact form used in banners, chart ticks, event rows. */
export function formatClock(iso) {
  const t = toMs(iso);
  if (t === null) return DASH;
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Locale date + time, e.g. 'Oct 17, 2026, 15:04:05'. */
export function formatDateTime(iso) {
  const t = toMs(iso);
  if (t === null) return DASH;
  return new Date(t).toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/** Short date 'Oct 17'. */
export function formatDate(iso) {
  const t = toMs(iso);
  if (t === null) return DASH;
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Bytes -> '25 MB', '1.2 GB' (decimal units). */
export function formatBytes(n) {
  const v = toNum(n);
  if (v === null) return DASH;
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let x = Math.abs(v);
  let i = 0;
  while (x >= 1000 && i < units.length - 1) {
    x /= 1000;
    i++;
  }
  const s = x < 10 && i > 0 ? trimZero(x.toFixed(1)) : String(Math.round(x));
  return `${v < 0 ? '-' : ''}${s} ${units[i]}`;
}

/** Normalize any MAC-ish string to lowercase, zero-padded, colon form; invalid -> null. */
export function normalizeMac(s) {
  if (typeof s !== 'string') return null;
  let str = s.trim().toLowerCase();
  try {
    str = decodeURIComponent(str);
  } catch {
    /* keep as-is */
  }
  const parts = str.split(/[:-]/);
  if (parts.length !== 6) {
    const hex = str.replace(/[^0-9a-f]/g, '');
    if (hex.length !== 12) return null;
    return hex.match(/../g).join(':');
  }
  if (!parts.every((p) => /^[0-9a-f]{1,2}$/.test(p))) return null;
  return parts.map((p) => p.padStart(2, '0')).join(':');
}

/** 'a4:83:e7:1c:2d:01' -> 'a4-83-e7-1c-2d-01' (for URLs and data-testids). */
export function macToId(mac) {
  if (!mac) return '';
  const norm = normalizeMac(String(mac));
  return (norm || String(mac).toLowerCase()).replace(/:/g, '-');
}

/** 'a4-83-e7-1c-2d-01' -> 'a4:83:e7:1c:2d:01'. */
export function idToMac(id) {
  if (!id) return '';
  const norm = normalizeMac(String(id));
  return norm || String(id).toLowerCase().replace(/-/g, ':');
}

/** Locally-administered (randomized / private) MAC: bit 0x02 of the first octet. */
export function isRandomizedMac(mac) {
  const norm = normalizeMac(String(mac || ''));
  if (!norm) return false;
  return (parseInt(norm.slice(0, 2), 16) & 0x02) !== 0;
}

/** Numeric IPv4 compare for sorting; non-IPs sort last. */
export function ipToInt(ip) {
  if (typeof ip !== 'string') return Number.MAX_SAFE_INTEGER;
  const p = ip.split('.');
  if (p.length !== 4) return Number.MAX_SAFE_INTEGER;
  let n = 0;
  for (const part of p) {
    const x = Number(part);
    if (!Number.isInteger(x) || x < 0 || x > 255) return Number.MAX_SAFE_INTEGER;
    n = n * 256 + x;
  }
  return n;
}

export function compareIp(a, b) {
  return ipToInt(a) - ipToInt(b);
}

/** Mask a public IPv4 for display: '73.162.88.14' -> '73.•••.•••.14'. */
export function maskIp(ip) {
  if (!ip) return DASH;
  const p = String(ip).split('.');
  if (p.length === 4) return `${p[0]}.•••.•••.${p[3]}`;
  // IPv6: keep first and last group
  const g = String(ip).split(':');
  if (g.length > 2) return `${g[0]}:••••:${g[g.length - 1]}`;
  return String(ip);
}

/** Percent change from prev to cur (rounded integer), null when not computable. */
export function percentChange(cur, prev) {
  const c = toNum(cur);
  const p = toNum(prev);
  if (c === null || p === null || p === 0) return null;
  return Math.round(((c - p) / p) * 100);
}

/** Round to 1 decimal (wire convention). */
export function round1(n) {
  const v = toNum(n);
  return v === null ? null : Math.round(v * 10) / 10;
}

export { isNum };
