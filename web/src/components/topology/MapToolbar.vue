<script setup>
// Floating map toolbar (TOPOLOGY.md §4.4): zoom out / readout / zoom in / fit · reset layout · group-by · legend.
// Replaces Vue Flow's <Controls>. Keyboard shortcuts (F, +, -) are handled by TopologyMap.
import { computed } from 'vue';
import IconButton from '../ui/IconButton.vue';
import Segmented from '../ui/Segmented.vue';
import Tooltip from '../ui/Tooltip.vue';

const props = defineProps({
  zoom: { type: Number, default: 1 },
  groupBy: { type: String, default: 'type' },
  legendOpen: { type: Boolean, default: false },
  pinnedCount: { type: Number, default: 0 },
  nodeCount: { type: Number, default: 0 },
  minZoom: { type: Number, default: 0.2 },
  maxZoom: { type: Number, default: 2 },
});

const emit = defineEmits(['fit', 'zoom-in', 'zoom-out', 'relayout', 'update:groupBy', 'toggle-legend']);

const zoomPct = computed(() => `${Math.round((Number(props.zoom) || 1) * 100)}%`);
const canZoomIn = computed(() => props.zoom < props.maxZoom - 0.001);
const canZoomOut = computed(() => props.zoom > props.minZoom + 0.001);

const GROUP_OPTIONS = [
  { value: 'type', label: 'By type', testid: 'map-groupby-type' },
  { value: 'flat', label: 'Flat', testid: 'map-groupby-flat' },
];

const relayoutTip = "Reset node positions — keeps 'Connected via'";
</script>

<template>
  <div
    class="nm-map-toolbar flex max-w-[calc(100vw-48px)] flex-wrap items-center gap-0.5 rounded-lg border border-border bg-surface/90 p-1 shadow-popover backdrop-blur"
    role="toolbar"
    aria-label="Map controls"
  >
    <Tooltip text="Zoom out (−)">
      <IconButton
        icon="minus"
        label="Zoom out"
        size="sm"
        :show-title="false"
        :disabled="!canZoomOut"
        data-testid="map-zoom-out-btn"
        @click="emit('zoom-out')"
      />
    </Tooltip>
    <span
      class="hidden w-10 select-none text-center text-[11px] font-medium leading-4 text-muted tabular-nums min-[400px]:inline-block"
      aria-live="off"
      data-testid="map-zoom-readout"
    >{{ zoomPct }}</span>
    <Tooltip text="Zoom in (+)">
      <IconButton
        icon="plus"
        label="Zoom in"
        size="sm"
        :show-title="false"
        :disabled="!canZoomIn"
        data-testid="map-zoom-in-btn"
        @click="emit('zoom-in')"
      />
    </Tooltip>
    <Tooltip text="Fit to screen (F)">
      <!-- Icon.vue has no "fit" glyph and icons.js must not change: inline four-corner-brackets SVG. -->
      <button
        type="button"
        class="nm-icon-btn inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors duration-[120ms] hover:bg-surface-3 hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
        aria-label="Fit to screen"
        data-testid="map-fit-btn"
        :disabled="nodeCount === 0"
        @click="emit('fit')"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M4 9V5a1 1 0 0 1 1-1h4" />
          <path d="M15 4h4a1 1 0 0 1 1 1v4" />
          <path d="M20 15v4a1 1 0 0 1-1 1h-4" />
          <path d="M9 20H5a1 1 0 0 1-1-1v-4" />
        </svg>
      </button>
    </Tooltip>

    <span class="mx-1 h-4 w-px bg-border" aria-hidden="true" />

    <Tooltip :text="pinnedCount > 0 ? relayoutTip : 'No pinned positions — drag a device to pin it'">
      <span class="relative inline-flex">
        <IconButton
          icon="rotate-ccw"
          label="Reset layout"
          size="sm"
          :show-title="false"
          :disabled="pinnedCount === 0"
          data-testid="map-relayout-btn"
          :data-pinned-count="pinnedCount"
          @click="emit('relayout')"
        />
        <span
          v-if="pinnedCount > 0"
          class="pointer-events-none absolute -right-0.5 -top-0.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-semibold leading-none text-accent-contrast tabular-nums"
          aria-hidden="true"
        >{{ pinnedCount > 99 ? '99+' : pinnedCount }}</span>
      </span>
    </Tooltip>

    <div class="mx-0.5 hidden min-[480px]:block">
      <Segmented
        :model-value="groupBy"
        :options="GROUP_OPTIONS"
        size="sm"
        label="Group devices"
        @update:model-value="(v) => emit('update:groupBy', v)"
      />
    </div>

    <Tooltip text="Legend">
      <IconButton
        icon="info"
        label="Legend"
        size="sm"
        :show-title="false"
        :active="legendOpen"
        :aria-expanded="legendOpen ? 'true' : 'false'"
        aria-controls="nm-map-legend"
        data-testid="map-legend-btn"
        @click="emit('toggle-legend')"
      />
    </Tooltip>
  </div>
</template>
