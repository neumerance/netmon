// Mutable mock "world" state (PLAN.md §7.4). Every mock module reads from here on each tick, so changes
// made via applyMockState() become visible on the next 1 s tick (or immediately via the returned effects).

import { MOCK_DEVICES, MOCK_NEW_DEVICE } from './devices.js';

export const DEFAULT_DOWNLOAD_MBPS = 450.0;
export const DEFAULT_UPLOAD_MBPS = 40.0;

const MAX_MBPS = 100000;

function defaults() {
  return {
    internetDown: false,
    downloadMbps: DEFAULT_DOWNLOAD_MBPS,
    uploadMbps: DEFAULT_UPLOAD_MBPS,
    devicesOffline: [], // normalized colon MACs
    newDevice: false,
  };
}

let world = defaults();

/**
 * Local MAC normalizer (kept here so the mock has no dependency on net/sys.js; same semantics):
 * accepts ':' or '-' separators (or url-encoded ':'), any case, unpadded octets. Invalid -> null.
 */
export function normalizeMacLoose(s) {
  if (typeof s !== 'string') return null;
  let str = s.trim();
  try { str = decodeURIComponent(str); } catch { /* keep as-is */ }
  const parts = str.split(/[:-]/);
  if (parts.length !== 6) return null;
  const out = [];
  for (const p of parts) {
    if (!/^[0-9a-fA-F]{1,2}$/.test(p)) return null;
    out.push(p.toLowerCase().padStart(2, '0'));
  }
  return out.join(':');
}

/** Snapshot copy of the world state (the `MockState` wire shape). */
export function getMockState() {
  return {
    internetDown: world.internetDown,
    downloadMbps: world.downloadMbps,
    uploadMbps: world.uploadMbps,
    devicesOffline: [...world.devicesOffline],
    newDevice: world.newDevice,
  };
}

export function resetMockState() {
  world = defaults();
}

export function isInternetDown() {
  return world.internetDown;
}

export function getTargetSpeeds() {
  return { downloadMbps: world.downloadMbps, uploadMbps: world.uploadMbps };
}

/** Rows currently part of the simulated LAN (ignoring the offline set). */
export function presentDevices() {
  return world.newDevice ? [...MOCK_DEVICES, MOCK_NEW_DEVICE] : [...MOCK_DEVICES];
}

/** Whether a MAC currently answers on the simulated LAN. Self is always online. */
export function isMockDeviceOnline(mac) {
  const m = normalizeMacLoose(mac);
  if (!m) return false;
  const row = presentDevices().find((d) => d.mac === m);
  if (!row) return false;
  if (row.isSelf) return true;
  return !world.devicesOffline.includes(m);
}

/**
 * Validates a mock-state patch. Unknown keys are ignored (lenient on purpose).
 * @returns {{ ok: true, value: object } | { ok: false, errors: Record<string,string> }}
 */
export function validateMockPatch(patch) {
  if (patch == null) patch = {};
  if (typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, errors: { body: 'must be a JSON object' } };
  }
  const errors = {};
  const value = {};
  for (const key of ['internetDown', 'newDevice', 'reset']) {
    if (patch[key] === undefined) continue;
    if (typeof patch[key] !== 'boolean') errors[key] = 'must be a boolean';
    else value[key] = patch[key];
  }
  for (const key of ['downloadMbps', 'uploadMbps']) {
    if (patch[key] === undefined) continue;
    const n = patch[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > MAX_MBPS) {
      errors[key] = `must be a number > 0 and <= ${MAX_MBPS}`;
    } else {
      value[key] = Math.round(n * 10) / 10;
    }
  }
  if (patch.devicesOffline !== undefined) {
    if (!Array.isArray(patch.devicesOffline)) {
      errors.devicesOffline = 'must be an array of MAC addresses';
    } else {
      const macs = [];
      const bad = [];
      for (const s of patch.devicesOffline) {
        const m = normalizeMacLoose(s);
        if (m) { if (!macs.includes(m)) macs.push(m); } else bad.push(String(s));
      }
      if (bad.length) errors.devicesOffline = `invalid MAC address(es): ${bad.join(', ')}`;
      else value.devicesOffline = macs;
    }
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

/**
 * Applies a patch to the world. `reset` is processed first, then the remaining fields.
 * Throws Error('validation') with `.code = 'validation'`, `.status = 400`, `.details` on invalid input.
 *
 * Effects tell core what to kick off (PLAN §7.4):
 *   rescan        devicesOffline / newDevice / reset provided  -> discovery.scanNow() + pinger.pingNow()
 *   runSpeedTest  downloadMbps / uploadMbps provided           -> start (or queue one) manual speed test
 *   reprobe       internetDown / reset provided                -> probe.checkNow()
 *   reset         reset:true                                   -> core resets store, live list, history...
 */
export function applyMockState(patch) {
  const v = validateMockPatch(patch);
  if (!v.ok) {
    const err = new Error('validation');
    err.code = 'validation';
    err.status = 400;
    err.details = v.errors;
    throw err;
  }
  const p = v.value;
  const effects = { rescan: false, runSpeedTest: false, reprobe: false, reset: false };

  if (p.reset === true) {
    resetMockState();
    effects.reset = true;
    effects.rescan = true;
    effects.reprobe = true;
  }
  if (p.internetDown !== undefined) {
    world.internetDown = p.internetDown;
    effects.reprobe = true;
  }
  if (p.downloadMbps !== undefined) {
    world.downloadMbps = p.downloadMbps;
    effects.runSpeedTest = true;
  }
  if (p.uploadMbps !== undefined) {
    world.uploadMbps = p.uploadMbps;
    effects.runSpeedTest = true;
  }
  if (p.devicesOffline !== undefined) {
    world.devicesOffline = p.devicesOffline;
    effects.rescan = true;
  }
  if (p.newDevice !== undefined) {
    world.newDevice = p.newDevice;
    effects.rescan = true;
  }
  return { state: getMockState(), effects };
}
