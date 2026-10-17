<script setup>
// Tiny SVG trend line (PLAN §8.6, DESIGN §3.10). `null` values are gaps (lost samples) and draw a
// small danger tick at the bottom. Fewer than 2 numeric samples -> dashed baseline.
// Decorative (aria-hidden); the parent supplies accessible text.
import { computed, useId } from 'vue';

const props = defineProps({
  values: { type: Array, default: () => [] },
  width: { type: Number, default: 96 },
  height: { type: Number, default: 24 },
  tone: { type: String, default: 'brand' }, // brand | accent | success | warning | danger | info | neutral
  fill: { type: Boolean, default: true },
  minScale: { type: Number, default: 20 }, // y max is at least this (quiet series read as flat-low)
  maxScale: { type: Number, default: null }, // fixed y max (overrides auto)
  nullTicks: { type: Boolean, default: true },
  lastDot: { type: Boolean, default: true },
  strokeWidth: { type: Number, default: 1.5 },
});

const gid = `spark-${useId()}`.replace(/[^a-zA-Z0-9_-]/g, '');

const COLORS = {
  brand: 'var(--color-accent)',
  accent: 'var(--color-accent)',
  success: 'var(--color-success)',
  warning: 'var(--color-warning)',
  danger: 'var(--color-danger)',
  info: 'var(--color-info)',
  neutral: 'var(--color-subtle)',
};
const color = computed(() => COLORS[props.tone] || COLORS.brand);

const geo = computed(() => {
  const vals = (props.values || []).map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null));
  const nums = vals.filter((v) => v !== null);
  const W = props.width;
  const H = props.height;
  const inset = 1 + props.strokeWidth / 2;
  if (nums.length < 2) return { empty: true, W, H, vals };

  let yMax = props.maxScale;
  if (!(yMax > 0)) {
    const sorted = [...nums].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    yMax = Math.max(props.minScale, p95 * 1.25, 1e-9);
  }
  const n = vals.length;
  const x = (i) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v) => {
    const c = Math.min(Math.max(v, 0), yMax);
    return H - inset - (c / yMax) * (H - inset * 2);
  };

  const segments = [];
  let cur = [];
  vals.forEach((v, i) => {
    if (v === null) {
      if (cur.length) segments.push(cur);
      cur = [];
    } else cur.push([x(i), y(v)]);
  });
  if (cur.length) segments.push(cur);

  const fmt = (p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
  const lines = segments.map((s) => (s.length === 1 ? `M${fmt(s[0])}h0.01` : `M${s.map(fmt).join('L')}`));
  const areas = segments
    .filter((s) => s.length > 1)
    .map((s) => `M${s[0][0].toFixed(2)},${H}L${s.map(fmt).join('L')}L${s[s.length - 1][0].toFixed(2)},${H}Z`);
  const ticks = vals.map((v, i) => (v === null ? x(i) : null)).filter((v) => v !== null);
  let last = null;
  for (let i = n - 1; i >= 0; i--) {
    if (vals[i] !== null) {
      last = [x(i), y(vals[i])];
      break;
    }
  }
  return { empty: false, W, H, lines, areas, ticks, last };
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
  >
    <template v-if="geo.empty">
      <line
        x1="0"
        :y1="height - 1.5"
        :x2="width"
        :y2="height - 1.5"
        stroke="var(--color-border-strong)"
        stroke-width="1"
        stroke-dasharray="3 3"
        vector-effect="non-scaling-stroke"
      />
    </template>
    <template v-else>
      <defs v-if="fill">
        <linearGradient :id="gid" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" :stop-color="color" stop-opacity="0.16" />
          <stop offset="100%" :stop-color="color" stop-opacity="0" />
        </linearGradient>
      </defs>
      <path v-for="(d, i) in fill ? geo.areas : []" :key="'a' + i" :d="d" :fill="`url(#${gid})`" stroke="none" />
      <path
        v-for="(d, i) in geo.lines"
        :key="'l' + i"
        :d="d"
        fill="none"
        :stroke="color"
        :stroke-width="strokeWidth"
        stroke-linecap="round"
        stroke-linejoin="round"
        vector-effect="non-scaling-stroke"
      />
      <template v-if="nullTicks">
        <rect
          v-for="(tx, i) in geo.ticks"
          :key="'t' + i"
          :x="Math.max(0, Math.min(width - 1, tx - 0.5))"
          :y="height - 4"
          width="1"
          height="4"
          fill="var(--color-danger)"
        />
      </template>
      <circle v-if="lastDot && geo.last" :cx="geo.last[0]" :cy="geo.last[1]" r="1.75" :fill="color" />
    </template>
  </svg>
</template>
