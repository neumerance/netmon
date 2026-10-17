<script setup>
// Page shell (PLAN §8.5). Every section component takes no props and talks to store.js directly.
import { onMounted, onBeforeUnmount, computed } from 'vue';
import TopBar from './components/alarms/TopBar.vue';
import AlertStack from './components/alarms/AlertStack.vue';
import ToastHost from './components/alarms/ToastHost.vue';
import SettingsDrawer from './components/alarms/SettingsDrawer.vue';
import AlarmController from './components/alarms/AlarmController.vue';
import InternetStatusCard from './components/metrics/InternetStatusCard.vue';
import SpeedTestCard from './components/metrics/SpeedTestCard.vue';
import IspCard from './components/metrics/IspCard.vue';
import SpeedHistoryChart from './components/metrics/SpeedHistoryChart.vue';
import LocalThroughputCard from './components/metrics/LocalThroughputCard.vue';
import EventsPanel from './components/metrics/EventsPanel.vue';
import DevicesPanel from './components/devices/DevicesPanel.vue';
import Icon from './components/ui/Icon.vue';
import Button from './components/ui/Button.vue';
import Skeleton from './components/ui/Skeleton.vue';
import { state, ui, init, runSpeedTest } from './store.js';
import { useStream } from './composables/useStream.js';
import { formatTime } from './lib/format.js';

const stream = useStream();

onMounted(() => {
  init();
  window.addEventListener('keydown', onShortcut);
});
onBeforeUnmount(() => window.removeEventListener('keydown', onShortcut));

// Global shortcut owned by the shell: R = run speed test (DESIGN §9). TopBar owns M / , / T and the
// devices toolbar owns '/'. Ignored while typing or when an overlay is open.
function onShortcut(e) {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  if (e.key !== 'r' && e.key !== 'R') return;
  const t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  if (document.querySelector('[aria-modal="true"]')) return;
  if (!state.loaded || state.speed.running) return;
  e.preventDefault();
  runSpeedTest().catch(() => {});
}

const scanText = computed(() => {
  const cidr = state.network?.cidr;
  return cidr ? `scanning ${cidr}${state.mock ? "" : " every 30s"}` : 'waiting for a network interface';
});

const lastUpdate = computed(() => (stream.lastUpdateAt.value ? formatTime(stream.lastUpdateAt.value) : null));
</script>

<template>
  <div class="flex min-h-screen min-h-dvh flex-col bg-bg text-text">
    <TopBar />

    <!-- Backend unreachable (DESIGN §6): SSE down for > 3 s. Client-side only; not a server alert. -->
    <div
      v-if="stream.showBackendBanner.value"
      data-testid="backend-banner"
      role="status"
      aria-live="polite"
      class="border-b border-border bg-surface-2"
    >
      <div class="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 sm:px-6">
        <Icon name="refresh-cw" :size="16" class="nm-spin text-warning" />
        <p class="text-[13px] font-medium text-text">Backend unreachable — reconnecting…</p>
        <p class="text-xs text-muted">
          Attempt {{ stream.attempts.value }}<template v-if="lastUpdate"> · last update {{ lastUpdate }}</template>
        </p>
        <Button size="sm" variant="secondary" class="ml-auto" data-testid="backend-retry" @click="stream.retry()">Retry now</Button>
      </div>
    </div>

    <AlertStack />

    <main
      class="mx-auto w-full max-w-[1440px] flex-1 px-4 py-4 sm:px-6 lg:py-5"
    >
      <template v-if="state.loaded">
        <!--
          Desktop (xl): wide left column = devices, then speed history; right rail = the compact
          KPI cards stacked, then events. Rows: [devices | cards] [devices | events…] [chart | …events].
          Smaller screens keep DOM order: cards → devices → speed history → events.
        -->
        <div class="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_400px] xl:grid-rows-[auto_auto_1fr] xl:gap-5">
          <aside
            class="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:col-start-2 xl:row-start-1 xl:grid-cols-1"
            aria-label="Internet and this computer"
          >
            <InternetStatusCard />
            <SpeedTestCard />
            <IspCard />
            <LocalThroughputCard />
          </aside>

          <div class="min-w-0 xl:col-start-1 xl:row-span-2 xl:row-start-1">
            <DevicesPanel />
          </div>

          <div class="min-w-0 xl:col-start-1 xl:row-start-3">
            <SpeedHistoryChart />
          </div>

          <aside class="min-w-0 xl:col-start-2 xl:row-span-2 xl:row-start-2" aria-label="Events">
            <EventsPanel />
          </aside>
        </div>
      </template>

      <!-- Initial load skeleton (appears after 150 ms to avoid a flash on fast loads). -->
      <div v-else class="nm-delayed" aria-busy="true" aria-label="Loading NetMon">
        <div class="grid grid-cols-1 gap-4 lg:grid-cols-3 xl:gap-5">
          <div v-for="i in 3" :key="i" class="flex min-h-[116px] flex-col gap-3 rounded-lg border border-border bg-surface p-4 lg:p-5">
            <Skeleton :width="60" :height="10" />
            <Skeleton :width="110" :height="24" />
            <Skeleton :width="140" :height="10" />
          </div>
        </div>
        <div class="mt-4 grid grid-cols-1 gap-4 xl:mt-5 xl:grid-cols-3 xl:gap-5">
          <div class="rounded-lg border border-border bg-surface xl:col-span-2">
            <div class="flex items-center gap-3 border-b border-border p-4">
              <Skeleton :width="80" :height="14" />
              <Skeleton :width="200" :height="28" rounded="md" class="ml-auto" />
            </div>
            <!-- Map is the default Devices view: skeleton the canvas (same height + 3 circles as TopologyMap). -->
            <div
              v-if="ui.devicesView === 'map'"
              class="flex h-[clamp(520px,68vh,640px)] items-center justify-center max-md:h-[62svh] max-md:min-h-[420px]"
            >
              <div class="relative h-[180px] w-[240px]">
                <Skeleton :width="56" :height="56" rounded="full" class="absolute left-1/2 top-0 -translate-x-1/2" />
                <Skeleton :width="48" :height="48" rounded="full" class="absolute bottom-0 left-4" />
                <Skeleton :width="48" :height="48" rounded="full" class="absolute bottom-0 right-4" />
              </div>
            </div>
            <template v-else>
              <div v-for="i in 6" :key="i" class="flex items-center gap-3 border-b border-border px-4 py-3 last:border-0">
                <Skeleton :width="32" :height="32" rounded="md" />
                <div class="flex flex-1 flex-col gap-1.5">
                  <Skeleton :width="160" :height="10" />
                  <Skeleton :width="110" :height="8" />
                </div>
                <Skeleton :width="90" :height="10" class="max-sm:hidden" />
                <Skeleton :width="72" :height="10" class="max-md:hidden" />
              </div>
            </template>
          </div>
          <div class="flex flex-col gap-4 xl:gap-5">
            <div v-for="i in 3" :key="i" class="flex h-40 flex-col gap-3 rounded-lg border border-border bg-surface p-4">
              <Skeleton :width="90" :height="12" />
              <Skeleton height="100%" rounded="md" />
            </div>
          </div>
        </div>
        <p
          v-if="stream.status.value === 'reconnecting'"
          class="mt-6 flex items-center justify-center gap-2 text-center text-[13px] text-muted"
        >
          <Icon name="loader" :size="14" class="nm-spin" />
          Waiting for the NetMon server at <span class="font-mono text-xs">/api</span>…
        </p>
      </div>
    </main>

    <footer class="mx-auto w-full max-w-[1440px] px-4 pb-6 pt-2 text-xs text-subtle sm:px-6">
      NetMon · {{ scanText }} · data stays on this machine<template v-if="state.mock"> · mock data</template>
    </footer>

    <SettingsDrawer />
    <ToastHost />
    <AlarmController />
  </div>
</template>

<style scoped>
.nm-delayed {
  animation: nm-fade-in 120ms ease-out 150ms both;
}
</style>
