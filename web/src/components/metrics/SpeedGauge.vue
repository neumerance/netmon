<script setup>
// Live speed dial (met-internal, used by SpeedTestCard). Hand-drawn SVG: a 240° track, a value arc
// whose length animates via stroke-dasharray, and a dashed tick at the alarm threshold.
// Purely presentational — the parent decides value/max/tone/label.
import { computed } from 'vue';
import { formatMbpsValue, mbpsUnit } from '../../lib/format.js';
import { clamp, isNum } from './metricsUtil.js';

const props = defineProps({
  value: { type: Number, default: null },
  max: { type: Number, default: 1000 },
  threshold: { type: Number, default: null },
  /** 'accent' | 'info' | 'warning' | 'success' | 'muted' */
  tone: { type: String, default: 'accent' },
  /** Small caption under the number ('Download', 'Upload', 'Last test'...). */
  label: { type: String, default: '' },
  /** Live measurement in progress (subtle emphasis, no value transition lag). */
  live: { type: Boolean, default: false },
  size: { type: Number, default: 132 },
});

// Geometry in a fixed viewBox; the SVG scales to `size` px wide.
const CX = 64;
const CY = 60;
const R = 50;
const SWEEP = 240; // degrees, symmetric around 12 o'clock
const VB_W = 128;
const VB_H = 94;

function polar(angleDeg, r = R) {
  const a = (angleDeg * Math.PI) / 180;
  return [CX + r * Math.sin(a), CY - r * Math.cos(a)];
}

const startAngle = -SWEEP / 2;
const endAngle = SWEEP / 2;
const [sx, sy] = polar(startAngle);
const [ex, ey] = polar(endAngle);
const arcPath = `M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${R} ${R} 0 1 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`;

const fraction = computed(() => (isNum(props.value) && props.max > 0 ? clamp(props.value / props.max, 0, 1) : 0));

const thresholdTick = computed(() => {
  if (!isNum(props.threshold) || props.max <= 0 || props.threshold > props.max) return null;
  const angle = startAngle + SWEEP * clamp(props.threshold / props.max, 0, 1);
  const [x1, y1] = polar(angle, R - 8);
  const [x2, y2] = polar(angle, R + 7);
  return { x1, y1, x2, y2 };
});

const toneStroke = computed(
  () =>
    ({
      accent: 'stroke-accent',
      info: 'stroke-info',
      warning: 'stroke-warning',
      success: 'stroke-success',
      muted: 'stroke-border-strong',
    })[props.tone] || 'stroke-accent',
);

const valueText = computed(() => formatMbpsValue(props.value));
const unitText = computed(() => mbpsUnit(props.value));
const maxLabel = computed(() => (props.max >= 1000 ? `${+(props.max / 1000).toFixed(1)}G` : String(Math.round(props.max))));

const ariaLabel = computed(() => {
  const v = isNum(props.value) ? `${valueText.value} ${unitText.value}` : 'no value';
  return `${props.label ? props.label + ': ' : ''}${v}`;
});
</script>

<template>
  <div class="relative shrink-0" :style="{ width: size + 'px' }" role="img" :aria-label="ariaLabel">
    <svg :viewBox="`0 0 ${VB_W} ${VB_H}`" class="block h-auto w-full overflow-visible" aria-hidden="true">
      <!-- track -->
      <path :d="arcPath" fill="none" class="stroke-surface-3" stroke-width="8" stroke-linecap="round" />
      <!-- value -->
      <path
        :d="arcPath"
        fill="none"
        :class="[toneStroke, live ? 'nm-gauge-live' : 'nm-gauge-ease']"
        stroke-width="8"
        stroke-linecap="round"
        pathLength="100"
        :stroke-dasharray="`${(fraction * 100).toFixed(2)} 200`"
        :opacity="fraction > 0 ? 1 : 0"
      />
      <!-- threshold tick -->
      <line
        v-if="thresholdTick"
        :x1="thresholdTick.x1"
        :y1="thresholdTick.y1"
        :x2="thresholdTick.x2"
        :y2="thresholdTick.y2"
        class="stroke-warning"
        stroke-width="1.5"
        stroke-linecap="round"
      >
        <title>Threshold {{ threshold }} Mbps</title>
      </line>
      <text :x="sx" :y="VB_H - 1" text-anchor="middle" class="fill-subtle text-[9px]">0</text>
      <text :x="ex" :y="VB_H - 1" text-anchor="middle" class="fill-subtle text-[9px]">{{ maxLabel }}</text>
    </svg>
    <div class="pointer-events-none absolute inset-x-0 top-[24%] flex flex-col items-center leading-none">
      <span
        class="text-[22px] font-semibold tracking-tight tabular-nums"
        :class="isNum(value) ? 'text-text' : 'text-subtle'"
      >{{ valueText }}</span>
      <span class="mt-1 text-[11px] font-medium text-muted">{{ unitText }}</span>
    </div>
    <div
      v-if="label"
      class="-mt-0.5 truncate text-center text-[10px] font-medium uppercase leading-4 tracking-[0.06em] text-subtle"
    >{{ label }}</div>
  </div>
</template>

<style scoped>
.nm-gauge-ease {
  transition: stroke-dasharray 400ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.nm-gauge-live {
  transition: stroke-dasharray 180ms linear;
}
@media (prefers-reduced-motion: reduce) {
  .nm-gauge-ease,
  .nm-gauge-live {
    transition: none;
  }
}
</style>
