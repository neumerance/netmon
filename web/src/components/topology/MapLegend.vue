<script setup>
// Static map legend card (TOPOLOGY.md §4.5). Opened from MapToolbar's Legend button.
import IconButton from '../ui/IconButton.vue';
import Icon from '../ui/Icon.vue';
import { TINT_CLASSES } from '../../lib/deviceTypes.js';
import { GROUP_ORDER, GROUP_LABELS } from './layout.js';

const emit = defineEmits(['close']);

const LINES = [
  // Opacities match LinkEdge's STYLES so the swatches look like the real lines.
  { label: 'Good connection', color: 'var(--color-success)', opacity: 0.55, dash: null },
  { label: 'Fair connection', color: 'var(--color-warning)', opacity: 0.8, dash: null },
  { label: 'Poor connection', color: 'var(--color-danger)', opacity: 0.9, dash: null },
  { label: 'This computer', color: 'var(--color-accent)', opacity: 0.7, dash: null },
  { label: 'Online, no ping reply', color: 'var(--color-success)', opacity: 0.4, dash: null },
  { label: 'No data yet', color: 'var(--color-border-strong)', opacity: 1, dash: null },
  { label: 'Offline', color: 'var(--color-subtle)', opacity: 0.5, dash: '4 4' },
];

const groups = GROUP_ORDER.map((g) => ({ key: g, label: GROUP_LABELS[g] || g, dot: (TINT_CLASSES[g] || TINT_CLASSES.unknown).dot }));

function onKeydown(e) {
  if (e.key === 'Escape') {
    // Close the legend first; don't let the map also clear the selection.
    e.stopPropagation();
    emit('close');
  }
}
</script>

<template>
  <section
    id="nm-map-legend"
    class="w-[272px] max-w-[calc(100vw-48px)] rounded-lg border border-border bg-overlay p-3 text-xs text-text shadow-popover animate-nm-pop-in"
    data-testid="map-legend"
    aria-labelledby="nm-map-legend-title"
    @keydown="onKeydown"
  >
    <header class="mb-2 flex items-center justify-between">
      <h3 id="nm-map-legend-title" class="text-[13px] font-semibold leading-[18px]">Legend</h3>
      <IconButton icon="x" label="Close legend" size="sm" class="-mr-1" @click="emit('close')" />
    </header>

    <ul class="space-y-1.5">
      <li v-for="l in LINES" :key="l.label" class="flex items-center gap-2">
        <svg width="28" height="8" viewBox="0 0 28 8" aria-hidden="true" class="shrink-0">
          <line
            x1="2"
            y1="4"
            x2="26"
            y2="4"
            :style="{ stroke: l.color, strokeOpacity: l.opacity, strokeWidth: 2, strokeLinecap: 'round', strokeDasharray: l.dash || undefined }"
          />
        </svg>
        <span class="text-muted">{{ l.label }}</span>
      </li>
      <li class="flex items-center gap-2">
        <svg width="28" height="8" viewBox="0 0 28 8" aria-hidden="true" class="shrink-0">
          <line x1="2" y1="4" x2="26" y2="4" :style="{ stroke: 'var(--color-success)', strokeOpacity: 0.45, strokeWidth: 1.5 }" />
          <circle cx="10" cy="4" r="2" :style="{ fill: 'var(--color-success)' }" />
          <circle cx="20" cy="4" r="2" :style="{ fill: 'var(--color-success)' }" />
        </svg>
        <span class="text-muted">Moving dots = device is online</span>
      </li>
      <li class="flex items-center gap-2">
        <span class="flex w-7 shrink-0 justify-center" aria-hidden="true">
          <span class="h-3.5 w-3.5 rounded-[4px] bg-surface" :style="{ boxShadow: '0 0 0 2px color-mix(in oklab, var(--color-accent) 70%, transparent)' }" />
        </span>
        <span class="text-muted">Accent ring = this computer</span>
      </li>
      <li class="flex items-center gap-2">
        <span class="flex w-7 shrink-0 justify-center text-subtle" aria-hidden="true"><Icon name="pin" :size="12" :stroke-width="2" /></span>
        <span class="text-muted">Position pinned by you</span>
      </li>
    </ul>

    <div class="my-2.5 h-px bg-border" aria-hidden="true" />

    <ul class="grid grid-cols-[auto_auto] justify-start gap-x-4 gap-y-1">
      <li v-for="g in groups" :key="g.key" class="flex min-w-0 items-center gap-1.5">
        <span class="h-2 w-2 shrink-0 rounded-full" :class="g.dot" aria-hidden="true" />
        <span class="whitespace-nowrap text-muted">{{ g.label }}</span>
      </li>
    </ul>

    <p class="mt-2.5 text-[11px] leading-4 text-muted">
      Lines show the path from the internet to each device. NetMon can't see which access point a device uses —
      drag a device onto an access point, or set 'Connected via' in its details.
    </p>
  </section>
</template>
