// Shared reactive clock (PLAN §8.4). One interval per distinct intervalMs, shared by all callers and
// stopped automatically when the last subscribed component unmounts.
import { ref, getCurrentScope, onScopeDispose } from 'vue';

const tickers = new Map(); // intervalMs -> { now: Ref<number>, timer, users }

/**
 * @param {number} [intervalMs=1000]
 * @returns {import('vue').Ref<number>} ms epoch, updated every intervalMs
 */
export function useNow(intervalMs = 1000) {
  const ms = Math.max(50, Number(intervalMs) || 1000);
  let t = tickers.get(ms);
  if (!t) {
    t = { now: ref(Date.now()), timer: null, users: 0 };
    tickers.set(ms, t);
  }
  t.users += 1;
  if (!t.timer) {
    t.now.value = Date.now();
    t.timer = setInterval(() => {
      t.now.value = Date.now();
    }, ms);
  }
  if (getCurrentScope()) {
    onScopeDispose(() => {
      t.users -= 1;
      if (t.users <= 0 && t.timer) {
        clearInterval(t.timer);
        t.timer = null;
        t.users = 0;
      }
    });
  }
  // Called outside a component/effect scope: ticker keeps running for the app lifetime.
  return t.now;
}
