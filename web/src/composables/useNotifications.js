// useNotifications — opt-in browser (desktop) notifications.
//
// Shared singleton state. `permission` mirrors Notification.permission
// ('default' | 'granted' | 'denied' | 'unsupported'). `enabled` is a per-browser
// preference (localStorage 'netmon.notifications'), defaulting to on, so simply
// granting permission is enough to start receiving notifications; the Settings
// drawer lets the user switch them off again without revoking browser permission.
//
// notify() only shows a notification when permission is granted, the user has
// not disabled them, and (unless { force: true }) the page is not currently
// visible+focused — when the user is looking at the dashboard the on-screen
// banner is enough.

import { ref, computed } from 'vue';

const STORAGE_KEY = 'netmon.notifications';
const supported = typeof window !== 'undefined' && 'Notification' in window;

function readPermission() {
  if (!supported) return 'unsupported';
  try {
    return window.Notification.permission || 'default';
  } catch {
    return 'unsupported';
  }
}

function readEnabled() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === null ? true : v === '1';
  } catch {
    return true;
  }
}

const permission = ref(readPermission());
const enabled = ref(readEnabled());
let permissionWatchInstalled = false;

function installPermissionWatch() {
  if (permissionWatchInstalled || !supported) return;
  permissionWatchInstalled = true;
  // Keep `permission` fresh if the user changes it in browser site settings.
  try {
    navigator.permissions
      ?.query({ name: 'notifications' })
      .then((status) => {
        status.onchange = () => {
          permission.value = readPermission();
        };
      })
      .catch(() => {});
  } catch {
    /* ignore */
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      permission.value = readPermission();
    });
  }
}

function setEnabled(v) {
  enabled.value = !!v;
  try {
    localStorage.setItem(STORAGE_KEY, enabled.value ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/** Ask the browser for permission. Resolves to the resulting permission string. */
async function request() {
  if (!supported) {
    permission.value = 'unsupported';
    return permission.value;
  }
  try {
    const res = window.Notification.requestPermission();
    // Old Safari uses a callback API and returns undefined.
    const result = res && typeof res.then === 'function' ? await res : readPermission();
    permission.value = result || readPermission();
  } catch {
    permission.value = readPermission();
  }
  if (permission.value === 'granted') setEnabled(true);
  return permission.value;
}

function pageIsWatched() {
  if (typeof document === 'undefined') return false;
  const visible = document.visibilityState === 'visible';
  const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
  return visible && focused;
}

/**
 * Show a desktop notification. Returns the Notification or null.
 * opts: { tag?, force? (show even if the page is focused), requireInteraction? }
 */
function notify(title, body = '', opts = {}) {
  permission.value = readPermission();
  if (!supported || permission.value !== 'granted' || !enabled.value) return null;
  if (!opts.force && pageIsWatched()) return null;
  try {
    const n = new window.Notification(title, {
      body,
      tag: opts.tag || undefined,
      renotify: !!opts.tag,
      requireInteraction: !!opts.requireInteraction,
      icon: '/favicon.svg',
      silent: true, // NetMon plays its own alarm tones
    });
    n.onclick = () => {
      try {
        window.focus();
      } catch {
        /* ignore */
      }
      n.close();
    };
    return n;
  } catch (err) {
    // e.g. Chrome on Android requires a service worker for `new Notification`.
    console.warn('[useNotifications] could not show notification', err);
    return null;
  }
}

/** True when notifications will actually be delivered. */
const active = computed(() => permission.value === 'granted' && enabled.value);

export function useNotifications() {
  installPermissionWatch();
  return { supported, permission, enabled, active, setEnabled, request, notify };
}

export default useNotifications;
