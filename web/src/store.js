// Reactive application store (PLAN.md §8.1) — a plain reactive singleton, no Pinia.
//
// Data flow: init() loads GET /api/snapshot, then opens the SSE stream. Every SSE (re)connect starts
// with a full `snapshot`, so a dropped connection resyncs automatically. Components read `state` /
// computed refs and call the exported actions; they never talk to api.js directly for live data.

import { reactive, computed, watch } from 'vue';
import { api, ApiError, connectStream } from './api.js';
import { deviceTypeLabel, TYPE_GROUPS, CATEGORIES } from './lib/deviceTypes.js';
import { normalizeMac, compareIp } from './lib/format.js';

const UI_STORAGE_KEY = 'netmon.ui';
const VIEW_STORAGE_KEY = 'netmon.devices.view';
const DEVICE_VIEWS = ['map', 'list'];
const EVENTS_CAP = 200;
const HISTORY_CAP = 200;
const LEVEL_RANK = { critical: 0, warning: 1, info: 2 };

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

function defaultSpeed() {
  return { running: false, progress: null, last: null, lastError: null, nextAutoAt: null, history: [] };
}

function defaultInternet() {
  return { status: 'unknown', since: null, lastCheckedAt: null, latencyMs: null, consecutiveFailures: 0, target: null, error: null };
}

function defaultSettings() {
  return { speedThresholdMbps: 200, speedTestIntervalMin: 15, soundAlerts: true, activeFingerprinting: true };
}

const ROUTER_LOG_CAP = 500;

/** Router integration (syslog + SNMP). `available` is false against an older server without /api/router. */
function defaultRouter() {
  return { available: false, config: null, status: null, ports: [], log: [] };
}

export const state = reactive({
  loaded: false,
  connection: 'connecting', // 'connecting' | 'open' | 'reconnecting'
  mock: false,
  serverTime: null,
  network: null,
  devices: [],
  internet: defaultInternet(),
  speed: defaultSpeed(),
  isp: null,
  alerts: [],
  settings: defaultSettings(),
  events: [],
  toasts: [],
  topology: { overrides: {} }, // TOPOLOGY.md §7: { [mac]: { parentMac, position, updatedAt } }
  router: defaultRouter(),
  // ---- extras (not in PLAN §8.1, additive) ----
  lastMessageAt: null, // ms epoch of the last SSE message (or snapshot)
  disconnectedAt: null, // ms epoch when the connection last dropped; null while open
  reconnectAttempts: 0,
});

function loadUiPrefs() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(UI_STORAGE_KEY) : null;
    if (!raw) return {};
    const p = JSON.parse(raw) || {};
    const out = {};
    if (p.theme === 'light' || p.theme === 'dark' || p.theme === 'system') out.theme = p.theme;
    if (typeof p.muted === 'boolean') out.muted = p.muted;
    if (p.dismissed && typeof p.dismissed === 'object') out.dismissed = { ...p.dismissed };
    return out;
  } catch {
    return {};
  }
}

/** Initial Devices view: URL ?view=list|map (wins) -> localStorage -> 'map' (TOPOLOGY.md §8.1). */
function initialDevicesView() {
  try {
    const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('view') : null;
    if (DEVICE_VIEWS.includes(q)) return q;
  } catch {
    /* ignore */
  }
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(VIEW_STORAGE_KEY) : null;
    if (DEVICE_VIEWS.includes(v)) return v;
  } catch {
    /* private mode / blocked storage */
  }
  return 'map';
}

export const ui = reactive({
  filter: 'all', // 'all' | 'online' | 'offline' | 'saved' (also accepts 'new')
  typeFilter: 'all', // 'all' | category id (also accepts a TYPE_GROUPS key or an array of category ids)
  search: '',
  theme: 'system', // 'light' | 'dark' | 'system'
  muted: false,
  dismissed: {}, // { [alertId]: since }
  settingsOpen: false,
  devicesView: initialDevicesView(), // 'map' | 'list'
  selectedMac: null, // device whose detail panel is open (not persisted)
  ...loadUiPrefs(),
});

// Persist only theme, muted, dismissed.
watch(
  () => [ui.theme, ui.muted, JSON.stringify(ui.dismissed)],
  () => {
    try {
      localStorage.setItem(UI_STORAGE_KEY, JSON.stringify({ theme: ui.theme, muted: ui.muted, dismissed: ui.dismissed }));
    } catch {
      /* private mode / blocked storage */
    }
  },
);

// ---------------------------------------------------------------------------------------------
// Computed
// ---------------------------------------------------------------------------------------------

/** Server order (PLAN §5): online first (gateway, self, then numeric IP); offline after, by name. */
export function compareDevices(a, b) {
  if (a.online !== b.online) return a.online ? -1 : 1;
  if (a.online) {
    if (a.isGateway !== b.isGateway) return a.isGateway ? -1 : 1;
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
    const ip = compareIp(a.ip, b.ip);
    if (ip) return ip;
  } else {
    const an = (a.name || a.hostname || a.ip || a.mac || '').toLowerCase();
    const bn = (b.name || b.hostname || b.ip || b.mac || '').toLowerCase();
    if (an !== bn) return an < bn ? -1 : 1;
  }
  return String(a.mac).localeCompare(String(b.mac));
}

export const devicesSorted = computed(() => [...state.devices].sort(compareDevices));

const NEW_DEVICE_MS = 10 * 60 * 1000;

/** First seen < 10 min ago and not saved (DESIGN §3.4 "New"). */
export function isNewDevice(d, now = Date.now()) {
  if (!d || d.saved || !d.firstSeen) return false;
  const t = Date.parse(d.firstSeen);
  return Number.isFinite(t) && now - t < NEW_DEVICE_MS;
}

function typeFilterSet(tf) {
  if (!tf || tf === 'all') return null;
  if (Array.isArray(tf)) return tf.length ? new Set(tf) : null;
  if (TYPE_GROUPS[tf] && !CATEGORIES.includes(tf)) return new Set(TYPE_GROUPS[tf]);
  return new Set([tf]);
}

/** True if device matches a free-text query (name, hostname, ip, mac with/without separators, vendor, model, label). */
export function deviceMatchesSearch(d, q) {
  const query = String(q || '').trim().toLowerCase();
  if (!query) return true;
  const mac = String(d.mac || '').toLowerCase();
  const hay = [d.name, d.hostname, d.ip, mac, mac.replace(/:/g, '-'), mac.replace(/:/g, ''), d.vendor, d.model, deviceTypeLabel(d), d.notes]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  if (hay.includes(query)) return true;
  // MAC typed with other separators ("a4-83-e7", "a483e7")
  const compact = query.replace(/[:\-.\s]/g, '');
  return compact.length >= 4 && /^[0-9a-f]+$/.test(compact) && mac.replace(/:/g, '').includes(compact);
}

/** Apply type filter + search (but not the status filter) — used for tab counts. */
export const searchedDevices = computed(() => {
  const types = typeFilterSet(ui.typeFilter);
  return devicesSorted.value.filter((d) => (!types || types.has(d.category)) && deviceMatchesSearch(d, ui.search));
});

function matchesStatus(d, filter, now) {
  switch (filter) {
    case 'online':
      return !!d.online;
    case 'offline':
      return !d.online;
    case 'saved':
      return !!d.saved;
    case 'new':
      return isNewDevice(d, now);
    default:
      return true;
  }
}

export const filteredDevices = computed(() => {
  const now = Date.now();
  return searchedDevices.value.filter((d) => matchesStatus(d, ui.filter, now));
});

export const devicesByCategory = computed(() => {
  const out = {};
  for (const d of devicesSorted.value) {
    const c = d.category || 'unknown';
    (out[c] ||= []).push(d);
  }
  return out;
});

export const typeCounts = computed(() => {
  const out = {};
  for (const d of state.devices) {
    const c = d.category || 'unknown';
    out[c] = (out[c] || 0) + 1;
  }
  return out;
});

export const counts = computed(() => {
  let online = 0;
  let saved = 0;
  let savedOffline = 0;
  for (const d of state.devices) {
    if (d.online) online++;
    if (d.saved) {
      saved++;
      if (!d.online) savedOffline++;
    }
  }
  return { total: state.devices.length, online, offline: state.devices.length - online, saved, savedOffline };
});

/** Tab counts over the type-filtered + searched set (DESIGN §3.4). */
export const filterCounts = computed(() => {
  const now = Date.now();
  const list = searchedDevices.value;
  return {
    all: list.length,
    online: list.filter((d) => d.online).length,
    offline: list.filter((d) => !d.online).length,
    saved: list.filter((d) => d.saved).length,
    new: list.filter((d) => isNewDevice(d, now)).length,
  };
});

export const visibleAlerts = computed(() =>
  state.alerts
    .filter((a) => a.level === 'critical' || !(a.id in ui.dismissed) || ui.dismissed[a.id] !== a.since)
    .slice()
    .sort((a, b) => (LEVEL_RANK[a.level] ?? 9) - (LEVEL_RANK[b.level] ?? 9) || String(a.since).localeCompare(String(b.since))),
);

export const topAlertLevel = computed(() => {
  let best = null;
  for (const a of visibleAlerts.value) {
    if (best === null || (LEVEL_RANK[a.level] ?? 9) < (LEVEL_RANK[best] ?? 9)) best = a.level;
  }
  return best;
});

export const isSlow = computed(
  () => !!(state.speed.last && typeof state.speed.last.downloadMbps === 'number' && state.speed.last.downloadMbps < state.settings.speedThresholdMbps),
);

/** The device for this machine (isSelf), or null. */
export const selfDevice = computed(() => state.devices.find((d) => d.isSelf) || null);

/** Topology overrides ({ [mac]: Override }). */
export const topologyOverrides = computed(() => state.topology.overrides);

/** Number of nodes the user dragged to a fixed position. */
export const pinnedCount = computed(() => Object.values(state.topology.overrides || {}).filter((o) => o && o.position).length);

/** Map highlight: null when no filter is active, else the Set of macs passing all filters. */
export const mapHighlight = computed(() => {
  if (ui.filter === 'all' && ui.typeFilter === 'all' && !String(ui.search || '').trim()) return null;
  return new Set(filteredDevices.value.map((d) => d.mac));
});

/** The device whose detail panel is open (live copy), or null. */
export const selectedDevice = computed(() => (ui.selectedMac ? getDevice(ui.selectedMac) : null));

/** Device by MAC (any separator form). */
export function getDevice(mac) {
  const m = normalizeMac(String(mac || ''));
  return state.devices.find((d) => d.mac === m) || null;
}

// ---------------------------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------------------------

let toastSeq = 0;
const toastTimers = new Map();

/**
 * Push a toast. Extra fields (e.g. `action: { label, onClick }`, `kind`) are kept on the object.
 * timeoutMs <= 0 keeps the toast until removed.
 * @returns {string} id
 */
export function pushToast({ level = 'info', title = '', message = '', timeoutMs = 5000, ...extra } = {}) {
  const id = `t${Date.now().toString(36)}_${++toastSeq}`;
  state.toasts.push({ id, level, title, message, timeoutMs, createdAt: Date.now(), ...extra });
  // Keep the stack bounded.
  while (state.toasts.length > 6) removeToast(state.toasts[0].id);
  if (timeoutMs > 0) toastTimers.set(id, setTimeout(() => removeToast(id), timeoutMs));
  return id;
}

export function removeToast(id) {
  const t = toastTimers.get(id);
  if (t) clearTimeout(t);
  toastTimers.delete(id);
  const i = state.toasts.findIndex((x) => x.id === id);
  if (i !== -1) state.toasts.splice(i, 1);
}

function errorToast(err, title) {
  const network = err instanceof ApiError ? err.isNetwork : true;
  pushToast({
    level: 'error',
    title: network ? "Couldn't reach NetMon server" : title,
    message: network ? 'Check that the backend is running, then try again.' : err?.message || '',
    timeoutMs: 8000,
  });
}

// ---------------------------------------------------------------------------------------------
// Server -> state
// ---------------------------------------------------------------------------------------------

function upsertDevice(device) {
  if (!device || !device.mac) return;
  const i = state.devices.findIndex((d) => d.mac === device.mac);
  if (i === -1) state.devices.push(device);
  else state.devices.splice(i, 1, device);
}

function appendHistory(result) {
  if (!result || !result.id) return;
  const h = state.speed.history;
  if (h.some((r) => r.id === result.id)) return;
  h.push(result);
  if (h.length > HISTORY_CAP) h.splice(0, h.length - HISTORY_CAP);
}

function applySnapshot(s) {
  if (!s || typeof s !== 'object') return;
  state.mock = !!s.mock;
  state.serverTime = s.serverTime ?? null;
  state.network = s.network ?? null;
  state.devices = Array.isArray(s.devices) ? s.devices : [];
  state.internet = s.internet ? { ...defaultInternet(), ...s.internet } : defaultInternet();
  const speed = s.speed || {};
  state.speed = {
    ...defaultSpeed(),
    ...speed,
    history: Array.isArray(speed.history) ? speed.history.slice(-HISTORY_CAP) : [],
  };
  if (state.speed.last) appendHistory(state.speed.last);
  state.isp = s.isp ?? null;
  state.alerts = Array.isArray(s.alerts) ? s.alerts : [];
  state.settings = { ...defaultSettings(), ...(s.settings || {}) };
  state.events = Array.isArray(s.events) ? s.events.slice(0, EVENTS_CAP) : [];
  state.router = s.router && typeof s.router === 'object'
    ? { ...defaultRouter(), ...s.router, available: true, log: Array.isArray(s.router.log) ? s.router.log.slice(0, ROUTER_LOG_CAP) : [] }
    : defaultRouter();
  if (s.topology && typeof s.topology === 'object') {
    setServerTopology(s.topology.overrides);
  } else if (!topologyFetched) {
    // Older server without topology in the snapshot: fetch once, ignore 404 (feature unavailable).
    topologyFetched = true;
    api
      .topology()
      .then((res) => {
        if (res && typeof res === 'object') setServerTopology(res.overrides);
      })
      .catch(() => {});
  }
  state.loaded = true;
}

let topologyFetched = false;

function sanitizeOverrides(o) {
  return o && typeof o === 'object' && !Array.isArray(o) ? { ...o } : {};
}

/** Apply one SSE message (exported for tests / debugging). */
export function applyStreamEvent(type, data) {
  state.lastMessageAt = Date.now();
  switch (type) {
    case 'snapshot':
      applySnapshot(data);
      break;
    case 'devices':
      if (Array.isArray(data)) state.devices = data;
      break;
    case 'device':
      upsertDevice(data);
      break;
    case 'internet':
      if (data) state.internet = { ...defaultInternet(), ...data };
      break;
    case 'speed':
      if (data) {
        const { history: _ignored, ...rest } = data;
        Object.assign(state.speed, rest);
        if (rest.last) appendHistory(rest.last);
      }
      break;
    case 'isp':
      state.isp = data ?? null;
      break;
    case 'alerts':
      if (Array.isArray(data)) state.alerts = data;
      break;
    case 'event':
      if (data && data.id && !state.events.some((e) => e.id === data.id)) {
        state.events.unshift(data);
        if (state.events.length > EVENTS_CAP) state.events.length = EVENTS_CAP;
      }
      break;
    case 'settings':
      if (data) state.settings = { ...defaultSettings(), ...data };
      break;
    case 'network':
      state.network = data ?? null;
      break;
    case 'topology':
      setServerTopology(data?.overrides);
      break;
    case 'router':
      if (data && typeof data === 'object') applyRouterState(data);
      break;
    case 'routerLog':
      if (data?.cleared) state.router.log = [];
      else if (data?.id && !state.router.log.some((e) => e.id === data.id)) {
        state.router.log.unshift(data);
        if (state.router.log.length > ROUTER_LOG_CAP) state.router.log.length = ROUTER_LOG_CAP;
      }
      break;
    default:
      break;
  }
}

function setConnection(status) {
  if (status === 'open') {
    state.connection = 'open';
    state.disconnectedAt = null;
    state.reconnectAttempts = 0;
  } else {
    if (state.connection === 'open' || state.disconnectedAt === null) state.disconnectedAt = Date.now();
    state.connection = 'reconnecting';
    state.reconnectAttempts += 1;
  }
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

let stream = null;
let initPromise = null;

/** GET /api/snapshot, then connect SSE. Idempotent (returns the same promise). */
export function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const snap = await api.snapshot();
      applySnapshot(snap);
      state.lastMessageAt = Date.now();
    } catch (err) {
      // Backend not up yet: the stream's first `snapshot` will populate state when it is.
      console.warn('[store] initial snapshot failed:', err?.message || err);
    }
    if (!stream) {
      stream = connectStream({ onEvent: applyStreamEvent, onStatus: setConnection });
    }
  })();
  return initPromise;
}

/** Force an immediate SSE reconnect (e.g. "Retry now"). The server resends a snapshot. */
export function reconnectNow() {
  if (stream) stream.reconnect();
  else init();
}

/** Re-fetch the full snapshot over REST. */
export async function refreshSnapshot() {
  try {
    applySnapshot(await api.snapshot());
  } catch (err) {
    errorToast(err, "Couldn't refresh");
    throw err;
  }
}

export async function saveDevice(mac, { name, type = null, notes = '' } = {}) {
  try {
    const res = await api.updateDevice(mac, { name, type: type || null, notes: notes ?? '' });
    if (res?.device) upsertDevice(res.device);
    return res?.device ?? null;
  } catch (err) {
    errorToast(err, "Couldn't save device");
    throw err;
  }
}

export async function forgetDevice(mac) {
  try {
    const res = await api.deleteDevice(mac);
    const m = normalizeMac(String(mac));
    const i = state.devices.findIndex((d) => d.mac === m);
    if (i !== -1) {
      const d = state.devices[i];
      if (d.online) {
        state.devices.splice(i, 1, {
          ...d,
          saved: false,
          name: null,
          notes: '',
          userType: null,
          typeSource: 'auto',
          category: d.autoCategory || d.category,
        });
      } else {
        state.devices.splice(i, 1);
      }
    }
    return res;
  } catch (err) {
    errorToast(err, "Couldn't forget device");
    throw err;
  }
}

export async function refingerprint(mac) {
  try {
    const res = await api.refingerprint(mac);
    if (res?.device) upsertDevice(res.device);
    return res?.device ?? null;
  } catch (err) {
    errorToast(err, err?.code === 'offline' ? 'Device is offline' : "Couldn't re-detect device type");
    throw err;
  }
}

/**
 * POST /api/speedtest. Resolves true when started; false when the server refused because a test is
 * already running (409) or the internet is down (503) — both show a toast instead of throwing.
 */
export async function runSpeedTest() {
  try {
    await api.runSpeedTest();
    state.speed.running = true;
    state.speed.lastError = null;
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      pushToast({ level: 'info', title: 'A speed test is already running' });
      return false;
    }
    errorToast(err, "Couldn't start speed test");
    throw err;
  }
}

/** PUT /api/settings (partial). 400 -> throws ApiError with `.details` (no toast; show inline). */
export async function updateSettings(patch) {
  try {
    const res = await api.updateSettings(patch);
    if (res && typeof res === 'object') state.settings = { ...defaultSettings(), ...res };
    return state.settings;
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 400)) errorToast(err, "Couldn't save settings");
    throw err;
  }
}

function applyRouterState({ config, status, ports }) {
  state.router.available = true;
  if (config) state.router.config = config;
  if (status) state.router.status = status;
  if (Array.isArray(ports)) state.router.ports = ports;
}

/** PUT /api/router/config with a partial { syslog?, snmp? }. Validation errors (400) are rethrown untoasted. */
export async function updateRouterConfig(patch) {
  try {
    const res = await api.updateRouterConfig(patch);
    if (res && typeof res === 'object') applyRouterState(res);
    return state.router;
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 400)) errorToast(err, "Couldn't save router settings");
    throw err;
  }
}

/** One-off SNMP check: resolves { ok, host, system?, ports?, error? }. */
export function testRouterSnmp(body = {}) {
  return api.testRouterSnmp(body);
}

export async function clearRouterLog() {
  try {
    await api.clearRouterLog();
    state.router.log = [];
  } catch (err) {
    errorToast(err, "Couldn't clear the router log");
  }
}

/** Hide a warning/info alert until its `since` changes. Critical alerts cannot be dismissed. */
export function dismissAlert(id) {
  const a = state.alerts.find((x) => x.id === id);
  if (!a || a.level === 'critical') return;
  ui.dismissed = { ...pruneDismissed(), [id]: a.since };
}

function pruneDismissed() {
  // Drop dismissals for alerts that no longer exist so localStorage doesn't grow forever.
  const active = new Set(state.alerts.map((a) => a.id));
  const out = {};
  for (const [k, v] of Object.entries(ui.dismissed)) if (active.has(k)) out[k] = v;
  return out;
}

export function setFilter(f) {
  ui.filter = ['all', 'online', 'offline', 'saved', 'new'].includes(f) ? f : 'all';
}

export function setTypeFilter(t) {
  if (Array.isArray(t)) ui.typeFilter = t.length ? [...t] : 'all';
  else ui.typeFilter = t || 'all';
}

export function setSearch(s) {
  ui.search = String(s ?? '');
}

export function setTheme(t) {
  ui.theme = t === 'light' || t === 'dark' ? t : 'system';
}

export function toggleMute() {
  ui.muted = !ui.muted;
}

export function openSettings() {
  ui.settingsOpen = true;
}

export function closeSettings() {
  ui.settingsOpen = false;
}

// ---------------------------------------------------------------------------------------------
// Devices view + detail panel + topology (TOPOLOGY.md §10.5)
// ---------------------------------------------------------------------------------------------

export function setDevicesView(v) {
  const view = DEVICE_VIEWS.includes(v) ? v : 'map';
  ui.devicesView = view;
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    /* private mode / blocked storage */
  }
  // Keep a ?view= URL in sync so a reload shows what the user picked (the URL param wins on load).
  try {
    const url = new URL(location.href);
    if (url.searchParams.has('view')) {
      url.searchParams.set('view', view);
      history.replaceState(history.state, '', url);
    }
  } catch {
    /* ignore */
  }
}

/** Open (mac) or close (null) the device detail panel. */
export function selectDevice(mac) {
  if (mac == null || mac === '') {
    ui.selectedMac = null;
    return;
  }
  const m = normalizeMac(String(mac));
  ui.selectedMac = m || String(mac).toLowerCase();
}

function topoKey(mac) {
  return normalizeMac(String(mac || '')) || String(mac || '').toLowerCase();
}

/*
 * Topology overrides = last server payload + local changes still in flight.
 * Every optimistic change is an op with a sequence number. Server payloads (snapshot, SSE `topology`, PUT /
 * DELETE responses) replace the base and the pending ops are re-applied on top, so a response or SSE event
 * that predates another local change never makes that change snap back. A failed request drops only its
 * own op instead of restoring a stale snapshot over newer changes.
 */
let topoBase = {};
let topoSeq = 0;
let topoAdoptedSeq = 0; // highest request seq whose response payload became the base
const topoOps = []; // [{ seq, at, mac, patch } | { seq, at, reset: 'positions' }] in seq order

function applyTopoOp(overrides, op) {
  if (op.reset === 'positions') {
    const next = {};
    for (const [mac, o] of Object.entries(overrides)) if (o && o.parentMac != null) next[mac] = { ...o, position: null };
    return next;
  }
  const next = { ...overrides };
  const cur = overrides[op.mac] || { parentMac: null, position: null };
  const merged = { ...cur, ...op.patch, updatedAt: op.at };
  if (merged.parentMac == null && merged.position == null) delete next[op.mac];
  else next[op.mac] = merged;
  return next;
}

function recomputeTopology() {
  let o = topoBase;
  for (const op of topoOps) o = applyTopoOp(o, op);
  state.topology = { overrides: o };
}

/** New server-confirmed overrides (SSE / snapshot: always; request responses: pass their seq). */
function setServerTopology(overrides, seq = null) {
  if (seq != null) {
    // An older request's response must not overwrite a newer response's (fuller) payload.
    if (seq < topoAdoptedSeq) {
      recomputeTopology();
      return;
    }
    topoAdoptedSeq = seq;
  }
  topoBase = sanitizeOverrides(overrides);
  recomputeTopology();
}

function pushTopoOp(op) {
  const entry = { ...op, seq: ++topoSeq, at: new Date().toISOString() };
  topoOps.push(entry);
  recomputeTopology();
  return entry.seq;
}

function dropTopoOp(seq) {
  const i = topoOps.findIndex((o) => o.seq === seq);
  if (i !== -1) topoOps.splice(i, 1);
}

async function putTopology(mac, body, errorTitle) {
  const key = topoKey(mac);
  const seq = pushTopoOp({ mac: key, patch: body });
  try {
    const res = await api.updateTopology(key, body);
    dropTopoOp(seq);
    if (res && res.overrides) setServerTopology(res.overrides, seq);
    else recomputeTopology();
    return res?.override ?? null;
  } catch (err) {
    dropTopoOp(seq);
    recomputeTopology();
    errorToast(err, errorTitle);
    throw err;
  }
}

/** "Connected via": parentMac = hub MAC, or null for the gateway. */
export function setDeviceParent(mac, parentMac, { clearPosition = false } = {}) {
  const p = parentMac == null || parentMac === '' ? null : topoKey(parentMac);
  const body = { parentMac: p, ...(clearPosition ? { position: null } : {}) };
  return putTopology(mac, body, "Couldn't change the connection");
}

/** Pin a map node at a canvas position. */
export function setNodePosition(mac, pos) {
  const x = Math.round(Number(pos?.x) * 10) / 10;
  const y = Math.round(Number(pos?.y) * 10) / 10;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return Promise.resolve(null);
  return putTopology(mac, { position: { x, y } }, "Couldn't save the map position");
}

/** Unpin a map node (back to automatic layout). */
export function clearNodePosition(mac) {
  return putTopology(mac, { position: null }, "Couldn't save the map position");
}

/** DELETE /api/topology?scope=positions|all. */
export async function resetLayout({ scope = 'positions' } = {}) {
  // 'positions' is applied optimistically; 'all' waits for the server (it only takes a seq).
  const seq = scope === 'positions' ? pushTopoOp({ reset: 'positions' }) : ++topoSeq;
  try {
    const res = await api.resetTopology(scope);
    dropTopoOp(seq);
    if (res && res.overrides) setServerTopology(res.overrides, seq);
    else recomputeTopology();
    pushToast({ level: 'success', title: 'Layout reset', timeoutMs: 3000 });
    return state.topology.overrides;
  } catch (err) {
    dropTopoOp(seq);
    recomputeTopology();
    errorToast(err, "Couldn't reset the layout");
    throw err;
  }
}
