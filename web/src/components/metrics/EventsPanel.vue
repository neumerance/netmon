<script setup>
// Events log (PLAN §8.6 metrics, DESIGN §3.11): newest first, kind icon in a tinted circle,
// message (device names emphasised), relative time with full timestamp tooltip, day separators,
// a light kind filter (All | Devices | Internet | Speed) and "Load older" from /api/events.
import { computed, ref, watch } from 'vue';
import Card from '../ui/Card.vue';
import Icon from '../ui/Icon.vue';
import { state } from '../../store.js';
import { api } from '../../api.js';
import { useNow } from '../../composables/useNow.js';
import { formatClock, formatDateTime, formatDurationShort, formatMbpsValue, formatRelative } from '../../lib/format.js';
import { deviceDisplayName } from '../../lib/deviceTypes.js';
import { dayKey, dayLabel, msValue, pastRelative, toMs } from './metricsUtil.js';

const now = useNow(15000);

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'devices', label: 'Devices' },
  { key: 'internet', label: 'Internet' },
  { key: 'speed', label: 'Speed' },
  { key: 'router', label: 'Router' },
];
const FILTER_KEY = 'netmon.events.filter';
function loadFilter() {
  try {
    const v = localStorage.getItem(FILTER_KEY);
    if (FILTERS.some((f) => f.key === v)) return v;
  } catch {
    /* ignore */
  }
  return 'all';
}
const filter = ref(loadFilter());
function setFilter(k) {
  filter.value = k;
  try {
    localStorage.setItem(FILTER_KEY, k);
  } catch {
    /* ignore */
  }
}

function groupOf(type) {
  if (!type) return 'other';
  if (type.startsWith('device_') || type.startsWith('network_')) return 'devices';
  if (type.startsWith('internet_')) return 'internet';
  if (type.startsWith('speedtest_')) return 'speed';
  if (type.startsWith('router_')) return 'router';
  return 'other';
}

// ---- data: live events + optionally older ones loaded on demand ----
const older = ref([]);
const loadingOlder = ref(false);
const olderExhausted = ref(false);

// A full snapshot replaces state.events; drop anything loaded from before it.
watch(
  () => state.events,
  () => {
    older.value = [];
    olderExhausted.value = false;
  },
);

const allEvents = computed(() => {
  const live = state.events || [];
  const ids = new Set(live.map((e) => e.id));
  const merged = live.concat(older.value.filter((e) => !ids.has(e.id)));
  return merged
    .filter((e) => e && e.id)
    .map((e) => ({ ...e, t: toMs(e.at) ?? 0 }))
    .sort((a, b) => b.t - a.t);
});

const visible = computed(() => (filter.value === 'all' ? allEvents.value : allEvents.value.filter((e) => groupOf(e.type) === filter.value)));

const counts = computed(() => {
  const c = { all: allEvents.value.length, devices: 0, internet: 0, speed: 0, router: 0 };
  for (const e of allEvents.value) {
    const g = groupOf(e.type);
    if (g in c) c[g] += 1;
  }
  return c;
});

// Snapshot carries the newest 100; if the client has at least that many there may be more.
const canLoadOlder = computed(() => !olderExhausted.value && allEvents.value.length >= 100 && allEvents.value.length < 500);
async function loadOlder() {
  if (loadingOlder.value) return;
  loadingOlder.value = true;
  try {
    const res = await api.events(500);
    const list = Array.isArray(res) ? res : Array.isArray(res?.events) ? res.events : [];
    const before = allEvents.value.length;
    older.value = list;
    if (allEvents.value.length <= before) olderExhausted.value = true;
  } catch {
    /* keep what we have */
  } finally {
    loadingOlder.value = false;
  }
}

// ---- presentation per event type ----
const KIND = {
  internet_down: { icon: 'wifi-off', tint: 'danger' },
  internet_restored: { icon: 'wifi', tint: 'success' },
  speedtest_complete: { icon: 'gauge', tint: 'accent' },
  speedtest_failed: { icon: 'alert-triangle', tint: 'warning' },
  device_online: { icon: 'arrow-up-circle', tint: 'success' },
  device_offline: { icon: 'circle-off', tint: 'neutral' },
  device_new: { icon: 'plus-circle', tint: 'info' },
  device_saved: { icon: 'bookmark', tint: 'neutral' },
  device_forgotten: { icon: 'trash', tint: 'neutral' },
  settings_changed: { icon: 'settings', tint: 'neutral' },
  server_started: { icon: 'zap', tint: 'neutral' },
  network_scan: { icon: 'radar', tint: 'info' },
  network_changed: { icon: 'network', tint: 'accent' },
  router_wan_down: { icon: 'wifi-off', tint: 'warning' },
  router_wan_up: { icon: 'router', tint: 'success' },
  router_snmp_ok: { icon: 'router', tint: 'info' },
  router_snmp_error: { icon: 'alert-triangle', tint: 'warning' },
  router_syslog_error: { icon: 'alert-triangle', tint: 'warning' },
  router_log_critical: { icon: 'alert-octagon', tint: 'warning' },
};
const TINT = {
  danger: 'bg-danger/15 text-danger-fg',
  success: 'bg-success/15 text-success-fg',
  warning: 'bg-warning/15 text-warning-fg',
  accent: 'bg-accent/15 text-accent-fg',
  info: 'bg-info/15 text-info-fg',
  neutral: 'bg-surface-3 text-muted',
};

const threshold = computed(() => state.settings?.speedThresholdMbps ?? 200);

function kindOf(e) {
  const k = KIND[e.type] || { icon: e.level === 'critical' ? 'alert-octagon' : e.level === 'warning' ? 'alert-triangle' : 'info', tint: 'neutral' };
  if (e.type === 'speedtest_complete') {
    const slow = e.level === 'warning' || (typeof e.data?.downloadMbps === 'number' && e.data.downloadMbps < threshold.value);
    if (slow) return { icon: 'gauge', tint: 'warning' };
  }
  if (e.type === 'device_offline' && e.level === 'warning') return { icon: 'circle-off', tint: 'neutral' };
  return k;
}

const devicesByMac = computed(() => {
  const m = new Map();
  for (const d of state.devices || []) m.set(d.mac, d);
  return m;
});

/**
 * Returns message parts [{ text, strong }] so a device's display name can be emphasised
 * without v-html.
 */
function messageParts(e) {
  let msg = e.message || e.type || '';
  if (e.type === 'speedtest_complete' && e.data && typeof e.data.downloadMbps === 'number') {
    const d = e.data;
    msg = `Speed test · ${formatMbpsValue(d.downloadMbps)} ↓ / ${formatMbpsValue(d.uploadMbps)} ↑ Mbps · ${msValue(d.pingMs)} ms`;
  } else if (e.type === 'internet_restored' && typeof e.data?.downtimeMs === 'number') {
    msg = `Internet restored after ${formatDurationShort(e.data.downtimeMs)}`;
  }
  const dev = e.mac ? devicesByMac.value.get(e.mac) : null;
  const names = [];
  if (dev) {
    if (dev.name) names.push(dev.name);
    const dn = deviceDisplayName(dev);
    if (dn && !names.includes(dn)) names.push(dn);
  }
  for (const name of names) {
    const i = msg.indexOf(name);
    if (i !== -1) {
      return [
        { text: msg.slice(0, i), strong: false },
        { text: name, strong: true },
        { text: msg.slice(i + name.length), strong: false },
      ].filter((p) => p.text);
    }
  }
  return [{ text: msg, strong: false }];
}

function timeText(e) {
  const age = now.value - e.t;
  if (age < 60 * 60_000) return pastRelative(formatRelative, e.at, now.value);
  return formatClock(e.at);
}
function timeTitle(e) {
  return `${formatDateTime(e.at)} · ${pastRelative(formatRelative, e.at, now.value)}`;
}

// Rows with day headers interleaved.
const rows = computed(() => {
  const out = [];
  let lastDay = null;
  for (const e of visible.value) {
    const k = dayKey(e.t);
    if (k !== lastDay) {
      out.push({ header: true, key: 'h' + k, label: dayLabel(e.t, now.value) });
      lastDay = k;
    }
    out.push({ header: false, key: e.id, e });
  }
  return out;
});

const emptyText = computed(() =>
  filter.value === 'all'
    ? 'No events yet. Changes on your network will appear here.'
    : `No ${FILTERS.find((f) => f.key === filter.value)?.label.toLowerCase()} events yet.`,
);
</script>

<template>
  <Card :padded="false" data-testid="events-panel" class="flex min-h-0 flex-col overflow-hidden">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3">
      <div class="flex items-center gap-2">
        <Icon name="clock" :size="14" class="text-subtle" />
        <h2 class="text-[13px] font-semibold text-text">Events</h2>
        <span class="rounded-sm bg-surface-2 px-1.5 text-[11px] font-medium leading-5 text-subtle tabular-nums">{{ counts.all }}</span>
      </div>
      <div class="ml-auto inline-flex rounded-md border border-border bg-surface-2 p-0.5" role="group" aria-label="Filter events">
        <button
          v-for="f in FILTERS"
          :key="f.key"
          type="button"
          :data-testid="`events-filter-${f.key}`"
          :aria-pressed="filter === f.key ? 'true' : 'false'"
          class="h-6 rounded-[5px] px-2 text-[12px] font-medium transition-colors duration-150"
          :class="filter === f.key ? 'bg-surface-3 text-text shadow-card' : 'text-muted hover:text-text'"
          @click="setFilter(f.key)"
        >{{ f.label }}</button>
      </div>
    </div>

    <div class="max-h-[360px] min-h-[120px] flex-1 overflow-y-auto overscroll-contain" tabindex="-1">
      <p v-if="!visible.length" class="px-4 py-8 text-center text-xs text-muted">{{ emptyText }}</p>

      <ul v-else role="list" class="pb-1">
        <template v-for="row in rows" :key="row.key">
          <li
            v-if="row.header"
            class="sticky top-0 z-[1] bg-surface/95 px-4 pt-2 pb-1 text-[11px] font-medium uppercase tracking-[0.06em] text-subtle backdrop-blur"
            role="presentation"
          >{{ row.label }}</li>
          <li
            v-else
            data-testid="event-item"
            :data-type="row.e.type"
            :data-kind="row.e.type"
            :data-level="row.e.level"
            class="flex min-h-9 items-center gap-2.5 border-t border-border/60 px-3 py-1.5 first:border-t-0"
          >
            <span
              class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
              :class="TINT[kindOf(row.e).tint]"
              aria-hidden="true"
            >
              <Icon :name="kindOf(row.e).icon" :size="14" />
            </span>
            <span class="min-w-0 flex-1 truncate text-[13px] text-text" :title="row.e.message">
              <template v-for="(part, i) in messageParts(row.e)" :key="i">
                <span :class="part.strong ? 'font-medium' : ''">{{ part.text }}</span>
              </template>
            </span>
            <time
              class="shrink-0 text-[11px] text-subtle tabular-nums"
              :datetime="row.e.at"
              :title="timeTitle(row.e)"
            >{{ timeText(row.e) }}</time>
          </li>
        </template>
      </ul>

      <div v-if="canLoadOlder" class="border-t border-border px-4 py-2 text-center">
        <button
          type="button"
          class="text-xs font-medium text-accent-fg hover:underline disabled:opacity-60"
          :disabled="loadingOlder"
          data-testid="events-load-older"
          @click="loadOlder"
        >{{ loadingOlder ? 'Loading…' : 'Load older' }}</button>
      </div>
    </div>
  </Card>
</template>
