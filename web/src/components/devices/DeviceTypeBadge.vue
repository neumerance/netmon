<script setup>
// Device type: [icon] label · OS icon · confidence dots · "Why?" -> evidence popover.
// The element with data-testid="device-type" contains exactly deviceTypeLabel(device).
import { computed, ref } from 'vue';
import Icon from '../ui/Icon.vue';
import Spinner from '../ui/Spinner.vue';
import {
  OS_ICONS,
  OS_LABELS,
  confidenceLevel,
  deviceIcon,
  deviceTypeLabel
} from '../../lib/deviceTypes.js';
import { categoryTint, confidencePercent } from './deviceUi.js';
import EvidencePopover from './EvidencePopover.vue';

const props = defineProps({
  device: { type: Object, required: true },
  /** Show the small category icon before the label (off when the row already shows a tile). */
  showIcon: { type: Boolean, default: true },
  /** Keep everything on one line and truncate the label (table rows). */
  nowrap: { type: Boolean, default: false }
});
const emit = defineEmits(['change-type']);

const whyBtn = ref(null);
const open = ref(false);

const label = computed(() => deviceTypeLabel(props.device));
const isUser = computed(() => props.device.typeSource === 'user');
const pct = computed(() => confidencePercent(props.device.typeConfidence));
const level = computed(() => confidenceLevel(Number(props.device.typeConfidence) || 0));
const osIcon = computed(() => (props.device.os ? OS_ICONS[props.device.os] ?? null : null));
const osLabel = computed(() => (props.device.os ? OS_LABELS[props.device.os] ?? props.device.os : null));
const tint = computed(() => categoryTint(props.device.category));
const detecting = computed(
  () => Boolean(props.device.fingerprinting) && !(props.device.typeEvidence?.length > 0) && !isUser.value
);

const confidenceTitle = computed(() => {
  if (isUser.value) return 'Type set by you';
  if (level.value === 'high') return `High confidence (${pct.value}%)`;
  if (level.value === 'medium') return `Medium confidence (${pct.value}%)`;
  return `Low confidence — best guess (${pct.value}%)`;
});

/** One 6px dot (DESIGN §3.7): solid green = high, solid amber = medium, hollow ring = low. */
const dotTone = computed(() =>
  level.value === 'high'
    ? 'bg-success'
    : level.value === 'medium'
      ? 'bg-warning'
      : 'border border-subtle bg-transparent'
);

function toggle() {
  open.value = !open.value;
}
</script>

<template>
  <div class="flex min-w-0 items-center gap-x-1.5 gap-y-0.5 text-xs text-muted" :class="nowrap ? 'flex-nowrap' : 'flex-wrap'">
    <Icon
      v-if="showIcon"
      :name="deviceIcon(device)"
      :size="14"
      class="shrink-0"
      :class="device.online ? tint.text : 'text-subtle'"
    />
    <span
      data-testid="device-type"
      :data-category="device.category ?? 'unknown'"
      :data-os="device.os ?? ''"
      :data-source="device.typeSource ?? 'auto'"
      class="min-w-0"
      :class="nowrap ? 'truncate' : 'break-words'"
      :title="osLabel ? `${label} (${osLabel})` : label"
    >{{ label }}</span>
    <!-- OS glyph, confidence, Why? and extras stay together; they wrap as one group after a long label. -->
    <span class="inline-flex shrink-0 items-center gap-1.5">
    <Icon
      v-if="osIcon"
      :name="osIcon"
      :size="12"
      class="shrink-0 text-subtle"
      :title="osLabel"
      :aria-label="osLabel"
    />
    <Spinner v-if="detecting" :size="12" class="shrink-0 text-subtle" />

    <span
      v-if="isUser"
      class="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-muted"
      :title="confidenceTitle"
    >
      <Icon name="edit" :size="11" />
      <span class="sr-only">{{ confidenceTitle }}</span>
    </span>
    <span
      v-else-if="!detecting"
      class="inline-flex shrink-0 items-center"
      :title="confidenceTitle"
      :data-confidence="level"
      role="img"
      :aria-label="confidenceTitle"
    >
      <span class="size-1.5 rounded-full" :class="dotTone" />
    </span>

    <button
      ref="whyBtn"
      type="button"
      data-testid="device-type-why"
      class="shrink-0 rounded px-1 text-xs font-medium text-muted underline decoration-border-strong decoration-dotted underline-offset-2 hover:text-accent-fg hover:decoration-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      aria-haspopup="dialog"
      :aria-expanded="open ? 'true' : 'false'"
      @click.stop="toggle"
    >
      Why?
    </button>
    <slot />
    </span>

    <EvidencePopover
      :open="open"
      :device="device"
      :anchor="whyBtn"
      @close="open = false"
      @change-type="emit('change-type')"
    />
  </div>
</template>
