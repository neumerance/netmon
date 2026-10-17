<script setup>
// Tweened number text (DESIGN §8: KPI numbers tween 400 ms, rAF, tabular figures).
// The first value renders immediately (no count-up from 0); later changes ease from the
// previously displayed value. `null` renders through `format` (usually '—') without a tween.
// Attributes (data-testid, class, data-value...) fall through to the root <span>.
import { ref, watch, onBeforeUnmount } from 'vue';

const props = defineProps({
  value: { type: Number, default: null },
  format: { type: Function, default: (n) => (n == null ? '—' : String(n)) },
  duration: { type: Number, default: 400 },
  /** Set false to update instantly (e.g. live speed-test values already stream). */
  animate: { type: Boolean, default: true },
});

const display = ref(props.value);
let raf = 0;
let settle = 0; // guarantees the exact final value even when rAF is throttled (background tabs)

const reducedMotion = () => {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
};

// easeOutCubic — calm deceleration
const ease = (t) => 1 - (1 - t) ** 3;

watch(
  () => props.value,
  (to, from) => {
    cancelAnimationFrame(raf);
    clearTimeout(settle);
    const start = display.value;
    if (
      !props.animate ||
      to == null ||
      start == null ||
      from == null ||
      !Number.isFinite(to) ||
      !Number.isFinite(start) ||
      reducedMotion() ||
      typeof requestAnimationFrame === 'undefined'
    ) {
      display.value = to;
      return;
    }
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / props.duration);
      display.value = t >= 1 ? to : start + (to - start) * ease(t);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    settle = setTimeout(() => {
      cancelAnimationFrame(raf);
      display.value = to;
    }, props.duration + 100);
  },
);

onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  clearTimeout(settle);
});
</script>

<template>
  <span class="tabular-nums">{{ format(display) }}</span>
</template>
