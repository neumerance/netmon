// Presentation helpers shared by the devices components (frontend-devices only).
//
// Pure functions + static Tailwind class strings. Class strings are written out in full
// (never concatenated) so Tailwind's scanner can see them.

/* ------------------------------------------------------------------------------------------
 * Category tints come from lib/deviceTypes.js (token classes such as bg-cat-mobile/12, DESIGN.md §1.4).
 * Re-exported here so the devices components have one import site.
 * ---------------------------------------------------------------------------------------- */

export { categoryTint } from '../../lib/deviceTypes.js';

/** Tile classes used when a device is offline (tint removed so the row reads as dimmed). */
export const OFFLINE_TILE = 'bg-surface-3 text-subtle';

/* ------------------------------------------------------------------------------------------
 * Connection quality (PLAN.md §8.6):
 *   good = latency < 30 && loss < 2, fair = latency < 100 && loss < 10, else poor; offline grey.
 * ---------------------------------------------------------------------------------------- */

export const QUALITY = {
  good: {
    label: 'Good',
    dot: 'bg-success',
    text: 'text-success-fg',
    badge: 'bg-success/15 text-success-fg',
    stroke: 'var(--color-success)'
  },
  fair: {
    label: 'Fair',
    dot: 'bg-warning',
    text: 'text-warning-fg',
    badge: 'bg-warning/15 text-warning-fg',
    stroke: 'var(--color-warning)'
  },
  poor: {
    label: 'Poor',
    dot: 'bg-danger',
    text: 'text-danger-fg',
    badge: 'bg-danger/15 text-danger-fg',
    stroke: 'var(--color-danger)'
  },
  offline: {
    label: 'Offline',
    dot: 'bg-subtle',
    text: 'text-subtle',
    badge: 'bg-surface-3 text-muted',
    stroke: 'var(--color-subtle)'
  },
  noping: {
    label: 'No ping reply',
    dot: 'bg-border-strong',
    text: 'text-subtle',
    badge: 'bg-surface-3 text-muted',
    stroke: 'var(--color-subtle)'
  },
  none: {
    label: 'No data',
    dot: 'bg-border-strong',
    text: 'text-subtle',
    badge: 'bg-surface-3 text-muted',
    stroke: 'var(--color-subtle)'
  }
};

/**
 * True when the device is online but does not answer ping at all (ICMP blocked by a firewall,
 * e.g. Windows Defender; seen only through ARP). Uses the server flag when it is on the wire
 * (`pingable` / `answersIcmp`), otherwise infers it: online, with samples, none ever answered.
 */
export function isPingBlocked(device) {
  if (!device || !device.online || device.isSelf) return false;
  if (device.pingable === false || device.answersIcmp === false) return true;
  if (device.pingable === true || device.answersIcmp === true) return false;
  const hist = Array.isArray(device.latencyHistory) ? device.latencyHistory : [];
  return hist.length > 0 && hist.every((v) => v == null);
}

/** @returns {'good'|'fair'|'poor'|'offline'|'noping'|'none'} */
export function connectionQuality(device) {
  if (!device) return 'none';
  if (!device.online) return 'offline';
  if (isPingBlocked(device)) return 'noping';
  const latency = device.latencyMs;
  const loss = device.lossPct ?? 0;
  if (latency == null) {
    // The device answered ping earlier but every recent ping was lost -> poor (only when we
    // actually have samples; otherwise there is simply no data yet).
    const hist = Array.isArray(device.latencyHistory) ? device.latencyHistory : [];
    return hist.length > 0 && loss >= 10 ? 'poor' : 'none';
  }
  if (latency < 30 && loss < 2) return 'good';
  if (latency < 100 && loss < 10) return 'fair';
  return 'poor';
}

/* ------------------------------------------------------------------------------------------
 * Formatting helpers that are specific to the devices table.
 * ---------------------------------------------------------------------------------------- */

/** Self throughput number: always one decimal ('24.0', '3.0'); null -> '—'. */
export function formatRate(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  return v >= 1000 ? Math.round(v).toString() : v.toFixed(1);
}

/** 'a4:83:e7:1c:2d:01' -> 'a4-83-e7-1c-2d-01' (testids use dashes, PLAN.md conventions). */
export function macDashes(mac) {
  return String(mac ?? '').toLowerCase().replace(/[:]/g, '-');
}

/** Locally-administered (private / randomized) MAC. Prefer the server flag when present. */
export function isPrivateMac(device) {
  if (!device) return false;
  if (typeof device.randomizedMac === 'boolean') return device.randomizedMac;
  const first = parseInt(String(device.mac ?? '').slice(0, 2), 16);
  return Number.isFinite(first) && (first & 0x02) !== 0;
}

export function ipToNumber(ip) {
  if (!ip || typeof ip !== 'string') return Number.MAX_SAFE_INTEGER;
  const parts = ip.split('.');
  if (parts.length !== 4) return Number.MAX_SAFE_INTEGER;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return Number.MAX_SAFE_INTEGER;
    n = n * 256 + v;
  }
  return n;
}

/** Confidence -> human tier used by tooltips (thresholds mirror lib/deviceTypes confidenceLevel). */
export function confidencePercent(c) {
  const v = Number(c);
  if (!Number.isFinite(v)) return 0;
  return Math.round(Math.max(0, Math.min(1, v)) * 100);
}

/* ------------------------------------------------------------------------------------------
 * Sorting. 'default' keeps the server order (PLAN.md §5: gateway, self, IP; offline saved last).
 * ---------------------------------------------------------------------------------------- */

export const SORT_KEYS = [
  { id: 'default', label: 'Smart (default)' },
  { id: 'name', label: 'Name' },
  { id: 'ip', label: 'IP address' },
  { id: 'type', label: 'Device type' },
  { id: 'latency', label: 'Latency' },
  { id: 'lastSeen', label: 'Last seen' }
];

const SORT_IDS = new Set(SORT_KEYS.map((k) => k.id));

export function isSortKey(k) {
  return SORT_IDS.has(k);
}

/**
 * Sort a device list (returns a new array). Ties keep the incoming (server) order, so the
 * sort is stable and calm. Null latencies always sort last regardless of direction.
 * @param {object[]} list
 * @param {string} key   one of SORT_KEYS ids
 * @param {'asc'|'desc'} dir
 * @param {{ nameOf: (d)=>string, typeOf: (d)=>string }} accessors
 */
export function sortDevices(list, key, dir, { nameOf, typeOf }) {
  const arr = list.map((d, i) => ({ d, i }));
  if (key === 'default' || !isSortKey(key)) {
    if (dir === 'desc') arr.reverse();
    return arr.map((x) => x.d);
  }
  const sign = dir === 'desc' ? -1 : 1;
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  const cmp = (a, b) => {
    switch (key) {
      case 'name':
        return sign * collator.compare(nameOf(a.d) || '', nameOf(b.d) || '');
      case 'type':
        return sign * collator.compare(typeOf(a.d) || '', typeOf(b.d) || '');
      case 'ip':
        return sign * (ipToNumber(a.d.ip) - ipToNumber(b.d.ip));
      case 'latency': {
        const la = a.d.online ? a.d.latencyMs : null;
        const lb = b.d.online ? b.d.latencyMs : null;
        if (la == null && lb == null) return 0;
        if (la == null) return 1;
        if (lb == null) return -1;
        return sign * (la - lb);
      }
      case 'lastSeen': {
        // 'asc' = most recently seen first (what people expect from 'last seen').
        const ta = a.d.lastSeen ? Date.parse(a.d.lastSeen) : 0;
        const tb = b.d.lastSeen ? Date.parse(b.d.lastSeen) : 0;
        return sign * (tb - ta);
      }
      default:
        return 0;
    }
  };
  arr.sort((a, b) => cmp(a, b) || a.i - b.i);
  return arr.map((x) => x.d);
}
