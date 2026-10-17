// Persistence: a single JSON document at <dataDir>/store.json.
//
// - load(): missing file -> defaults; unreadable/corrupt file -> renamed to store.json.corrupt-<ts>, defaults.
// - Writes are debounced (500 ms for user changes, 10 s for background bookkeeping such as lastSeen,
//   fingerprints and events) and atomic + durable: write store.json.tmp (mode 0600), fsync, keep the
//   previous good file as store.json.bak, rename over store.json, fsync the directory.
// - load() falls back to store.json.bak when store.json is missing/corrupt (e.g. zero-length after a
//   power loss).
// - flush() writes synchronously (used on shutdown).
// - All accessors return copies so callers cannot mutate the persisted document by accident.
//
// Every method is a closure (no `this`), so methods can be passed around unbound
// (e.g. `getSettings: store.getSettings`).

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS, sanitizeSettings } from './settings.js';

const STORE_VERSION = 1;
const WRITE_DEBOUNCE_MS = 500;
const BACKGROUND_DEBOUNCE_MS = 10_000;
const SPEED_HISTORY_CAP = 200;
const EVENTS_CAP = 500;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

function emptyDoc() {
  return {
    version: STORE_VERSION,
    settings: { ...DEFAULT_SETTINGS },
    saved: {},
    known: {},
    fingerprints: {},
    speedHistory: [],
    events: [],
  };
}

function sanitizeDoc(raw) {
  const doc = emptyDoc();
  if (!isPlainObject(raw)) return doc;
  doc.settings = sanitizeSettings(raw.settings);
  for (const key of ['saved', 'known', 'fingerprints']) {
    if (isPlainObject(raw[key])) {
      for (const [mac, v] of Object.entries(raw[key])) if (isPlainObject(v)) doc[key][mac] = v;
    }
  }
  if (Array.isArray(raw.speedHistory)) {
    doc.speedHistory = raw.speedHistory.filter((r) => isPlainObject(r) && typeof r.downloadMbps === 'number')
      .slice(-SPEED_HISTORY_CAP);
  }
  if (Array.isArray(raw.events)) doc.events = raw.events.filter(isPlainObject).slice(-EVENTS_CAP);
  return doc;
}

export function createStore({ dataDir }) {
  const file = path.join(dataDir, 'store.json');
  const tmpFile = `${file}.tmp`;
  const bakFile = `${file}.bak`;
  let doc = emptyDoc();
  let timer = null;
  let timerDueAt = 0;

  function ensureDir() {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }

  function fsyncDir() {
    let fd = null;
    try { fd = fs.openSync(dataDir, 'r'); fs.fsyncSync(fd); } catch { /* not supported everywhere */ } finally {
      if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }

  function writeNow() {
    if (timer) { clearTimeout(timer); timer = null; timerDueAt = 0; }
    let fd = null;
    try {
      ensureDir();
      fd = fs.openSync(tmpFile, 'w', 0o600);
      fs.writeSync(fd, JSON.stringify(doc));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      // Keep the last good document: if the next rename is torn by a power loss, load() still has it.
      try { if (fs.statSync(file).size > 0) fs.copyFileSync(file, bakFile); } catch { /* first write */ }
      fs.renameSync(tmpFile, file);
      try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
      fsyncDir();
    } catch (err) {
      console.warn(`[store] write failed: ${err.message}`);
    } finally {
      if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }

  /** Debounced write. `urgent` (user-visible changes) flushes within 500 ms, background data within 10 s. */
  function scheduleWrite(urgent = false) {
    const delay = urgent ? WRITE_DEBOUNCE_MS : BACKGROUND_DEBOUNCE_MS;
    const due = Date.now() + delay;
    if (timer && timerDueAt <= due) return;
    if (timer) clearTimeout(timer);
    timerDueAt = due;
    timer = setTimeout(() => { timer = null; timerDueAt = 0; writeNow(); }, delay);
    timer.unref?.();
  }

  function readDoc(f) {
    const text = fs.readFileSync(f, 'utf8');
    if (!text.trim()) throw new Error('empty file');
    return sanitizeDoc(JSON.parse(text));
  }

  function load() {
    try {
      doc = readDoc(file);
      return;
    } catch (err) {
      if (err.code === 'ENOENT') {
        try { doc = readDoc(bakFile); console.warn(`[store] ${path.basename(file)} missing; restored from ${path.basename(bakFile)}`); } catch { doc = emptyDoc(); }
        return;
      }
      if (err.code && err.code !== 'ENOENT') {
        console.warn(`[store] cannot read ${file}: ${err.message}`);
        doc = emptyDoc();
        return;
      }
      const bad = `${file}.corrupt-${Date.now()}`;
      try { fs.renameSync(file, bad); } catch { /* ignore */ }
      try {
        doc = readDoc(bakFile);
        console.warn(`[store] ${file} is corrupt (${err.message}); moved to ${path.basename(bad)}, restored the previous copy`);
      } catch {
        console.warn(`[store] ${file} is corrupt (${err.message}); moved to ${path.basename(bad)}, starting fresh`);
        doc = emptyDoc();
      }
    }
  }

  function resetAll() {
    doc = emptyDoc();
    scheduleWrite(true);
  }

  // ---- settings
  const getSettings = () => ({ ...doc.settings });
  function setSettings(patch) {
    doc.settings = sanitizeSettings({ ...doc.settings, ...patch });
    scheduleWrite(true);
    return getSettings();
  }

  // ---- saved devices
  const listSaved = () => Object.values(doc.saved).map(clone);
  const getSaved = (mac) => clone(doc.saved[mac]) ?? null;
  /** Create or merge a saved device. Accepts name/type/notes and the bookkeeping fields lastSeen/lastIp. */
  function upsertSaved(mac, patch = {}) {
    const now = new Date().toISOString();
    const prev = doc.saved[mac];
    const next = {
      mac,
      name: prev?.name ?? '',
      type: prev?.type ?? null,
      notes: prev?.notes ?? '',
      savedAt: prev?.savedAt ?? now,
      updatedAt: prev?.updatedAt ?? now,
      lastSeen: prev?.lastSeen ?? null,
      lastIp: prev?.lastIp ?? null,
    };
    let userChange = false;
    for (const key of ['name', 'type', 'notes']) {
      if (patch[key] !== undefined) { next[key] = patch[key]; userChange = true; }
    }
    if (userChange) next.updatedAt = now;
    if (patch.lastSeen !== undefined) next.lastSeen = patch.lastSeen;
    if (patch.lastIp !== undefined) next.lastIp = patch.lastIp;
    doc.saved[mac] = next;
    scheduleWrite(userChange || !prev);
    return clone(next);
  }
  function removeSaved(mac) {
    if (!doc.saved[mac]) return false;
    delete doc.saved[mac];
    scheduleWrite(true);
    return true;
  }

  // ---- known devices (every MAC ever seen)
  const getKnown = (mac) => clone(doc.known[mac]) ?? null;
  const knownCount = () => Object.keys(doc.known).length;
  function upsertKnown(mac, patch = {}) {
    const prev = doc.known[mac] ?? { mac, ip: null, hostname: null, vendor: null, firstSeen: null, lastSeen: null };
    const next = { ...prev, mac };
    for (const key of ['ip', 'hostname', 'vendor', 'lastSeen']) {
      if (patch[key] !== undefined && patch[key] !== null) next[key] = patch[key];
    }
    next.firstSeen = prev.firstSeen ?? patch.firstSeen ?? patch.lastSeen ?? new Date().toISOString();
    doc.known[mac] = next;
    scheduleWrite();
    return clone(next);
  }

  // ---- fingerprint cache
  const getFingerprint = (mac) => clone(doc.fingerprints[mac]) ?? null;
  function setFingerprint(mac, { ip = null, at = new Date().toISOString(), result }) {
    doc.fingerprints[mac] = { ip, at, result };
    scheduleWrite();
  }

  // ---- speed history (oldest first)
  const getSpeedHistory = () => doc.speedHistory.map(clone);
  function addSpeedResult(r) {
    doc.speedHistory.push(clone(r));
    if (doc.speedHistory.length > SPEED_HISTORY_CAP) doc.speedHistory.splice(0, doc.speedHistory.length - SPEED_HISTORY_CAP);
    scheduleWrite();
  }

  // ---- events (oldest first on disk)
  const getEvents = () => doc.events.map(clone);
  function addEvent(e) {
    doc.events.push(clone(e));
    if (doc.events.length > EVENTS_CAP) doc.events.splice(0, doc.events.length - EVENTS_CAP);
    scheduleWrite();
  }

  return {
    file,
    load, flush: writeNow, resetAll,
    getSettings, setSettings,
    listSaved, getSaved, upsertSaved, removeSaved,
    getKnown, upsertKnown, knownCount,
    getFingerprint, setFingerprint,
    getSpeedHistory, addSpeedResult,
    getEvents, addEvent,
  };
}
