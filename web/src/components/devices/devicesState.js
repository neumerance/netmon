// Client-only UI state for the devices panel (frontend-devices only).
//
// Things that are not part of the global store contract (PLAN.md §8.1) but must be shared
// between the panel, rows and cards: pending re-detect requests, the table sort, and which
// devices joined while this page was open (for the "New" badge + highlight).

import { reactive, watch } from 'vue';
import { pushToast, refingerprint } from '../../store.js';
import { deviceDisplayName, deviceTypeLabel } from '../../lib/deviceTypes.js';
import { isSortKey } from './deviceUi.js';

const SORT_STORAGE_KEY = 'netmon.devices.sort';

function readSort() {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (v && isSortKey(v.key) && (v.dir === 'asc' || v.dir === 'desc')) return v;
  } catch {
    /* storage unavailable or corrupt: fall back to defaults */
  }
  return null;
}

const saved = readSort();

export const devicesUi = reactive({
  /** MACs with an in-flight POST /api/devices/:mac/fingerprint. */
  redetecting: {},
  sortKey: saved?.key ?? 'default',
  sortDir: saved?.dir ?? 'asc'
});

watch(
  () => [devicesUi.sortKey, devicesUi.sortDir],
  ([key, dir]) => {
    try {
      localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify({ key, dir }));
    } catch {
      /* ignore */
    }
  }
);

/** Click on a sortable header / pick in the sort menu: same key toggles direction. */
export function setSort(key, dir) {
  if (!isSortKey(key)) return;
  if (dir === 'asc' || dir === 'desc') {
    devicesUi.sortKey = key;
    devicesUi.sortDir = dir;
    return;
  }
  if (devicesUi.sortKey === key) {
    devicesUi.sortDir = devicesUi.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    devicesUi.sortKey = key;
    devicesUi.sortDir = 'asc';
  }
}

export function isRedetecting(mac) {
  return Boolean(mac && devicesUi.redetecting[mac]);
}

export function setRedetecting(mac, on) {
  if (!mac) return;
  if (on) devicesUi.redetecting[mac] = true;
  else delete devicesUi.redetecting[mac];
}

/* ------------------------------------------------------------------------------------------
 * "New" devices: a device counts as new when it was first reported after the initial device
 * list this page received (plus a short grace period for the first scan to settle), it is not
 * saved, and it was first seen less than NEW_WINDOW_MS ago. Purely cosmetic.
 * ---------------------------------------------------------------------------------------- */

const NEW_WINDOW_MS = 10 * 60 * 1000;
const INITIAL_GRACE_MS = 8000;

const initialMacs = new Set();
const arrivedAt = new Map(); // mac -> ms epoch when this page first saw it (after the grace period)
let firstListAt = 0;

/** Feed every device list update (called by DevicesPanel's watcher). */
export function trackDevices(devices, now = Date.now()) {
  if (!Array.isArray(devices) || devices.length === 0) return;
  if (!firstListAt) firstListAt = now;
  const inGrace = now - firstListAt <= INITIAL_GRACE_MS;
  for (const d of devices) {
    if (!d?.mac || initialMacs.has(d.mac) || arrivedAt.has(d.mac)) continue;
    if (inGrace) initialMacs.add(d.mac);
    else arrivedAt.set(d.mac, now);
  }
}

export function isNewDevice(device, now = Date.now()) {
  if (!device || device.saved || !device.online) return false;
  const at = arrivedAt.get(device.mac);
  if (!at) return false;
  // A device we have seen before (firstSeen long ago) that merely reconnected is not "new".
  const first = device.firstSeen ? Date.parse(device.firstSeen) : NaN;
  if (Number.isFinite(first) && now - first >= NEW_WINDOW_MS) return false;
  return now - at < NEW_WINDOW_MS;
}

/** True for a few seconds after the device appeared (drives the one-shot row highlight). */
export function isJustArrived(device, now = Date.now()) {
  const at = device ? arrivedAt.get(device.mac) : null;
  return Boolean(at && now - at < 2400);
}

/* ------------------------------------------------------------------------------------------
 * Actions with UI feedback (shared by rows, cards and the edit modal).
 * ---------------------------------------------------------------------------------------- */

/**
 * Re-detect a device's type (POST /api/devices/:mac/fingerprint, server waits up to 15 s).
 * Errors are already toasted by the store; we just swallow the rethrow here.
 * @returns {Promise<object|null>} the updated device, or null on failure / already running
 */
export async function redetectDevice(device) {
  const mac = device?.mac;
  if (!mac || isRedetecting(mac)) return null;
  setRedetecting(mac, true);
  try {
    const res = await refingerprint(mac);
    // Contract: resolves to the Device; tolerate a raw { device } response too.
    const updated = res && typeof res === 'object' && res.device ? res.device : res;
    const d = updated && typeof updated === 'object' && updated.mac ? updated : null;
    if (d) {
      const pct = Math.round((Number(d.typeConfidence) || 0) * 100);
      pushToast({
        level: 'success',
        title: `Re-detected ${deviceDisplayName(d)}`,
        message: d.typeSource === 'user'
          ? `Kept your type: ${deviceTypeLabel(d)}.`
          : `${deviceTypeLabel(d)} · ${pct}% confidence`
      });
    }
    return d;
  } catch {
    return null;
  } finally {
    setRedetecting(mac, false);
  }
}
