// Router integration persistence: <dataDir>/router.json (config) and <dataDir>/router-log.json (the last
// LOG_CAP syslog lines). Kept out of store.js like core/topology.js, with the same write discipline:
// atomic tmp + fsync + rename (mode 0600), debounced, flush() on shutdown, corrupt files set aside.
//
// The SNMP community is a secret: it is stored here but never returned by publicConfig(). The
// NETMON_SNMP_COMMUNITY environment variable, when set, wins over the stored value.

import fs from 'node:fs';
import path from 'node:path';

export const LOG_CAP = 2000;
const CONFIG_VERSION = 1;
const CONFIG_DEBOUNCE_MS = 300;
const LOG_DEBOUNCE_MS = 10_000;

export const DEFAULT_ROUTER_CONFIG = Object.freeze({
  syslog: Object.freeze({ enabled: false, port: 514, source: '' }), // source '' = the default gateway
  snmp: Object.freeze({ enabled: false, host: '', community: '', intervalSec: 10 }), // host '' = the default gateway
});

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
export const isIPv4 = (s) => typeof s === 'string' && IPV4_RE.test(s);

const FIELD_CHECKS = {
  syslog: {
    enabled: (v) => (typeof v === 'boolean' ? null : 'Must be true or false'),
    port: (v) => (Number.isInteger(v) && v >= 1 && v <= 65535 ? null : 'Must be a port between 1 and 65535'),
    source: (v) => (v === '' || isIPv4(v) ? null : 'Must be an IPv4 address, or empty for the default gateway'),
  },
  snmp: {
    enabled: (v) => (typeof v === 'boolean' ? null : 'Must be true or false'),
    host: (v) => (v === '' || isIPv4(v) ? null : 'Must be an IPv4 address, or empty for the default gateway'),
    community: (v) => {
      if (typeof v !== 'string') return 'Must be text';
      if (v.length > 64) return 'Must be at most 64 characters';
      return /^[\x20-\x7e]*$/.test(v) ? null : 'Only printable ASCII characters are allowed';
    },
    intervalSec: (v) => (Number.isInteger(v) && v >= 5 && v <= 300 ? null : 'Must be between 5 and 300 seconds'),
  },
};

/**
 * Validate a partial config patch { syslog?: {...}, snmp?: {...} }.
 * @returns {{ ok: true, value: object } | { ok: false, errors: Record<string,string> }}
 */
export function validateRouterConfig(patch) {
  if (!isPlainObject(patch)) return { ok: false, errors: { _: 'Body must be a JSON object' } };
  const errors = {};
  const value = {};
  for (const [section, fields] of Object.entries(patch)) {
    const checks = FIELD_CHECKS[section];
    if (!checks) { errors[section] = 'Unknown section'; continue; }
    if (!isPlainObject(fields)) { errors[section] = 'Must be an object'; continue; }
    for (const [key, v] of Object.entries(fields)) {
      const check = checks[key];
      const err = check ? check(v) : 'Unknown setting';
      if (err) errors[`${section}.${key}`] = err;
      else (value[section] ??= {})[key] = v;
    }
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value };
}

/** Coerce a loaded document into a full valid config. */
export function sanitizeRouterConfig(raw) {
  const out = structuredClone(DEFAULT_ROUTER_CONFIG);
  if (!isPlainObject(raw)) return out;
  for (const [section, checks] of Object.entries(FIELD_CHECKS)) {
    if (!isPlainObject(raw[section])) continue;
    for (const [key, check] of Object.entries(checks)) {
      if (key in raw[section] && check(raw[section][key]) === null) out[section][key] = raw[section][key];
    }
  }
  return out;
}

function sanitizeLog(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((e) => isPlainObject(e) && typeof e.id === 'string' && typeof e.message === 'string').slice(-LOG_CAP);
}

function writeAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function readJson(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return { missing: true };
    throw err;
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    const aside = `${file}.corrupt-${Date.now()}`;
    try { fs.renameSync(file, aside); } catch { /* ignore */ }
    console.warn(`[router] ${path.basename(file)} was corrupt; moved to ${path.basename(aside)}`);
    return { missing: true };
  }
}

export function createRouterStore({ dataDir, env = process.env }) {
  const configFile = path.join(dataDir, 'router.json');
  const logFile = path.join(dataDir, 'router-log.json');
  let config = structuredClone(DEFAULT_ROUTER_CONFIG);
  let log = [];
  let configTimer = null;
  let logTimer = null;
  let configDirty = false;
  let logDirty = false;
  let seq = 0;

  const envCommunity = () => (typeof env.NETMON_SNMP_COMMUNITY === 'string' && env.NETMON_SNMP_COMMUNITY !== ''
    ? env.NETMON_SNMP_COMMUNITY : null);

  function load() {
    try {
      const c = readJson(configFile);
      if (!c.missing) config = sanitizeRouterConfig(c.value?.config);
    } catch (err) {
      console.warn(`[router] could not read ${configFile}: ${err.message}`);
    }
    try {
      const l = readJson(logFile);
      if (!l.missing) log = sanitizeLog(l.value?.entries);
    } catch (err) {
      console.warn(`[router] could not read ${logFile}: ${err.message}`);
    }
  }

  function writeConfig() {
    if (configTimer) { clearTimeout(configTimer); configTimer = null; }
    if (!configDirty) return;
    try {
      writeAtomic(configFile, JSON.stringify({ version: CONFIG_VERSION, config }, null, 2));
      configDirty = false;
    } catch (err) {
      console.warn(`[router] could not save ${configFile}: ${err.message}`);
    }
  }

  function writeLog() {
    if (logTimer) { clearTimeout(logTimer); logTimer = null; }
    if (!logDirty) return;
    try {
      writeAtomic(logFile, JSON.stringify({ version: CONFIG_VERSION, entries: log }));
      logDirty = false;
    } catch (err) {
      console.warn(`[router] could not save ${logFile}: ${err.message}`);
    }
  }

  /** Full config including the community (server-side use only). */
  function getConfig() {
    const c = structuredClone(config);
    const fromEnv = envCommunity();
    if (fromEnv) c.snmp.community = fromEnv;
    return c;
  }

  /** Config safe to send to clients: the community is replaced by flags. */
  function publicConfig() {
    const c = structuredClone(config);
    const fromEnv = Boolean(envCommunity());
    const { community, ...snmp } = c.snmp;
    return { ...c, snmp: { ...snmp, communitySet: fromEnv || community !== '', communityFromEnv: fromEnv } };
  }

  /** Merge a validated patch. Returns the new full config. */
  function updateConfig(patch) {
    for (const [section, fields] of Object.entries(patch || {})) {
      if (!config[section]) continue;
      Object.assign(config[section], fields);
    }
    configDirty = true;
    if (!configTimer) {
      configTimer = setTimeout(writeConfig, CONFIG_DEBOUNCE_MS);
      configTimer.unref?.();
    }
    return getConfig();
  }

  /** Append a log entry (assigns id). Returns the stored entry. */
  function addLogEntry(entry) {
    seq = (seq + 1) % 1_000_000;
    const stored = { id: `rl_${Date.now()}_${seq}`, ...entry };
    log.push(stored);
    if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP);
    logDirty = true;
    if (!logTimer) {
      logTimer = setTimeout(writeLog, LOG_DEBOUNCE_MS);
      logTimer.unref?.();
    }
    return { ...stored };
  }

  /**
   * Newest first.
   * @param {{ limit?: number, maxSeverity?: number, q?: string }} [opts]  maxSeverity 0..7 keeps lines at
   *        least that severe (3 = err and worse).
   */
  function getLog({ limit = 200, maxSeverity = 7, q = '' } = {}) {
    const needle = String(q || '').toLowerCase();
    const out = [];
    for (let i = log.length - 1; i >= 0 && out.length < limit; i--) {
      const e = log[i];
      if (e.severity > maxSeverity) continue;
      if (needle && !`${e.app ?? ''} ${e.message}`.toLowerCase().includes(needle)) continue;
      out.push({ ...e });
    }
    return out;
  }

  function clearLog() {
    log = [];
    logDirty = true;
    writeLog();
  }

  function flush() {
    writeConfig();
    writeLog();
  }

  /** Back to defaults with an empty log (mock reset). */
  function reset() {
    config = structuredClone(DEFAULT_ROUTER_CONFIG);
    configDirty = true;
    writeConfig();
    clearLog();
  }

  return { load, getConfig, publicConfig, updateConfig, addLogEntry, getLog, clearLog, reset, flush, logCount: () => log.length };
}
