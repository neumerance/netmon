// Ticking relative-time text ('just now', '3 min ago') driven by the shared useNow clock.
import { computed, unref } from 'vue';
import { useNow } from './useNow.js';
import { formatRelative } from '../lib/format.js';

/**
 * @param {import('vue').MaybeRef<string|number|Date|null>} source ISO string / ms / Date (ref or getter ok)
 * @param {{ intervalMs?: number }} [opts]
 * @returns {import('vue').ComputedRef<string>}
 */
export function useRelativeTime(source, { intervalMs = 1000 } = {}) {
  const now = useNow(intervalMs);
  return computed(() => {
    const v = typeof source === 'function' ? source() : unref(source);
    return formatRelative(v, now.value);
  });
}

/** Elapsed ms since `source` (null when unknown), ticking. */
export function useElapsed(source, { intervalMs = 1000 } = {}) {
  const now = useNow(intervalMs);
  return computed(() => {
    const v = typeof source === 'function' ? source() : unref(source);
    if (v === null || v === undefined || v === '') return null;
    const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
    return Number.isFinite(t) ? Math.max(0, now.value - t) : null;
  });
}
