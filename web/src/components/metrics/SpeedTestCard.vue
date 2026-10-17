<script setup>
// Internet speed KPI (PLAN §8.6 metrics, DESIGN §3.2 / §3.8).
//  - Download / Upload / Ping·Jitter tiles from the last SpeedResult (tweened numbers, threshold
//    colouring, delta vs the previous test, threshold bar on Download).
//  - SpeedGauge dial: live Mbps while a test runs, otherwise the last download vs threshold.
//  - Run button + live progress (phase / overall percent / current Mbps) driven by SSE `speed`.
//    Only one test at a time: whoever started it (auto, startup, another tab), we show progress.
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import KpiCard from './KpiCard.vue';
import AnimatedNumber from './AnimatedNumber.vue';
import Button from '../ui/Button.vue';
import Icon from '../ui/Icon.vue';
import Tooltip from '../ui/Tooltip.vue';
import { state, isSlow, runSpeedTest } from '../../store.js';
import { useNow } from '../../composables/useNow.js';
import { formatClock, formatDateTime, formatMbpsValue, formatRelative, mbpsUnit } from '../../lib/format.js';
import {
  clamp,
  formatIn,
  isNum,
  latencyQuality,
  msValue,
  niceCeil,
  pctChange,
  QUALITY_LABELS,
  QUALITY_TEXT,
  toMs,
  pastRelative,
} from './metricsUtil.js';

const now = useNow(1000);

const speed = computed(() => state.speed || {});
const last = computed(() => speed.value.last || null);
const threshold = computed(() => state.settings?.speedThresholdMbps ?? 200);
const running = computed(() => !!speed.value.running);
const progress = computed(() => (running.value ? speed.value.progress || null : null));
const internetDown = computed(() => state.internet?.status === 'down');

// Previous result (the one before `last`) for deltas.
const prev = computed(() => {
  const h = speed.value.history || [];
  if (!last.value) return null;
  const i = h.findIndex((r) => r.id === last.value.id);
  if (i > 0) return h[i - 1];
  if (i === -1 && h.length) return h[h.length - 1];
  return null;
});

function delta(key) {
  const p = pctChange(last.value?.[key], prev.value?.[key]);
  if (p == null) return null;
  const tone = p > 0 ? 'text-success-fg' : p < -10 ? 'text-danger-fg' : 'text-muted';
  return { pct: Math.abs(p), up: p > 0, flat: p === 0, tone };
}
const downDelta = computed(() => delta('downloadMbps'));
const upDelta = computed(() => delta('uploadMbps'));

const downloadSlow = computed(() => isSlow.value);
const pingQuality = computed(() => latencyQuality(last.value?.pingMs));

// Threshold bar (Download tile): value vs threshold on a scale with headroom.
const barScale = computed(() => niceCeil(Math.max(threshold.value * 1.6, (last.value?.downloadMbps ?? 0) * 1.15, 10)));
const barFill = computed(() => (last.value ? clamp(last.value.downloadMbps / barScale.value, 0, 1) : 0));
const barTick = computed(() => clamp(threshold.value / barScale.value, 0, 1));

// ---- Run / progress state ----
const starting = ref(false);
async function onRun() {
  if (starting.value) return;
  starting.value = true;
  justFinished.value = null;
  try {
    await runSpeedTest();
  } catch {
    /* store already toasted */
  } finally {
    starting.value = false;
  }
}

const phase = computed(() => progress.value?.phase || 'starting');
const percent = computed(() => clamp(Math.round(progress.value?.percent ?? 0), 0, 100));
const currentMbps = computed(() => (isNum(progress.value?.currentMbps) ? progress.value.currentMbps : null));

// While a phase runs, its tile shows the LIVE Mbps from progress events (DESIGN §3.2) instead of
// the previous result next to a "Testing…" label. data-value keeps the last completed result.
const liveDown = computed(() => running.value && phase.value === 'download');
const liveUp = computed(() => running.value && phase.value === 'upload');
const downShown = computed(() => (liveDown.value ? currentMbps.value : last.value ? last.value.downloadMbps : null));
const upShown = computed(() => (liveUp.value ? currentMbps.value : last.value ? last.value.uploadMbps : null));

const progressText = computed(() => {
  if (!progress.value) return 'Starting…';
  if (percent.value >= 99) return 'Finishing…';
  if (phase.value === 'latency') return 'Measuring latency…';
  const label = phase.value === 'upload' ? 'Upload' : 'Download';
  const mbps = currentMbps.value != null ? ` · ${formatMbpsValue(currentMbps.value)} ${mbpsUnit(currentMbps.value)}` : '';
  return `${label} · ${percent.value}%${mbps}`;
});
// Announced politely on phase changes only (not every percent tick).
const phaseAnnouncement = computed(() => {
  if (!running.value) return '';
  return { starting: 'Speed test starting', latency: 'Measuring latency', download: 'Measuring download speed', upload: 'Measuring upload speed' }[phase.value] || '';
});

// "Just finished" flash for 3 s after a run completes with a new result.
const justFinished = ref(null);
let finishTimer = 0;
let runStartLastId = null;
watch(running, (isRunning, wasRunning) => {
  if (isRunning) {
    runStartLastId = last.value?.id ?? null;
    justFinished.value = null;
    return;
  }
  if (wasRunning && last.value && last.value.id !== runStartLastId) {
    justFinished.value = last.value;
    clearTimeout(finishTimer);
    finishTimer = setTimeout(() => (justFinished.value = null), 3000);
  }
});
onBeforeUnmount(() => clearTimeout(finishTimer));

const failed = computed(() => {
  const err = speed.value.lastError;
  if (!err || running.value) return null;
  const errAt = toMs(err.at);
  const lastAt = toMs(last.value?.at);
  if (lastAt != null && errAt != null && errAt <= lastAt) return null;
  return err;
});

// ---- Gauge ----
const peak = ref(0);
watch(currentMbps, (v) => {
  if (isNum(v) && v > peak.value) peak.value = v;
});
watch(phase, () => (peak.value = 0));

const gauge = computed(() => {
  if (running.value) {
    if (phase.value === 'upload') {
      const max = niceCeil(Math.max((last.value?.uploadMbps ?? 0) * 1.5, peak.value * 1.15, 50));
      return { value: currentMbps.value, max, threshold: null, tone: 'info', label: 'Upload', live: true };
    }
    const max = niceCeil(Math.max(threshold.value * 1.5, (last.value?.downloadMbps ?? 0) * 1.2, peak.value * 1.15, 100));
    return {
      value: phase.value === 'download' ? currentMbps.value : null,
      max,
      threshold: threshold.value,
      tone: 'accent',
      label: phase.value === 'download' ? 'Download' : 'Latency',
      live: true,
    };
  }
  const v = last.value?.downloadMbps ?? null;
  const max = niceCeil(Math.max(threshold.value * 1.5, (v ?? 0) * 1.2, 100));
  return { value: v, max, threshold: threshold.value, tone: downloadSlow.value ? 'warning' : 'accent', label: 'Download', live: false };
});

// ---- Meta text ----
const lastText = computed(() => {
  if (!last.value) return null;
  const rel = pastRelative(formatRelative, last.value.at, now.value);
  return `Tested ${formatClock(last.value.at)} · ${rel}`;
});
const nextText = computed(() => {
  if ((state.settings?.speedTestIntervalMin ?? 15) === 0) return 'Automatic tests off';
  if (!speed.value.nextAutoAt) return null;
  const rel = formatIn(speed.value.nextAutoAt, now.value);
  return rel === 'now' ? 'Next automatic test due now' : `Next automatic test ${rel}`;
});

// Never block the user from running a test (no cooldown, works while "down"); only swallow the double-click
// while the start request is in flight. Pressing during a running test just reports that one is running.
const buttonDisabled = computed(() => starting.value);
const buttonTip = computed(() => {
  if (running.value) return 'A speed test is running';
  return [last.value ? `Last test ${formatClock(last.value.at)}` : 'No test yet', nextText.value?.toLowerCase()]
    .filter(Boolean)
    .join(' · ');
});

const fmtMbpsNum = (n) => formatMbpsValue(n);
const fmtMs = (n) => msValue(n);
</script>

<template>
  <KpiCard
    label="Internet speed"
    icon="gauge"
    data-testid="speedtest-card"
    :tone="downloadSlow && !internetDown ? 'warning' : 'neutral'"
  >
    <template #aside>
      <Tooltip :text="buttonTip" data-testid="run-speedtest">
        <Button
          data-testid="run-speedtest-btn"
          variant="primary"
          size="sm"
          icon="play"
          :disabled="buttonDisabled"
          :aria-disabled="buttonDisabled ? 'true' : undefined"
          @click="onRun"
        >Run speed test</Button>
      </Tooltip>
    </template>

    <!-- Result tiles -->
    <div class="grid grid-cols-1 gap-1.5 @xs:grid-cols-3 @xs:gap-2 @sm:gap-3">
      <!-- Download -->
      <section
        data-testid="kpi-download"
        class="flex min-w-0 items-center justify-between gap-2 rounded-md bg-surface-2 px-2.5 py-1.5 @xs:block @xs:py-2 @sm:px-3"
        :class="downloadSlow ? 'ring-1 ring-inset ring-warning/40' : ''"
        aria-label="Download speed"
      >
        <div class="flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.06em] text-subtle">
          <Icon :name="running && phase === 'download' ? 'loader' : 'arrow-down'" :size="12" :class="running && phase === 'download' ? 'nm-spin text-accent-fg' : 'text-accent-fg'" />
          <span class="truncate">{{ running && phase === 'download' ? 'Testing…' : 'Download' }}</span>
        </div>
        <div class="flex items-baseline gap-1 whitespace-nowrap @xs:mt-1">
          <span data-testid="kpi-value" class="text-[18px] font-semibold leading-6 tracking-tight @xs:text-[20px] @xs:leading-7 " :class="liveDown ? 'text-text opacity-80' : downloadSlow ? 'text-warning-fg' : 'text-text'">
            <AnimatedNumber
              data-testid="speed-download"
              :data-value="last ? last.downloadMbps : ''"
              :data-live="liveDown ? 'true' : undefined"
              :value="downShown"
              :animate="!liveDown"
              :format="fmtMbpsNum"
            />
          </span>
          <span class="text-[12px] font-medium text-muted">{{ mbpsUnit(downShown) }}</span>
        </div>
        <div class="mt-0.5 hidden items-center gap-1 truncate text-[11px] leading-4 text-muted @xs:flex">
          <template v-if="liveDown">Live · {{ percent }}%</template>
          <template v-else-if="!last">No test yet</template>
          <template v-else-if="downDelta && !downDelta.flat">
            <span :class="downDelta.tone" :title="`vs previous test (${formatMbpsValue(prev?.downloadMbps)} Mbps)`">{{ downDelta.up ? '▲' : '▼' }} {{ downDelta.pct }}%</span>
            <span class="truncate">vs prev</span>
          </template>
          <template v-else-if="downloadSlow"><span class="text-warning-fg">Below {{ threshold }}</span></template>
          <template v-else>≥ {{ threshold }} <Icon name="check" :size="11" class="text-success-fg" /></template>
        </div>
        <!-- threshold bar -->
        <div
          class="relative mt-1.5 hidden h-[3px] rounded-full bg-surface-3 @xs:block"
          :title="`Threshold ${threshold} Mbps`"
          data-testid="speed-threshold-bar"
        >
          <div
            class="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
            :class="downloadSlow ? 'bg-warning' : 'bg-accent'"
            :style="{ width: (barFill * 100).toFixed(1) + '%' }"
          />
          <div class="absolute -top-[2px] h-[7px] w-px bg-text/60" :style="{ left: (barTick * 100).toFixed(1) + '%' }" />
        </div>
      </section>

      <!-- Upload -->
      <section data-testid="kpi-upload" class="flex min-w-0 items-center justify-between gap-2 rounded-md bg-surface-2 px-2.5 py-1.5 @xs:block @xs:py-2 @sm:px-3" aria-label="Upload speed">
        <div class="flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.06em] text-subtle">
          <Icon :name="running && phase === 'upload' ? 'loader' : 'arrow-up'" :size="12" :class="running && phase === 'upload' ? 'nm-spin text-info-fg' : 'text-info-fg'" />
          <span class="truncate">{{ running && phase === 'upload' ? 'Testing…' : 'Upload' }}</span>
        </div>
        <div class="flex items-baseline gap-1 whitespace-nowrap @xs:mt-1">
          <span data-testid="kpi-value" class="text-[18px] font-semibold leading-6 tracking-tight @xs:text-[20px] @xs:leading-7 text-text " :class="liveUp ? 'opacity-80' : ''">
            <AnimatedNumber
              data-testid="speed-upload"
              :data-value="last ? last.uploadMbps : ''"
              :data-live="liveUp ? 'true' : undefined"
              :value="upShown"
              :animate="!liveUp"
              :format="fmtMbpsNum"
            />
          </span>
          <span class="text-[12px] font-medium text-muted">{{ mbpsUnit(upShown) }}</span>
        </div>
        <div class="mt-0.5 hidden items-center gap-1 truncate text-[11px] leading-4 text-muted @xs:flex">
          <template v-if="liveUp">Live · {{ percent }}%</template>
          <template v-else-if="!last">No test yet</template>
          <template v-else-if="upDelta && !upDelta.flat">
            <span :class="upDelta.tone" :title="`vs previous test (${formatMbpsValue(prev?.uploadMbps)} Mbps)`">{{ upDelta.up ? '▲' : '▼' }} {{ upDelta.pct }}%</span>
            <span class="truncate">vs prev</span>
          </template>
          <template v-else>{{ formatClock(last.at) }}</template>
        </div>
      </section>

      <!-- Ping · Jitter -->
      <section data-testid="kpi-ping" class="flex min-w-0 items-center justify-between gap-2 rounded-md bg-surface-2 px-2.5 py-1.5 @xs:block @xs:py-2 @sm:px-3" aria-label="Ping and jitter">
        <div class="flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.06em] text-subtle">
          <Icon :name="running && phase === 'latency' ? 'loader' : 'activity'" :size="12" :class="running && phase === 'latency' ? 'nm-spin' : ''" />
          <span class="truncate">{{ running && phase === 'latency' ? 'Testing…' : 'Ping' }}</span>
        </div>
        <div class="flex items-baseline gap-1 whitespace-nowrap @xs:mt-1">
          <span data-testid="kpi-value" class="text-[18px] font-semibold leading-6 tracking-tight @xs:text-[20px] @xs:leading-7 " :class="last ? QUALITY_TEXT[pingQuality] : 'text-text'">
            <AnimatedNumber
              data-testid="speed-ping"
              :data-value="last ? last.pingMs : ''"
              :value="last ? last.pingMs : null"
              :format="fmtMs"
            />
          </span>
          <span class="text-[12px] font-medium text-muted">ms</span>
        </div>
        <div
          class="mt-0.5 hidden truncate text-[11px] leading-4 text-muted @xs:block"
          :title="last ? `${QUALITY_LABELS[pingQuality]} latency · jitter ${msValue(last.jitterMs)} ms` : undefined"
        >
          <template v-if="last">± {{ msValue(last.jitterMs) }} ms jitter</template>
          <template v-else>No test yet</template>
        </div>
      </section>
    </div>

    <!-- Status (compact: no gauge) -->
    <div class="flex flex-col items-stretch gap-2">

      <div class="min-w-0 flex-1">
        <span class="sr-only" aria-live="polite">{{ phaseAnnouncement }}</span>

        <!-- Running -->
        <div
          v-if="running"
          data-testid="speedtest-progress"
          :data-phase="phase"
          :data-percent="percent"
          role="progressbar"
          aria-label="Speed test progress"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="percent"
          :aria-valuetext="progressText"
          class="min-w-0"
        >
          <div class="flex items-center gap-1.5 text-[13px] font-medium text-text">
            <Icon name="loader" :size="14" class="nm-spin shrink-0" :class="phase === 'upload' ? 'text-info-fg' : 'text-accent-fg'" />
            <span class="truncate tabular-nums">{{ progressText }}</span>
          </div>
          <div class="mt-2 h-[3px] overflow-hidden rounded-full bg-surface-3">
            <div
              class="h-full rounded-full transition-[width] duration-200 ease-linear"
              :class="phase === 'upload' ? 'bg-info' : 'bg-accent'"
              :style="{ width: percent + '%' }"
            />
          </div>
          <p class="mt-1.5 text-[11px] text-subtle">Measuring via Cloudflare</p>
        </div>

        <!-- Just finished -->
        <div v-else-if="justFinished" class="flex items-center gap-1.5 text-[13px] font-medium" :class="justFinished.downloadMbps < threshold ? 'text-warning-fg' : 'text-success-fg'" data-testid="speedtest-done">
          <Icon name="check" :size="14" />
          <span class="tabular-nums">{{ formatMbpsValue(justFinished.downloadMbps) }} / {{ formatMbpsValue(justFinished.uploadMbps) }} Mbps</span>
        </div>

        <!-- Failed -->
        <div v-else-if="failed" class="min-w-0" data-testid="speedtest-error">
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-sm text-[13px] font-medium text-danger-fg hover:underline disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="buttonDisabled"
            :title="failed.message"
            @click="onRun"
          >
            <Icon name="alert-triangle" :size="14" />
            Speed test failed · Retry
          </button>
          <p class="mt-1 truncate text-[11px] text-subtle" :title="formatDateTime(failed.at)">{{ pastRelative(formatRelative, failed.at, now) }}</p>
        </div>

        <!-- Idle -->
        <div v-else class="min-w-0 space-y-0.5">
          <!-- Compact: verdict + when on one line; full details in the tooltip. -->
          <template v-if="last">
            <div
              class="flex min-w-0 items-center gap-1.5 text-[12px]"
              :title="`${formatDateTime(last.at)}${last.colo ? ` · via ${last.colo}` : ''}${nextText && !internetDown ? ` · ${nextText}` : ''}`"
            >
              <Icon :name="downloadSlow ? 'alert-triangle' : 'check-circle'" :size="13" class="shrink-0" :class="downloadSlow ? 'text-warning-fg' : 'text-success-fg'" />
              <span class="shrink-0 font-medium" :class="downloadSlow ? 'text-warning-fg' : 'text-success-fg'">{{ downloadSlow ? `Below ${threshold} Mbps` : `Above ${threshold} Mbps` }}</span>
              <span class="truncate text-muted">· {{ lastText }}</span>
            </div>
          </template>
          <template v-else>
            <div class="text-[13px] font-medium text-text">No test yet</div>
            <button
              type="button"
              class="text-xs font-medium text-accent-fg hover:underline disabled:opacity-60"
              :disabled="buttonDisabled"
              @click="onRun"
            >Run now</button>
          </template>
          <p v-if="nextText && !internetDown && !last" class="truncate text-[11px] text-subtle">{{ nextText }}</p>
          <p v-if="internetDown" class="truncate text-[11px] text-danger-fg">Automatic tests paused while the internet is down</p>
        </div>
      </div>
    </div>
  </KpiCard>
</template>
