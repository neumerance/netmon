// Mock drop-in for net/fingerprint/index.js createFingerprinter (PLAN.md §2.6, §7.2, §7.3).
// fingerprint() resolves after 200 ms with the device-table row as a FingerprintResult and calls onResult.
// No sockets, no network. Each request resolves independently after 200 ms (the `concurrency` option is
// accepted for signature parity but not enforced, so all mock devices are typed ~200 ms after first scan).

import { findMockDevice } from './devices.js';
import { normalizeMacLoose } from './state.js';

export const MOCK_FINGERPRINT_DELAY_MS = 200;

/**
 * Builds the FingerprintResult for a MAC (pure apart from the timestamp).
 * @param {{ mac: string, hostname?: string|null, ttl?: number|null }} device
 * @param {{ activeProbed?: boolean, at?: string }} [opts]
 */
export function mockFingerprintResult(device, { activeProbed = true, at = new Date().toISOString() } = {}) {
  const mac = normalizeMacLoose(device?.mac) || device?.mac || null;
  const found = findMockDevice(mac);

  if (!found) {
    const hostname = device?.hostname ?? null;
    return {
      category: 'unknown', os: null, model: null, manufacturer: null,
      typeConfidence: 0,
      typeEvidence: ['No identifying services found'],
      hostnameHints: hostname ? [hostname] : [],
      signals: {
        ttl: device?.ttl ?? null, openPorts: activeProbed ? [] : null, mdnsServices: [], mdnsModel: null,
        upnpDeviceType: null, upnpFriendlyName: null, upnpModel: null, netbiosName: null,
      },
      activeProbed,
      fingerprintedAt: at,
    };
  }

  const { row } = found;
  const s = row.signals;
  return {
    category: row.category,
    os: row.os,
    model: row.model,
    manufacturer: row.manufacturer,
    typeConfidence: row.typeConfidence,
    typeEvidence: [...row.typeEvidence],
    hostnameHints: row.hostname ? [row.hostname] : [],
    signals: {
      ttl: row.ttl,
      // Active-probe-only signals are absent when activeFingerprinting is off.
      openPorts: activeProbed ? [...s.openPorts] : null,
      mdnsServices: [...s.mdnsServices],
      mdnsModel: s.mdnsModel,
      upnpDeviceType: s.upnpDeviceType,
      upnpFriendlyName: s.upnpFriendlyName,
      upnpModel: s.upnpModel,
      netbiosName: activeProbed ? s.netbiosName : null,
    },
    activeProbed,
    fingerprintedAt: at,
  };
}

export function createFingerprinter({ getSettings, onResult, concurrency = 2, passiveBrowseMs = 300000,
  activeProbeMinIntervalMs = 3600000, getNetwork = null, isNetworkBusy = null } = {}) {
  void concurrency; void passiveBrowseMs; void activeProbeMinIntervalMs; void getNetwork; void isNetworkBusy;

  /** mac -> { timer, resolve, device, promise } */
  const pending = new Map();
  // ip -> device; kept for interface parity (the real fingerprinter attributes passive mDNS/SSDP answers by IP).
  let devicesByIp = new Map();

  function activeEnabled() {
    try {
      const s = typeof getSettings === 'function' ? getSettings() : null;
      return s ? s.activeFingerprinting !== false : true;
    } catch {
      return true;
    }
  }

  function emit(mac, result) {
    if (typeof onResult !== 'function') return;
    try {
      const r = onResult(mac, result);
      if (r && typeof r.catch === 'function') r.catch((e) => console.warn('[mock-fingerprint] onResult failed:', e?.message || e));
    } catch (e) {
      console.warn('[mock-fingerprint] onResult failed:', e?.message || e);
    }
  }

  function fingerprint(device, { force = false } = {}) {
    void force;
    const mac = normalizeMacLoose(device?.mac) || device?.mac;
    if (!mac) {
      return Promise.resolve(mockFingerprintResult({ mac: null, hostname: device?.hostname, ttl: device?.ttl }));
    }
    const existing = pending.get(mac);
    if (existing) return existing.promise;

    let resolveFn;
    const promise = new Promise((resolve) => { resolveFn = resolve; });
    const entry = { promise, resolve: resolveFn, device: { ...device, mac }, timer: null };
    entry.timer = setTimeout(() => {
      pending.delete(mac);
      const result = mockFingerprintResult(entry.device, { activeProbed: activeEnabled() });
      emit(mac, result);
      entry.resolve(result);
    }, MOCK_FINGERPRINT_DELAY_MS);
    pending.set(mac, entry);
    return promise;
  }

  return {
    start() { /* no sockets in mock mode */ },
    stop() {
      // Never leave callers hanging: resolve pending requests (without onResult) and clear timers.
      for (const [mac, entry] of pending) {
        clearTimeout(entry.timer);
        entry.resolve(mockFingerprintResult(entry.device, { activeProbed: activeEnabled() }));
        pending.delete(mac);
      }
    },
    /** Network changed (interface parity with the real fingerprinter; nothing to rebind here). */
    setNetwork() { /* no sockets in mock mode */ },
    updateDevices(devices) {
      devicesByIp = new Map((Array.isArray(devices) ? devices : []).filter((d) => d && d.ip).map((d) => [d.ip, d]));
    },
    fingerprint,
  };
}
