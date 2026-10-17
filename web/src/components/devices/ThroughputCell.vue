<script setup>
// Throughput: real live rx/tx only for this computer (interface counters). Every other device
// shows "—" because one host cannot observe other devices' traffic without router integration.
import { computed } from 'vue';
import Tooltip from '../ui/Tooltip.vue';
import { formatRate } from './deviceUi.js';

const props = defineProps({
  device: { type: Object, required: true },
  /** 'cell' (table) | 'card': in cards the non-self "—" is visually hidden (kept for a11y/tests). */
  variant: { type: String, default: 'cell' }
});

const isSelf = computed(() => Boolean(props.device.isSelf));
const rx = computed(() => formatRate(props.device.rxMbps));
const tx = computed(() => formatRate(props.device.txMbps));
const rawRx = computed(() => (props.device.rxMbps == null ? '' : String(props.device.rxMbps)));
const rawTx = computed(() => (props.device.txMbps == null ? '' : String(props.device.txMbps)));
</script>

<template>
  <span
    v-if="isSelf"
    data-testid="device-throughput"
    :data-rx="rawRx"
    :data-tx="rawTx"
    title="Live traffic on this computer's network interface (download ↓ / upload ↑)"
    class="inline-flex items-baseline gap-0.5 whitespace-nowrap text-xs font-medium tabular-nums text-text"
  ><span class="text-accent-fg">↓</span> <span>{{ rx }}</span> <span class="text-info-fg">↑</span> <span>{{ tx }}</span> <span class="font-normal text-muted">Mbps</span></span>
  <template v-else>
    <!-- ui/Tooltip forwards attrs to its wrapper span and keeps a native title on it when idle. -->
    <Tooltip
      data-testid="device-throughput"
      data-rx=""
      data-tx=""
      text="Requires router integration"
      class="cursor-help text-xs text-subtle"
      :class="variant === 'card' ? 'sr-only' : ''"
    >—</Tooltip>
    <span class="sr-only">Throughput requires router integration</span>
  </template>
</template>
