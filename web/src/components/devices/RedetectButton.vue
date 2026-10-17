<script setup>
// "Re-detect" (re-fingerprint) button with spinner while the request is in flight.
// Disabled for offline devices (the API answers 409 for them).
import { computed } from 'vue';
import Icon from '../ui/Icon.vue';
import Spinner from '../ui/Spinner.vue';
import { isRedetecting } from './devicesState.js';

const props = defineProps({
  device: { type: Object, required: true },
  /** 'mini' = tiny icon in the type line (table) | 'labelled' = bordered button with text (card). */
  variant: { type: String, default: 'mini' }
});
const emit = defineEmits(['refingerprint']);

const pending = computed(() => isRedetecting(props.device.mac));
const disabled = computed(() => pending.value || !props.device.online);
const title = computed(() => {
  if (pending.value) return 'Re-detecting device type…';
  if (!props.device.online) return 'Device is offline — re-detect needs it online';
  return 'Re-detect device type';
});
</script>

<template>
  <button
    type="button"
    data-testid="refingerprint-btn"
    :disabled="disabled"
    :aria-busy="pending ? 'true' : 'false'"
    :title="title"
    :class="
        variant === 'labelled'
          ? 'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted ring-1 ring-border-strong ring-inset transition-colors hover:bg-surface-3 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40'
          : 'inline-grid size-6 shrink-0 place-items-center rounded text-subtle transition-colors hover:bg-surface-3 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent'
      "
    @click.stop="emit('refingerprint', device)"
  >
    <Spinner v-if="pending" :size="variant === 'labelled' ? 14 : 12" />
    <Icon v-else name="refresh" :size="variant === 'labelled' ? 15 : 13" />
    <span :class="variant === 'labelled' ? '' : 'sr-only'">Re-detect</span>
  </button>
</template>
