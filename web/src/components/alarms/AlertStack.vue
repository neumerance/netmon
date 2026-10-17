<script setup>
// AlertStack — server-computed alerts rendered as banners beneath the TopBar.
//
//   critical (internet_down) : red, pulsing, persistent (no dismiss), role="alert"
//   warning  (slow_speed)    : amber, dismissible, "Run test again"
//   info     (device_offline): calm neutral surface, dismissible, "Show" filters the devices table
//
// One `alert-banner` per visible alert (PLAN §11). When more than 3 info alerts are
// active, the extras collapse behind a "+N more" row that can be expanded.
import { computed, ref } from 'vue';
import {
  state,
  visibleAlerts,
  dismissAlert,
  runSpeedTest,
  setFilter,
  toggleMute,
} from '../../store.js';
import { useNow } from '../../composables/useNow.js';
import { useSound } from '../../composables/useSound.js';
import { formatClock, formatDateTime, formatDurationShort, formatRelative, formatMbpsValue } from '../../lib/format.js';
import Icon from '../ui/Icon.vue';

const now = useNow(1000);
const sound = useSound();

const INFO_VISIBLE_MAX = 3;
const expanded = ref(false);

const alerts = computed(() => visibleAlerts.value || []);
const nonInfo = computed(() => alerts.value.filter((a) => a.level !== 'info'));
const info = computed(() => alerts.value.filter((a) => a.level === 'info'));
const collapsedInfo = computed(() =>
  !expanded.value && info.value.length > INFO_VISIBLE_MAX ? info.value.slice(0, INFO_VISIBLE_MAX - 1) : info.value,
);
const hiddenInfoCount = computed(() => info.value.length - collapsedInfo.value.length);
const shown = computed(() => [...nonInfo.value, ...collapsedInfo.value]);

const LEVEL_STYLE = {
  critical: {
    box: 'nm-pulse-danger border-danger/50 bg-danger/12 text-danger-fg',
    icon: 'alert-octagon',
    iconClass: 'text-danger',
  },
  warning: {
    box: 'border-warning/40 bg-warning/12 text-warning-fg',
    icon: 'alert-triangle',
    iconClass: 'text-warning',
  },
  info: {
    box: 'border-border bg-surface text-text',
    icon: 'info',
    iconClass: 'text-info',
  },
};
function styleFor(a) {
  return LEVEL_STYLE[a.level] || LEVEL_STYLE.info;
}

function deviceFor(mac) {
  if (!mac) return null;
  return (state.devices || []).find((d) => d.mac === mac) || null;
}

function headline(a) {
  if (a.kind === 'internet_down') {
    const since = a.since || state.internet?.since;
    return since ? `${a.title || 'Internet is down'} since ${formatClock(since)}` : a.title || 'Internet is down';
  }
  if (a.kind === 'slow_speed') {
    const last = state.speed?.last;
    if (last && typeof last.downloadMbps === 'number') {
      return `${a.title} — ${formatMbpsValue(last.downloadMbps)} Mbps measured at ${formatClock(last.at)}`;
    }
  }
  return a.title;
}

// Detail line split in two so screen readers are not flooded (DESIGN §5.1/§9: announced once on
// appearance, never every tick): `text` is static and lives in the live region; `tick` changes
// every second and is aria-hidden (`srTick` is its static, announced equivalent).
function detailParts(a) {
  if (a.kind === 'internet_down') {
    const since = Date.parse(a.since || state.internet?.since || '');
    const ok = Number.isFinite(since);
    return {
      text: 'retrying every 5s',
      tick: ok ? ` · down for ${formatDurationShort(Math.max(0, now.value - since))}` : '',
      srTick: '',
    };
  }
  if (a.kind === 'slow_speed') {
    const t = state.settings?.speedThresholdMbps;
    return { text: t ? `Threshold ${t} Mbps. Speed tests run automatically; you can re-test now.` : a.message || '', tick: '', srTick: '' };
  }
  if (a.kind === 'device_offline') {
    const d = deviceFor(a.mac);
    const ip = d?.ip ? ` · ${d.ip}` : '';
    if (!a.since) return { text: `Not seen recently${ip}`, tick: '', srTick: '' };
    return {
      text: '',
      tick: `Last seen ${formatRelative(a.since, now.value)}`,
      srTick: `Last seen at ${formatClock(a.since)}`,
      after: ip,
    };
  }
  return { text: a.message || '', tick: '', srTick: '' };
}
function hasDetail(a) {
  const p = detailParts(a);
  return Boolean(p.text || p.tick || p.after);
}

function detailTitle(a) {
  if (a.kind === 'internet_down') {
    const c = state.internet?.lastCheckedAt;
    return c ? `Last check ${formatDateTime(c)}` : undefined;
  }
  return a.since ? formatDateTime(a.since) : undefined;
}

const speedRunning = computed(() => !!state.speed?.running);
async function retest() {
  try {
    await runSpeedTest();
  } catch {
    /* store already toasts errors */
  }
}

function showOffline() {
  setFilter('offline');
  const target =
    document.querySelector('[data-testid="devices-panel"]') ||
    document.querySelector('[data-testid="filter-offline"]') ||
    document.querySelector('[data-testid="devices-table"]');
  target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function enableSound() {
  const ok = await sound.unlock();
  if (ok) sound.restartAlarmLoop();
}
</script>

<template>
  <div
    v-if="shown.length"
    class="sticky top-14 z-[29] border-b border-border/60 bg-bg/80 backdrop-blur"
    data-testid="alert-stack"
  >
    <div class="mx-auto flex max-w-[1440px] flex-col gap-2 px-4 py-2 sm:px-6">
      <div
        v-for="a in shown"
        :key="a.id"
        class="flex flex-col gap-2 rounded-lg border px-4 py-3 sm:flex-row sm:items-center sm:gap-3"
        :class="styleFor(a).box"
        data-testid="alert-banner"
        :data-level="a.level"
        :data-kind="a.kind"
        :data-alert-id="a.id"
        :role="a.level === 'critical' ? 'alert' : 'status'"
        :aria-live="a.level === 'critical' ? 'assertive' : 'polite'"
      >
        <div class="flex min-w-0 flex-1 items-start gap-3">
          <Icon
            :name="a.kind === 'device_offline' ? 'circle-off' : styleFor(a).icon"
            :size="18"
            class="mt-px shrink-0"
            :class="styleFor(a).iconClass"
          />
          <div class="min-w-0">
            <p class="text-sm font-medium leading-5" :class="a.level === 'info' ? 'text-text' : ''">
              {{ headline(a) }}
            </p>
            <p
              v-if="hasDetail(a)"
              class="text-[13px] leading-5"
              :class="a.level === 'info' ? 'text-muted' : ''"
              :title="detailTitle(a)"
            >
              <span v-if="detailParts(a).text">{{ detailParts(a).text }}</span><span
                v-if="detailParts(a).tick"
                aria-hidden="true"
                data-testid="alert-elapsed"
              >{{ detailParts(a).tick }}</span><span
                v-if="detailParts(a).srTick"
                class="sr-only"
              >{{ detailParts(a).srTick }}</span><span v-if="detailParts(a).after">{{ detailParts(a).after }}</span>
            </p>
          </div>
        </div>

        <div class="flex shrink-0 flex-wrap items-center gap-2 pl-[30px] sm:pl-0">
          <!-- Critical: sound controls, never dismissible -->
          <template v-if="a.level === 'critical'">
            <button
              v-if="sound.needsUnlock.value"
              type="button"
              class="inline-flex h-8 items-center gap-1.5 rounded-md border border-danger/50 bg-danger/15 px-3 text-[13px] font-medium text-danger-fg hover:bg-danger/25"
              data-testid="enable-sound-btn"
              @click="enableSound"
            >
              <Icon name="volume" :size="14" />
              Enable sound
            </button>
            <button
              v-else-if="sound.sounding.value"
              type="button"
              class="inline-flex h-8 items-center gap-1.5 rounded-md border border-danger/50 px-3 text-[13px] font-medium text-danger-fg hover:bg-danger/15"
              data-testid="alert-mute-btn"
              @click="toggleMute()"
            >
              <Icon name="bell-off" :size="14" />
              Mute
            </button>
          </template>

          <!-- Warning: re-test -->
          <button
            v-if="a.kind === 'slow_speed'"
            type="button"
            class="inline-flex h-8 items-center gap-1.5 rounded-md border border-warning/40 px-3 text-[13px] font-medium text-warning-fg hover:bg-warning/15 disabled:cursor-not-allowed disabled:opacity-60"
            data-testid="alert-retest-btn"
            :disabled="speedRunning"
            @click="retest"
          >
            <Icon name="refresh" :size="14" :class="speedRunning ? 'nm-spin' : ''" />
            {{ speedRunning ? 'Testing…' : 'Run test again' }}
          </button>

          <!-- Info: jump to offline devices -->
          <button
            v-if="a.kind === 'device_offline'"
            type="button"
            class="inline-flex h-8 items-center rounded-md border border-border-strong px-3 text-[13px] font-medium text-text hover:bg-surface-3"
            data-testid="alert-show-btn"
            @click="showOffline"
          >
            Show
          </button>

          <button
            v-if="a.level !== 'critical'"
            type="button"
            class="inline-flex h-8 w-8 items-center justify-center rounded-md opacity-80 hover:bg-surface-3 hover:opacity-100"
            :class="a.level === 'info' ? 'text-muted' : ''"
            data-testid="alert-dismiss"
            :aria-label="`Dismiss: ${a.title}`"
            title="Dismiss"
            @click="dismissAlert(a.id)"
          >
            <Icon name="x" :size="16" />
          </button>
        </div>
      </div>

      <!-- Collapsed info alerts -->
      <button
        v-if="hiddenInfoCount > 0 || (expanded && info.length > INFO_VISIBLE_MAX)"
        type="button"
        class="self-start rounded-md px-2 py-1 text-[13px] text-muted hover:bg-surface-3 hover:text-text"
        data-testid="alert-more-btn"
        :aria-expanded="expanded ? 'true' : 'false'"
        @click="expanded = !expanded"
      >
        {{ expanded ? 'Show fewer' : `+${hiddenInfoCount} more saved devices offline` }}
      </button>
    </div>
  </div>
</template>
