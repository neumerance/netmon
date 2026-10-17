<script setup>
// Latency cell: quality dot + formatMs(latencyMs) + sparkline of latencyHistory (+ optional
// quality word). Tooltip (title) lists latency, jitter and loss. The element carrying
// data-testid="device-latency" contains only the formatMs() text (PLAN.md §11).
//
// Offline devices show "—" with no quality dot or sparkline (DESIGN §3.4); the last known
// values stay in the tooltip. Online devices that never answer ping (ICMP blocked, seen only
// through ARP) show "—" and "No ping reply" instead of a misleading red "Poor · 100% loss".
import { computed } from 'vue';
import { formatMs, formatPercent } from '../../lib/format.js';
import { QUALITY, connectionQuality } from './deviceUi.js';
import LatencySparkline from './LatencySparkline.vue';
import QualityBadge from './QualityBadge.vue';

const props = defineProps({
  device: { type: Object, required: true },
  /** compact = table cell (sparkline 56px); 'card' = mobile card (larger sparkline + word badge). */
  variant: { type: String, default: 'table' },
  showBadge: { type: Boolean, default: false },
  /** Table rows: show the quality word only on wide panels (≥ @4xl/devices), where it fits. */
  tableBadge: { type: Boolean, default: false }
});

const quality = computed(() => connectionQuality(props.device));
const style = computed(() => QUALITY[quality.value]);
const isSelf = computed(() => Boolean(props.device.isSelf));
const online = computed(() => Boolean(props.device.online));
const noPing = computed(() => quality.value === 'noping');
const text = computed(() => (online.value && !noPing.value ? formatMs(props.device.latencyMs) : '—'));
/** Dot + sparkline only while there is a live measurement to show. */
const live = computed(() => !isSelf.value && online.value && !noPing.value);

const history = computed(() => (Array.isArray(props.device.latencyHistory) ? props.device.latencyHistory : []));

const title = computed(() => {
  const d = props.device;
  if (d.isSelf) return 'This computer is not pinged — see live throughput instead';
  if (noPing.value) return 'No ping reply (ICMP blocked) — the device is seen on the network through ARP only';
  if (d.latencyMs == null && !history.value.length) return d.online ? 'No ping samples yet' : 'Offline';
  const parts = [
    `Latency ${formatMs(d.latencyMs)}`,
    `jitter ${formatMs(d.jitterMs)}`,
    `loss ${d.lossPct == null ? '—' : formatPercent(d.lossPct)}`
  ];
  const window = history.value.length ? ` (last ${history.value.length} pings)` : '';
  const prefix = d.online ? `${style.value.label} connection · ` : 'Offline · last known values · ';
  return `${prefix}${parts.join(' · ')}${window}`;
});

const srText = computed(() => {
  if (isSelf.value) return 'Latency is not measured for this computer';
  if (noPing.value) return 'No ping reply (ICMP blocked)';
  if (!online.value) return 'Offline';
  return `${style.value.label} connection`;
});
const badgeVisible = computed(() => !isSelf.value && (props.showBadge || props.tableBadge));
</script>

<template>
  <div class="flex min-w-0 items-center gap-2" :title="title">
    <span
      v-if="live"
      aria-hidden="true"
      class="size-1.5 shrink-0 rounded-full transition-colors duration-300"
      :class="style.dot"
    />
    <span
      data-testid="device-latency"
      class="shrink-0 text-[13px] font-medium tabular-nums"
      :class="live ? style.text : 'text-subtle'"
    >{{ text }}</span>
    <LatencySparkline
      v-if="live"
      :values="history"
      :width="variant === 'card' ? 88 : 48"
      :height="variant === 'card' ? 22 : 20"
      :color="style.stroke"
      class="text-subtle"
      :class="variant === 'card' ? '' : 'hidden @3xl/devices:block'"
    />
    <template v-if="badgeVisible">
      <QualityBadge v-if="showBadge" :quality="quality" />
      <span v-else class="hidden @4xl/devices:contents"><QualityBadge :quality="quality" /></span>
    </template>
    <span
      v-if="!showBadge || isSelf || quality === 'none'"
      class="sr-only"
      :class="tableBadge && !isSelf && quality !== 'none' ? '@4xl/devices:hidden' : ''"
    >{{ srText }}</span>
  </div>
</template>
