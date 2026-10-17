// Call `handler(event)` on pointerdown outside the element(s) (PLAN §8.4).
import { onMounted, onBeforeUnmount, unref } from 'vue';

/**
 * @param {import('vue').Ref<HTMLElement|null>|Array<import('vue').Ref<HTMLElement|null>>} elRef
 * @param {(e: Event) => void} handler
 * @param {{ enabled?: () => boolean }} [opts] optional guard, e.g. only while a popover is open
 */
export function useClickOutside(elRef, handler, opts = {}) {
  const refs = Array.isArray(elRef) ? elRef : [elRef];
  const listener = (e) => {
    if (opts.enabled && !opts.enabled()) return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    for (const r of refs) {
      let el = unref(r);
      if (el && el.$el) el = el.$el; // component instance
      if (!el) continue;
      if (el === e.target || path.includes(el) || (el.contains && el.contains(e.target))) return;
    }
    handler(e);
  };
  onMounted(() => document.addEventListener('pointerdown', listener, true));
  onBeforeUnmount(() => document.removeEventListener('pointerdown', listener, true));
}
