// useTitleAlert — reflect the alarm state in the browser tab (title + favicon),
// so an outage is visible even when NetMon sits in a background tab.
//
//   critical (internet down) : title blinks every 1 s between
//                              "⚠ Internet down — NetMon" and "Internet down — NetMon"
//                              (the text "Internet down" is always present), favicon -> /favicon-alert.svg
//   warning  (slow internet) : "Slow internet — NetMon"
//   SSE reconnecting         : "Reconnecting… — NetMon"
//   otherwise                : "NetMon"
//
// Call once from a long-lived component (AlarmController). Cleans up on unmount.

import { watch, onScopeDispose, getCurrentScope } from 'vue';
import { state, topAlertLevel } from '../store.js';

const BASE_TITLE = 'NetMon';
const CRITICAL_TITLE = '⚠ Internet down — NetMon';
const CRITICAL_ALT_TITLE = 'Internet down — NetMon';
const WARNING_TITLE = 'Slow internet — NetMon';
const RECONNECTING_TITLE = 'Reconnecting… — NetMon';
const ALERT_FAVICON = '/favicon-alert.svg';

export function useTitleAlert() {
  if (typeof document === 'undefined') return;

  let blinkTimer = null;
  let blinkOn = true;
  let originalFavicon = null;

  function faviconEl() {
    return (
      document.getElementById('favicon') ||
      document.querySelector('link[rel~="icon"]')
    );
  }

  function setFavicon(alert) {
    const el = faviconEl();
    if (!el) return;
    if (originalFavicon === null) originalFavicon = el.getAttribute('href') || '/favicon.svg';
    const want = alert ? ALERT_FAVICON : originalFavicon;
    if (el.getAttribute('href') !== want) el.setAttribute('href', want);
  }

  function stopBlink() {
    if (blinkTimer) clearInterval(blinkTimer);
    blinkTimer = null;
  }

  function startBlink() {
    if (blinkTimer) return;
    blinkOn = true;
    document.title = CRITICAL_TITLE;
    blinkTimer = setInterval(() => {
      blinkOn = !blinkOn;
      document.title = blinkOn ? CRITICAL_TITLE : CRITICAL_ALT_TITLE;
    }, 1000);
  }

  function apply(level, connection) {
    if (level === 'critical') {
      setFavicon(true);
      startBlink();
      return;
    }
    stopBlink();
    setFavicon(false);
    if (level === 'warning') document.title = WARNING_TITLE;
    else if (connection === 'reconnecting') document.title = RECONNECTING_TITLE;
    else document.title = BASE_TITLE;
  }

  watch(
    () => [topAlertLevel.value, state.connection],
    ([level, connection]) => apply(level, connection),
    { immediate: true },
  );

  if (getCurrentScope()) {
    onScopeDispose(() => {
      stopBlink();
      setFavicon(false);
      document.title = BASE_TITLE;
    });
  }
}

export default useTitleAlert;
