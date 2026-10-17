// Topology overrides: the user's "Connected via" choice and pinned map position per device MAC
// (docs/TOPOLOGY.md §7).
//
// Persistence lives in its own document <dataDir>/topology.json so store.js (whose sanitizeDoc drops
// unknown keys) needs no change. Same write discipline as core/store.js:
//   - debounced 500 ms, atomic + durable: write topology.json.tmp (mode 0600), fsync, keep the previous
//     good file as topology.json.bak, rename over topology.json, fsync the directory;
//   - load(): missing file -> deep copy of `defaults` (nothing is written until something changes);
//     corrupt file -> renamed to topology.json.corrupt-<ts>, then topology.json.bak if usable, else defaults;
//   - flush() writes synchronously when there are unsaved changes (used on shutdown);
//   - every getter returns a deep copy.
//
// Overrides that reference MACs which later disappear are kept: the client falls back to the gateway
// and the device re-attaches when it returns. Forgetting a device that has left the network
// (DELETE /api/devices/:mac on an offline entry) drops its own override (routes/api.js).
//
// Node built-ins only. Every store method is a closure (no `this`), so methods can be passed unbound.

import fs from 'node:fs';
import path from 'node:path';

export const HUB_CATEGORIES = ['access_point', 'router', 'network_switch'];
export const COORD_LIMIT = 10000;
export const MAX_OVERRIDES = 1000;
export const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
export const RESET_SCOPES = ['positions', 'all'];

/** Mock mode defaults: phones and the TV are "Connected via" the Deco M5 mesh node (mock/devices.js). */
export const MOCK_DEFAULT_OVERRIDES = {
  '5a:1f:3e:8c:44:04': { parentMac: '50:c7:bf:3d:7e:06', position: null }, // Jon's iPhone  -> Deco M5
  '3c:28:6d:a1:b2:05': { parentMac: '50:c7:bf:3d:7e:06', position: null }, // Pixel 8       -> Deco M5
  'a8:23:fe:44:19:07': { parentMac: '50:c7:bf:3d:7e:06', position: null }, // LG TV         -> Deco M5
};

const TOPOLOGY_VERSION = 1;
const WRITE_DEBOUNCE_MS = 500;
const EPOCH_ISO = new Date(0).toISOString();

const MSG = {
  body: 'Body must be a JSON object',
  nothing: 'Nothing to update',
  badMac: 'Invalid MAC address',
  self: 'A device cannot connect through itself',
  gateway: 'The gateway cannot be re-parented',
  notHub: 'Not an access point, mesh node, switch or router on this network',
  cycle: 'That would create a loop',
  position: 'Position must be finite numbers within ±10000',
  gatewayPosition: 'The gateway cannot be moved',
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

// ------------------------------------------------------------------------------------------ helpers

/**
 * Local MAC normalizer (same semantics as routes/api.js parseMac + net/sys.js normalizeMac, duplicated
 * on purpose so core does not depend on routes): accepts colons, dashes, url-encoded colons, Cisco dotted
 * form, bare 12 hex digits, any case, unpadded octets. Returns lowercase colon form or null.
 */
export function normalizeMacInput(input) {
  if (typeof input !== 'string') return null;
  let v = input.trim();
  try { v = decodeURIComponent(v); } catch { /* keep as-is */ }
  v = v.trim().toLowerCase().replace(/%3a/g, ':');
  if (!v) return null;
  let parts;
  if (/^[0-9a-f]{1,2}([:-][0-9a-f]{1,2}){5}$/.test(v)) parts = v.split(/[:-]/);
  else if (/^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/.test(v)) parts = v.replace(/\./g, '').match(/../g);
  else if (/^[0-9a-f]{12}$/.test(v)) parts = v.match(/../g);
  else return null;
  const mac = parts.map((o) => o.padStart(2, '0')).join(':');
  return MAC_RE.test(mac) ? mac : null;
}

export function isHubDevice(d) {
  return Boolean(d && HUB_CATEGORIES.includes(d.category) && !d.isGateway);
}

const round1 = (n) => Math.round(n * 10) / 10;
const validCoord = (n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= COORD_LIMIT;

/** `{x,y}` -> rounded copy, `null` -> null, anything else -> undefined (invalid). */
function parsePosition(p) {
  if (p === null) return null;
  if (!isPlainObject(p) || !validCoord(p.x) || !validCoord(p.y)) return undefined;
  // `+ 0` turns -0 into 0 so the JSON is stable.
  return { x: round1(p.x) + 0, y: round1(p.y) + 0 };
}

const validIso = (s) => typeof s === 'string' && s.length <= 40 && Number.isFinite(Date.parse(s));

/** Newest `MAX_OVERRIDES` entries (by updatedAt, ties by MAC) — mutates `map`; never drops `keepMac`. */
function enforceCap(map, keepMac = null) {
  const macs = Object.keys(map);
  if (macs.length <= MAX_OVERRIDES) return;
  const victims = macs
    .filter((m) => m !== keepMac)
    .sort((a, b) => (Date.parse(map[a].updatedAt) - Date.parse(map[b].updatedAt)) || (a < b ? -1 : a > b ? 1 : 0));
  for (const m of victims.slice(0, macs.length - MAX_OVERRIDES)) delete map[m];
}

/**
 * True if setting `mac`'s parent to `parentMac` would create a cycle, walking the *override* parents
 * (the default parent is the gateway, which is the root and can never be part of a loop).
 *
 * `isHubMac` (optional predicate): when given, the walk only follows links whose parent is a hub that
 * is present on the network: the same rule the map uses to resolve effective parents (web layout.js
 * resolveParents). A stale override pointing through a departed device or a former hub is ignored there,
 * so it must not produce a "loop" error here either. Without it (on-disk sanitizing) every raw link is
 * followed.
 */
export function wouldCreateCycle(mac, parentMac, overrides, isHubMac = null) {
  if (parentMac == null) return false;
  if (parentMac === mac) return true;
  const map = isPlainObject(overrides) ? overrides : {};
  const follows = typeof isHubMac === 'function' ? isHubMac : () => true;
  const seen = new Set();
  let cur = parentMac;
  while (cur != null) {
    if (cur === mac) return true;
    if (seen.has(cur)) return false; // pre-existing loop not involving `mac`
    seen.add(cur);
    const next = map[cur]?.parentMac;
    cur = typeof next === 'string' && follows(next) ? next : null;
  }
  return false;
}

/**
 * Drop invalid keys/values and return `{ [mac]: Override }`.
 * Keys and parent MACs are normalized; positions are rounded to 1 decimal; a missing/invalid updatedAt
 * becomes `now` (or epoch for stale on-disk data, see `fallbackUpdatedAt`); entries with neither a parent
 * nor a position are dropped; existing loops are broken deterministically (MAC order) by clearing the
 * parent of the entry that closes them; at most MAX_OVERRIDES newest entries are kept.
 */
export function sanitizeOverrides(raw, { fallbackUpdatedAt = new Date().toISOString() } = {}) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  for (const [key, v] of Object.entries(raw)) {
    const mac = normalizeMacInput(key);
    if (!mac || !isPlainObject(v)) continue;
    let parentMac = null;
    if (typeof v.parentMac === 'string') {
      const p = normalizeMacInput(v.parentMac);
      if (p && p !== mac) parentMac = p;
    }
    const position = parsePosition(v.position ?? null) ?? null;
    if (parentMac === null && position === null) continue;
    const updatedAt = validIso(v.updatedAt) ? new Date(v.updatedAt).toISOString() : fallbackUpdatedAt;
    // Two raw keys may normalize to the same MAC: keep the newer one.
    if (out[mac] && Date.parse(out[mac].updatedAt) >= Date.parse(updatedAt)) continue;
    out[mac] = { parentMac, position, updatedAt };
  }
  // Break pre-existing loops (deterministic: MAC order).
  for (const mac of Object.keys(out).sort()) {
    const o = out[mac];
    if (o.parentMac && wouldCreateCycle(mac, o.parentMac, out)) {
      o.parentMac = null;
      if (o.position === null) delete out[mac];
    }
  }
  enforceCap(out);
  return out;
}

/** SSE `topology` event payload (and the snapshot's `topology` key): `{ overrides }`. */
export function buildTopologyPayload(overrides) {
  return { overrides: clone(isPlainObject(overrides) ? overrides : {}) };
}

// --------------------------------------------------------------------------------------- validation

/**
 * Validate a PUT body for `mac` (already normalized by the route).
 * ctx = { devices: Device[] (state.getDevices()), overrides, known: boolean (devices.has(mac) || store.getSaved(mac)) }
 * -> { ok: true, value: { parentMac?: string|null, position?: {x,y}|null } }
 *  | { ok: false, status: 400|404, errors: { [field]: msg } }
 */
export function validateTopologyPatch(mac, body, ctx = {}) {
  const { devices = [], overrides = {}, known = false } = ctx;
  if (!known) return { ok: false, status: 404, errors: { mac: 'Device not found' } };
  if (!isPlainObject(body)) return { ok: false, status: 400, errors: { _: MSG.body } };
  const hasParent = Object.prototype.hasOwnProperty.call(body, 'parentMac') && body.parentMac !== undefined;
  const hasPosition = Object.prototype.hasOwnProperty.call(body, 'position') && body.position !== undefined;
  if (!hasParent && !hasPosition) return { ok: false, status: 400, errors: { _: MSG.nothing } };

  const list = Array.isArray(devices) ? devices : [];
  const errors = {};
  const value = {};
  const target = list.find((d) => d?.mac === mac) ?? null;
  const hubMacs = new Set(list.filter(isHubDevice).map((d) => d.mac));
  const isPresentHub = (m) => hubMacs.has(m);

  if (hasParent) {
    const gateway = list.find((d) => d?.isGateway) ?? null;
    if (body.parentMac === null || body.parentMac === '') {
      value.parentMac = null;
    } else {
      const parentMac = normalizeMacInput(body.parentMac);
      if (!parentMac) errors.parentMac = MSG.badMac;
      else if (parentMac === mac) errors.parentMac = MSG.self;
      else if (gateway && parentMac === gateway.mac) value.parentMac = null; // gateway = the default parent
      else if (target?.isGateway) errors.parentMac = MSG.gateway;
      else {
        const parent = list.find((d) => d?.mac === parentMac);
        if (!isHubDevice(parent)) errors.parentMac = MSG.notHub;
        else if (wouldCreateCycle(mac, parentMac, overrides, isPresentHub)) errors.parentMac = MSG.cycle;
        else value.parentMac = parentMac;
      }
    }
  }

  if (hasPosition) {
    const position = parsePosition(body.position);
    if (position === undefined) errors.position = MSG.position;
    // The gateway (and the internet node) are fixed layout anchors: a stored position would be unused junk.
    else if (position !== null && target?.isGateway) errors.position = MSG.gatewayPosition;
    else value.position = position;
  }

  return Object.keys(errors).length ? { ok: false, status: 400, errors } : { ok: true, value };
}

// -------------------------------------------------------------------------------------------- store

/**
 * createTopologyStore({ dataDir, defaults = {}, fileName = 'topology.json' })
 * -> { file, load(), flush(), getOverrides(), getOverride(mac), applyPatch(mac, value) -> Override|null,
 *      reset({ scope = 'positions' }) -> overrides, removeOverride(mac) -> boolean }
 */
export function createTopologyStore({ dataDir, defaults = {}, fileName = 'topology.json' } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('createTopologyStore: dataDir is required');
  const file = path.join(dataDir, fileName);
  const tmpFile = `${file}.tmp`;
  const bakFile = `${file}.bak`;
  const defaultsCopy = () => sanitizeOverrides(clone(defaults));

  let overrides = defaultsCopy();
  let dirty = false;
  let timer = null;

  function fsyncDir() {
    let fd = null;
    try { fd = fs.openSync(dataDir, 'r'); fs.fsyncSync(fd); } catch { /* not supported everywhere */ } finally {
      if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }

  function writeNow() {
    if (timer) { clearTimeout(timer); timer = null; }
    let fd = null;
    try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      fd = fs.openSync(tmpFile, 'w', 0o600);
      fs.writeSync(fd, JSON.stringify({ version: TOPOLOGY_VERSION, overrides }));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      try { if (fs.statSync(file).size > 0) fs.copyFileSync(file, bakFile); } catch { /* first write */ }
      fs.renameSync(tmpFile, file);
      try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
      fsyncDir();
      dirty = false;
    } catch (err) {
      console.warn(`[topology] write failed: ${err.message}`);
    } finally {
      if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }

  function scheduleWrite() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => { timer = null; writeNow(); }, WRITE_DEBOUNCE_MS);
    timer.unref?.();
  }

  function readDoc(f) {
    const text = fs.readFileSync(f, 'utf8');
    if (!text.trim()) throw new Error('empty file');
    const raw = JSON.parse(text);
    if (!isPlainObject(raw)) throw new Error('not a JSON object');
    // Accept { version, overrides } and (defensively) a bare overrides map.
    const map = isPlainObject(raw.overrides) ? raw.overrides : ('version' in raw ? {} : raw);
    return sanitizeOverrides(map, { fallbackUpdatedAt: EPOCH_ISO });
  }

  function load() {
    if (timer) { clearTimeout(timer); timer = null; }
    dirty = false;
    try {
      overrides = readDoc(file);
      return;
    } catch (err) {
      if (err.code === 'ENOENT') {
        try {
          overrides = readDoc(bakFile);
          console.warn(`[topology] ${path.basename(file)} missing; restored from ${path.basename(bakFile)}`);
        } catch {
          overrides = defaultsCopy(); // fresh data dir: defaults, no write until something changes
        }
        return;
      }
      if (err.code) { // EACCES, EISDIR, ...: leave the file alone
        console.warn(`[topology] cannot read ${file}: ${err.message}`);
        overrides = defaultsCopy();
        return;
      }
      const bad = `${file}.corrupt-${Date.now()}`;
      try { fs.renameSync(file, bad); } catch { /* ignore */ }
      try {
        overrides = readDoc(bakFile);
        console.warn(`[topology] ${file} is corrupt (${err.message}); moved to ${path.basename(bad)}, restored the previous copy`);
      } catch {
        overrides = defaultsCopy();
        console.warn(`[topology] ${file} is corrupt (${err.message}); moved to ${path.basename(bad)}, using defaults`);
      }
    }
  }

  /** Synchronous write of pending changes (shutdown). No-op when nothing changed. */
  function flush() {
    if (dirty || timer) writeNow();
  }

  const getOverrides = () => clone(overrides);
  const getOverride = (mac) => clone(overrides[mac]) ?? null;

  /**
   * Merge a validated patch (omitted field = unchanged). Returns the new Override, or null when the
   * entry ended up with neither a parent nor a position (it is deleted).
   */
  function applyPatch(mac, value = {}) {
    const key = normalizeMacInput(mac);
    if (!key) throw new TypeError(`applyPatch: invalid MAC ${mac}`);
    const prev = overrides[key] ?? { parentMac: null, position: null };
    const next = { parentMac: prev.parentMac, position: prev.position ? { ...prev.position } : null };
    if (value.parentMac !== undefined) {
      const p = value.parentMac === null ? null : normalizeMacInput(value.parentMac);
      next.parentMac = p && p !== key ? p : null;
    }
    if (value.position !== undefined) next.position = parsePosition(value.position) ?? null;

    if (next.parentMac === null && next.position === null) {
      if (overrides[key]) { delete overrides[key]; scheduleWrite(); }
      return null;
    }
    overrides[key] = { ...next, updatedAt: new Date().toISOString() };
    enforceCap(overrides, key);
    scheduleWrite();
    return clone(overrides[key]);
  }

  /** scope 'positions': clear every pinned position (keeps "Connected via"); 'all': back to `defaults`. */
  function reset({ scope = 'positions' } = {}) {
    if (!RESET_SCOPES.includes(scope)) throw new TypeError(`reset: unknown scope ${scope}`);
    if (scope === 'all') {
      overrides = defaultsCopy();
      scheduleWrite();
      return getOverrides();
    }
    let changed = false;
    const now = new Date().toISOString();
    for (const [mac, o] of Object.entries(overrides)) {
      if (o.position === null) continue;
      changed = true;
      if (o.parentMac === null) delete overrides[mac];
      else overrides[mac] = { ...o, position: null, updatedAt: now };
    }
    if (changed) scheduleWrite();
    return getOverrides();
  }

  function removeOverride(mac) {
    const key = normalizeMacInput(mac);
    if (!key || !overrides[key]) return false;
    delete overrides[key];
    scheduleWrite();
    return true;
  }

  return { file, load, flush, getOverrides, getOverride, applyPatch, reset, removeOverride };
}
