<script setup>
// Straight link between a parent and a child anchor (TOPOLOGY.md §4.3). Colour = child's ping quality,
// dashed when offline/unknown/down, SMIL "flow dots" (parent → child) on online links, hover label.
// Colours are applied through `style` (CSS custom properties are not reliable in SVG presentation attributes).
import { computed, inject, ref } from 'vue';
import { EdgeLabelRenderer } from '@vue-flow/core';

defineOptions({ inheritAttrs: false });

const props = defineProps({
  id: { type: String, required: true },
  source: { type: String, default: '' },
  target: { type: String, default: '' },
  sourceX: { type: Number, default: 0 },
  sourceY: { type: Number, default: 0 },
  targetX: { type: Number, default: 0 },
  targetY: { type: Number, default: 0 },
  data: { type: Object, default: () => ({}) },
});

const INERT = { selectedId: null, hoveredId: null, reducedMotion: false };
const ctx = inject('nm-topology-ctx', INERT);

const STYLES = {
  good: { color: 'var(--color-success)', opacity: 0.55, dash: null },
  fair: { color: 'var(--color-warning)', opacity: 0.8, dash: null },
  poor: { color: 'var(--color-danger)', opacity: 0.9, dash: null },
  self: { color: 'var(--color-accent)', opacity: 0.7, dash: null },
  none: { color: 'var(--color-border-strong)', opacity: 1, dash: null },
  // Online (seen on the network) but ignores ping: online green, a little fainter than a measured link.
  noping: { color: 'var(--color-success)', opacity: 0.4, dash: null },
  unknown: { color: 'var(--color-border-strong)', opacity: 1, dash: '2 4' },
  offline: { color: 'var(--color-subtle)', opacity: 0.5, dash: '4 4' },
  down: { color: 'var(--color-danger)', opacity: 0.9, dash: '6 4' },
};
const WIDTHS = { wan: 2.5, uplink: 2, lan: 1.5 };

const hovered = ref(false);

const kind = computed(() => props.data.kind || 'lan');
const look = computed(() => STYLES[props.data.quality] || STYLES.none);

const d = computed(
  () => `M ${round(props.sourceX)} ${round(props.sourceY)} L ${round(props.targetX)} ${round(props.targetY)}`,
);

// "Touching" = the selected / hovered node is either end of this edge.
const touching = computed(() => {
  const ids = [ctx.selectedId, ctx.hoveredId].filter(Boolean);
  return ids.includes(props.source) || ids.includes(props.target);
});
// Label only for the edge itself or the edge leading INTO the hovered / selected node (hovering the gateway
// would otherwise pop a label on every LAN link at once).
const labelVisible = computed(() => {
  if (!props.data.label) return false;
  if (hovered.value) return true;
  return [ctx.selectedId, ctx.hoveredId].filter(Boolean).includes(props.target);
});
const emphasized = computed(() => hovered.value || touching.value);

const lineStyle = computed(() => {
  const base = WIDTHS[kind.value] ?? 1.5;
  let opacity = look.value.opacity;
  if (props.data.dimmed && !emphasized.value) opacity = props.data.context ? 0.35 : 0.12;
  else if (emphasized.value) opacity = 1;
  return {
    stroke: look.value.color,
    strokeOpacity: opacity,
    strokeWidth: emphasized.value ? base + 1 : base,
    // Parent hub offline while this device still answers: the path is doubtful -> "assumed" dash.
    strokeDasharray: look.value.dash || (props.data.viaOfflineParent ? '2 4' : undefined),
    strokeLinecap: 'round',
    fill: 'none',
    transition: 'stroke-opacity 120ms ease, stroke-width 120ms ease, stroke 300ms ease',
  };
});

const animated = computed(() => !!props.data.animated && !props.data.dimmed && !ctx.reducedMotion);
// Constant dot speed (~140 px/s, WAN a bit faster) so long and short links move at the same calm pace.
const dur = computed(() => {
  const len = Math.hypot(props.targetX - props.sourceX, props.targetY - props.sourceY) || 0;
  const v = kind.value === 'wan' ? 180 : 140;
  const min = kind.value === 'wan' ? 1.2 : 1.6;
  return Math.round(Math.min(Math.max(len / v, min), 4) * 10) / 10;
});
const dotR = computed(() => (kind.value === 'wan' ? 2.5 : 2));
const dots = computed(() => (kind.value === 'wan' ? [0, -dur.value / 2] : [0]));
const dotStyle = computed(() => ({ fill: look.value.color, fillOpacity: emphasized.value ? 1 : 0.9 }));

const mid = computed(() => ({ x: (props.sourceX + props.targetX) / 2, y: (props.sourceY + props.targetY) / 2 }));

function round(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}
</script>

<template>
  <g
    class="nm-link"
    :data-testid="data.testid"
    :data-kind="kind"
    :data-quality="data.quality"
    :data-online="String(!!data.online)"
    :data-animated="String(animated)"
    :data-assumed="String(!!data.assumed)"
    :data-dimmed="String(!!data.dimmed)"
    :data-context="data.context ? 'true' : undefined"
    :data-via-offline-parent="data.viaOfflineParent ? 'true' : undefined"
    :data-source="source"
    :data-target="target"
  >
    <path
      class="nm-link-hit"
      :d="d"
      stroke="transparent"
      stroke-width="16"
      fill="none"
      @mouseenter="hovered = true"
      @mouseleave="hovered = false"
    />
    <path class="nm-link-line" :d="d" :style="lineStyle" />
    <template v-if="animated">
      <circle v-for="(begin, i) in dots" :key="i" :r="dotR" :style="dotStyle" class="nm-link-dot">
        <animateMotion :dur="dur + 's'" :begin="begin + 's'" repeatCount="indefinite" :path="d" />
      </circle>
    </template>
  </g>
  <EdgeLabelRenderer>
    <div
      v-if="labelVisible"
      class="nm-edge-label pointer-events-none absolute inline-flex h-5 items-center whitespace-nowrap rounded-md border border-border bg-overlay px-1.5 text-[11px] font-medium leading-4 text-text shadow-popover tabular-nums"
      :style="{ transform: `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px)`, zIndex: 1000 }"
      data-testid="map-edge-label"
      :data-edge="id"
    >{{ data.label }}</div>
  </EdgeLabelRenderer>
</template>
