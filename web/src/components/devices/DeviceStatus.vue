<script setup>
// Status: "Online" / "Offline · last seen 3 min ago" (PLAN.md §11 device-status).
// The element's textContent is always exactly that string; the `stacked` variant (table) only
// changes the visual layout: pill on line 1, "last seen …" on line 2 (the " · " is visually
// hidden but kept in the text). The relative time ticks via the shared useNow() ticker.
import { computed } from 'vue';
import { useNow } from '../../composables/useNow.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';

const props = defineProps({
  device: { type: Object, required: true },
  /** 'inline' (one pill, card header) | 'stacked' (table cell). */
  variant: { type: String, default: 'stacked' }
});

const now = useNow(1000);

const online = computed(() => Boolean(props.device.online));
const lastSeenText = computed(() =>
  !online.value && props.device.lastSeen ? `last seen ${formatRelative(props.device.lastSeen, now.value)}` : null
);
const title = computed(() => {
  const state = online.value ? 'Online' : 'Offline';
  return props.device.lastSeen ? `${state} · last seen ${formatDateTime(props.device.lastSeen)}` : state;
});

const pillTone = computed(() =>
  online.value
    ? 'bg-success/12 text-success-fg ring-success/25'
    : 'bg-surface-3 text-muted ring-border-strong'
);
</script>

<template>
  <span
    data-testid="device-status"
    :data-status="online ? 'online' : 'offline'"
    :title="title"
    class="inline-flex max-w-full text-xs font-medium"
    :class="variant === 'stacked' ? 'flex-col items-start gap-0.5' : 'items-center'"
  ><span
      class="inline-flex max-w-full items-center gap-1.5 rounded-full px-2 py-0.5 ring-1 ring-inset"
      :class="pillTone"
    ><span
        aria-hidden="true"
        class="size-1.5 shrink-0 rounded-full transition-colors duration-300"
        :class="online ? 'bg-success' : 'border border-subtle bg-transparent'"
      /><span>{{ online ? 'Online' : 'Offline' }}</span><span
        v-if="lastSeenText && variant !== 'stacked'"
        class="min-w-0 truncate font-normal"
      > · {{ lastSeenText }}</span></span><template v-if="lastSeenText && variant === 'stacked'"><span class="sr-only"> · </span><span
        class="block max-w-full truncate whitespace-nowrap pl-0.5 text-[11px] leading-4 font-normal text-muted"
      >{{ lastSeenText }}</span></template></span>
</template>
