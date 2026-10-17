// Smoothly tween a numeric value (DESIGN §8: KPI numbers tween 400 ms with rAF).
// Returns a ref that follows `source`; null/undefined pass through immediately (no tween).
// Honors prefers-reduced-motion (jumps instantly).
import { ref, watch, unref, onScopeDispose, getCurrentScope } from 'vue';

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

function reducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * @param {import('vue').MaybeRef<number|null>|(() => number|null)} source
 * @param {{ duration?: number, enabled?: import('vue').MaybeRef<boolean> }} [opts]
 *        enabled=false makes the output follow the source instantly (e.g. during a live speed test).
 * @returns {import('vue').Ref<number|null>}
 */
export function useTween(source, { duration = 400, enabled = true } = {}) {
  const read = () => (typeof source === 'function' ? source() : unref(source));
  const initial = read();
  const out = ref(typeof initial === 'number' && Number.isFinite(initial) ? initial : (initial ?? null));
  let raf = 0;

  const cancel = () => {
    if (raf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(raf);
    raf = 0;
  };

  watch(read, (to) => {
    cancel();
    const from = out.value;
    if (
      typeof to !== 'number' ||
      !Number.isFinite(to) ||
      typeof from !== 'number' ||
      !Number.isFinite(from) ||
      !unref(enabled) ||
      duration <= 0 ||
      typeof requestAnimationFrame === 'undefined' ||
      reducedMotion()
    ) {
      out.value = to ?? null;
      return;
    }
    const start = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - start) / duration);
      out.value = from + (to - from) * easeOutCubic(p);
      if (p < 1) raf = requestAnimationFrame(step);
      else {
        out.value = to;
        raf = 0;
      }
    };
    raf = requestAnimationFrame(step);
  });

  if (getCurrentScope()) onScopeDispose(cancel);
  return out;
}
