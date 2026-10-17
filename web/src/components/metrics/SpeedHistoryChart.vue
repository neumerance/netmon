<script setup>
// Speed history chart (PLAN §8.6 metrics, DESIGN §3.9) — hand-written responsive SVG.
//  - Download: accent line + gradient area; points below the threshold are filled warning.
//  - Upload: info line.
//  - Dashed threshold line (settings.speedThresholdMbps) with a label pill and a faint band below.
//  - Internet-down intervals (from events) shaded; failed tests marked with an x at the baseline.
//  - Hover / touch / keyboard (←/→/Home/End/Esc) crosshair with a tooltip; hidden data table for SR.
//  - Ranges 6h / 24h / 7d / All. The snapshot carries the last 50 results; older ones are fetched
//    once from /api/speedtest/history so longer ranges are complete.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Card from '../ui/Card.vue';
import Icon from '../ui/Icon.vue';
import Button from '../ui/Button.vue';
import { state, runSpeedTest } from '../../store.js';
import { api } from '../../api.js';
import { useNow } from '../../composables/useNow.js';
import { formatDateTime, formatMbpsValue, mbpsUnit } from '../../lib/format.js';
import {
  clamp,
  clock,
  downIntervals,
  isNum,
  median,
  monthDay,
  msValue,
  nearestIndex,
  niceScale,
  splitRuns,
  timeTicks,
  toMs,
} from './metricsUtil.js';

const HOUR = 3_600_000;
const RANGES = [
  { key: '6h', label: '6h', ms: 6 * HOUR, mobile: false },
  { key: '24h', label: '24h', ms: 24 * HOUR, mobile: true },
  { key: '7d', label: '7d', ms: 7 * 24 * HOUR, mobile: true },
  { key: 'all', label: 'All', ms: null, mobile: true },
];
const RANGE_KEY = 'netmon.speedRange';

function loadRange() {
  try {
    const v = localStorage.getItem(RANGE_KEY);
    if (RANGES.some((r) => r.key === v)) return v;
  } catch {
    /* storage unavailable */
  }
  return '24h';
}
const range = ref(loadRange());
function setRange(key) {
  range.value = key;
  active.value = null;
  try {
    localStorage.setItem(RANGE_KEY, key);
  } catch {
    /* ignore */
  }
}

const now = useNow(5000);
const threshold = computed(() => state.settings?.speedThresholdMbps ?? 200);

// ---------------------------------------------------------------------------------------------
// Data: snapshot/SSE history + older results fetched over REST
// ---------------------------------------------------------------------------------------------
const older = ref([]);
let fetchSeq = 0;
async function fetchOlder() {
  const seq = ++fetchSeq;
  try {
    const res = await api.speedHistory(200);
    if (seq !== fetchSeq) return;
    const list = Array.isArray(res) ? res : Array.isArray(res?.history) ? res.history : [];
    older.value = list;
  } catch {
    /* non-fatal: the chart still shows the snapshot window */
  }
}
// The history array identity only changes when a full snapshot is applied (boot, reconnect,
// mock reset) — refetch then so stale older results never linger.
watch(
  () => state.speed?.history,
  () => {
    older.value = [];
    fetchOlder();
  },
);
onMounted(fetchOlder);

const allPoints = computed(() => {
  const live = (state.speed?.history || []).filter((r) => r && toMs(r.at) != null);
  const ids = new Set(live.map((r) => r.id));
  const oldestLive = live.length ? Math.min(...live.map((r) => toMs(r.at))) : Infinity;
  const extra = older.value.filter((r) => r && !ids.has(r.id) && toMs(r.at) != null && toMs(r.at) < oldestLive);
  return [...extra, ...live]
    .map((r) => ({ ...r, t: toMs(r.at) }))
    .sort((a, b) => a.t - b.t);
});

const domain = computed(() => {
  const pts = allPoints.value;
  const lastT = pts.length ? pts[pts.length - 1].t : 0;
  const end = Math.max(now.value, lastT);
  const r = RANGES.find((x) => x.key === range.value) || RANGES[1];
  let start;
  if (r.ms) start = end - r.ms;
  else start = pts.length ? pts[0].t : end - HOUR;
  if (end - start < HOUR) start = end - HOUR;
  return { start, end };
});

const points = computed(() => allPoints.value.filter((p) => p.t >= domain.value.start && p.t <= domain.value.end));

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------
const wrap = ref(null);
const width = ref(0);
let ro = null;
let rafId = 0;
onMounted(() => {
  const measure = () => {
    if (wrap.value) width.value = Math.max(0, Math.floor(wrap.value.clientWidth));
  };
  measure();
  if (typeof ResizeObserver !== 'undefined' && wrap.value) {
    ro = new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(measure);
    });
    ro.observe(wrap.value);
  }
});
onBeforeUnmount(() => {
  ro?.disconnect();
  cancelAnimationFrame(rafId);
  clearTimeout(freshTimer);
});

const PAD = { left: 44, right: 16, top: 12, bottom: 24 };
const height = computed(() => (width.value < 480 ? 180 : width.value < 768 ? 200 : 220));
const plot = computed(() => ({
  x0: PAD.left,
  x1: Math.max(PAD.left + 10, width.value - PAD.right),
  y0: PAD.top,
  y1: height.value - PAD.bottom,
}));

const yScale = computed(() => {
  let maxV = threshold.value;
  for (const p of points.value) {
    if (isNum(p.downloadMbps)) maxV = Math.max(maxV, p.downloadMbps);
    if (isNum(p.uploadMbps)) maxV = Math.max(maxV, p.uploadMbps);
  }
  return niceScale(maxV * 1.15, 4);
});

const xOf = (t) => {
  const { start, end } = domain.value;
  const { x0, x1 } = plot.value;
  return x0 + ((t - start) / Math.max(1, end - start)) * (x1 - x0);
};
const yOf = (v) => {
  const { y0, y1 } = plot.value;
  return y1 - (clamp(v, 0, yScale.value.max) / yScale.value.max) * (y1 - y0);
};

const yTicks = computed(() =>
  yScale.value.ticks.map((v) => ({ v, y: yOf(v), label: v >= 1000 ? `${+(v / 1000).toFixed(2)}G` : String(v) })),
);

const xTicks = computed(() => {
  const maxTicks = Math.max(2, Math.min(6, Math.floor((plot.value.x1 - plot.value.x0) / 90)));
  return timeTicks(domain.value.start, domain.value.end, maxTicks)
    .map((tk) => ({ ...tk, x: xOf(tk.t) }))
    .filter((tk) => tk.x >= plot.value.x0 + 12 && tk.x <= plot.value.x1 - 12);
});

// Break lines across gaps larger than 3x the test interval.
const maxGapMs = computed(() => {
  const intervalMs = (state.settings?.speedTestIntervalMin || 0) * 60_000;
  const pts = allPoints.value;
  const diffs = [];
  for (let i = 1; i < pts.length; i++) diffs.push(pts[i].t - pts[i - 1].t);
  const med = median(diffs) || 0;
  const base = Math.max(intervalMs, med, 5 * 60_000);
  return base * 3;
});

const geo = computed(() =>
  points.value.map((p) => ({
    p,
    x: xOf(p.t),
    yd: isNum(p.downloadMbps) ? yOf(p.downloadMbps) : null,
    yu: isNum(p.uploadMbps) ? yOf(p.uploadMbps) : null,
    below: isNum(p.downloadMbps) && p.downloadMbps < threshold.value,
  })),
);

const runs = computed(() => splitRuns(geo.value, (g) => g.p.t, maxGapMs.value));

const f = (n) => n.toFixed(1);
function linePath(run, key) {
  const pts = run.filter((g) => g[key] != null);
  if (pts.length < 2) return null;
  return pts.map((g, i) => `${i ? 'L' : 'M'}${f(g.x)} ${f(g[key])}`).join(' ');
}
function areaPath(run) {
  const pts = run.filter((g) => g.yd != null);
  if (pts.length < 2) return null;
  const base = plot.value.y1;
  return `${pts.map((g, i) => `${i ? 'L' : 'M'}${f(g.x)} ${f(g.yd)}`).join(' ')} L${f(pts[pts.length - 1].x)} ${f(base)} L${f(pts[0].x)} ${f(base)} Z`;
}
const downLines = computed(() => runs.value.map((r) => linePath(r, 'yd')).filter(Boolean));
const upLines = computed(() => runs.value.map((r) => linePath(r, 'yu')).filter(Boolean));
const areas = computed(() => runs.value.map(areaPath).filter(Boolean));

// Points are drawn when they are not too dense; below-threshold points always are.
const showAllPoints = computed(() => {
  const g = geo.value;
  if (g.length <= 1) return true;
  if (g.length > 80) return false;
  const gaps = [];
  for (let i = 1; i < g.length; i++) gaps.push(g[i].x - g[i - 1].x);
  return (median(gaps) ?? 0) >= 9;
});

const thresholdY = computed(() => (threshold.value <= yScale.value.max ? yOf(threshold.value) : null));
const thresholdLabel = computed(() => `${formatMbpsValue(threshold.value)} ${mbpsUnit(threshold.value)}`);
const thresholdPillW = computed(() => thresholdLabel.value.length * 5.6 + 10);

// Internet-down bands and failed tests (from the event log).
const downBands = computed(() => {
  const ivs = downIntervals(state.events, now.value, state.internet?.status === 'down');
  const { start, end } = domain.value;
  return ivs
    .filter((iv) => iv.end >= start && iv.start <= end)
    .map((iv) => {
      const x = xOf(Math.max(iv.start, start));
      const x2 = xOf(Math.min(iv.end, end));
      return { x, w: Math.max(2, x2 - x) };
    });
});
const failedMarks = computed(() => {
  const { start, end } = domain.value;
  return (state.events || [])
    .filter((e) => e?.type === 'speedtest_failed')
    .map((e) => ({ id: e.id, t: toMs(e.at), message: e.message }))
    .filter((e) => e.t != null && e.t >= start && e.t <= end)
    .map((e) => ({ ...e, x: xOf(e.t) }));
});

// ---------------------------------------------------------------------------------------------
// New-point animation
// ---------------------------------------------------------------------------------------------
const fresh = ref(new Set());
let knownIds = null;
let freshTimer = 0;
watch(
  () => allPoints.value.map((p) => p.id),
  (ids) => {
    if (knownIds == null) {
      knownIds = new Set(ids);
      return;
    }
    const added = ids.filter((id) => !knownIds.has(id));
    knownIds = new Set(ids);
    if (!added.length || added.length > 3) return; // bulk loads (snapshot / older fetch) don't animate
    fresh.value = new Set(added);
    clearTimeout(freshTimer);
    freshTimer = setTimeout(() => (fresh.value = new Set()), 400);
  },
  { immediate: true },
);

// ---------------------------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------------------------
const active = ref(null); // index into geo
const svgEl = ref(null);

function pickAt(clientX) {
  if (!svgEl.value || !geo.value.length) return;
  const rect = svgEl.value.getBoundingClientRect();
  const x = ((clientX - rect.left) / Math.max(1, rect.width)) * width.value;
  active.value = nearestIndex(
    geo.value.map((g) => g.x),
    x,
  );
}
function onPointerMove(e) {
  pickAt(e.clientX);
}
function onPointerLeave(e) {
  if (e.pointerType === 'mouse') active.value = null;
}
function onKeydown(e) {
  const n = geo.value.length;
  if (!n) return;
  const cur = active.value ?? n - 1;
  let next = null;
  if (e.key === 'ArrowLeft') next = active.value == null ? n - 1 : Math.max(0, cur - 1);
  else if (e.key === 'ArrowRight') next = active.value == null ? n - 1 : Math.min(n - 1, cur + 1);
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = n - 1;
  else if (e.key === 'Escape') {
    active.value = null;
    return;
  } else return;
  e.preventDefault();
  active.value = next;
}
watch(geo, (g) => {
  if (active.value != null && active.value >= g.length) active.value = g.length ? g.length - 1 : null;
});

const activeGeo = computed(() => (active.value != null ? geo.value[active.value] || null : null));

const TOOLTIP_W = 184;
const tooltipStyle = computed(() => {
  const g = activeGeo.value;
  if (!g) return null;
  const flip = g.x + 14 + TOOLTIP_W > width.value;
  const left = flip ? Math.max(0, g.x - 14 - TOOLTIP_W) : g.x + 14;
  const anchorY = g.yd ?? g.yu ?? plot.value.y1;
  const top = clamp(anchorY - 44, 0, Math.max(0, height.value - 112));
  return { left: `${left}px`, top: `${top}px`, width: `${TOOLTIP_W}px` };
});

function tooltipDate(t) {
  return `${clock(t)} · ${monthDay(t)}`;
}

// ---------------------------------------------------------------------------------------------
// A11y + misc
// ---------------------------------------------------------------------------------------------
const ariaLabel = computed(() => {
  const n = points.value.length;
  const lastP = points.value[n - 1];
  const rangeLabel = RANGES.find((r) => r.key === range.value)?.label || '';
  if (!n) return `Speed history (${rangeLabel}), no tests in this range`;
  return `Speed history (${rangeLabel}), ${n} test${n === 1 ? '' : 's'}, latest download ${formatMbpsValue(lastP.downloadMbps)} Mbps, upload ${formatMbpsValue(lastP.uploadMbps)} Mbps. Threshold ${threshold.value} Mbps. Use arrow keys to inspect points.`;
});

const hasAny = computed(() => allPoints.value.length > 0);
const internetDown = computed(() => state.internet?.status === 'down');
const runningTest = computed(() => !!state.speed?.running);

async function runNow() {
  try {
    await runSpeedTest();
  } catch {
    /* toasted by store */
  }
}

const gradId = `nm-speed-grad-${Math.random().toString(36).slice(2, 8)}`;
const clipId = `${gradId}-clip`;

// Ensure the first measure happens after the card is laid out (e.g. inside collapsed parents).
onMounted(() => nextTick(() => wrap.value && (width.value = Math.floor(wrap.value.clientWidth))));
</script>

<template>
  <Card :padded="false" data-testid="speed-chart" class="overflow-hidden">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3.5 pb-2">
      <div class="flex items-center gap-2">
        <Icon name="activity" :size="14" class="text-subtle" />
        <h2 class="text-[13px] font-semibold text-text">Speed history</h2>
      </div>

      <!-- legend -->
      <div class="hidden items-center gap-3 text-[11px] text-muted md:flex" aria-hidden="true">
        <span class="inline-flex items-center gap-1.5"><span class="h-2 w-2 rounded-full bg-accent" />Download</span>
        <span class="inline-flex items-center gap-1.5"><span class="h-2 w-2 rounded-full bg-info" />Upload</span>
        <span class="inline-flex items-center gap-1.5">
          <svg width="14" height="2" class="overflow-visible"><line x1="0" y1="1" x2="14" y2="1" class="stroke-warning" stroke-width="1.5" stroke-dasharray="3 2" /></svg>
          {{ thresholdLabel }}
        </span>
      </div>

      <div class="ml-auto inline-flex rounded-md border border-border bg-surface-2 p-0.5" role="group" aria-label="Time range">
        <button
          v-for="r in RANGES"
          :key="r.key"
          type="button"
          :data-testid="`speed-range-${r.key}`"
          :aria-pressed="range === r.key ? 'true' : 'false'"
          class="h-6 min-w-[34px] rounded-[5px] px-2 text-[12px] font-medium transition-colors duration-150"
          :class="[
            range === r.key ? 'bg-surface-3 text-text shadow-card' : 'text-muted hover:text-text',
            r.mobile ? '' : 'hidden sm:inline-block',
          ]"
          @click="setRange(r.key)"
        >{{ r.label }}</button>
      </div>
    </div>

    <div ref="wrap" class="relative px-0 pb-2" :style="{ height: height + 8 + 'px' }">
      <!-- Empty: no tests at all -->
      <div v-if="!hasAny" class="absolute inset-0 flex flex-col items-center justify-center gap-1 px-6 text-center">
        <Icon name="gauge" :size="22" class="mb-1 text-subtle" />
        <p class="text-[13px] font-medium text-text">No speed tests yet</p>
        <p class="text-xs text-muted">Results appear here after the first test.</p>
        <Button
          class="mt-2"
          variant="secondary"
          size="sm"
          icon="play"
          :disabled="internetDown || runningTest"
          @click="runNow"
        >Run speed test</Button>
      </div>

      <template v-else-if="width > 0">
        <svg
          ref="svgEl"
          :width="width"
          :height="height"
          :viewBox="`0 0 ${width} ${height}`"
          role="img"
          tabindex="0"
          :aria-label="ariaLabel"
          class="block touch-pan-y select-none outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
          @pointermove="onPointerMove"
          @pointerdown="onPointerMove"
          @pointerleave="onPointerLeave"
          @keydown="onKeydown"
          @blur="active = null"
        >
          <defs>
            <linearGradient :id="gradId" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" class="text-accent" stop-color="currentColor" stop-opacity="0.18" />
              <stop offset="100%" class="text-accent" stop-color="currentColor" stop-opacity="0" />
            </linearGradient>
            <clipPath :id="clipId">
              <rect :x="plot.x0" :y="plot.y0 - 4" :width="plot.x1 - plot.x0" :height="plot.y1 - plot.y0 + 8" />
            </clipPath>
          </defs>

          <!-- gridlines + y labels -->
          <g>
            <template v-for="tk in yTicks" :key="'y' + tk.v">
              <line :x1="plot.x0" :x2="plot.x1" :y1="tk.y" :y2="tk.y" class="stroke-border" stroke-width="1" shape-rendering="crispEdges" />
              <text :x="plot.x0 - 8" :y="tk.y + 3.5" text-anchor="end" class="fill-subtle text-[11px] tabular-nums">{{ tk.label }}</text>
            </template>
            <text :x="plot.x0 + 6" :y="plot.y0 + 10" class="fill-subtle text-[10px] font-medium">Mbps</text>
          </g>

          <!-- x labels -->
          <g>
            <text v-for="tk in xTicks" :key="'x' + tk.t" :x="tk.x" :y="height - 6" text-anchor="middle" class="fill-subtle text-[11px] tabular-nums">{{ tk.label }}</text>
          </g>

          <g :clip-path="`url(#${clipId})`">
            <!-- internet down bands -->
            <rect
              v-for="(b, i) in downBands"
              :key="'down' + i"
              :x="b.x"
              :y="plot.y0"
              :width="b.w"
              :height="plot.y1 - plot.y0"
              class="fill-danger/8"
            />

            <!-- below-threshold band -->
            <rect
              v-if="thresholdY != null"
              :x="plot.x0"
              :y="thresholdY"
              :width="plot.x1 - plot.x0"
              :height="Math.max(0, plot.y1 - thresholdY)"
              class="fill-warning/4"
            />

            <!-- download area + line -->
            <path v-for="(d, i) in areas" :key="'a' + i" :d="d" :fill="`url(#${gradId})`" />
            <path
              v-for="(d, i) in upLines"
              :key="'u' + i"
              :d="d"
              fill="none"
              class="stroke-info"
              stroke-width="1.5"
              stroke-linejoin="round"
              stroke-linecap="round"
            />
            <path
              v-for="(d, i) in downLines"
              :key="'d' + i"
              :d="d"
              fill="none"
              class="stroke-accent"
              stroke-width="2"
              stroke-linejoin="round"
              stroke-linecap="round"
            />
          </g>

          <!-- threshold line + label pill -->
          <g v-if="thresholdY != null">
            <line
              data-testid="threshold-line"
              :data-value="threshold"
              :x1="plot.x0"
              :x2="plot.x1"
              :y1="thresholdY"
              :y2="thresholdY"
              class="stroke-warning"
              stroke-width="1.25"
              stroke-dasharray="4 4"
              opacity="0.9"
            />
            <g :transform="`translate(${plot.x1 - thresholdPillW - 2}, ${Math.max(plot.y0, thresholdY - 17)})`">
              <rect :width="thresholdPillW" height="14" rx="3" class="fill-warning/15" />
              <text :x="thresholdPillW / 2" y="10" text-anchor="middle" class="fill-warning-fg text-[10px] font-medium tabular-nums">{{ thresholdLabel }}</text>
            </g>
          </g>

          <!-- failed tests -->
          <g v-for="m in failedMarks" :key="m.id" :transform="`translate(${m.x}, ${plot.y1 - 4})`" class="stroke-danger" stroke-width="1.5" stroke-linecap="round">
            <title>Speed test failed{{ m.message ? ': ' + m.message : '' }}</title>
            <line x1="-3" y1="-3" x2="3" y2="3" />
            <line x1="-3" y1="3" x2="3" y2="-3" />
          </g>

          <!-- crosshair -->
          <line
            v-if="activeGeo"
            :x1="activeGeo.x"
            :x2="activeGeo.x"
            :y1="plot.y0"
            :y2="plot.y1"
            class="stroke-border-strong"
            stroke-width="1"
            shape-rendering="crispEdges"
          />

          <!-- points -->
          <g>
            <template v-for="(g, i) in geo" :key="g.p.id">
              <circle
                v-if="g.yu != null && (showAllPoints || active === i)"
                :cx="g.x"
                :cy="g.yu"
                :r="active === i ? 3.5 : 2.5"
                class="fill-surface stroke-info"
                :class="{ 'nm-point-in': fresh.has(g.p.id) }"
                stroke-width="1.5"
              />
              <circle
                v-if="g.yd != null && (showAllPoints || g.below || active === i)"
                data-testid="speed-chart-point"
                :data-id="g.p.id"
                :data-below="g.below ? 'true' : 'false'"
                :cx="g.x"
                :cy="g.yd"
                :r="active === i ? 4.5 : 3"
                :class="[g.below ? 'fill-warning stroke-warning' : 'fill-surface stroke-accent', { 'nm-point-in': fresh.has(g.p.id) }]"
                stroke-width="1.5"
              />
            </template>
          </g>

          <!-- full-height hit area for hover -->
          <rect :x="plot.x0" :y="0" :width="plot.x1 - plot.x0" :height="height" fill="transparent" />
        </svg>

        <!-- No points in the selected range -->
        <div
          v-if="!points.length"
          class="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center"
        >
          <p class="text-[13px] font-medium text-text">No tests in this range</p>
          <p class="text-xs text-muted">Try a longer range.</p>
        </div>

        <!-- Tooltip -->
        <div
          v-if="activeGeo && tooltipStyle"
          class="pointer-events-none absolute z-10 rounded-lg border border-border bg-overlay p-2.5 text-xs shadow-popover"
          :style="tooltipStyle"
          data-testid="speed-chart-tooltip"
          role="presentation"
        >
          <div class="mb-1.5 text-[11px] font-medium text-subtle tabular-nums">{{ tooltipDate(activeGeo.p.t) }}</div>
          <div class="flex items-center justify-between gap-2">
            <span class="inline-flex items-center gap-1.5 text-muted"><span class="h-2 w-2 rounded-full bg-accent" />Download</span>
            <span class="font-medium tabular-nums" :class="activeGeo.below ? 'text-warning-fg' : 'text-text'">{{ formatMbpsValue(activeGeo.p.downloadMbps) }} {{ mbpsUnit(activeGeo.p.downloadMbps) }}</span>
          </div>
          <div class="mt-0.5 flex items-center justify-between gap-2">
            <span class="inline-flex items-center gap-1.5 text-muted"><span class="h-2 w-2 rounded-full bg-info" />Upload</span>
            <span class="font-medium tabular-nums text-text">{{ formatMbpsValue(activeGeo.p.uploadMbps) }} {{ mbpsUnit(activeGeo.p.uploadMbps) }}</span>
          </div>
          <div class="mt-1 text-[11px] text-subtle tabular-nums">
            Ping {{ msValue(activeGeo.p.pingMs) }} ms<template v-if="activeGeo.p.colo"> · {{ activeGeo.p.colo }}</template><template v-if="activeGeo.p.trigger"> · {{ activeGeo.p.trigger }}</template>
          </div>
          <div v-if="activeGeo.below" class="mt-1.5 inline-flex rounded-sm bg-warning/15 px-1.5 text-[10px] font-medium leading-4 text-warning-fg">Below threshold</div>
        </div>
      </template>
    </div>

    <!-- Screen-reader data table -->
    <table class="sr-only">
      <caption>Speed test results in the selected range</caption>
      <thead>
        <tr><th scope="col">Time</th><th scope="col">Download (Mbps)</th><th scope="col">Upload (Mbps)</th><th scope="col">Ping (ms)</th></tr>
      </thead>
      <tbody>
        <tr v-for="p in points" :key="'sr' + p.id">
          <td>{{ formatDateTime(p.at) }}</td>
          <td>{{ formatMbpsValue(p.downloadMbps) }}{{ p.downloadMbps < threshold ? ' (below threshold)' : '' }}</td>
          <td>{{ formatMbpsValue(p.uploadMbps) }}</td>
          <td>{{ msValue(p.pingMs) }}</td>
        </tr>
      </tbody>
    </table>
  </Card>
</template>

<style scoped>
.nm-point-in {
  transform-box: fill-box;
  transform-origin: center;
  animation: nm-point-in 240ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
@keyframes nm-point-in {
  from {
    transform: scale(0);
  }
  to {
    transform: scale(1);
  }
}
@media (prefers-reduced-motion: reduce) {
  .nm-point-in {
    animation: none;
  }
}
</style>
