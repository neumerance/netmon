<script setup>
// Map node for the gateway router — the centre of the map (TOPOLOGY.md §4.2). 200×128 box.
// When no gateway device is known the layout emits a placeholder (data.placeholder) that is not selectable.
import { computed, inject } from 'vue';
import { Handle, Position } from '@vue-flow/core';
import Icon from '../../ui/Icon.vue';
import { QUALITY } from '../../devices/deviceUi.js';
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

const size = NODE_SIZES.gateway;
const anchor = computed(() => props.data.anchor || size.anchor);

const placeholder = computed(() => !!props.data.placeholder);
const selected = computed(() => !placeholder.value && ctx.selectedId === props.id);
const hovered = computed(() => !placeholder.value && ctx.hoveredId === props.id);
const isDropTarget = computed(() => !!ctx.dropTargetId && ctx.dropTargetId === props.id);
// Placeholder gateway counts as "up" visually (it's an inferred router, not an offline device).
const online = computed(() => placeholder.value || !!props.data.online);

const showName = computed(() => (ctx.zoom ?? 1) >= 0.35);
const showSecondary = computed(() => (ctx.zoom ?? 1) >= 0.55);

const dotClass = computed(() => {
  const q = props.data.quality;
  if (q === 'offline') return 'bg-surface border border-subtle';
  return QUALITY[q]?.dot || 'bg-border-strong';
});

const tileShadow = computed(() => {
  const s = [];
  if (selected.value) {
    s.push('0 0 0 2px var(--color-accent)');
    s.push('0 0 0 6px color-mix(in oklab, var(--color-accent) 18%, transparent)');
  } else if (!placeholder.value) {
    // ring-2 ring-cat-network/35
    s.push('0 0 0 2px color-mix(in oklab, var(--color-cat-network) 35%, transparent)');
  }
  if (!placeholder.value && online.value) s.push('0 0 24px color-mix(in oklab, var(--color-cat-network) 22%, transparent)');
  if (hovered.value || isDropTarget.value) s.push('var(--shadow-popover)');
  return s.join(', ') || 'none';
});

const secondary = computed(() => {
  const d = props.data;
  if (placeholder.value) return d.ip || 'Not detected';
  return [d.typeLabel, d.ip].filter(Boolean).join(' · ');
});

const counts = computed(() => props.data.counts || { online: 0, offline: 0, total: 0 });
const statsText = computed(() => {
  const c = counts.value;
  const base = `${c.online ?? 0} online`;
  return c.offline > 0 ? `${base} · ${c.offline} offline` : base;
});

const ariaLabel = computed(() => {
  const d = props.data;
  const parts = [d.name || 'Gateway', 'Gateway', d.typeLabel, online.value ? 'Online' : 'Offline'];
  if (online.value && d.latencyMs != null) parts.push(formatMs(d.latencyMs));
  parts.push(statsText.value);
  return parts.filter(Boolean).join(', ');
});

function onKey(e) {
  if (placeholder.value) return;
  if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault();
    ctx.select?.(props.id);
  }
}
</script>

<template>
  <div
    class="nm-node relative select-none"
    :class="[!placeholder && !online ? 'opacity-60' : '']"
    :style="{ width: size.w + 'px', height: size.h + 'px' }"
    :data-testid="data.testid || 'map-node-gateway'"
    data-kind="gateway"
    :data-category="data.device?.category ?? 'router'"
    :data-online="String(online)"
    :data-selected="String(selected)"
    data-dimmed="false"
    :data-highlighted="String(!!data.highlighted)"
    data-pinned="false"
    data-parent="internet"
    :data-quality="data.quality"
    :data-mac="data.mac ?? undefined"
    :data-placeholder="placeholder ? 'true' : undefined"
    :data-drop-target="isDropTarget ? 'true' : undefined"
  >
    <div
      :role="placeholder ? undefined : 'button'"
      :tabindex="placeholder ? undefined : 0"
      :data-node-focus="placeholder ? undefined : ''"
      class="flex h-full w-full flex-col items-center rounded-lg outline-offset-2"
      :class="placeholder ? 'cursor-default' : ''"
      :aria-label="placeholder ? undefined : ariaLabel"
      :aria-pressed="placeholder ? undefined : selected ? 'true' : 'false'"
      @keydown="onKey"
    >
      <div
        class="relative h-16 w-16 shrink-0 rounded-2xl border bg-surface transition-[border-color,box-shadow,outline-color] duration-[120ms]"
        :class="[
          placeholder ? 'border-dashed border-border-strong' : hovered || selected ? 'border-cat-network/70' : 'border-cat-network/40',
          isDropTarget ? 'outline-2 outline-offset-4 outline-dashed outline-accent' : '',
        ]"
        :style="{ boxShadow: tileShadow }"
      >
        <div
          class="absolute inset-0 flex items-center justify-center rounded-[15px]"
          :class="placeholder ? 'bg-surface-2 text-subtle' : online ? 'bg-cat-network/12 text-cat-network' : 'bg-surface-3 text-subtle'"
        >
          <Icon name="router" :size="30" />
        </div>
        <div v-if="isDropTarget" class="absolute inset-0 rounded-[15px] bg-accent/8" aria-hidden="true" />
        <!-- Gateway badge above the tile's top-right corner -->
        <span
          v-if="!placeholder"
          class="absolute -right-9 -top-3 inline-flex h-[18px] items-center rounded-md bg-surface px-1.5 text-[11px] font-medium text-cat-network shadow-sm ring-1 ring-inset ring-cat-network/25"
        >
          <span class="absolute inset-0 rounded-md bg-cat-network/12" aria-hidden="true" />
          <span class="relative">Gateway</span>
        </span>
        <span
          v-if="!placeholder"
          class="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-surface transition-colors duration-300"
          :class="dotClass"
          aria-hidden="true"
        />
      </div>

      <div v-if="showName" class="mt-1.5 flex w-full min-w-0 flex-col items-center nm-halo">
        <span
          class="max-w-full truncate rounded-sm px-1 text-[13px] font-semibold leading-[18px]"
          :class="[placeholder ? 'text-muted' : 'text-text', selected ? 'bg-surface/90' : 'bg-bg/80']"
          :title="data.name || 'Gateway'"
        >{{ data.name || 'Gateway' }}</span>
        <template v-if="showSecondary">
          <span class="max-w-full truncate rounded-sm bg-bg/80 px-1 text-[11px] leading-[14px] text-muted tabular-nums" :title="secondary">{{ secondary }}</span>
          <span
            v-if="!placeholder || counts.total > 0"
            class="mt-1 inline-flex h-5 items-center gap-1 rounded-full border border-border bg-surface px-2 text-[11px] font-medium leading-4 text-muted tabular-nums"
          >
            <span class="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
            <span>{{ counts.online ?? 0 }} online</span>
            <template v-if="counts.offline > 0">
              <span class="text-subtle" aria-hidden="true">·</span>
              <span>{{ counts.offline }} offline</span>
            </template>
          </span>
        </template>
      </div>
    </div>

    <div
      v-if="isDropTarget"
      class="pointer-events-none absolute left-1/2 top-full mt-1 -translate-x-1/2 whitespace-nowrap rounded-sm bg-surface/90 px-1 text-[11px] font-medium leading-4 text-accent-fg nm-halo"
      data-testid="map-drop-hint"
    >Drop to connect via {{ data.name || 'Gateway' }}</div>

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
