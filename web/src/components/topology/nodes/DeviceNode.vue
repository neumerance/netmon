<script setup>
// Map node for a client device (TOPOLOGY.md §4.2). 112×88 box: 44 px icon tile on top, name + IP below.
// All transient state (hover / selected / dragging / zoom LOD) comes from the 'nm-topology-ctx' that
// TopologyMap provides; everything structural comes from node.data (layout.js buildGraph).
import { computed, inject } from 'vue';
import { Handle, Position } from '@vue-flow/core';
import Icon from '../../ui/Icon.vue';
import { categoryTint, OFFLINE_TILE, QUALITY } from '../../devices/deviceUi.js';
import { formatMs } from '../../../lib/format.js';
import { NODE_SIZES } from '../layout.js';

// Vue Flow passes many node props (position, dimensions, events, …); never let them fall through to the DOM.
defineOptions({ inheritAttrs: false });

const props = defineProps({
  id: { type: String, required: true },
  data: { type: Object, default: () => ({}) },
  dragging: { type: Boolean, default: false },
});

const INERT = { selectedId: null, hoveredId: null, dropTargetId: null, draggingId: null, zoom: 1, reducedMotion: false, select() {}, nodeName: () => '' };
const ctx = inject('nm-topology-ctx', INERT);

const size = NODE_SIZES.device;
const anchor = computed(() => props.data.anchor || size.anchor);

const selected = computed(() => ctx.selectedId === props.id);
const hovered = computed(() => ctx.hoveredId === props.id && !props.dragging);
const isDragging = computed(() => props.dragging || ctx.draggingId === props.id);
const online = computed(() => !!props.data.online);
const isSelf = computed(() => !!props.data.isSelf);

// Level of detail by zoom: < 0.55 hide the secondary line, < 0.35 tile only.
const showName = computed(() => (ctx.zoom ?? 1) >= 0.35);
const showSecondary = computed(() => (ctx.zoom ?? 1) >= 0.55);

const tintClass = computed(() => (online.value ? categoryTint(props.data.category).tile : OFFLINE_TILE));

const dotClass = computed(() => {
  if (isSelf.value) return 'bg-accent';
  const q = props.data.quality;
  if (q === 'offline') return 'bg-surface border border-subtle';
  // Online but ignores ping (common for phones, IoT, Windows firewall): still online, so show green.
  if (q === 'noping' && online.value) return 'bg-success';
  return QUALITY[q]?.dot || 'bg-border-strong';
});

// Box-shadow stack is computed in one place (Tailwind ring utilities also use box-shadow and an inline
// style would silently override them).
const tileShadow = computed(() => {
  const s = [];
  if (selected.value) {
    s.push('0 0 0 2px var(--color-accent)');
    s.push('0 0 0 6px color-mix(in oklab, var(--color-accent) 18%, transparent)');
  } else if (isSelf.value) {
    s.push('0 0 0 2px color-mix(in oklab, var(--color-accent) 70%, transparent)');
  } else if (props.data.highlighted) {
    s.push('0 0 0 1px color-mix(in oklab, var(--color-accent) 50%, transparent)');
  }
  if (isDragging.value) s.push('var(--shadow-modal)');
  else if (hovered.value) s.push('var(--shadow-popover)');
  return s.length ? s.join(', ') : 'none';
});

// IP under the name — or the type label when there is no IP or the name already IS the IP (unnamed devices).
const secondary = computed(() => {
  const { ip, name, typeLabel } = props.data;
  return ip && ip !== name ? ip : typeLabel || '';
});

const ariaLabel = computed(() => {
  const d = props.data;
  const parts = [d.name || d.mac || props.id, d.typeLabel];
  if (isSelf.value) parts.push('This computer');
  parts.push(online.value ? 'Online' : 'Offline');
  if (online.value && d.latencyMs != null) parts.push(formatMs(d.latencyMs));
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
    data-kind="device"
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
    :data-self="isSelf ? 'true' : undefined"
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
      <!-- Icon tile (44×44, centred; its centre is the edge anchor) -->
      <div
        class="relative h-11 w-11 shrink-0 rounded-xl border bg-surface transition-[transform,border-color,box-shadow] duration-[120ms]"
        :class="[
          online ? (hovered || selected ? 'border-border-strong' : 'border-border') : 'border-dashed border-border-strong',
          isDragging ? 'scale-[1.04]' : hovered ? '-translate-y-px' : '',
        ]"
        :style="{ boxShadow: tileShadow }"
      >
        <div class="absolute inset-0 flex items-center justify-center rounded-[11px]" :class="tintClass">
          <Icon :name="data.icon || 'question'" :size="22" />
        </div>
        <!-- pinned position marker (hover / selected only) -->
        <span
          v-if="data.pinned && (hovered || selected)"
          class="absolute -left-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-surface text-subtle ring-1 ring-border"
          title="Position pinned by you"
        >
          <Icon name="pin" :size="10" :stroke-width="2" />
        </span>
        <!-- "You" pill for this computer -->
        <span
          v-if="isSelf"
          class="absolute -right-3 -top-2 inline-flex h-4 items-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-4 text-accent-contrast shadow-sm"
        >You</span>
        <!-- status dot -->
        <span
          class="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-surface transition-colors duration-300"
          :class="dotClass"
          aria-hidden="true"
        />
      </div>

      <!-- Labels -->
      <div v-if="showName" class="mt-1.5 flex w-full min-w-0 flex-col items-center nm-halo">
        <span
          class="flex max-w-full items-center gap-0.5 rounded-sm px-1 text-xs leading-4"
          :class="selected ? 'bg-surface/90 font-semibold text-text' : 'bg-bg/80 font-medium text-text'"
        >
          <span class="truncate" :title="data.name">{{ data.name }}</span>
          <Icon v-if="data.saved" name="star-filled" :size="10" class="text-warning" />
        </span>
        <span
          v-if="showSecondary && secondary"
          class="max-w-full truncate rounded-sm bg-bg/80 px-1 text-[11px] leading-[14px] text-muted tabular-nums"
          :title="secondary"
        >{{ secondary }}</span>
      </div>
    </div>

    <Handle
      id="in"
      type="target"
      :position="Position.Top"
      :connectable="false"
      :style="{ left: anchor.x + 'px', top: anchor.y + 'px' }"
    />
  </div>
</template>
