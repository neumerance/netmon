// Topology layout engine for the Devices "Map" view (docs/TOPOLOGY.md §3).
//
// Pure ES module: no Vue, no DOM, no Math.random, no Date.now. The same inputs always produce the
// same output (same order, same integer coordinates), so Vue Flow can diff by node id and nothing
// jitters between SSE updates.
//
// Model: Internet -> Gateway -> hubs (access points / mesh nodes / secondary routers / switches) and
// devices. Every non-gateway device hangs off the gateway unless the user re-parented it onto a hub
// ("Connected via"), persisted per MAC as `overrides[mac] = { parentMac, position }`.
//
// Geometry: radial and tiered. Gateway centre = (0,0), internet straight above it. The ring around the
// gateway is cut into sectors (one per gateway-child hub plus one per device type group); each sector's
// items fill concentric rings outward. A final AABB collision pass guarantees no two boxes overlap.

import { CATEGORIES, CATEGORY_TINTS, deviceDisplayName, deviceTypeLabel, deviceIcon } from '../../lib/deviceTypes.js';
import { connectionQuality, ipToNumber, macDashes } from '../devices/deviceUi.js';
// Pure formatting helpers (lib/format.js has no Vue imports either).
import { formatMs, formatPercent, maskIp, normalizeMac } from '../../lib/format.js';

/* ------------------------------------------------------------------------------------------
 * Public constants (exact contract, TOPOLOGY.md §3.1)
 * ---------------------------------------------------------------------------------------- */

export const NODE_TYPES = { internet: 'internet', gateway: 'gateway', hub: 'hub', device: 'device' };
export const EDGE_TYPE = 'link';
export const HUB_CATEGORIES = ['access_point', 'router', 'network_switch'];
export const MAX_NODES = 200; // device + hub nodes rendered; the rest is reported in meta.truncated
export const INTERNET_ID = 'internet';
export const PLACEHOLDER_GATEWAY_ID = 'gateway';

// Box size of each node type in flow px (components render exactly this size) and the edge anchor
// (= icon-tile centre) relative to the node's top-left corner.
export const NODE_SIZES = {
  internet: { w: 240, h: 96, anchor: { x: 120, y: 48 } },
  gateway: { w: 200, h: 128, anchor: { x: 100, y: 32 } },
  hub: { w: 136, h: 104, anchor: { x: 68, y: 26 } },
  device: { w: 112, h: 88, anchor: { x: 56, y: 22 } },
};

// Tint groups used for sectors (keys of TINT_CLASSES in lib/deviceTypes.js), in sector order.
export const GROUP_ORDER = ['computer', 'mobile', 'media', 'iot', 'network', 'unknown'];
export const GROUP_LABELS = {
  computer: 'Computers',
  mobile: 'Phones & tablets',
  media: 'Media',
  iot: 'IoT & printers',
  network: 'Network',
  unknown: 'Unknown',
};

/* ------------------------------------------------------------------------------------------
 * Layout tuning (TOPOLOGY.md §3.3). Internal; exported as LAYOUT for tests / debugging only.
 * ---------------------------------------------------------------------------------------- */

const DEG = Math.PI / 180;
const INTERNET_CENTER = { x: 0, y: -230 };
const WAN_HALF_WEDGE = 32 * DEG; // reserved around straight up for the WAN edge
const SWEEP_START = -Math.PI / 2 + WAN_HALF_WEDGE; // -58deg
const SWEEP = 2 * Math.PI - 2 * WAN_HALF_WEDGE; // 296deg, clockwise (screen y down)
const HUB_ARC = 168; // min arc between hub centres on the hub ring
const R_HUB_MIN = 280;
const R0_WITH_HUBS_OFFSET = 190; // first client ring = R_HUB + 190 when there are hubs
const R0_NO_HUBS = 250;
const RING = 112; // radial distance between client rings
// The canvas is ~1.5:1 landscape: squash the rings into ellipses so the fitted map is not mostly empty height.
const Y_SCALE = 0.7;
const ARC = 128; // min arc distance between client centres on a ring
const PAD = 0.06; // rad between sectors
const COLLISION_GAP = 12; // min gap between two node boxes (6 px inflation per side)
const COLLISION_PASSES = 50;
const GOLDEN_ANGLE = 2.399963;
const COORD_LIMIT = 10000;
const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

export const LAYOUT = Object.freeze({
  INTERNET_CENTER,
  SWEEP_START,
  SWEEP,
  HUB_ARC,
  R_HUB_MIN,
  R0_NO_HUBS,
  RING,
  Y_SCALE,
  ARC,
  PAD,
  COLLISION_GAP,
  COLLISION_PASSES,
});

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/* ------------------------------------------------------------------------------------------
 * Small helpers
 * ---------------------------------------------------------------------------------------- */

/** Lowercase colon MAC or null. Fast path for the wire form; tolerant of dashes / upper case otherwise. */
function normMac(mac) {
  if (typeof mac !== 'string') return null;
  if (MAC_RE.test(mac)) return mac;
  return normalizeMac(mac);
}

function isObj(v) {
  return v !== null && typeof v === 'object';
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Override entry for a MAC, tolerating a null/undefined overrides map. */
function overrideOf(overrides, mac) {
  if (!isObj(overrides) || !mac) return null;
  const o = overrides[mac];
  return isObj(o) ? o : null;
}

/** Valid pinned position from an override, else null. */
function pinnedPosition(override) {
  const p = override?.position;
  if (!isObj(p)) return null;
  const { x, y } = p;
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (Math.abs(x) > COORD_LIMIT || Math.abs(y) > COORD_LIMIT) return null;
  return { x, y };
}

/** Angle normalised into [0, 2pi) measured clockwise from the sweep start (used for ordering). */
function sweepRelative(angle) {
  const t = (angle - SWEEP_START) % (2 * Math.PI);
  return t < 0 ? t + 2 * Math.PI : t;
}

function groupOf(device) {
  return CATEGORY_TINTS[device?.category] ?? 'unknown';
}

function categoryRank(device) {
  const i = CATEGORIES.indexOf(device?.category);
  return i === -1 ? CATEGORIES.length : i;
}

/** Item order within a sector: sub-hubs first, self first, category order, IP numeric, mac. */
function compareItems(a, b) {
  return (
    (isHub(b) ? 1 : 0) - (isHub(a) ? 1 : 0) ||
    (b.isSelf ? 1 : 0) - (a.isSelf ? 1 : 0) ||
    categoryRank(a) - categoryRank(b) ||
    ipToNumber(a.ip) - ipToNumber(b.ip) ||
    (a.mac < b.mac ? -1 : a.mac > b.mac ? 1 : 0)
  );
}

/** Hub order on the hub ring: IP numeric, then mac. */
function compareByIp(a, b) {
  return ipToNumber(a.ip) - ipToNumber(b.ip) || (a.mac < b.mac ? -1 : a.mac > b.mac ? 1 : 0);
}

/** Valid devices (mac normalised) in input order, without duplicates (first occurrence wins). */
function validDevices(devices) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(devices)) return out;
  for (const d of devices) {
    if (!isObj(d)) continue;
    const mac = normMac(d.mac);
    if (!mac || seen.has(mac)) continue;
    seen.add(mac);
    out.push(d.mac === mac ? d : { ...d, mac });
  }
  return out;
}

/** 32-bit FNV-1a hash -> 8 hex chars (deterministic short key). */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/* ------------------------------------------------------------------------------------------
 * Public helpers
 * ---------------------------------------------------------------------------------------- */

/** Access point / mesh node / secondary router / switch that is not the gateway. */
export function isHub(device) {
  return !!device && HUB_CATEGORIES.includes(device.category) && !device.isGateway;
}

/** First device with isGateway in input order, else null. */
export function findGateway(devices) {
  if (!Array.isArray(devices)) return null;
  for (const d of devices) {
    if (isObj(d) && d.isGateway && normMac(d.mac)) return d;
  }
  return null;
}

/** Node ids ARE MACs (lowercase colon form), except INTERNET_ID and PLACEHOLDER_GATEWAY_ID. */
export function nodeIdForMac(mac) {
  return normMac(mac) ?? String(mac ?? '').toLowerCase();
}

/** 'map-node-' + MAC in dash form. */
export function testidForMac(mac) {
  return 'map-node-' + macDashes(mac);
}

/**
 * True if setting `mac`'s parent to `parentMac` would create a cycle (walks override parents).
 * `isHubMac` (optional predicate): only follow links whose parent is a hub present on the network, the
 * same rule as resolveParents and the server's PUT /api/topology validation (stale links through departed
 * devices or former hubs are ignored there, so they must not hide a valid choice here).
 */
export function wouldCreateCycle(mac, parentMac, overrides, isHubMac = null) {
  const self = normMac(mac);
  let cur = normMac(parentMac);
  if (!self || !cur) return false;
  const follows = typeof isHubMac === 'function' ? isHubMac : () => true;
  const visited = new Set();
  while (cur) {
    if (cur === self) return true;
    if (visited.has(cur)) return false; // pre-existing loop that does not include `mac`
    visited.add(cur);
    const next = normMac(overrideOf(overrides, cur)?.parentMac);
    cur = next && follows(next) ? next : null;
  }
  return false;
}

/**
 * Effective parent of every non-gateway device.
 * @returns {Map<string, { parentMac: string|null, source: 'user'|'default'|'fallback' }>}
 *   'user'     override.parentMac points at a present hub (or is null explicitly) and creates no cycle
 *   'default'  no override -> gateway
 *   'fallback' override.parentMac points at a MAC that is missing / not a hub / would cycle -> gateway
 */
export function resolveParents(devices, overrides) {
  const list = validDevices(devices);
  const gateway = findGateway(list);
  const gatewayMac = gateway ? normMac(gateway.mac) : null;
  const hubs = new Map();
  for (const d of list) if (isHub(d)) hubs.set(d.mac, d);

  // Raw requested parent per MAC: undefined = no request, null = gateway, string = some MAC.
  const requested = (mac) => {
    const o = overrideOf(overrides, mac);
    if (!o || !('parentMac' in o)) return undefined;
    if (o.parentMac === null) return null;
    const p = normMac(o.parentMac);
    if (!p) return 'invalid';
    return p === gatewayMac ? null : p;
  };

  // Cycle check over the *requested* hub chain: a hub is on a cycle iff following valid hub requests
  // from it comes back to it. Every node on a cycle falls back, so the result is always a tree.
  const onCycle = (mac) => {
    const visited = new Set([mac]);
    let cur = requested(mac);
    while (typeof cur === 'string' && hubs.has(cur) && cur !== mac) {
      if (visited.has(cur)) return false; // loop further up that does not include `mac`
      visited.add(cur);
      cur = requested(cur);
    }
    return cur === mac;
  };

  const out = new Map();
  for (const d of list) {
    if (d.mac === gatewayMac) continue;
    const req = requested(d.mac);
    if (req === undefined) {
      out.set(d.mac, { parentMac: null, source: 'default' });
    } else if (req === null) {
      out.set(d.mac, { parentMac: null, source: 'user' });
    } else if (req !== 'invalid' && req !== d.mac && hubs.has(req) && !(isHub(d) && onCycle(d.mac))) {
      out.set(d.mac, { parentMac: req, source: 'user' });
    } else {
      out.set(d.mac, { parentMac: null, source: 'fallback' });
    }
  }
  return out;
}

/**
 * Options for the "Connected via" select of `device`:
 * [{ value: null, label: 'Gateway', sublabel: '<gateway display name>', isDefault: true, online },
 *  { value: '<hub mac>', label: '<hub display name>', sublabel: deviceTypeLabel(hub), isDefault: false, online }, ...]
 * Excludes the device itself and its descendants (cycle); for the gateway returns [].
 * Hubs ordered by display name (Intl.Collator, numeric), then mac.
 */
export function hubOptions(device, devices, overrides) {
  if (!device || device.isGateway) return [];
  const mac = normMac(device.mac);
  const list = validDevices(devices);
  const gateway = findGateway(list);
  const options = [
    {
      value: null,
      label: 'Gateway',
      sublabel: gateway ? deviceDisplayName(gateway) : null,
      isDefault: true,
      online: gateway ? !!gateway.online : null,
    },
  ];
  const hubMacs = new Set(list.filter(isHub).map((h) => h.mac));
  const isPresentHub = (m) => hubMacs.has(m);
  const hubs = list
    .filter((h) => isHub(h) && h.mac !== mac && !wouldCreateCycle(mac, h.mac, overrides, isPresentHub))
    .map((h) => ({ h, name: deviceDisplayName(h) }))
    .sort((a, b) => collator.compare(a.name, b.name) || (a.h.mac < b.h.mac ? -1 : a.h.mac > b.h.mac ? 1 : 0));
  for (const { h, name } of hubs) {
    options.push({ value: h.mac, label: name, sublabel: deviceTypeLabel(h), isDefault: false, online: !!h.online });
  }
  return options;
}

/** WAN edge quality from InternetStatus: 'down' | 'unknown' | 'good' (<50 ms) | 'fair' (<150) | 'poor'. */
export function wanQuality(internet) {
  const status = internet?.status;
  if (status === 'down') return 'down';
  if (status !== 'up') return 'unknown';
  const ms = numOrNull(internet.latencyMs);
  if (ms === null || ms < 50) return 'good'; // up without an RTT sample still means reachable
  if (ms < 150) return 'fair';
  return 'poor';
}

/**
 * Truncate to MAX_NODES non-gateway nodes: hubs first, then other devices in input order.
 * @returns {{ gateway: object|null, kept: object[], truncated: number }} kept excludes the gateway, input order.
 */
function selectDevices(devices) {
  const list = validDevices(devices);
  const gateway = findGateway(list);
  const others = gateway ? list.filter((d) => d.mac !== gateway.mac) : list;
  if (others.length <= MAX_NODES) return { gateway, all: list, kept: others, truncated: 0 };
  const keep = new Set();
  for (const d of others) if (keep.size < MAX_NODES && isHub(d)) keep.add(d.mac);
  for (const d of others) if (keep.size < MAX_NODES && !isHub(d)) keep.add(d.mac);
  const kept = others.filter((d) => keep.has(d.mac));
  return { gateway, all: list, kept, truncated: others.length - kept.length };
}

function normGroupBy(groupBy) {
  return groupBy === 'flat' ? 'flat' : 'type';
}

/**
 * Structural key: changes iff node set, parents, groups, hub-ness, pinned positions or groupBy change.
 * Online/offline flips, latency, names and highlight do NOT change it. (Category and IP are part of it
 * because they decide sector membership and ordering, i.e. positions.)
 */
export function layoutKey(devices, { overrides = {}, groupBy = 'type' } = {}) {
  const { gateway, kept } = selectDevices(devices);
  const gwMac = gateway ? gateway.mac : null;
  const parents = resolveParents(gateway ? [gateway, ...kept] : kept, overrides);
  const parts = [normGroupBy(groupBy), gwMac ?? '-'];
  const sorted = [...kept].sort((a, b) => (a.mac < b.mac ? -1 : 1));
  for (const d of sorted) {
    const pin = pinnedPosition(overrideOf(overrides, d.mac));
    parts.push(
      [
        d.mac,
        isHub(d) ? 'h' : 'd',
        d.category ?? '',
        d.isSelf ? 's' : '',
        d.ip ?? '',
        parents.get(d.mac)?.parentMac ?? '',
        pin ? `${Math.round(pin.x)},${Math.round(pin.y)}` : '',
      ].join('|'),
    );
  }
  return `${kept.length}-${fnv1a(parts.join(';'))}`;
}

/**
 * Pick the drop target for a dragged node: the hub/gateway node whose box contains the dragged node's
 * anchor point; ties -> smallest centre distance, then id. Returns node id or null.
 * `dragged` / `candidates` are { id, type, position:{x,y} } (sizes from NODE_SIZES). Never returns the
 * dragged node itself or one of `excludeIds` (its descendants).
 */
export function pickDropTarget(dragged, candidates, { excludeIds = [] } = {}) {
  if (!dragged || !dragged.position || !Array.isArray(candidates)) return null;
  const dSize = NODE_SIZES[dragged.type] ?? NODE_SIZES.device;
  const ax = dragged.position.x + dSize.anchor.x;
  const ay = dragged.position.y + dSize.anchor.y;
  if (!Number.isFinite(ax) || !Number.isFinite(ay)) return null;
  const exclude = new Set(excludeIds);
  exclude.add(dragged.id);
  let best = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    if (!c || !c.position || exclude.has(c.id)) continue;
    if (c.type !== NODE_TYPES.hub && c.type !== NODE_TYPES.gateway) continue;
    const s = NODE_SIZES[c.type];
    const { x, y } = c.position;
    if (ax < x || ax > x + s.w || ay < y || ay > y + s.h) continue;
    const dist = Math.hypot(ax - (x + s.w / 2), ay - (y + s.h / 2));
    if (dist < bestDist || (dist === bestDist && String(c.id) < String(best))) {
      best = c.id;
      bestDist = dist;
    }
  }
  return best;
}

/* ------------------------------------------------------------------------------------------
 * Sector angles (§3.3 step 7)
 * ---------------------------------------------------------------------------------------- */

/**
 * Distribute the usable sweep over sectors. Each sector has { weight, min }. Raw angle proportional to
 * weight, raised to its minimum; if the total exceeds the available sweep, the part above each minimum
 * is scaled down proportionally (or, if the minimums alone do not fit, everything is scaled equally).
 */
function sectorAngles(sectors) {
  const n = sectors.length;
  if (n === 0) return [];
  const avail = SWEEP - PAD * n;
  const sumW = sectors.reduce((s, x) => s + x.weight, 0);
  const theta = sectors.map((x) => Math.max((avail * x.weight) / sumW, x.min));
  const total = theta.reduce((s, t) => s + t, 0);
  if (total <= avail + 1e-9) return theta;
  const sumMin = sectors.reduce((s, x) => s + x.min, 0);
  if (sumMin >= avail) return sectors.map((x) => (x.min * avail) / sumMin);
  const surplus = total - sumMin;
  const factor = (avail - sumMin) / surplus;
  return theta.map((t, i) => sectors[i].min + (t - sectors[i].min) * factor);
}

/* ------------------------------------------------------------------------------------------
 * Collision pass (§3.3 step 11)
 * ---------------------------------------------------------------------------------------- */

/**
 * Resolve AABB overlaps in place. `items` = [{ cx, cy, w, h, fixed }] in output order.
 * Pairs are visited in output order; an overlapping pair is pushed apart along the centre-to-centre
 * vector by exactly the distance that separates the (gap-inflated) boxes along that vector.
 */
function resolveCollisions(items) {
  const n = items.length;
  for (let pass = 0; pass < COLLISION_PASSES; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      const a = items[i];
      for (let j = i + 1; j < n; j++) {
        const b = items[j];
        if (a.fixed && b.fixed) continue;
        const ox = (a.w + b.w) / 2 + COLLISION_GAP - Math.abs(b.cx - a.cx);
        if (ox <= 0) continue;
        const oy = (a.h + b.h) / 2 + COLLISION_GAP - Math.abs(b.cy - a.cy);
        if (oy <= 0) continue;
        let dx = b.cx - a.cx;
        let dy = b.cy - a.cy;
        let len = Math.hypot(dx, dy);
        if (len < 1e-6) {
          const ang = j * GOLDEN_ANGLE;
          dx = Math.cos(ang);
          dy = Math.sin(ang);
          len = 1;
        }
        const ux = dx / len;
        const uy = dy / len;
        // Distance along u that clears one axis (whichever needs less), plus a hair of slack.
        const tx = Math.abs(ux) > 1e-9 ? ox / Math.abs(ux) : Infinity;
        const ty = Math.abs(uy) > 1e-9 ? oy / Math.abs(uy) : Infinity;
        const t = Math.min(tx, ty) + 0.01;
        if (a.fixed) {
          b.cx += ux * t;
          b.cy += uy * t;
        } else if (b.fixed) {
          a.cx -= ux * t;
          a.cy -= uy * t;
        } else {
          a.cx -= (ux * t) / 2;
          a.cy -= (uy * t) / 2;
          b.cx += (ux * t) / 2;
          b.cy += (uy * t) / 2;
        }
        moved = true;
      }
    }
    if (!moved) return pass + 1;
  }
  return COLLISION_PASSES;
}

/* ------------------------------------------------------------------------------------------
 * Node / edge data
 * ---------------------------------------------------------------------------------------- */

/** connectionQuality, except this computer (not pinged, but online) reads 'self'. */
function nodeQuality(d) {
  return d.isSelf && d.online ? 'self' : connectionQuality(d);
}

/** Edge quality: child's node quality ('noping' = online but ignores ping; LinkEdge draws it as online). */
function edgeQuality(d) {
  return nodeQuality(d);
}

function lanLabel(d) {
  if (!d.online) return 'Offline';
  if (d.isSelf) return 'This computer';
  const ms = numOrNull(d.latencyMs);
  if (ms === null) return connectionQuality(d) === 'noping' ? 'No ping reply' : 'No data yet';
  const loss = numOrNull(d.lossPct);
  return loss === null ? formatMs(ms) : `${formatMs(ms)} · ${formatPercent(loss)} loss`;
}

function wanLabel(internet) {
  const status = internet?.status;
  if (status === 'down') return 'Internet down';
  if (status !== 'up') return 'Checking…';
  const ms = numOrNull(internet.latencyMs);
  return ms === null ? 'Online' : formatMs(ms);
}

/** Data of the internet node (also used by TopologyMap to patch speed / ISP updates in without a relayout). */
export function internetNodeData(internet, isp, speed) {
  return internetData(internet, isp, speed);
}

function internetData(internet, isp, speed) {
  const progress = isObj(speed?.progress) ? speed.progress : null;
  const last = isObj(speed?.last) ? speed.last : null;
  return {
    status: internet?.status === 'up' || internet?.status === 'down' ? internet.status : 'unknown',
    latencyMs: numOrNull(internet?.latencyMs),
    since: internet?.since ?? null,
    target: internet?.target ?? null,
    isp: isObj(isp)
      ? {
          name: isp.name ?? null,
          asn: isp.asn ?? null,
          ip: isp.ip ?? null,
          ipMasked: isp.ip ? maskIp(isp.ip) : null,
          city: isp.city ?? null,
          country: isp.country ?? null,
          colo: isp.colo ?? null,
        }
      : null,
    speed: {
      running: !!speed?.running,
      phase: progress?.phase ?? null,
      percent: numOrNull(progress?.percent),
      currentMbps: numOrNull(progress?.currentMbps),
      downloadMbps: numOrNull(last?.downloadMbps),
      uploadMbps: numOrNull(last?.uploadMbps),
      lastAt: last?.at ?? null,
    },
  };
}

/* ------------------------------------------------------------------------------------------
 * Main entry
 * ---------------------------------------------------------------------------------------- */

/**
 * Build the Vue Flow graph.
 * @returns {{ nodes: object[], edges: object[], meta: object }} see TOPOLOGY.md §3.2
 */
export function buildGraph(
  devices,
  {
    isp = null,
    internet = null,
    speed = null,
    network = null,
    overrides = {},
    highlight = null,
    groupBy = 'type',
    reducedMotion = false,
    maxAnimatedEdges = 60,
  } = {},
) {
  const mode = normGroupBy(groupBy);
  const hl = highlight instanceof Set ? highlight : null;
  const { gateway, all, kept, truncated } = selectDevices(devices);
  const gatewayId = gateway ? gateway.mac : PLACEHOLDER_GATEWAY_ID;
  const parents = resolveParents(gateway ? [gateway, ...kept] : kept, overrides);
  const byMac = new Map(kept.map((d) => [d.mac, d]));

  // Children per parent (null key = gateway), input order for now.
  const children = new Map([[null, []]]);
  for (const d of kept) {
    const p = parents.get(d.mac)?.parentMac ?? null;
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(d);
  }
  const childrenOf = (mac) => children.get(mac) ?? [];

  /* ---- 1. Sectors ---------------------------------------------------------------------- */
  const gwHubs = childrenOf(null).filter(isHub).sort(compareByIp);
  const gwDevices = childrenOf(null).filter((d) => !isHub(d));

  const groupSectors = [];
  if (mode === 'flat') {
    if (gwDevices.length) groupSectors.push({ kind: 'group', key: 'all', items: gwDevices });
  } else {
    for (const g of GROUP_ORDER) {
      const items = gwDevices.filter((d) => groupOf(d) === g);
      if (items.length) groupSectors.push({ kind: 'group', key: g, items });
    }
  }
  // The hub's whole subtree, flattened (each node keeps its real parent for its edge).
  const subtreeOf = (mac) => {
    const items = [];
    const stack = [...childrenOf(mac)];
    const seen = new Set([mac]);
    while (stack.length) {
      const d = stack.shift();
      if (seen.has(d.mac)) continue;
      seen.add(d.mac);
      items.push(d);
      if (isHub(d)) stack.push(...childrenOf(d.mac));
    }
    return items;
  };
  const hubSectors = gwHubs.map((h) => {
    // Clusters: the hub's own clients, then one per sub-hub (the sub-hub + its subtree). Each cluster gets its
    // own slice of the sector, so a mesh node's clients never mix with its parent AP's clients.
    const direct = childrenOf(h.mac);
    const clients = direct.filter((d) => !isHub(d)).sort(compareItems);
    const clusters = [];
    if (clients.length) clusters.push({ hub: null, items: clients });
    for (const sh of direct.filter(isHub).sort(compareByIp)) {
      clusters.push({ hub: sh, items: subtreeOf(sh.mac).sort(compareItems) });
    }
    const items = clusters.flatMap((c) => (c.hub ? [c.hub, ...c.items] : c.items));
    return { kind: 'hub', key: h.mac, hub: h, items, clusters };
  });
  for (const s of groupSectors) s.items.sort(compareItems);

  // Round-robin interleave g0, h0, g1, h1, ... then leftovers.
  const sectors = [];
  for (let i = 0; i < Math.max(groupSectors.length, hubSectors.length); i++) {
    if (i < groupSectors.length) sectors.push(groupSectors[i]);
    if (i < hubSectors.length) sectors.push(hubSectors[i]);
  }

  /* ---- 2. Radii and angles ------------------------------------------------------------- */
  const H = hubSectors.length;
  const R_HUB = Math.max(R_HUB_MIN, Math.ceil((H * HUB_ARC) / SWEEP));
  // Only hub sectors start their clients outside the hub ring; type groups stay on the inner ring.
  const R0_HUB = R_HUB + R0_WITH_HUBS_OFFSET;
  const sectorR0 = (s) => (s.kind === 'hub' ? R0_HUB : R0_NO_HUBS);
  for (const s of sectors) {
    const clientMin = (Math.min(s.items.length, 3) * ARC) / sectorR0(s);
    s.weight = Math.max(1, s.items.length) + (s.kind === 'hub' ? 1 : 0);
    // Hub sectors also reserve room for their first clients so a busy AP does not collapse.
    s.min = s.kind === 'hub' ? Math.max(HUB_ARC / R_HUB, clientMin) : clientMin;
  }
  const thetas = sectorAngles(sectors);

  /* ---- 3. Auto placement (centres) ----------------------------------------------------- */
  // place: mac -> { cx, cy, angle, radius, order }
  const place = new Map();
  const deviceOrder = []; // device macs in fill order (sector, ring, angle)
  const put = (d, a, R) => {
    place.set(d.mac, { cx: R * Math.cos(a), cy: R * Math.sin(a) * Y_SCALE, angle: a, radius: R });
    if (!isHub(d)) deviceOrder.push(d.mac);
  };
  // Fill `items` onto concentric rings (from r0 outward) inside the angular slice [start, start + theta].
  const fillRings = (items, start, theta, r0) => {
    let idx = 0;
    for (let k = 0; idx < items.length; k++) {
      const R = r0 + k * RING;
      const cap = Math.max(1, Math.floor((theta * R) / ARC));
      const nk = Math.min(cap, items.length - idx);
      const stagger = k % 2 === 1 ? (0.5 * ARC) / R : 0;
      const margin = Math.min(theta / 2, (0.5 * ARC) / R);
      for (let j = 0; j < nk; j++, idx++) {
        let a = start + (theta * (j + 0.5)) / nk + stagger;
        a = Math.min(Math.max(a, start + margin), start + theta - margin);
        put(items[idx], a, R);
      }
    }
  };
  let cursor = SWEEP_START + PAD / 2;
  sectors.forEach((s, si) => {
    const theta = thetas[si];
    const start = cursor;
    cursor += theta + PAD;
    if (s.kind !== 'hub') {
      fillRings(s.items, start, theta, R0_NO_HUBS);
      return;
    }
    const a = start + theta / 2;
    place.set(s.hub.mac, { cx: R_HUB * Math.cos(a), cy: R_HUB * Math.sin(a) * Y_SCALE, angle: a, radius: R_HUB });
    const total = s.clusters.reduce((n, c) => n + c.items.length + (c.hub ? 1 : 0), 0);
    let sub = start;
    for (const c of s.clusters) {
      const th = total > 0 ? (theta * (c.items.length + (c.hub ? 1 : 0))) / total : theta;
      if (c.hub) {
        put(c.hub, sub + th / 2, R0_HUB);
        fillRings(c.items, sub, th, R0_HUB + RING);
      } else {
        fillRings(c.items, sub, th, R0_HUB);
      }
      sub += th;
    }
  });

  /* ---- 4. Output order ----------------------------------------------------------------- */
  const hubMacs = kept
    .filter(isHub)
    .map((d) => d.mac)
    .sort((a, b) => {
      const pa = place.get(a);
      const pb = place.get(b);
      return sweepRelative(pa.angle) - sweepRelative(pb.angle) || pa.radius - pb.radius || (a < b ? -1 : 1);
    });

  /* ---- 5. Pinned + collisions ---------------------------------------------------------- */
  const gwSize = NODE_SIZES.gateway;
  const inSize = NODE_SIZES.internet;
  const boxes = [
    { id: INTERNET_ID, cx: INTERNET_CENTER.x, cy: INTERNET_CENTER.y, w: inSize.w, h: inSize.h, fixed: true },
    { id: gatewayId, cx: 0, cy: 0, w: gwSize.w, h: gwSize.h, fixed: true },
  ];
  const pinned = new Set();
  const addBox = (mac, type) => {
    const size = NODE_SIZES[type];
    const pin = pinnedPosition(overrideOf(overrides, mac));
    const p = place.get(mac);
    if (pin) {
      pinned.add(mac);
      const x = Math.round(pin.x);
      const y = Math.round(pin.y);
      boxes.push({ id: mac, cx: x + size.w / 2, cy: y + size.h / 2, w: size.w, h: size.h, fixed: true, pin: { x, y } });
    } else {
      boxes.push({ id: mac, cx: p.cx, cy: p.cy, w: size.w, h: size.h, fixed: false });
    }
  };
  for (const mac of hubMacs) addBox(mac, NODE_TYPES.hub);
  for (const mac of deviceOrder) addBox(mac, NODE_TYPES.device);
  resolveCollisions(boxes);

  const topLeft = new Map();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    const x = b.pin ? b.pin.x : Math.round(b.cx - b.w / 2);
    const y = b.pin ? b.pin.y : Math.round(b.cy - b.h / 2);
    topLeft.set(b.id, { x, y });
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + b.w);
    maxY = Math.max(maxY, y + b.h);
  }

  /* ---- 6. Nodes ------------------------------------------------------------------------ */
  const dimmedOf = (mac) => hl !== null && !hl.has(mac);
  // Hubs on the path from a highlighted device up to the gateway: still "dimmed" (not a match) but drawn as
  // context, so the match does not look cut off from the network.
  const contextIds = new Set();
  if (hl !== null) {
    for (const mac of hl) {
      let p = parents.get(mac)?.parentMac ?? null;
      let guard = 0;
      while (p && !contextIds.has(p) && guard++ < 64) {
        if (!hl.has(p)) contextIds.add(p);
        p = parents.get(p)?.parentMac ?? null;
      }
    }
  }
  const contextOf = (mac) => contextIds.has(mac);
  const highlightedOf = (mac) => hl !== null && hl.has(mac);
  const nodeBase = (id, type, data, { draggable = true, zIndex = 0 } = {}) => ({
    id,
    type,
    position: topLeft.get(id),
    data: { kind: type, anchor: { ...NODE_SIZES[type].anchor }, ...data },
    draggable,
    selectable: false,
    connectable: false,
    focusable: false,
    zIndex,
  });

  const nodes = [];
  nodes.push(
    nodeBase(
      INTERNET_ID,
      NODE_TYPES.internet,
      { testid: 'map-node-internet', dimmed: false, highlighted: false, ...internetData(internet, isp, speed) },
      { draggable: false },
    ),
  );

  let onlineAll = 0;
  for (const d of all) if (d.online) onlineAll++;
  const counts = { online: onlineAll, offline: all.length - onlineAll, total: all.length };
  nodes.push(
    nodeBase(
      gatewayId,
      NODE_TYPES.gateway,
      {
        testid: 'map-node-gateway',
        dimmed: false,
        highlighted: gateway ? highlightedOf(gateway.mac) : false,
        mac: gateway ? gateway.mac : null,
        device: gateway ?? null,
        placeholder: !gateway,
        name: gateway ? deviceDisplayName(gateway) : 'Gateway',
        typeLabel: gateway ? deviceTypeLabel(gateway) : 'Router (not detected)',
        ip: gateway?.ip ?? network?.gateway ?? null,
        online: gateway ? !!gateway.online : null,
        quality: gateway ? nodeQuality(gateway) : 'none',
        latencyMs: gateway ? numOrNull(gateway.latencyMs) : null,
        counts,
        clientCount: childrenOf(null).length,
      },
      { draggable: false, zIndex: 2 },
    ),
  );

  const common = (d) => {
    const pr = parents.get(d.mac) ?? { parentMac: null, source: 'default' };
    return {
      testid: testidForMac(d.mac),
      dimmed: dimmedOf(d.mac),
      context: contextOf(d.mac),
      highlighted: highlightedOf(d.mac),
      mac: d.mac,
      device: d,
      name: deviceDisplayName(d),
      typeLabel: deviceTypeLabel(d),
      ip: d.ip ?? null,
      category: d.category ?? 'unknown',
      group: groupOf(d),
      icon: deviceIcon(d),
      online: !!d.online,
      quality: nodeQuality(d),
      latencyMs: numOrNull(d.latencyMs),
      isSelf: !!d.isSelf,
      saved: !!d.saved,
      parentMac: pr.parentMac,
      parentSource: pr.source,
      pinned: pinned.has(d.mac),
    };
  };
  for (const mac of hubMacs) {
    const d = byMac.get(mac);
    nodes.push(nodeBase(mac, NODE_TYPES.hub, { ...common(d), clientCount: childrenOf(mac).length }, { zIndex: 1 }));
  }
  for (const mac of deviceOrder) {
    nodes.push(nodeBase(mac, NODE_TYPES.device, common(byMac.get(mac))));
  }

  /* ---- 7. Edges ------------------------------------------------------------------------ */
  const edges = [];
  const wq = wanQuality(internet);
  edges.push({
    id: 'e-internet',
    type: EDGE_TYPE,
    source: INTERNET_ID,
    target: gatewayId,
    sourceHandle: 'out',
    targetHandle: 'in',
    data: {
      kind: 'wan',
      mac: null,
      testid: 'map-edge-internet',
      quality: wq,
      online: internet?.status === 'up',
      latencyMs: numOrNull(internet?.latencyMs),
      jitterMs: null,
      lossPct: null,
      label: wanLabel(internet),
      assumed: false,
      dimmed: false,
      animated: false,
    },
  });
  const childEdge = (mac, kind) => {
    const d = byMac.get(mac);
    const pr = parents.get(mac) ?? { parentMac: null, source: 'default' };
    // Parent hub offline while the child still answers: the user-asserted path is doubtful; draw it as an
    // assumed (dashed, still) link instead of a healthy flowing one.
    const parentDev = pr.parentMac ? byMac.get(pr.parentMac) : null;
    const viaOfflineParent = !!parentDev && !parentDev.online && !!d.online;
    return {
      id: 'e-' + mac,
      type: EDGE_TYPE,
      source: pr.parentMac ?? gatewayId,
      target: mac,
      sourceHandle: 'out',
      targetHandle: 'in',
      data: {
        kind,
        mac,
        testid: 'map-edge-' + macDashes(mac),
        quality: edgeQuality(d),
        online: !!d.online,
        latencyMs: numOrNull(d.latencyMs),
        jitterMs: numOrNull(d.jitterMs),
        lossPct: numOrNull(d.lossPct),
        label: lanLabel(d),
        assumed: pr.source !== 'user',
        viaOfflineParent,
        dimmed: dimmedOf(mac),
        context: contextOf(mac),
        animated: false,
      },
    };
  };
  for (const mac of hubMacs) edges.push(childEdge(mac, 'uplink'));
  for (const mac of deviceOrder) edges.push(childEdge(mac, 'lan'));

  const STILL = new Set(['offline', 'none', 'down', 'unknown']);
  let budget = Math.max(0, Math.floor(Number(maxAnimatedEdges) || 0));
  for (const e of edges) {
    const want = !reducedMotion && e.data.online && !STILL.has(e.data.quality) && !e.data.dimmed && !e.data.viaOfflineParent;
    if (want && budget > 0) {
      e.data.animated = true;
      budget--;
    }
  }

  /* ---- 8. Meta ------------------------------------------------------------------------- */
  let onlineNodes = 0;
  for (const d of kept) if (d.online) onlineNodes++;
  const meta = {
    layoutKey: layoutKey(devices, { overrides, groupBy: mode }),
    center: { x: 0, y: 0 },
    bounds: { minX, minY, maxX, maxY },
    gatewayId,
    hubIds: hubMacs.slice(),
    counts: {
      devices: deviceOrder.length,
      hubs: hubMacs.length,
      online: onlineNodes,
      offline: kept.length - onlineNodes,
      pinned: pinned.size,
    },
    truncated,
    sectors: sectors.map((s, i) => ({
      kind: s.kind,
      key: s.key,
      label: s.kind === 'hub' ? deviceDisplayName(s.hub) : (GROUP_LABELS[s.key] ?? 'Devices'),
      items: s.items.map((d) => d.mac),
      theta: thetas[i],
    })),
  };

  return { nodes, edges, meta };
}

/**
 * Descendant node ids of `mac` in a built graph (for pickDropTarget's excludeIds). Walks edges.
 * @param {{ edges: object[] }} graph
 */
export function descendantIds(graph, mac) {
  const id = nodeIdForMac(mac);
  const kids = new Map();
  for (const e of graph?.edges ?? []) {
    if (!kids.has(e.source)) kids.set(e.source, []);
    kids.get(e.source).push(e.target);
  }
  const out = [];
  const seen = new Set([id]);
  const stack = [...(kids.get(id) ?? [])];
  while (stack.length) {
    const c = stack.pop();
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
    stack.push(...(kids.get(c) ?? []));
  }
  return out;
}
