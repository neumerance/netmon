// useWakeLock — keep the display awake (no dimming, no sleep) while the dashboard is open.
//
// Uses the Screen Wake Lock API. The browser drops the lock whenever the tab is hidden or
// minimised, so it is re-requested each time the page becomes visible again. If a request is
// refused (some browsers want a user gesture first) it is retried on the next click or key press.
// Needs a secure context: http://localhost and http://127.0.0.1 qualify, a LAN IP over plain
// http does not, and in that case this is a silent no-op.
//
// Call once from a long-lived component (App). Releases the lock on unmount.

import { ref, onScopeDispose, getCurrentScope } from 'vue';

export function useWakeLock() {
  const active = ref(false);
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  if (!supported || typeof document === 'undefined') return { supported, active };

  let sentinel = null;
  let pending = false;
  let disposed = false;

  async function acquire() {
    if (disposed || pending || sentinel || document.visibilityState !== 'visible') return;
    pending = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (disposed) {
        lock.release().catch(() => {});
        return;
      }
      sentinel = lock;
      active.value = true;
      lock.addEventListener('release', () => {
        if (sentinel === lock) sentinel = null;
        active.value = false;
      });
    } catch {
      // Refused (no user activation yet, battery saver, permissions policy): retry on interaction.
    } finally {
      pending = false;
    }
  }

  const onVisibility = () => {
    if (document.visibilityState === 'visible') acquire();
  };
  const onInteract = () => {
    if (!sentinel) acquire();
  };

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pointerdown', onInteract, true);
  window.addEventListener('keydown', onInteract, true);
  acquire();

  if (getCurrentScope()) {
    onScopeDispose(() => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pointerdown', onInteract, true);
      window.removeEventListener('keydown', onInteract, true);
      if (sentinel) sentinel.release().catch(() => {});
      sentinel = null;
    });
  }

  return { supported, active };
}

export default useWakeLock;
