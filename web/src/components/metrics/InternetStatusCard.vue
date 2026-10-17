<script setup>
// Internet status KPI (PLAN §8.6 metrics, DESIGN §3.2).
// Big Online / Offline / Checking… readout driven by the server probe (state.internet), uptime or
// downtime counter, last-check age, probe HTTP latency + a sparkline of the last 60 probes
// (client-side rolling buffer). Pulses red while the internet is down.
import { computed, ref, watch } from 'vue';
import KpiCard from './KpiCard.vue';
import Icon from '../ui/Icon.vue';
import Badge from '../ui/Badge.vue';
import Spinner from '../ui/Spinner.vue';
import Sparkline from '../ui/Sparkline.vue';
import { state, isSlow } from '../../store.js';
import { useNow } from '../../composables/useNow.js';
import { formatClock, formatDateTime, formatMbps } from '../../lib/format.js';
import { agoShort, downIntervals, latencyQuality, msValue, QUALITY_TEXT, shortDuration, toMs } from './metricsUtil.js';

const now = useNow(1000);

const internet = computed(() => state.internet || {});
const status = computed(() => {
  const s = internet.value.status;
  return s === 'up' || s === 'down' ? s : 'unknown';
});

const statusText = computed(() => ({ up: 'Online', down: 'Offline', unknown: 'Checking…' })[status.value]);

const sinceMs = computed(() => toMs(internet.value.since));
const elapsed = computed(() => (sinceMs.value == null ? null : Math.max(0, now.value - sinceMs.value)));

const checkedAgo = computed(() => {
  const at = internet.value.lastCheckedAt;
  if (!at) return null;
  const a = agoShort(at, now.value);
  return a === 'now' ? 'checked just now' : `checked ${a}`;
});

const failures = computed(() => internet.value.consecutiveFailures ?? 0);

const metaText = computed(() => {
  if (status.value === 'up') {
    const parts = [];
    if (elapsed.value != null) parts.push(`Up ${shortDuration(elapsed.value)}`);
    if (checkedAgo.value) parts.push(checkedAgo.value);
    return parts.join(' · ') || 'Connected';
  }
  if (status.value === 'down') {
    const parts = [];
    if (sinceMs.value != null) parts.push(`Since ${formatClock(internet.value.since)} (${shortDuration(elapsed.value)})`);
    if (failures.value > 0) parts.push(`${failures.value} failed probe${failures.value === 1 ? '' : 's'}`);
    return parts.join(' · ');
  }
  return 'Waiting for the first connectivity check…';
});

// ---- Probe latency history (last 60 checks; null = failed check) ----
const PROBE_POINTS = 60;
const probeHistory = ref([]);
watch(
  () => internet.value.lastCheckedAt,
  (at, prev) => {
    if (!at || at === prev) return;
    const v = internet.value.status === 'down' || internet.value.error ? null : internet.value.latencyMs ?? null;
    const next = probeHistory.value.concat([typeof v === 'number' ? v : null]);
    probeHistory.value = next.length > PROBE_POINTS ? next.slice(-PROBE_POINTS) : next;
  },
  { immediate: true },
);

const latency = computed(() => (status.value === 'up' ? internet.value.latencyMs ?? null : null));
const quality = computed(() => latencyQuality(latency.value));
const sparkTone = computed(() => ({ excellent: 'success', good: 'success', fair: 'warning', poor: 'danger' })[quality.value] || 'neutral');

const targetLabel = computed(() => internet.value.target || null);

// ---- Mini stats: availability over the probe buffer + most recent outage (from events) ----
const availability = computed(() => {
  const h = probeHistory.value;
  if (!h.length) return null;
  const ok = h.filter((v) => v != null).length;
  return { pct: Math.round((ok / h.length) * 1000) / 10, n: h.length };
});
const lastOutage = computed(() => {
  const ivs = downIntervals(state.events, now.value, status.value === 'down');
  if (!ivs.length) return null;
  const iv = ivs[ivs.length - 1];
  return { start: iv.start, ms: iv.end - iv.start, ongoing: status.value === 'down' && iv.end >= now.value - 1000 };
});
const lastOutageText = computed(() => {
  const o = lastOutage.value;
  if (!o) return 'None recorded';
  if (o.ongoing) return `Now · ${shortDuration(o.ms)}`;
  return `${agoShort(new Date(o.start).toISOString(), now.value)} · ${shortDuration(o.ms)}`;
});

const slowTitle = computed(() => {
  const last = state.speed?.last;
  const thr = state.settings?.speedThresholdMbps;
  if (!last) return '';
  return `Last test ${formatMbps(last.downloadMbps)} — below the ${thr} Mbps threshold`;
});
</script>

<template>
  <KpiCard
    label="Internet"
    icon="globe"
    data-testid="kpi-internet-status"
    :data-state="status"
    :tone="status === 'down' ? 'danger' : 'neutral'"
    :pulse="status === 'down'"
  >
    <template #aside>
      <Badge v-if="status === 'up' && isSlow" tone="warning" :title="slowTitle" data-testid="internet-slow-badge">Slow</Badge>
      <span
        v-if="targetLabel && status !== 'unknown'"
        class="hidden rounded-sm bg-surface-2 px-1.5 text-[11px] leading-5 text-subtle sm:inline"
        :title="`Connectivity probe target: ${targetLabel}`"
      >{{ targetLabel }}</span>
    </template>

    <div class="flex min-w-0 items-center gap-2.5" aria-live="polite">
      <span v-if="status === 'unknown'" class="text-muted"><Spinner :size="18" /></span>
      <span v-else class="relative flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
        <span
          v-if="status === 'down'"
          class="nm-ping absolute inline-flex h-full w-full rounded-full bg-danger"
        />
        <span
          class="relative inline-flex h-2.5 w-2.5 rounded-full"
          :class="status === 'up' ? 'bg-success' : 'bg-danger'"
        />
      </span>
      <span
        data-testid="internet-status"
        :data-status="status"
        class="text-[20px] font-semibold leading-7 tracking-tight"
        :class="{
          'text-success-fg': status === 'up',
          'text-danger-fg': status === 'down',
          'text-muted': status === 'unknown',
        }"
      >{{ statusText }}</span>
      <Icon v-if="status === 'down'" name="wifi-off" :size="18" class="text-danger-fg" />
      <!-- Compact: probe latency + sparkline sit on the status row instead of a footer. -->
      <div
        class="ml-auto flex shrink-0 items-center gap-2"
        :title="`Probe latency, last ${probeHistory.length} checks${availability ? ` · ${availability.pct}% available` : ''} · last outage: ${lastOutageText}`"
      >
        <span class="text-[13px] font-medium tabular-nums" :class="QUALITY_TEXT[quality]">
          <template v-if="latency != null">{{ msValue(latency) }}<span class="ml-0.5 text-[11px] font-normal text-muted">ms</span></template>
          <template v-else-if="status === 'down'"><span class="text-danger-fg">No response</span></template>
          <template v-else>—</template>
        </span>
        <Sparkline :values="probeHistory" :width="56" :height="20" :tone="sparkTone" />
      </div>
    </div>

    <p
      class="truncate text-xs text-muted"
      :title="internet.since ? `Status since ${formatDateTime(internet.since)}` : undefined"
    >{{ metaText }}<template v-if="availability"> · {{ availability.pct }}% up</template></p>
  </KpiCard>
</template>
