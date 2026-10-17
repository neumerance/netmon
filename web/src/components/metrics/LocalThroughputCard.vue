<script setup>
// This computer's live throughput (PLAN §8.6 metrics): rx/tx Mbps of the `isSelf` device, from the
// server's interface-counter monitor. Keeps a client-side rolling buffer (60 samples, one every
// 2 s ≈ 2 minutes) drawn as a small dual-series area chart.
// Other devices' throughput cannot be observed from one host without router integration.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import KpiCard from './KpiCard.vue';
import Icon from '../ui/Icon.vue';
import AnimatedNumber from './AnimatedNumber.vue';
import { state, selfDevice } from '../../store.js';
import { formatMbpsValue, mbpsUnit } from '../../lib/format.js';
import { deviceDisplayName } from '../../lib/deviceTypes.js';
import { isNum, niceCeil } from './metricsUtil.js';

const BUFFER = 60;
const SAMPLE_MS = 2000;

const self = computed(() => selfDevice.value || null);
const rx = computed(() => (isNum(self.value?.rxMbps) ? self.value.rxMbps : null));
const tx = computed(() => (isNum(self.value?.txMbps) ? self.value.txMbps : null));

const rxBuf = ref([]);
const txBuf = ref([]);

function push() {
  const r = rx.value;
  const t = tx.value;
  if (r == null && t == null && !rxBuf.value.length) return; // nothing yet
  rxBuf.value = rxBuf.value.concat([r]).slice(-BUFFER);
  txBuf.value = txBuf.value.concat([t]).slice(-BUFFER);
}

let timer = 0;
onMounted(() => {
  push();
  timer = setInterval(push, SAMPLE_MS);
});
onBeforeUnmount(() => clearInterval(timer));
// First real sample should appear immediately rather than up to 2 s later.
watch(
  () => rx.value != null || tx.value != null,
  (has) => {
    if (has && !rxBuf.value.length) push();
  },
);

const peak = computed(() => {
  let m = 0;
  for (const v of rxBuf.value) if (isNum(v)) m = Math.max(m, v);
  for (const v of txBuf.value) if (isNum(v)) m = Math.max(m, v);
  return m;
});

// ---- chart geometry (viewBox units; stretched with preserveAspectRatio="none") ----
const W = 240;
const H = 56;
const yMax = computed(() => niceCeil(Math.max(1, peak.value * 1.15)));

function series(buf) {
  const n = BUFFER;
  const pts = [];
  // Right-align so new samples enter from the right edge.
  const offset = n - buf.length;
  buf.forEach((v, i) => {
    if (!isNum(v)) return;
    const x = ((offset + i) / (n - 1)) * W;
    const y = H - 1 - (Math.min(v, yMax.value) / yMax.value) * (H - 3);
    pts.push([x, y]);
  });
  return pts;
}
const toLine = (pts) => (pts.length < 2 ? null : pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' '));
const toArea = (pts) =>
  pts.length < 2 ? null : `${toLine(pts)} L${pts[pts.length - 1][0].toFixed(1)} ${H} L${pts[0][0].toFixed(1)} ${H} Z`;

const rxPts = computed(() => series(rxBuf.value));
const txPts = computed(() => series(txBuf.value));

const uid = Math.random().toString(36).slice(2, 8);
const gradRx = `nm-thr-rx-${uid}`;
const gradTx = `nm-thr-tx-${uid}`;

const ifaceText = computed(() => {
  const n = state.network;
  if (!n) return null;
  return [n.iface, n.ip].filter(Boolean).join(' · ');
});
const selfName = computed(() => (self.value ? deviceDisplayName(self.value) : 'This computer'));
const hasData = computed(() => rx.value != null || tx.value != null);
const fmt = (n) => formatMbpsValue(n);
</script>

<template>
  <KpiCard label="This computer" icon="laptop" data-testid="local-throughput">
    <template #aside>
      <span v-if="hasData" class="inline-flex items-center gap-1.5 text-[11px] font-medium text-success-fg">
        <span class="relative flex h-1.5 w-1.5" aria-hidden="true">
          <span class="nm-ping absolute inline-flex h-full w-full rounded-full bg-success" />
          <span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
        </span>
        Live
      </span>
    </template>

    <p class="-mt-1 truncate text-xs text-muted" :title="`${self?.mac ? `${selfName} · ${self.mac} · ` : ''}Live traffic from interface counters; other devices need router integration`">
      {{ selfName }}<template v-if="ifaceText"> · {{ ifaceText }}</template>
    </p>

    <div class="grid grid-cols-2 gap-3">
      <div class="min-w-0">
        <div class="flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.06em] text-subtle">
          <Icon name="arrow-down" :size="12" class="text-accent-fg" /> Receiving
        </div>
        <div class="mt-0.5 flex items-baseline gap-1 whitespace-nowrap">
          <AnimatedNumber
            data-testid="local-rx"
            :data-value="rx ?? ''"
            :value="rx"
            :format="fmt"
            :duration="300"
            class="text-[20px] font-semibold leading-7 tracking-tight text-text"
          />
          <span class="text-[12px] font-medium text-muted">{{ mbpsUnit(rx) }}</span>
        </div>
      </div>
      <div class="min-w-0">
        <div class="flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.06em] text-subtle">
          <Icon name="arrow-up" :size="12" class="text-info-fg" /> Sending
        </div>
        <div class="mt-0.5 flex items-baseline gap-1 whitespace-nowrap">
          <AnimatedNumber
            data-testid="local-tx"
            :data-value="tx ?? ''"
            :value="tx"
            :format="fmt"
            :duration="300"
            class="text-[20px] font-semibold leading-7 tracking-tight text-text"
          />
          <span class="text-[12px] font-medium text-muted">{{ mbpsUnit(tx) }}</span>
        </div>
      </div>
    </div>
  </KpiCard>
</template>
