<script setup>
// Map node for a hub: access point / mesh node / switch / secondary router (TOPOLOGY.md §4.2).
// 136×104 box: 52 px tile, name, type label and a "<n> devices" pill. Hubs are drop targets for re-parenting.
import { computed, inject } from 'vue';
import { Handle, Position } from '@vue-flow/core';
import Icon from '../../ui/Icon.vue';
import { categoryTint, OFFLINE_TILE, QUALITY } from '../../devices/deviceUi.js';
import { formatMs } from '../../../lib/format.js';
import { NODE_SIZES } from '../layout.js';

defineOptions({ inheritAttrs: false });

const props = defineProps({
  id: { type: String, required: true },
  data: { type: Object, default: () => ({}) },
  dragging: { type: Boolean, default: false },
});

const INERT = { selectedId: null, hoveredId: null, dropTargetId: null, draggingId: null, zoom: 1, reducedMotion: false, select() {}, nodeName: () => '' };
const ctx = inject('nm-topology-ctx', INERT);

const size = NODE_SIZES.hub;
const anchor = computed(() => props.data.anchor || size.anchor);

const selected = computed(() => ctx.selectedId === props.id);
const hovered = computed(() => ctx.hoveredId === props.id && !props.dragging);
const isDragging = computed(() => props.dragging || ctx.draggingId === props.id);
const isDropTarget = computed(() => !!ctx.dropTargetId && ctx.dropTargetId === props.id);
const online = computed(() => !!props.data.online);

const showName = computed(() => (ctx.zoom ?? 1) >= 0.35);
const showSecondary = computed(() => (ctx.zoom ?? 1) >= 0.55);

const tintClass = computed(() => (online.value ? categoryTint(props.data.category || 'access_point').tile : OFFLINE_TILE));

const dotClass = computed(() => {
  const q = props.data.quality;
  if (q === 'offline') return 'bg-surface border border-subtle';
  // Online but ignores ping: still online, so show green.
  if (q === 'noping' && online.value) return 'bg-success';
  return QUALITY[q]?.dot || 'bg-border-strong';
});

const tileShadow = computed(() => {
  const s = [];
  if (selected.value) {
    s.push('0 0 0 2px var(--color-accent)');
    s.push('0 0 0 6px color-mix(in oklab, var(--color-accent) 18%, transparent)');
  } else if (props.data.highlighted) {
    s.push('0 0 0 1px color-mix(in oklab, var(--color-accent) 50%, transparent)');
  }
  if (isDragging.value) s.push('var(--shadow-modal)');
  else if (hovered.value || isDropTarget.value) s.push('var(--shadow-popover)');
  return s.length ? s.join(', ') : 'none';
});

const count = computed(() => Number(props.data.clientCount) || 0);
const countText = computed(() => `${count.value} ${count.value === 1 ? 'device' : 'devices'}`);

const ariaLabel = computed(() => {
  const d = props.data;
  const parts = [d.name || d.mac || props.id, d.typeLabel, online.value ? 'Online' : 'Offline'];
  if (online.value && d.latencyMs != null) parts.push(formatMs(d.latencyMs));
  parts.push(countText.value);
  const parentName = ctx.nodeName?.(d.parentMac ?? null);
  if (parentName) parts.push(`connected via ${parentName}`);
  return parts.filter(Boolean).join(', ');
});

function onKey(e) {
  if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault();
    ctx.select?.(props.id);
  }
}
</script>

<template>
  <div
    class="nm-node relative select-none transition-opacity duration-[120ms]"
    :class="[
      data.dimmed ? (data.context ? 'opacity-60 saturate-50' : 'opacity-25 saturate-0') : !online ? 'opacity-60' : 'opacity-100',
      isDragging ? 'cursor-grabbing' : '',
    ]"
    :style="{ width: size.w + 'px', height: size.h + 'px' }"
    :data-testid="data.testid"
    data-kind="hub"
    :data-category="data.category"
    :data-online="String(online)"
    :data-selected="String(selected)"
    :data-dimmed="String(!!data.dimmed)"
    :data-context="data.context ? 'true' : undefined"
    :data-highlighted="String(!!data.highlighted)"
    :data-pinned="String(!!data.pinned)"
    :data-parent="data.parentMac ?? 'gateway'"
    :data-quality="data.quality"
    :data-mac="data.mac"
    :data-drop-target="isDropTarget ? 'true' : undefined"
  >
    <div
      role="button"
      tabindex="0"
      data-node-focus
      class="flex h-full w-full flex-col items-center rounded-lg outline-offset-2"
      :aria-label="ariaLabel"
      :aria-pressed="selected ? 'true' : 'false'"
      @keydown="onKey"
    >
      <div
        class="relative h-[52px] w-[52px] shrink-0 rounded-2xl border bg-surface transition-[transform,border-color,box-shadow,outline-color] duration-[120ms]"
        :class="[
          online
            ? hovered || selected
              ? 'border-cat-network/70'
              : 'border-cat-network/40'
            : 'border-dashed border-border-strong',
          isDragging ? 'scale-[1.04]' : hovered ? '-translate-y-px' : '',
          isDropTarget ? 'outline-2 outline-offset-4 outline-dashed outline-accent' : '',
        ]"
        :style="{ boxShadow: tileShadow }"
      >
        <div class="absolute inset-0 flex items-center justify-center rounded-[15px]" :class="tintClass">
          <Icon :name="data.icon || 'wifi'" :size="26" />
        </div>
        <div v-if="isDropTarget" class="absolute inset-0 rounded-[15px] bg-accent/8" aria-hidden="true" />
        <span
          v-if="data.pinned && (hovered || selected)"
          class="absolute -left-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-surface text-subtle ring-1 ring-border"
          title="Position pinned by you"
        >
          <Icon name="pin" :size="10" :stroke-width="2" />
        </span>
        <span
          class="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-surface transition-colors duration-300"
          :class="dotClass"
          aria-hidden="true"
        />
      </div>

      <div v-if="showName" class="mt-1 flex w-full min-w-0 flex-col items-center nm-halo">
        <span
          class="flex max-w-full items-center gap-0.5 rounded-sm px-1 text-[13px] font-semibold leading-[18px] text-text"
          :class="selected ? 'bg-surface/90' : 'bg-bg/80'"
        >
          <span class="truncate" :title="data.name">{{ data.name }}</span>
          <Icon v-if="data.saved" name="star-filled" :size="10" class="text-warning" />
        </span>
        <span
          v-if="showSecondary"
          class="max-w-full truncate rounded-sm bg-bg/80 px-1 text-[11px] leading-[14px] text-muted"
          :title="data.typeLabel"
        >{{ data.typeLabel }}</span>
      </div>
      <!-- Count pill: always in the DOM (stable testid); only visually hidden at low zoom. -->
      <div class="flex w-full justify-center" :class="showName && showSecondary ? '' : 'sr-only'">
        <span
          class="inline-flex h-4 items-center rounded-full bg-surface-2 px-1.5 text-[10px] font-medium leading-4 text-muted tabular-nums ring-1 ring-inset ring-border"
          data-testid="map-hub-count"
          :data-count="count"
        >{{ countText }}</span>
      </div>
    </div>

    <!-- Drop hint (while another node is dragged over this hub) -->
    <div
      v-if="isDropTarget"
      class="pointer-events-none absolute left-1/2 top-full mt-1 -translate-x-1/2 whitespace-nowrap rounded-sm bg-surface/90 px-1 text-[11px] font-medium leading-4 text-accent-fg nm-halo"
      data-testid="map-drop-hint"
    >Drop to connect via {{ data.name }}</div>

    <Handle
      id="in"
      type="target"
      :position="Position.Top"
      :connectable="false"
      :style="{ left: anchor.x + 'px', top: anchor.y + 'px' }"
    />
    <Handle
      id="out"
      type="source"
      :position="Position.Bottom"
      :connectable="false"
      :style="{ left: anchor.x + 'px', top: anchor.y + 'px' }"
    />
  </div>
</template>
