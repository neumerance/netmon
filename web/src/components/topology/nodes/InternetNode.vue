<script setup>
// Internet / ISP card at the top of the map (TOPOLOGY.md §4.2). 240×96, not selectable, not draggable.
// Shows the ISP name, masked public IP + ASN, the probe status and the last (or live) speed test result.
import { computed, inject } from 'vue';
import { Handle, Position } from '@vue-flow/core';
import Icon from '../../ui/Icon.vue';
import Spinner from '../../ui/Spinner.vue';
import { formatDuration, formatMbpsValue, formatMs, mbpsUnit, DASH } from '../../../lib/format.js';
import { useNow } from '../../../composables/useNow.js';
import { NODE_SIZES } from '../layout.js';

defineOptions({ inheritAttrs: false });

const props = defineProps({
  id: { type: String, required: true },
  data: { type: Object, default: () => ({}) },
});

const INERT = { zoom: 1 };
const ctx = inject('nm-topology-ctx', INERT);
const now = useNow(1000);

const size = NODE_SIZES.internet;
const anchor = computed(() => props.data.anchor || size.anchor);

const status = computed(() => (['up', 'down'].includes(props.data.status) ? props.data.status : 'unknown'));
const isp = computed(() => props.data.isp || null);
const speed = computed(() => props.data.speed || {});

const ispName = computed(() => isp.value?.name || 'Internet');
const ipLine = computed(() => {
  const i = isp.value;
  if (!i) return DASH;
  const parts = [];
  if (i.ipMasked || i.ip) parts.push(i.ipMasked || i.ip);
  if (i.asn != null && i.asn !== '') parts.push(`AS${i.asn}`);
  return parts.length ? parts.join(' · ') : DASH;
});

const statusPill = computed(() => {
  if (status.value === 'up') {
    const ms = props.data.latencyMs;
    return { tone: 'bg-success/15 text-success-fg', dot: 'bg-success', text: ms != null ? `Online · ${formatMs(ms)}` : 'Online' };
  }
  if (status.value === 'down') {
    const since = props.data.since ? Date.parse(props.data.since) : NaN;
    const dur = Number.isFinite(since) ? formatDuration(Math.max(0, now.value - since)) : null;
    return { tone: 'bg-danger/15 text-danger-fg', dot: 'bg-danger', text: dur && dur !== DASH ? `Down · ${dur}` : 'Down' };
  }
  return { tone: 'bg-surface-3 text-muted', dot: 'bg-subtle', text: 'Checking…' };
});

// Live speed-test line (while running) or the last result.
const speedLine = computed(() => {
  const s = speed.value;
  if (s.running) {
    if (s.phase === 'download') return { live: true, dir: 'down', text: `Testing ↓ ${formatMbpsValue(s.currentMbps)} ${mbpsUnit(s.currentMbps)}` };
    if (s.phase === 'upload') return { live: true, dir: 'up', text: `Testing ↑ ${formatMbpsValue(s.currentMbps)} ${mbpsUnit(s.currentMbps)}` };
    return { live: true, dir: null, text: 'Measuring latency…' };
  }
  if (s.downloadMbps == null && s.uploadMbps == null) return null;
  return { live: false };
});

const title = computed(() => {
  const i = isp.value;
  const lines = [];
  if (i) {
    lines.push(i.name || 'Internet');
    if (i.asn != null && i.asn !== '') lines.push(`AS${i.asn}`);
    const place = [i.city, i.country].filter(Boolean).join(', ');
    if (place) lines.push(place);
    if (i.colo) lines.push(`Cloudflare colo ${i.colo}`);
    if (i.ip) lines.push(`Public IP ${i.ip}`);
  } else {
    lines.push('Internet');
  }
  const target = props.data.target;
  if (target) lines.push(`Probe target ${target}`);
  return lines.join('\n');
});

const compact = computed(() => (ctx.zoom ?? 1) < 0.35);
</script>

<template>
  <div
    class="nm-node relative cursor-default select-none"
    :style="{ width: size.w + 'px', height: size.h + 'px' }"
    :data-testid="data.testid || 'map-node-internet'"
    data-kind="internet"
    :data-status="status"
    :title="title"
  >
    <!-- Low zoom: the card's text is unreadable, so show just a large round globe tile (status-coloured ring)
         centred on the edge anchor instead of an empty card. -->
    <div v-if="compact" class="flex h-full w-full items-center justify-center" data-compact="true">
      <div
        class="relative flex h-14 w-14 items-center justify-center rounded-full border-[3px] bg-surface shadow-card"
        :class="status === 'up' ? 'border-success text-success-fg' : status === 'down' ? 'border-danger text-danger-fg' : 'border-border-strong text-subtle'"
      >
        <span v-if="status === 'down'" class="pointer-events-none absolute inset-0 rounded-full nm-pulse-danger" aria-hidden="true" />
        <Icon v-if="status !== 'unknown'" name="globe" :size="30" />
        <Spinner v-else :size="28" />
      </div>
    </div>
    <div
      v-else
      class="relative flex h-full w-full items-center gap-2.5 rounded-xl border bg-surface py-2.5 pl-3 pr-2.5 shadow-card"
      :class="status === 'down' ? 'border-danger/50' : 'border-border'"
    >
      <!-- pulse layer on top of the opaque card so the WAN edge never shows through -->
      <span v-if="status === 'down'" class="pointer-events-none absolute inset-0 rounded-xl nm-pulse-danger" aria-hidden="true" />
      <div
        class="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
        :class="status === 'up' ? 'bg-success/12 text-success-fg' : status === 'down' ? 'bg-danger/15 text-danger-fg' : 'bg-surface-3 text-subtle'"
      >
        <Icon v-if="status !== 'unknown'" name="globe" :size="20" />
        <Spinner v-else :size="20" />
      </div>

      <div class="relative flex min-w-0 flex-1 flex-col gap-px">
        <p class="truncate text-[13px] font-semibold leading-[18px] text-text">{{ ispName }}</p>
        <p class="truncate font-mono text-[11px] leading-[14px] text-muted">{{ ipLine }}</p>
        <div class="flex min-w-0 flex-col items-start gap-0.5">
          <span
            class="inline-flex h-[18px] shrink-0 items-center gap-1 whitespace-nowrap rounded-sm px-1 text-[11px] font-medium leading-4"
            :class="statusPill.tone"
          >
            <span class="h-1.5 w-1.5 rounded-full" :class="statusPill.dot" aria-hidden="true" />
            {{ statusPill.text }}
          </span>
          <span v-if="speedLine && speedLine.live" class="flex max-w-full items-center gap-1 text-[11px] font-medium leading-[14px] text-muted tabular-nums">
            <Spinner :size="12" />
            <span class="truncate" :class="speedLine.dir === 'down' ? 'text-accent-fg' : speedLine.dir === 'up' ? 'text-info-fg' : ''">{{ speedLine.text }}</span>
          </span>
          <span
            v-else-if="speedLine"
            class="flex max-w-full items-baseline gap-x-0.5 overflow-hidden whitespace-nowrap text-[11px] font-medium leading-[14px] text-muted tabular-nums"
            :title="`Last speed test: ${formatMbpsValue(speed.downloadMbps)} down, ${formatMbpsValue(speed.uploadMbps)} up (${mbpsUnit(speed.downloadMbps)})`"
          >
            <span class="text-accent-fg" aria-hidden="true">↓</span><span class="text-text">{{ formatMbpsValue(speed.downloadMbps) }}</span>
            <span class="ml-1 text-info-fg" aria-hidden="true">↑</span><span class="text-text">{{ formatMbpsValue(speed.uploadMbps) }}</span>
            <span class="ml-0.5 text-[10px] text-subtle">{{ mbpsUnit(speed.downloadMbps) }}</span>
            <span class="sr-only">download and upload</span>
          </span>
        </div>
      </div>
    </div>

    <Handle
      id="out"
      type="source"
      :position="Position.Bottom"
      :connectable="false"
      :style="{ left: anchor.x + 'px', top: anchor.y + 'px' }"
    />
  </div>
</template>
