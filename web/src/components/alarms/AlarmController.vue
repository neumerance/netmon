<script setup>
// AlarmController — renderless. Turns server state changes into sound, desktop
// notifications, toasts and the tab title/favicon.
//
// Alerts (state.alerts):
//   - critical present (internet down) -> repeating alarm: 3 two-tone beeps now and
//     every 30 s while active (only audible if settings.soundAlerts && !ui.muted;
//     useSound handles the autoplay unlock). Stops when the alert clears (soft
//     "restored" chime if the alarm was audible) or when the live connection to the
//     backend drops (state unknown). Desktop notification on a newly raised critical.
//   - newly raised warning (slow speed) -> one soft chime + desktop notification.
//   - slow_speed clears while internet is up -> success toast "Speed back above ...".
//   Alerts already present when the page loads do not chime (a critical one still
//   starts the repeating alarm).
//
// Events (state.events, new ids only — never for the initial snapshot):
//   device_new (info), device_offline (warning), device_online (success),
//   internet_restored (success), speedtest_complete after a *manual* test.
//   Bursts of >= 3 device events of one type within ~2 s collapse into one toast.
import { watch, onBeforeUnmount } from 'vue';
import { state, pushToast, getDevice } from '../../store.js';
import { useSound } from '../../composables/useSound.js';
import { useNotifications } from '../../composables/useNotifications.js';
import { useTitleAlert } from '../../composables/useTitleAlert.js';
import { deviceDisplayName, deviceTypeLabel } from '../../lib/deviceTypes.js';
import { formatClock, formatDurationShort, formatMbpsValue, formatMs } from '../../lib/format.js';

const CRITICAL_REPEAT_MS = 30000;
const EVENT_RECENT_MS = 30000; // ignore "new" events older than this (e.g. replayed after reconnect)
const BURST_WINDOW_MS = 800; // device events are buffered this long so bursts can collapse
const BURST_COLLAPSE_AT = 3;
const TOAST_MS = { info: 6000, success: 6000, warning: 10000, error: 10000 };

const sound = useSound();
const notifications = useNotifications();
useTitleAlert();

function toast(level, title, message = '', extra = {}) {
  // timeoutMs: 0 -> ToastHost manages the (pausable) timer via autoDismissMs.
  return pushToast({ level, title, message, timeoutMs: 0, autoDismissMs: TOAST_MS[level] ?? 6000, ...extra });
}

// ---------------------------------------------------------------------------
// Alerts -> sound / notifications
// ---------------------------------------------------------------------------

let alertsInitialized = false;
let prevKeys = new Set(); // `${id}|${since}`
let prevIds = new Set();
let loopWasAudible = false;
let criticalNotified = false;

const keyOf = (a) => `${a.id}|${a.since ?? ''}`;

function hasCritical() {
  return (state.alerts || []).some((a) => a.level === 'critical');
}

/** Start/stop the repeating alarm to match (connection open && critical alert active). */
function syncAlarmLoop({ allowChime = true } = {}) {
  const shouldLoop = state.loaded && state.connection === 'open' && hasCritical();
  if (shouldLoop && !sound.alarmActive.value) {
    sound.startAlarmLoop('critical', CRITICAL_REPEAT_MS);
  } else if (!shouldLoop && sound.alarmActive.value) {
    sound.stopAlarmLoop();
    if (allowChime && loopWasAudible && !hasCritical()) sound.playChime();
    loopWasAudible = false;
  }
}

// Remember whether the alarm was actually audible at some point (for the restore chime).
watch(
  () => sound.sounding.value && sound.unlocked.value,
  (v) => {
    if (v) loopWasAudible = true;
  },
);

watch(
  () => (state.loaded ? (state.alerts || []).map(keyOf).join(',') : null),
  (sig) => {
    if (sig === null) return;
    const alerts = state.alerts || [];
    const keys = new Set(alerts.map(keyOf));
    const ids = new Set(alerts.map((a) => a.id));

    if (!alertsInitialized) {
      alertsInitialized = true;
      prevKeys = keys;
      prevIds = ids;
      syncAlarmLoop();
      return;
    }

    for (const a of alerts) {
      if (prevKeys.has(keyOf(a))) continue;
      if (a.level === 'critical') {
        if (!criticalNotified) {
          const since = a.since ? ` since ${formatClock(a.since)}` : '';
          notifications.notify(a.title || 'Internet is down', `No internet connectivity${since}.`, {
            tag: 'netmon-internet',
            requireInteraction: true,
          });
          criticalNotified = true;
        }
      } else if (a.level === 'warning') {
        sound.playAlarm('warning');
        notifications.notify(a.title || 'Slow internet', a.message || '', { tag: `netmon-${a.id}` });
      }
    }

    // slow_speed cleared while the internet is up -> reassure the user.
    if (prevIds.has('slow_speed') && !ids.has('slow_speed') && state.internet?.status !== 'down') {
      const last = state.speed?.last;
      const threshold = state.settings?.speedThresholdMbps;
      if (last && typeof last.downloadMbps === 'number' && threshold && last.downloadMbps >= threshold) {
        toast('success', `Speed back above ${threshold} Mbps`, `${formatMbpsValue(last.downloadMbps)} Mbps measured at ${formatClock(last.at)}`);
      }
    }

    if (!ids.has('internet_down') && prevIds.has('internet_down') && criticalNotified) {
      notifications.notify('Internet restored', 'NetMon detected connectivity again.', { tag: 'netmon-internet' });
    }
    if (!hasCritical()) criticalNotified = false;

    prevKeys = keys;
    prevIds = ids;
    syncAlarmLoop();
  },
  { immediate: true },
);

// Backend connection drop -> stop sounding (we no longer know the state); resume on reconnect.
watch(
  () => state.connection,
  () => syncAlarmLoop({ allowChime: false }),
);

// ---------------------------------------------------------------------------
// Events -> toasts
// ---------------------------------------------------------------------------

const seenEvents = new Set();
let eventsInitialized = false;

function isRecent(ev) {
  const t = Date.parse(ev?.at || '');
  return Number.isFinite(t) && Date.now() - t <= EVENT_RECENT_MS;
}

function deviceInfo(mac) {
  const d = mac ? getDevice(mac) : null;
  return d
    ? { name: deviceDisplayName(d), label: deviceTypeLabel(d), ip: d.ip, vendor: d.vendor, device: d }
    : null;
}

// --- Burst buffering for device events ----------------------------------------
const buckets = new Map(); // type -> { items: Event[], timer }

function bufferDeviceEvent(ev) {
  let b = buckets.get(ev.type);
  if (!b) {
    b = { items: [], timer: null };
    buckets.set(ev.type, b);
  }
  b.items.push(ev);
  if (!b.timer) b.timer = setTimeout(() => flushBucket(ev.type), BURST_WINDOW_MS);
}

function namesList(items) {
  const names = items.map((ev) => deviceInfo(ev.mac)?.name || ev.mac || 'Unknown device');
  const head = names.slice(0, 3).join(', ');
  return names.length > 3 ? `${head} +${names.length - 3} more` : head;
}

function flushBucket(type) {
  const b = buckets.get(type);
  buckets.delete(type);
  if (!b || !b.items.length) return;
  const items = b.items;
  if (items.length >= BURST_COLLAPSE_AT) {
    const n = items.length;
    if (type === 'device_new') toast('info', `${n} new devices joined`, namesList(items));
    else if (type === 'device_offline') toast('warning', `${n} devices went offline`, namesList(items));
    else if (type === 'device_online') toast('success', `${n} devices are back online`, namesList(items));
    return;
  }
  for (const ev of items) toastForDeviceEvent(ev);
}

function toastForDeviceEvent(ev) {
  const info = deviceInfo(ev.mac);
  if (ev.type === 'device_new') {
    const parts = info ? [info.label, info.ip, info.vendor].filter(Boolean) : [];
    const body = parts.length ? parts.join(' · ') : String(ev.message || '').replace(/^New device on network:\s*/i, '');
    toast('info', 'New device joined', body, { kind: 'device_new', mac: ev.mac ?? null });
  } else if (ev.type === 'device_offline') {
    const name = info?.name || String(ev.message || '').replace(/\s+went offline$/i, '') || 'A saved device';
    const d = info?.device;
    const parts = [];
    if (d?.lastSeen) parts.push(`Last seen ${formatClock(d.lastSeen)}`);
    if (d?.ip) parts.push(d.ip);
    toast(ev.level === 'info' ? 'info' : 'warning', `${name} went offline`, parts.join(' · '), { kind: 'device_offline', mac: ev.mac ?? null });
  } else if (ev.type === 'device_online') {
    const name = info?.name || String(ev.message || '').replace(/\s+(came|is back) online$/i, '') || 'A saved device';
    toast('success', `${name} is back online`, info?.ip || '', { kind: 'device_online', mac: ev.mac ?? null });
  }
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'device_new':
    case 'device_offline':
    case 'device_online':
      bufferDeviceEvent(ev);
      break;
    case 'internet_restored': {
      const ms = ev.data?.downtimeMs;
      let body = '';
      if (typeof ms === 'number' && ms >= 0) {
        const end = Date.parse(ev.at);
        const start = Number.isFinite(end) ? new Date(end - ms).toISOString() : null;
        body = `Down for ${formatDurationShort(ms)}` + (start ? ` (${formatClock(start)} – ${formatClock(ev.at)})` : '');
      }
      toast('success', 'Internet restored', body, { kind: 'internet_restored' });
      break;
    }
    case 'speedtest_complete': {
      const r = ev.data;
      if (!r || r.trigger !== 'manual') break;
      const body = `${formatMbpsValue(r.downloadMbps)} ↓ / ${formatMbpsValue(r.uploadMbps)} ↑ Mbps · ${formatMs(r.pingMs)}`;
      toast(ev.level === 'warning' ? 'warning' : 'success', 'Speed test complete', body, { kind: 'speedtest_complete' });
      break;
    }
    default:
      break;
  }
}

watch(
  // Track both in-place unshifts and whole-array replacement (snapshot).
  () => (state.loaded ? [state.events, state.events.length, state.events[0]?.id] : null),
  (src) => {
    if (src === null) return;
    const events = state.events || [];
    if (!eventsInitialized) {
      eventsInitialized = true;
      for (const ev of events) if (ev?.id) seenEvents.add(ev.id);
      return;
    }
    // events are newest first; handle the new ones oldest-first.
    const fresh = [];
    for (const ev of events) {
      if (!ev?.id || seenEvents.has(ev.id)) continue;
      seenEvents.add(ev.id);
      if (isRecent(ev)) fresh.push(ev);
    }
    for (let i = fresh.length - 1; i >= 0; i--) handleEvent(fresh[i]);
    // Keep the seen-set bounded.
    if (seenEvents.size > 2000) {
      const keep = new Set(events.map((e) => e.id));
      for (const id of seenEvents) if (!keep.has(id)) seenEvents.delete(id);
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  for (const b of buckets.values()) clearTimeout(b.timer);
  buckets.clear();
  sound.stopAlarmLoop();
});
</script>

<template>
  <!-- renderless -->
  <span hidden aria-hidden="true" />
</template>
