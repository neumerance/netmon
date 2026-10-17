// Device manager (PLAN §4.1, §6.1, §6.5).
//
// Merges discovery scans, ping samples, self throughput and fingerprint results into one live
// device list keyed by MAC, decides online/offline, schedules fingerprinting, and produces the
// wire Device objects. Saved devices are always listed (offline ones from the store).

import { isRandomizedMac, ipInCidr } from '../net/sys.js';

const HISTORY_LEN = 30;
const STATS_WINDOW = 10;
// lastSeen lives in memory; the store copy is refreshed coarsely (and on every offline transition).
const PERSIST_SEEN_EVERY_MS = 5 * 60_000;
// Weak / degraded fingerprints are retried this often (the strong-result refresh is timings.refingerprintMs).
const WEAK_REFINGERPRINT_MS = 10 * 60_000;
const WEAK_CONFIDENCE = 0.5;
// Phones/tablets in Wi-Fi power save stop answering ping for minutes while still associated: their
// (complete) ARP entry keeps them online for this long after the last ICMP reply.
const MOBILE_ARP_GRACE_MS = 15 * 60_000;
const MOBILE_CATEGORIES = new Set(['phone', 'tablet', 'wearable']);
const PRESENCE_CONCURRENCY = 8;
const HOSTNAME_SUFFIX_RE = /\.(local|lan|home|localdomain)$/i;

export function cleanHostname(h) {
  if (typeof h !== 'string') return null;
  let s = h.trim().replace(/\.+$/, '');
  for (let i = 0; i < 2 && HOSTNAME_SUFFIX_RE.test(s); i++) s = s.replace(HOSTNAME_SUFFIX_RE, '');
  return s || null;
}

const round1 = (n) => Math.round(n * 10) / 10;
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const parseTime = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? t : null; };

function ipToNum(ip) {
  if (typeof ip !== 'string') return Number.MAX_SAFE_INTEGER;
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x))) return Number.MAX_SAFE_INTEGER;
  return ((p[0] * 256 + p[1]) * 256 + p[2]) * 256 + p[3];
}

function latencyStats(history) {
  if (!history.length) return { latencyMs: null, jitterMs: null, lossPct: null };
  const lost = history.filter((v) => v == null).length;
  const lossPct = round1((lost / history.length) * 100);
  const windowVals = history.slice(-STATS_WINDOW).filter((v) => v != null);
  if (!windowVals.length) return { latencyMs: null, jitterMs: null, lossPct };
  const latencyMs = round1(windowVals.reduce((a, b) => a + b, 0) / windowVals.length);
  let jitterMs = null;
  if (windowVals.length >= 2) {
    let sum = 0;
    for (let i = 1; i < windowVals.length; i++) sum += Math.abs(windowVals[i] - windowVals[i - 1]);
    jitterMs = round1(sum / (windowVals.length - 1));
  } else {
    jitterMs = 0;
  }
  return { latencyMs, jitterMs, lossPct };
}

/**
 * @param {object} o
 * @param {object} o.store
 * @param {object} o.state         core/state.js instance
 * @param {object} o.eventLog
 * @param {object} o.timings
 * @param {() => object|null} o.getNetwork
 * @param {() => object|null} o.getFingerprinter   lazily resolved (modules are created after the manager)
 * @param {() => object|null} o.getPinger
 */
export function createDeviceManager({ store, state, eventLog, timings, getNetwork, getFingerprinter, getPinger, presenceProbe = null, isNetworkBusy = null }) {
  /** @type {Map<string, object>} mac -> entry */
  const entries = new Map();
  // First scan after a fresh install / mock reset / network change: one summary event instead of
  // a "New device on network" event per device.
  let baselineNext = false;
  const presenceInFlight = new Set();
  // ip -> mac from the latest scan: a saved device's remembered IP that now belongs to another MAC
  // (DHCP reuse) or lies outside the current subnet (network change) must not be pinged on its behalf.
  let ipOwners = new Map();
  let selfThroughput = { rxMbps: null, txMbps: null };
  let dirty = false;
  let tickTimer = null;
  let broadcastTimer = null;

  // ------------------------------------------------------------------ entries
  function newEntry(mac, init = {}) {
    const cached = store.getFingerprint(mac);
    const known = store.getKnown(mac);
    return {
      mac,
      ip: init.ip ?? known?.ip ?? null,
      hostname: init.hostname ?? known?.hostname ?? null,
      vendor: init.vendor ?? known?.vendor ?? null,
      isSelf: Boolean(init.isSelf),
      isGateway: Boolean(init.isGateway),
      firstSeen: parseTime(known?.firstSeen) ?? Date.now(),
      lastSeen: init.lastSeen ?? null,         // ms epoch
      online: false,
      statusInitialized: init.statusInitialized ?? true,
      answersIcmp: false,
      lastIcmpAt: null,
      history: [],
      ttl: null,
      fp: cached?.result ?? null,
      fpIp: cached?.ip ?? null,
      fpAt: parseTime(cached?.at),
      // A result restored from store.json is shown right away but re-run once per process, so passive
      // mDNS/SSDP answers heard after a restart (and classifier fixes) refine it.
      fpFromCache: Boolean(cached?.result),
      fpInFlight: false,
      lastPersistAt: 0,
    };
  }

  /** Restore saved devices at boot so they are listed (offline) before the first scan. */
  function restoreSaved() {
    for (const s of store.listSaved()) {
      if (entries.has(s.mac)) continue;
      const known = store.getKnown(s.mac);
      entries.set(s.mac, newEntry(s.mac, {
        ip: s.lastIp ?? known?.ip ?? null,
        lastSeen: parseTime(s.lastSeen) ?? parseTime(known?.lastSeen),
        statusInitialized: false, // first status determination after boot is not logged as an event
      }));
    }
  }

  // ------------------------------------------------------------------ wire shape
  function toWire(e) {
    const saved = store.getSaved(e.mac);
    const fp = e.fp;
    const userType = saved?.type ?? null;
    const autoCategory = fp?.category ?? 'unknown';
    let stats = e.isSelf ? { latencyMs: null, jitterMs: null, lossPct: null } : latencyStats(e.history);
    // Offline -> no current latency (the history/sparkline keeps the last known samples).
    if (!e.online && !e.isSelf) stats = { latencyMs: null, jitterMs: null, lossPct: null };
    // Never answered a ping (ICMP blocked, seen via ARP/TCP only): loss is unknown, not 100 %.
    else if (!e.answersIcmp && !e.isSelf) stats = { ...stats, lossPct: null };
    const pingable = e.isSelf ? null : e.answersIcmp ? true : e.history.length ? false : null;
    const known = store.getKnown(e.mac);
    return {
      mac: e.mac,
      ip: e.ip ?? null,
      hostname: cleanHostname(e.hostname) ?? cleanHostname(fp?.hostnameHints?.[0]) ?? null,
      vendor: e.vendor ?? fp?.manufacturer ?? null,
      name: saved?.name ?? null,
      saved: Boolean(saved),
      notes: saved?.notes ?? '',
      online: e.online,
      isSelf: e.isSelf,
      isGateway: e.isGateway,
      randomizedMac: safeRandomized(e.mac),
      firstSeen: known?.firstSeen ?? iso(e.firstSeen),
      lastSeen: iso(e.lastSeen),
      category: userType ?? autoCategory,
      autoCategory,
      os: fp?.os ?? null,
      model: fp?.model ?? null,
      typeConfidence: typeof fp?.typeConfidence === 'number' ? fp.typeConfidence : 0,
      typeEvidence: Array.isArray(fp?.typeEvidence) ? fp.typeEvidence : [],
      typeSource: userType ? 'user' : 'auto',
      userType,
      // "Identifying…" only while a run is pending or about to be queued (never forever when the
      // fingerprinter is unavailable or the device has no IP).
      fingerprinting: Boolean(e.fpInFlight || (!fp && e.online && e.ip && getFingerprinter())),
      latencyMs: stats.latencyMs,
      jitterMs: stats.jitterMs,
      lossPct: stats.lossPct,
      ttl: e.ttl ?? fp?.signals?.ttl ?? null,
      pingable,
      latencyHistory: e.isSelf ? [] : e.history.slice(),
      rxMbps: e.isSelf ? selfThroughput.rxMbps : null,
      txMbps: e.isSelf ? selfThroughput.txMbps : null,
    };
  }

  function safeRandomized(mac) {
    try { return Boolean(isRandomizedMac(mac)); } catch { return false; }
  }

  function sortKeyName(d) {
    return (d.name || d.hostname || d.model || d.vendor || d.ip || d.mac || '').toLowerCase();
  }

  /** Gateway first, then self, then numeric IP; offline after online, by name. */
  function compareDevices(a, b) {
    if (a.online !== b.online) return a.online ? -1 : 1;
    if (a.online) {
      if (a.isGateway !== b.isGateway) return a.isGateway ? -1 : 1;
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
      return ipToNum(a.ip) - ipToNum(b.ip) || a.mac.localeCompare(b.mac);
    }
    return sortKeyName(a).localeCompare(sortKeyName(b)) || a.mac.localeCompare(b.mac);
  }

  function list() {
    return [...entries.values()].map(toWire).sort(compareDevices);
  }

  function get(mac) {
    const e = entries.get(mac);
    if (e) return toWire(e);
    return null;
  }

  // ------------------------------------------------------------------ broadcasting
  const broadcastDevices = () => { dirty = false; state.broadcast('devices', list()); };
  const broadcastDevice = (mac) => { const d = get(mac); if (d) state.broadcast('device', d); };
  const markDirty = () => { dirty = true; };

  // ------------------------------------------------------------------ online / offline
  function displayName(mac) {
    const d = get(mac);
    return d ? (d.name || d.hostname || d.model || d.vendor || d.ip || d.mac) : mac;
  }

  /** Re-evaluate one entry; returns true if online status changed. */
  function evaluate(e, now = Date.now()) {
    const online = e.isSelf || (e.lastSeen != null && now - e.lastSeen <= timings.offlineAfterMs);
    if (!e.statusInitialized) {
      if (!state.isFirstScanDone()) return false;
      e.statusInitialized = true;
      if (online === e.online) return false;
      e.online = online;
      return true; // status changed but not logged (boot)
    }
    if (online === e.online) return false;
    e.online = online;
    const saved = store.getSaved(e.mac);
    if (saved) {
      const name = saved.name || displayName(e.mac);
      if (online) {
        eventLog.add({ type: 'device_online', level: 'info', message: `${name} is back online`, mac: e.mac, data: { ip: e.ip } });
      } else {
        store.upsertSaved(e.mac, { lastSeen: iso(e.lastSeen), lastIp: e.ip });
        if (e.lastSeen != null) store.upsertKnown(e.mac, { lastSeen: iso(e.lastSeen) });
        eventLog.add({ type: 'device_offline', level: 'warning', message: `${name} went offline`, mac: e.mac, data: { ip: e.ip, lastSeen: iso(e.lastSeen) } });
      }
    }
    return true;
  }

  function markSeen(e, atMs) {
    if (e.lastSeen == null || atMs > e.lastSeen) e.lastSeen = atMs;
    if (atMs - e.lastPersistAt >= PERSIST_SEEN_EVERY_MS) {
      e.lastPersistAt = atMs;
      store.upsertKnown(e.mac, { ip: e.ip, hostname: e.hostname, vendor: e.vendor, lastSeen: iso(atMs) });
      if (store.getSaved(e.mac)) store.upsertSaved(e.mac, { lastSeen: iso(atMs), lastIp: e.ip });
    }
  }

  function evaluateAll(now = Date.now()) {
    let anyChange = false;
    for (const e of [...entries.values()]) {
      if (evaluate(e, now)) { anyChange = true; broadcastDevice(e.mac); }
    }
    // Drop unsaved devices that have been offline for too long (they stay in store.known).
    let removed = false;
    for (const e of [...entries.values()]) {
      if (e.online || e.isSelf || store.getSaved(e.mac)) continue;
      const since = e.lastSeen ?? e.firstSeen;
      if (now - since > timings.dropUnsavedAfterMs) { entries.delete(e.mac); removed = true; }
    }
    if (removed) { updatePingTargets(); broadcastDevices(); }
    if (anyChange || removed) state.recomputeAlerts();
  }

  function updatePingTargets() {
    const pinger = getPinger();
    if (!pinger) return;
    const cidr = getNetwork()?.cidr;
    const targets = [...entries.values()]
      .filter((e) => !e.isSelf && e.ip)
      .filter((e) => { try { return !cidr || ipInCidr(e.ip, cidr); } catch { return true; } })
      .filter((e) => !ipOwners.has(e.ip) || ipOwners.get(e.ip) === e.mac)
      .map((e) => ({ mac: e.mac, ip: e.ip }));
    try { pinger.setTargets(targets); } catch (err) { console.warn(`[devices] setTargets failed: ${err.message}`); }
  }

  // ------------------------------------------------------------------ fingerprinting
  function fpInput(e) {
    return { mac: e.mac, ip: e.ip, hostname: e.hostname, vendor: e.vendor, isGateway: e.isGateway, isSelf: e.isSelf, ttl: e.ttl, randomizedMac: safeRandomized(e.mac) };
  }

  function isWeak(fp) {
    return !fp || fp.category === 'unknown' || !(fp.typeConfidence >= WEAK_CONFIDENCE);
  }

  /**
   * @returns {false | { force: boolean }} whether (and how) to re-run detection for an online entry.
   */
  function needsFingerprint(e, now) {
    if (!e.fp) return { force: false };
    if (e.fpFromCache) return { force: false };
    if (e.fpIp && e.ip && e.fpIp !== e.ip) return { force: false };
    if (e.fpAt == null || now - e.fpAt > timings.refingerprintMs) return { force: false };
    const busy = typeof isNetworkBusy === 'function' && isNetworkBusy();
    // Produced while a speed test saturated the link: active probes timed out. Re-run once it is over.
    if (e.fp.degraded && !busy && now - e.fpAt > 30_000) return { force: true };
    if (isWeak(e.fp) && !busy) {
      const sig = e.fp.signals || {};
      // Probed while asleep (no ping reply, no open port) and now it answers: probe again right away.
      const wokeUp = e.fp.activeProbed && sig.ttl == null && (!sig.openPorts || sig.openPorts.length === 0)
        && typeof e.ttl === 'number';
      if (wokeUp && now - e.fpAt > 60_000) return { force: true };
      if (now - e.fpAt > WEAK_REFINGERPRINT_MS) return { force: wokeUp };
    }
    return false;
  }

  /** Start (or join) a fingerprint run. Resolves with the result or null; never rejects. */
  function requestFingerprint(e, { force = false } = {}) {
    const fp = getFingerprinter();
    if (!fp || !e.ip) return Promise.resolve(null);
    if (e.fpInFlight && e.fpPromise && !force) return e.fpPromise;
    e.fpInFlight = true;
    e.fpFromCache = false;
    markDirty();
    const p = Promise.resolve()
      .then(() => fp.fingerprint(fpInput(e), { force }))
      .then((result) => { if (result) applyFingerprint(e.mac, result); return result ?? null; })
      .catch((err) => { console.warn(`[devices] fingerprint ${e.mac} failed: ${err?.message ?? err}`); return null; })
      .finally(() => {
        const cur = entries.get(e.mac);
        if (cur && cur.fpPromise === p) { cur.fpInFlight = false; cur.fpPromise = null; markDirty(); }
      });
    e.fpPromise = p;
    return p;
  }

  // ------------------------------------------------------------------ presence
  function categoryOf(e) {
    return store.getSaved(e.mac)?.type || e.fp?.category || null;
  }

  function isMobile(e) {
    const c = categoryOf(e);
    return c ? MOBILE_CATEGORIES.has(c) : safeRandomized(e.mac);
  }

  /** Ports a cheap TCP presence check can use (a RST counts as "alive" too). */
  function presencePorts(e) {
    const open = Array.isArray(e.fp?.signals?.openPorts) ? e.fp.signals.openPorts.filter((p) => Number.isInteger(p)) : [];
    const ports = open.slice(0, 2);
    if (!ports.length && e.fp?.os === 'ios') ports.push(62078);
    return ports;
  }

  /** Async TCP presence checks for devices that are in ARP but did not answer ping this scan. */
  function runPresenceChecks(candidates) {
    if (!candidates.length || typeof presenceProbe !== 'function') return;
    const queue = candidates.filter(({ e }) => !presenceInFlight.has(e.mac));
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const { e, ports } = queue[next++];
        presenceInFlight.add(e.mac);
        let alive = false;
        try { alive = Boolean(await presenceProbe(e.ip, ports)); } catch { alive = false; }
        presenceInFlight.delete(e.mac);
        if (!alive || entries.get(e.mac) !== e) continue;
        markSeen(e, Date.now());
        if (evaluate(e)) { broadcastDevice(e.mac); state.recomputeAlerts(); }
        markDirty();
      }
    };
    for (let i = 0; i < Math.min(PRESENCE_CONCURRENCY, queue.length); i++) worker();
  }

  // ------------------------------------------------------------------ module callbacks
  /** Discovery callback: scan started (drives the UI's "Scanning" indicator). */
  function onScanStart() {
    if (getNetwork() && !state.getNetwork()?.scanning) state.patchNetwork({ scanning: true });
  }

  /** Discovery callback: onDevices(rawDevices, { scannedAt, durationMs }). */
  function applyScan(rawDevices, meta = {}) {
    try {
      const now = Date.now();
      const scannedAtMs = parseTime(meta?.scannedAt) ?? now;
      const network = getNetwork();
      const seenMacs = new Set();
      const presenceCandidates = [];
      const baseline = Boolean(network) && (baselineNext || store.knownCount() === 0);
      const newLabels = [];
      const owners = new Map();
      for (const raw of Array.isArray(rawDevices) ? rawDevices : []) {
        if (raw && typeof raw.mac === 'string' && raw.ip) owners.set(raw.ip, raw.mac.toLowerCase());
      }
      ipOwners = owners;
      for (const raw of Array.isArray(rawDevices) ? rawDevices : []) {
        if (!raw || typeof raw.mac !== 'string') continue;
        const mac = raw.mac.toLowerCase();
        let e = entries.get(mac);
        const isNewMac = !store.getKnown(mac);
        if (!e) { e = newEntry(mac, { ip: raw.ip }); entries.set(mac, e); }

        if (raw.ip && raw.ip !== e.ip) {
          e.ip = raw.ip;
          if (store.getSaved(mac)) store.upsertSaved(mac, { lastIp: raw.ip });
        }
        if (raw.hostname) e.hostname = raw.hostname;
        if (raw.vendor) e.vendor = raw.vendor;
        if (typeof raw.ttl === 'number') e.ttl = raw.ttl;
        e.isSelf = Boolean(raw.isSelf) || (network?.mac ? network.mac === mac : false);
        e.isGateway = Boolean(raw.isGateway) || (network?.gateway ? network.gateway === e.ip : false);
        if (raw.alive) { e.answersIcmp = true; e.lastIcmpAt = scannedAtMs; }

        // Presence: a ping reply always counts. A complete ARP entry alone is weak evidence (macOS keeps
        // entries ~20 min after a device left), so when detection found an open TCP port we ask that
        // port instead (connect or RST = present); otherwise ARP counts for devices that never answer
        // ping, and for sleepy phones/tablets for a while after their last ping reply.
        let seen = e.isSelf || Boolean(raw.alive);
        if (!seen && raw.inArp && e.ip) {
          const ports = typeof presenceProbe === 'function' ? presencePorts(e) : [];
          if (ports.length) presenceCandidates.push({ e, ports });
          else if (!e.answersIcmp) seen = true;
          else if (isMobile(e) && e.lastIcmpAt != null && scannedAtMs - e.lastIcmpAt < MOBILE_ARP_GRACE_MS) seen = true;
        }
        if (seen) {
          seenMacs.add(mac);
          markSeen(e, scannedAtMs);
        }
        if (isNewMac) {
          store.upsertKnown(mac, { ip: e.ip, hostname: e.hostname, vendor: e.vendor, firstSeen: iso(scannedAtMs), lastSeen: iso(scannedAtMs) });
          e.lastPersistAt = scannedAtMs;
          if (!e.isSelf) {
            const label = cleanHostname(e.hostname) || e.vendor || e.ip || mac;
            if (baseline) newLabels.push(label);
            else eventLog.add({ type: 'device_new', level: 'info', message: `New device on network: ${label}`, mac, data: { ip: e.ip, vendor: e.vendor, hostname: e.hostname } });
          }
        }
      }
      if (baseline && seenMacs.size) {
        baselineNext = false;
        if (newLabels.length) {
          eventLog.add({
            type: 'network_scan', level: 'info',
            message: `Initial scan found ${newLabels.length} device${newLabels.length === 1 ? '' : 's'}${network?.cidr ? ` on ${network.cidr}` : ''}`,
            data: { count: newLabels.length, cidr: network?.cidr ?? null },
          });
        }
      }

      if (network && !state.isFirstScanDone()) state.patchNetwork({ firstScanDone: true }, { silent: true });
      state.patchNetwork({ scanning: false, lastScanAt: iso(scannedAtMs) });
      runPresenceChecks(presenceCandidates);

      evaluateAll(now);

      // Fingerprinting: tell the fingerprinter about the current device set, then queue what's needed.
      const fp = getFingerprinter();
      if (fp) {
        const online = [...entries.values()].filter((e) => e.online && e.ip);
        try { fp.updateDevices(online.map(fpInput)); } catch (err) { console.warn(`[devices] updateDevices failed: ${err.message}`); }
        for (const e of online) {
          if (e.fpInFlight) continue;
          const need = needsFingerprint(e, now);
          if (need) requestFingerprint(e, need);
        }
      }

      updatePingTargets();
      broadcastDevices();
      state.recomputeAlerts();
    } catch (err) {
      console.warn(`[devices] applyScan failed: ${err.stack || err.message}`);
    }
  }

  /** Pinger callback: onSample({ mac, ip, alive, rttMs, ttl, at }). */
  function applyPingSample(sample) {
    try {
      if (!sample || typeof sample.mac !== 'string') return;
      const e = entries.get(sample.mac.toLowerCase());
      if (!e || e.isSelf) return;
      if (sample.ip && e.ip && sample.ip !== e.ip) return; // stale target (IP changed since the round began)
      const atMs = parseTime(sample.at) ?? Date.now();
      e.history.push(sample.alive && typeof sample.rttMs === 'number' ? round1(sample.rttMs) : null);
      if (e.history.length > HISTORY_LEN) e.history.splice(0, e.history.length - HISTORY_LEN);
      if (sample.alive) {
        e.answersIcmp = true;
        e.lastIcmpAt = atMs;
        if (typeof sample.ttl === 'number') e.ttl = sample.ttl;
        markSeen(e, atMs);
      }
      markDirty();
      if (evaluate(e)) { broadcastDevice(e.mac); state.recomputeAlerts(); }
    } catch (err) {
      console.warn(`[devices] applyPingSample failed: ${err.message}`);
    }
  }

  /** Throughput monitor callback: onSample({ rxMbps, txMbps, at }). */
  function applySelfThroughput(sample) {
    if (!sample) return;
    selfThroughput = {
      rxMbps: typeof sample.rxMbps === 'number' ? round1(sample.rxMbps) : null,
      txMbps: typeof sample.txMbps === 'number' ? round1(sample.txMbps) : null,
    };
    markDirty();
  }

  /** Fingerprinter callback: onResult(mac, result). */
  function applyFingerprint(mac, result) {
    try {
      if (typeof mac !== 'string' || !result || typeof result !== 'object') return;
      mac = mac.toLowerCase();
      const e = entries.get(mac);
      const at = result.fingerprintedAt ?? new Date().toISOString();
      store.setFingerprint(mac, { ip: e?.ip ?? null, at, result });
      if (!e) return;
      const changed = JSON.stringify(e.fp) !== JSON.stringify(result);
      e.fp = result;
      e.fpIp = e.ip;
      e.fpAt = parseTime(at) ?? Date.now();
      if (changed) { broadcastDevice(mac); state.recomputeAlerts(); }
    } catch (err) {
      console.warn(`[devices] applyFingerprint failed: ${err.message}`);
    }
  }

  // ------------------------------------------------------------------ API helpers
  function has(mac) { return entries.has(mac); }
  function isOnline(mac) { return Boolean(entries.get(mac)?.online); }

  /** Called after a device is saved / edited. Creates an entry for a saved-but-unlisted MAC. */
  function onSavedChanged(mac) {
    if (!entries.has(mac)) {
      const s = store.getSaved(mac);
      if (!s) return;
      const known = store.getKnown(mac);
      entries.set(mac, newEntry(mac, { ip: s.lastIp ?? known?.ip, lastSeen: parseTime(s.lastSeen) ?? parseTime(known?.lastSeen) }));
      evaluate(entries.get(mac));
    }
    const e = entries.get(mac);
    if (e && store.getSaved(mac) && !store.getSaved(mac).lastSeen && e.lastSeen != null) {
      store.upsertSaved(mac, { lastSeen: iso(e.lastSeen), lastIp: e.ip });
    }
    broadcastDevice(mac);
    state.recomputeAlerts();
  }

  /** Called after a saved device is forgotten. Offline unsaved devices disappear from the list. */
  function onForgotten(mac) {
    const e = entries.get(mac);
    if (e && !e.online && !e.isSelf) {
      entries.delete(mac);
      updatePingTargets();
      broadcastDevices();
    } else {
      broadcastDevice(mac);
    }
    state.recomputeAlerts();
  }

  /** Force re-detection; resolves with the Device (after result or timeout). */
  async function refingerprint(mac, { timeoutMs = 15000 } = {}) {
    const e = entries.get(mac);
    if (!e) return null;
    const p = requestFingerprint(e, { force: true });
    broadcastDevice(mac);
    let timer;
    await Promise.race([p, new Promise((r) => { timer = setTimeout(r, timeoutMs); })]);
    clearTimeout(timer);
    return get(mac);
  }

  /** Mock reset: clear the live list and all ping windows. */
  function reset() {
    entries.clear();
    presenceInFlight.clear();
    selfThroughput = { rxMbps: null, txMbps: null };
    baselineNext = true;
    updatePingTargets();
  }

  /**
   * The host joined another network (Wi-Fi roaming, hotspot, DHCP change). Unsaved devices of the old
   * LAN are dropped, saved ones keep their entry but restart their status determination (first status
   * on the new network is not logged as online/offline), and the next scan is a baseline scan.
   */
  function onNetworkChanged() {
    for (const [mac, e] of [...entries]) {
      if (e.isSelf || !store.getSaved(mac)) { entries.delete(mac); continue; }
      e.isSelf = false;
      e.isGateway = false;
      e.statusInitialized = false;
      e.answersIcmp = false;
      e.lastIcmpAt = null;
      e.history = [];
      e.ttl = null;
    }
    presenceInFlight.clear();
    ipOwners = new Map();
    selfThroughput = { rxMbps: null, txMbps: null };
    baselineNext = true;
    updatePingTargets();
    broadcastDevices();
    state.recomputeAlerts();
  }

  /** True while any fingerprint run is pending (startup speed test waits for this). */
  function isFingerprinting() {
    for (const e of entries.values()) if (e.fpInFlight) return true;
    return false;
  }

  /** Resolve once every in-flight fingerprint run has settled (or after timeoutMs). */
  async function whenIdle(timeoutMs = 2000) {
    const pending = [...entries.values()].map((e) => e.fpPromise).filter(Boolean);
    if (!pending.length) return;
    let timer;
    await Promise.race([Promise.allSettled(pending), new Promise((r) => { timer = setTimeout(r, timeoutMs); })]);
    clearTimeout(timer);
  }

  // ------------------------------------------------------------------ lifecycle
  function start() {
    if (tickTimer) return;
    restoreSaved();
    tickTimer = setInterval(() => {
      try { evaluateAll(); } catch (err) { console.warn(`[devices] tick failed: ${err.message}`); }
    }, 1000);
    broadcastTimer = setInterval(() => { if (dirty) broadcastDevices(); }, Math.max(100, timings.devicesBroadcastMs));
    tickTimer.unref?.();
    broadcastTimer.unref?.();
  }

  function stop() {
    clearInterval(tickTimer); tickTimer = null;
    clearInterval(broadcastTimer); broadcastTimer = null;
  }

  return {
    start, stop, reset, restoreSaved, onNetworkChanged, isFingerprinting, whenIdle,
    list, get, has, isOnline,
    onScanStart, applyScan, applyPingSample, applySelfThroughput, applyFingerprint,
    onSavedChanged, onForgotten, refingerprint,
    broadcastDevices,
  };
}
