<script setup>
// Larger latency chart for the device detail panel (TOPOLOGY.md §5.2).
//
// - Hand-written SVG, width = container (ResizeObserver, rAF-debounced), fixed height.
// - Y axis 0 -> max(20, max * 1.2) ms rounded up to a "nice" value; 3 gridlines (0, mid, top) with
//   10 px labels in a left gutter ("20 ms" unit only on the top label).
// - Line 1.75 px in the quality colour, area gradient 18 % -> 0, dashed average line.
// - Null samples (lost pings) break the line and draw a 1x5 px danger tick on the baseline.
// - Hover / touch crosshair + tooltip "8.1 ms · 12 s ago" (or "#i of n" when the ping interval
//   is unknown).
// - Fewer than 2 numeric samples: dashed baseline + "No samples yet".
// Colours come from CSS custom properties via `style` (never var() in presentation attributes).
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import { QUALITY } from '../devices/deviceUi.js';
import { formatMsValue } from '../../lib/format.js';

const props = defineProps({
  values: { type: Array, default: () => [] },
  quality: { type: String, default: 'none' },
  height: { type: Number, default: 96 },
  muted: { type: Boolean, default: false },
  /** Ping interval in ms (sample age = (n-1-i) * interval). null -> tooltip shows "#i of n". */
  intervalMs: { type: Number, default: null }
});

const gradId = `nm-dlc-${useId()}`.replace(/[^a-zA-Z0-9_-]/g, '');

const GUTTER = 34; // left label gutter (px)
const PAD_TOP = 6;
const PAD_BOTTOM = 6;
const PAD_RIGHT = 4;

/* ---------------------------------------------------------------- container width */
const wrap = ref(null);
const width = ref(320);
let ro = null;
let raf = 0;

function measure() {
  raf = 0;
  const w = wrap.value?.clientWidth;
  if (w && Math.abs(w - width.value) >= 1) width.value = Math.round(w);
}

onMounted(() => {
  measure();
  if (typeof ResizeObserver !== 'undefined' && wrap.value) {
    ro = new ResizeObserver(() => {
      if (!raf) raf = requestAnimationFrame(measure);
    });
    ro.observe(wrap.value);
  }
});
onBeforeUnmount(() => {
  ro?.disconnect();
  ro = null;
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
});

/* ---------------------------------------------------------------- data */
const samples = computed(() =>
  (Array.isArray(props.values) ? props.values : []).map((v) =>
    v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v)
  )
);
const numeric = computed(() => samples.value.filter((v) => v != null));
const lost = computed(() => samples.value.length - numeric.value.length);
const hasChart = computed(() => numeric.value.length >= 2 && samples.value.length >= 2);

const stats = computed(() => {
  const nums = numeric.value;
  if (!nums.length) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of nums) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { min, max, avg: sum / nums.length };
});

const fmt1 = (v) => (v == null || !Number.isFinite(v) ? '' : (Math.round(v * 10) / 10).toFixed(1));

/** Round up to 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8 x 10^k so axis labels stay readable. */
function niceCeil(v) {
  if (!(v > 0)) return 20;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  const s = steps.find((x) => f <= x + 1e-9) ?? 10;
  return s * exp;
}

const yTop = computed(() => niceCeil(Math.max(20, (stats.value?.max ?? 0) * 1.2)));

const color = computed(() => {
  if (props.muted) return 'var(--color-subtle)';
  return (QUALITY[props.quality] ?? QUALITY.none).stroke;
});

/* ---------------------------------------------------------------- geometry */
const plot = computed(() => {
  const W = Math.max(GUTTER + 40, width.value);
  const H = Math.max(40, props.height);
  return { W, H, x0: GUTTER, x1: W - PAD_RIGHT, y0: PAD_TOP, y1: H - PAD_BOTTOM };
});

function xAt(i, n) {
  const { x0, x1 } = plot.value;
  return n <= 1 ? (x0 + x1) / 2 : x0 + (i / (n - 1)) * (x1 - x0);
}
function yAt(v) {
  const { y0, y1 } = plot.value;
  const c = Math.min(Math.max(v, 0), yTop.value);
  return y1 - (c / yTop.value) * (y1 - y0);
}

const geo = computed(() => {
  if (!hasChart.value) return null;
  const vals = samples.value;
  const n = vals.length;
  const { y1 } = plot.value;
  const segs = [];
  let cur = [];
  const ticks = [];
  vals.forEach((v, i) => {
    const x = xAt(i, n);
    if (v == null) {
      ticks.push(x);
      if (cur.length) segs.push(cur);
      cur = [];
    } else cur.push([x, yAt(v)]);
  });
  if (cur.length) segs.push(cur);
  const p = (pt) => `${pt[0].toFixed(2)},${pt[1].toFixed(2)}`;
  const lines = segs.map((s) => (s.length === 1 ? `M${p(s[0])}h0.01` : `M${s.map(p).join('L')}`));
  const areas = segs
    .filter((s) => s.length > 1)
    .map((s) => `M${s[0][0].toFixed(2)},${y1}L${s.map(p).join('L')}L${s[s.length - 1][0].toFixed(2)},${y1}Z`);
  const singles = segs.filter((s) => s.length === 1).map((s) => s[0]);
  let last = null;
  for (let i = n - 1; i >= 0; i--) {
    if (vals[i] != null) {
      last = [xAt(i, n), yAt(vals[i])];
      break;
    }
  }
  const avgY = stats.value ? yAt(stats.value.avg) : null;
  return { lines, areas, singles, ticks, last, avgY };
});

const grid = computed(() => {
  const top = yTop.value;
  const mid = top / 2;
  return [
    { y: yAt(top), label: `${formatMsValue(top)} ms` },
    { y: yAt(mid), label: formatMsValue(mid) },
    { y: yAt(0), label: '0' }
  ];
});

/* ---------------------------------------------------------------- hover / touch */
const hoverIndex = ref(null);

function indexFromEvent(e) {
  const svg = e.currentTarget;
  const rect = svg?.getBoundingClientRect?.();
  if (!rect || !rect.width) return null;
  const x = ((e.clientX - rect.left) / rect.width) * plot.value.W;
  const n = samples.value.length;
  if (n < 1) return null;
  const { x0, x1 } = plot.value;
  if (n === 1) return 0;
  const i = Math.round(((x - x0) / (x1 - x0)) * (n - 1));
  return Math.max(0, Math.min(n - 1, i));
}
function onPointerMove(e) {
  if (!hasChart.value) return;
  hoverIndex.value = indexFromEvent(e);
}
function onPointerLeave() {
  hoverIndex.value = null;
}

function ageText(i) {
  const n = samples.value.length;
  const iv = Number(props.intervalMs);
  if (!(iv > 0)) return `#${i + 1} of ${n}`;
  const ms = (n - 1 - i) * iv;
  if (ms <= 0) return 'latest';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return rs ? `${m} min ${rs} s ago` : `${m} min ago`;
}

const hover = computed(() => {
  const i = hoverIndex.value;
  if (i == null || !hasChart.value) return null;
  const v = samples.value[i];
  const x = xAt(i, samples.value.length);
  const y = v == null ? plot.value.y1 : yAt(v);
  const value = v == null ? 'Lost' : `${formatMsValue(v)} ms`;
  // Tooltip box position as % of the width so it tracks the SVG when it is stretched.
  const leftPct = (x / plot.value.W) * 100;
  return { i, x, y, lostSample: v == null, text: `${value} · ${ageText(i)}`, leftPct };
});

/* ---------------------------------------------------------------- text */
const summary = computed(() => {
  const s = stats.value;
  // No min/avg/max under an empty chart (a single sample would contradict "waiting for samples").
  if (!s || !hasChart.value) return '';
  return `Min ${formatMsValue(s.min)} · Avg ${formatMsValue(s.avg)} · Max ${formatMsValue(s.max)} ms`;
});

const ariaLabel = computed(() => {
  const n = samples.value.length;
  const s = stats.value;
  if (!hasChart.value || !s) return 'Latency: no samples yet';
  return `Latency, last ${n} pings: average ${formatMsValue(s.avg)} ms, max ${formatMsValue(s.max)} ms, ${lost.value} lost`;
});
</script>

<template>
  <div
    data-testid="detail-latency-chart"
    :data-samples="samples.length"
    :data-min="fmt1(stats?.min)"
    :data-avg="fmt1(stats?.avg)"
    :data-max="fmt1(stats?.max)"
    :data-muted="muted ? 'true' : 'false'"
    class="min-w-0"
  >
    <div ref="wrap" class="relative w-full" :style="{ height: `${height}px` }">
      <svg
        v-if="hasChart"
        :width="plot.W"
        :height="plot.H"
        :viewBox="`0 0 ${plot.W} ${plot.H}`"
        role="img"
        :aria-label="ariaLabel"
        class="block h-full w-full touch-pan-y select-none overflow-visible"
        :class="muted ? 'opacity-60' : ''"
        @pointermove="onPointerMove"
        @pointerdown="onPointerMove"
        @pointerleave="onPointerLeave"
        @pointercancel="onPointerLeave"
      >
        <defs>
          <linearGradient :id="gradId" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" :style="{ stopColor: color, stopOpacity: 0.18 }" />
            <stop offset="100%" :style="{ stopColor: color, stopOpacity: 0 }" />
          </linearGradient>
        </defs>

        <!-- Gridlines + labels -->
        <g aria-hidden="true">
          <template v-for="(g, i) in grid" :key="`g${i}`">
            <line
              :x1="plot.x0"
              :x2="plot.x1"
              :y1="Math.round(g.y) + 0.5"
              :y2="Math.round(g.y) + 0.5"
              style="stroke: var(--color-border)"
              stroke-width="1"
              shape-rendering="crispEdges"
            />
            <text
              :x="plot.x0 - 6"
              :y="g.y"
              text-anchor="end"
              dominant-baseline="middle"
              class="tabular-nums"
              style="fill: var(--color-subtle); font-size: 10px"
            >{{ g.label }}</text>
          </template>
        </g>

        <!-- Area + line -->
        <path v-for="(d, i) in geo.areas" :key="`a${i}`" :d="d" :fill="`url(#${gradId})`" stroke="none" />
        <path
          v-for="(d, i) in geo.lines"
          :key="`l${i}`"
          :d="d"
          fill="none"
          :style="{ stroke: color }"
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <circle
          v-for="(pt, i) in geo.singles"
          :key="`s${i}`"
          :cx="pt[0]"
          :cy="pt[1]"
          r="1.5"
          :style="{ fill: color }"
        />

        <!-- Average -->
        <line
          v-if="geo.avgY != null"
          :x1="plot.x0"
          :x2="plot.x1"
          :y1="geo.avgY"
          :y2="geo.avgY"
          style="stroke: var(--color-border-strong)"
          stroke-width="1"
          stroke-dasharray="3 3"
        />

        <!-- Lost pings -->
        <rect
          v-for="(x, i) in geo.ticks"
          :key="`t${i}`"
          :x="x - 0.5"
          :y="plot.y1 - 5"
          width="1"
          height="5"
          style="fill: var(--color-danger)"
        />

        <circle
          v-if="geo.last"
          :cx="geo.last[0]"
          :cy="geo.last[1]"
          r="2.5"
          :style="{ fill: color }"
        />

        <!-- Crosshair -->
        <g v-if="hover" aria-hidden="true">
          <line
            :x1="hover.x"
            :x2="hover.x"
            :y1="plot.y0"
            :y2="plot.y1"
            style="stroke: var(--color-border-strong)"
            stroke-width="1"
          />
          <circle
            :cx="hover.x"
            :cy="hover.y"
            r="3"
            :style="{
              fill: hover.lostSample ? 'var(--color-danger)' : color,
              stroke: 'var(--color-overlay)'
            }"
            stroke-width="1.5"
          />
        </g>
      </svg>

      <!-- Empty: dashed baseline -->
      <div v-else class="flex h-full flex-col justify-end" role="img" :aria-label="ariaLabel">
        <div class="relative mb-1.5 flex-1">
          <span class="absolute inset-0 grid place-items-center text-xs text-subtle">{{ numeric.length === 1 ? 'Waiting for more samples…' : 'No samples yet' }}</span>
        </div>
        <div class="border-t border-dashed border-border-strong" />
      </div>

      <!-- Tooltip -->
      <div
        v-if="hover"
        class="pointer-events-none absolute top-0 z-10 -translate-x-1/2 -translate-y-[calc(100%+4px)] whitespace-nowrap rounded-md border border-border bg-overlay px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-text shadow-popover"
        :style="{ left: `clamp(48px, ${hover.leftPct}%, calc(100% - 48px))` }"
        data-testid="detail-latency-tooltip"
      >
        {{ hover.text }}
      </div>
    </div>
    <p v-if="summary" class="mt-1.5 text-[11px] tabular-nums text-muted">{{ summary }}</p>
  </div>
</template>
