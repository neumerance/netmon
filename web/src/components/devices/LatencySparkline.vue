<script setup>
// Tiny latency sparkline (DESIGN.md §3.10), hand-written SVG.
// - Y range 0 -> max(20, p95 * 1.25) ms so a quiet device reads flat-low instead of noisy.
// - Line breaks at nulls (lost pings); each loss draws a short red tick on the baseline.
// - Fewer than 2 samples -> dashed baseline.
import { computed, useId } from 'vue';

const props = defineProps({
  values: { type: Array, default: () => [] },
  width: { type: Number, default: 64 },
  height: { type: Number, default: 20 },
  color: { type: String, default: 'var(--color-accent)' },
  muted: { type: Boolean, default: false }
});

const gradId = `nm-spark-${useId()}`;
const INSET = 1.5;

const samples = computed(() =>
  (Array.isArray(props.values) ? props.values : []).map((v) =>
    v == null || !Number.isFinite(Number(v)) ? null : Number(v)
  )
);

const numeric = computed(() => samples.value.filter((v) => v != null));

const yMax = computed(() => {
  const sorted = [...numeric.value].sort((a, b) => a - b);
  if (!sorted.length) return 20;
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  return Math.max(20, p95 * 1.25);
});

const geometry = computed(() => {
  const vals = samples.value;
  const n = vals.length;
  const w = props.width;
  const h = props.height;
  if (numeric.value.length < 2 || n < 2) return null;
  const step = (w - INSET * 2) / (n - 1);
  const y = (v) => {
    const clamped = Math.min(v, yMax.value);
    return h - INSET - (clamped / yMax.value) * (h - INSET * 2);
  };
  const segments = [];
  let current = [];
  const losses = [];
  vals.forEach((v, i) => {
    const x = INSET + i * step;
    if (v == null) {
      losses.push(x);
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push([x, y(v)]);
    }
  });
  if (current.length) segments.push(current);

  const lines = segments.map((seg) =>
    seg.map(([x, yy], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${yy.toFixed(2)}`).join(' ')
  );
  // Area under each multi-point segment.
  const areas = segments
    .filter((seg) => seg.length > 1)
    .map((seg) => {
      const first = seg[0];
      const last = seg[seg.length - 1];
      const top = seg.map(([x, yy], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${yy.toFixed(2)}`).join(' ');
      return `${top} L${last[0].toFixed(2)} ${h} L${first[0].toFixed(2)} ${h} Z`;
    });
  // Singletons between two losses still deserve a visible dot.
  const dots = segments.filter((seg) => seg.length === 1).map((seg) => seg[0]);
  let lastPoint = null;
  for (let i = n - 1; i >= 0; i--) {
    if (vals[i] != null) {
      lastPoint = [INSET + i * step, y(vals[i])];
      break;
    }
  }
  return { lines, areas, dots, losses, lastPoint };
});
</script>

<template>
  <svg
    :width="width"
    :height="height"
    :viewBox="`0 0 ${width} ${height}`"
    preserveAspectRatio="none"
    aria-hidden="true"
    focusable="false"
    class="block shrink-0 overflow-visible"
    :class="muted ? 'opacity-50' : ''"
  >
    <template v-if="geometry">
      <defs>
        <linearGradient :id="gradId" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" :style="{ stopColor: color, stopOpacity: 0.18 }" />
          <stop offset="100%" :style="{ stopColor: color, stopOpacity: 0 }" />
        </linearGradient>
      </defs>
      <path v-for="(d, i) in geometry.areas" :key="`a${i}`" :d="d" :fill="`url(#${gradId})`" stroke="none" />
      <path
        v-for="(d, i) in geometry.lines"
        :key="`l${i}`"
        :d="d"
        fill="none"
        :style="{ stroke: color }"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        vector-effect="non-scaling-stroke"
      />
      <circle v-for="(p, i) in geometry.dots" :key="`d${i}`" :cx="p[0]" :cy="p[1]" r="1.25" :style="{ fill: color }" />
      <rect
        v-for="(x, i) in geometry.losses"
        :key="`x${i}`"
        :x="x - 0.5"
        :y="height - 4"
        width="1"
        height="4"
        style="fill: var(--color-danger)"
      />
      <circle v-if="geometry.lastPoint" :cx="geometry.lastPoint[0]" :cy="geometry.lastPoint[1]" r="1.75" :style="{ fill: color }" />
    </template>
    <line
      v-else
      :x1="INSET"
      :x2="width - INSET"
      :y1="height - INSET - 0.5"
      :y2="height - INSET - 0.5"
      stroke="currentColor"
      stroke-opacity="0.35"
      stroke-width="1"
      stroke-dasharray="2 2"
    />
  </svg>
</template>
