<script setup>
// Router panel: SNMP port status + throughput and the router's syslog stream (server router/monitor.js).
// Off by default; "Set up" opens RouterSetup inline.
import { computed, ref } from 'vue';
import Card from '../ui/Card.vue';
import Icon from '../ui/Icon.vue';
import Badge from '../ui/Badge.vue';
import Button from '../ui/Button.vue';
import IconButton from '../ui/IconButton.vue';
import RouterSetup from './RouterSetup.vue';
import { state, clearRouterLog } from '../../store.js';
import { useNow } from '../../composables/useNow.js';
import { formatMbps, formatTime, formatDateTime, formatRelative, formatDurationShort } from '../../lib/format.js';

const now = useNow(15000);
const showSetup = ref(false);

const router = computed(() => state.router);
const status = computed(() => router.value.status);
const cfg = computed(() => router.value.config);
const anyEnabled = computed(() => Boolean(cfg.value?.syslog?.enabled || cfg.value?.snmp?.enabled));

const title = computed(() => status.value?.snmp?.system?.name || 'Router');
const subtitle = computed(() => {
  const s = status.value?.snmp;
  const parts = [];
  if (s?.host) parts.push(s.host);
  if (s?.system?.uptimeSec) parts.push(`up ${formatDurationShort(s.system.uptimeSec * 1000)}`);
  return parts.join(' · ');
});

// ---- status chips ----
const syslogChip = computed(() => {
  const s = status.value?.syslog;
  if (!s?.enabled) return { tone: 'neutral', label: 'Log off' };
  if (s.error) return { tone: 'danger', label: 'Log error', title: s.error };
  if (!s.listening) return { tone: 'neutral', label: 'Log starting…' };
  if (!s.received) return { tone: 'warning', label: `Log: waiting on :${s.port}`, title: `Listening on UDP ${s.port} for ${s.source || 'the router'}` };
  return { tone: 'success', label: 'Log live', title: `${s.received} lines since NetMon started · last ${formatRelative(s.lastMessageAt, now.value)}` };
});
const snmpChip = computed(() => {
  const s = status.value?.snmp;
  if (!s?.enabled) return { tone: 'neutral', label: 'SNMP off' };
  if (s.ok === true) return { tone: 'success', label: 'SNMP ok', title: `Last poll ${formatRelative(s.lastPollAt, now.value)}` };
  if (s.error) return { tone: 'danger', label: 'SNMP error', title: s.error };
  return { tone: 'neutral', label: 'SNMP connecting…' };
});

// ---- ports ----
const ports = computed(() => (router.value.ports || []).map((p) => ({
  ...p,
  label: p.alias || p.name,
  sub: p.alias && p.alias !== p.name ? p.name : p.descr && p.descr !== p.name ? p.descr : null,
  up: p.operStatus === 'up',
})).sort((a, b) => Number(b.wan) - Number(a.wan) || a.index - b.index)); // internet port(s) first
const showDownPorts = ref(false);
const visiblePorts = computed(() => (showDownPorts.value ? ports.value : ports.value.filter((p) => p.up)));
const hiddenPortCount = computed(() => ports.value.length - visiblePorts.value.length);
const fmtRate = (bps) => (bps == null ? '—' : formatMbps(bps / 1e6));

// ---- log ----
const LOG_FILTERS = [
  { key: 7, label: 'All' },
  { key: 4, label: 'Warnings' },
  { key: 3, label: 'Errors' },
];
const logFilter = ref(7);
const logSearch = ref('');
const logLines = computed(() => {
  const q = logSearch.value.trim().toLowerCase();
  return (router.value.log || []).filter((e) => e.severity <= logFilter.value
    && (!q || `${e.app || ''} ${e.message}`.toLowerCase().includes(q)));
});
const SEV_TONE = { 0: 'danger', 1: 'danger', 2: 'danger', 3: 'danger', 4: 'warning', 5: 'info', 6: 'neutral', 7: 'neutral' };

const droppedHint = computed(() => {
  const s = status.value?.syslog;
  if (!s?.dropped || !s.lastDroppedFrom) return null;
  return `Ignored ${s.dropped} message${s.dropped === 1 ? '' : 's'} from ${s.lastDroppedFrom}. If that is your router, set it as "Accept messages from" in the setup.`;
});
const waitingHint = computed(() => {
  const s = status.value?.syslog;
  if (!s?.enabled || !s.listening || s.received || router.value.log.length) return null;
  return `Listening on UDP ${s.port}. Nothing from ${s.source || 'the router'} yet — check that the router's remote log (syslog) server is set to ${state.network?.ip || 'this computer'}.`;
});
</script>

<template>
  <Card v-if="router.available" :padded="false" data-testid="router-panel" class="overflow-hidden">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3">
      <div class="flex min-w-0 items-center gap-2">
        <Icon name="router" :size="14" class="text-subtle" />
        <div class="min-w-0">
          <h2 class="truncate text-[13px] font-semibold text-text">{{ title }}</h2>
          <p v-if="subtitle" class="truncate text-xs text-muted">{{ subtitle }}</p>
        </div>
      </div>
      <div class="ml-auto flex items-center gap-2">
        <template v-if="anyEnabled && !showSetup">
          <Badge :tone="syslogChip.tone" dot size="sm" :title="syslogChip.title" data-testid="router-syslog-status">{{ syslogChip.label }}</Badge>
          <Badge :tone="snmpChip.tone" dot size="sm" :title="snmpChip.title" data-testid="router-snmp-status">{{ snmpChip.label }}</Badge>
        </template>
        <IconButton
          v-if="anyEnabled && !showSetup"
          icon="settings"
          label="Router settings"
          size="sm"
          data-testid="router-settings"
          @click="showSetup = true"
        />
      </div>
    </div>

    <RouterSetup v-if="showSetup" @done="showSetup = false" />

    <div v-else-if="!anyEnabled" class="flex flex-col items-center gap-3 px-6 py-8 text-center">
      <div class="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-2 text-subtle"><Icon name="router" :size="20" /></div>
      <div>
        <p class="text-[13px] font-medium text-text">Connect NetMon to your router</p>
        <p class="mt-1 max-w-[420px] text-xs text-muted">
          Works with any router that speaks the standard protocols: per-port traffic (including the internet link)
          over SNMP, and the router's own log over syslog.
        </p>
      </div>
      <Button size="sm" icon="settings" data-testid="router-setup-open" @click="showSetup = true">Set up</Button>
    </div>

    <template v-else>
      <!-- Ports -->
      <div v-if="cfg?.snmp?.enabled" class="border-b border-border">
        <p v-if="status?.snmp?.error" class="flex items-start gap-2 px-4 py-3 text-xs text-danger-fg" data-testid="router-snmp-error">
          <Icon name="alert-triangle" :size="14" class="mt-px shrink-0" />{{ status.snmp.error }}
        </p>
        <table v-if="ports.length" class="w-full text-[13px]" data-testid="router-ports">
          <thead>
            <tr class="text-left text-[11px] font-medium uppercase tracking-[0.06em] text-subtle">
              <th class="px-4 py-2 font-medium">Port</th>
              <th class="px-2 py-2 font-medium max-sm:hidden">Link</th>
              <th class="px-2 py-2 text-right font-medium">
                <Icon name="arrow-down" :size="11" class="inline-block align-[-1px]" /> In
              </th>
              <th class="px-4 py-2 text-right font-medium">
                <Icon name="arrow-up" :size="11" class="inline-block align-[-1px]" /> Out
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in visiblePorts" :key="p.index" class="border-t border-border/60" data-testid="router-port" :data-port="p.label">
              <td class="px-4 py-2">
                <div class="flex items-center gap-2">
                  <span class="h-2 w-2 shrink-0 rounded-full" :class="p.up ? 'bg-success' : 'bg-subtle'" :title="p.operStatus" />
                  <span class="font-medium text-text">{{ p.label }}</span>
                  <Badge
                    v-if="p.wan"
                    tone="brand"
                    size="sm"
                    :title="p.defaultRoute ? 'Carries the router’s default route' : 'Named like an internet (WAN) port'"
                  >Internet</Badge>
                </div>
                <p v-if="p.sub" class="ml-4 text-[11px] text-subtle">{{ p.sub }}</p>
              </td>
              <td class="px-2 py-2 text-xs text-muted max-sm:hidden">{{ p.up ? (p.speedMbps ? formatMbps(p.speedMbps) : 'up') : p.operStatus }}</td>
              <td class="px-2 py-2 text-right tabular-nums text-text">{{ fmtRate(p.inBps) }}</td>
              <td class="px-4 py-2 text-right tabular-nums text-text">{{ fmtRate(p.outBps) }}</td>
            </tr>
          </tbody>
        </table>
        <button
          v-if="hiddenPortCount > 0 || showDownPorts"
          type="button"
          class="w-full border-t border-border/60 px-4 py-1.5 text-left text-xs text-muted hover:text-text"
          @click="showDownPorts = !showDownPorts"
        >{{ showDownPorts ? 'Hide ports that are down' : `Show ${hiddenPortCount} port${hiddenPortCount === 1 ? '' : 's'} that are down` }}</button>
        <p v-if="!ports.length && !status?.snmp?.error" class="px-4 py-3 text-xs text-muted">Waiting for the first SNMP poll…</p>
        <p v-else-if="ports.length && ports.every((p) => p.inBps == null) && status?.snmp?.ok" class="px-4 pb-2 text-[11px] text-subtle">
          Rates appear after the second poll.
        </p>
      </div>

      <!-- Log -->
      <div v-if="cfg?.syslog?.enabled || router.log.length" data-testid="router-log">
        <div class="flex flex-wrap items-center gap-2 px-4 py-2.5">
          <h3 class="text-xs font-semibold text-text">Router log</h3>
          <span class="rounded-sm bg-surface-2 px-1.5 text-[11px] font-medium leading-5 text-subtle tabular-nums">{{ logLines.length }}</span>
          <div class="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
            <input
              v-model="logSearch"
              type="search"
              placeholder="Filter…"
              aria-label="Filter router log"
              class="h-7 w-[110px] min-w-0 rounded-md border border-border-strong bg-surface-2 px-2 text-xs text-text outline-none placeholder:text-subtle focus-visible:border-accent"
              data-testid="router-log-search"
            />
            <div class="inline-flex rounded-md border border-border bg-surface-2 p-0.5" role="group" aria-label="Router log severity">
              <button
                v-for="f in LOG_FILTERS"
                :key="f.key"
                type="button"
                :aria-pressed="logFilter === f.key ? 'true' : 'false'"
                class="h-6 rounded-[5px] px-2 text-[12px] font-medium transition-colors duration-150"
                :class="logFilter === f.key ? 'bg-surface-3 text-text shadow-card' : 'text-muted hover:text-text'"
                @click="logFilter = f.key"
              >{{ f.label }}</button>
            </div>
            <IconButton v-if="router.log.length" icon="trash" label="Clear router log" size="sm" data-testid="router-log-clear" @click="clearRouterLog" />
          </div>
        </div>
        <p v-if="status?.syslog?.error" class="flex items-start gap-2 px-4 pb-2 text-xs text-danger-fg" data-testid="router-syslog-error">
          <Icon name="alert-triangle" :size="14" class="mt-px shrink-0" />{{ status.syslog.error }}
        </p>
        <p v-if="droppedHint" class="px-4 pb-2 text-xs text-warning-fg">{{ droppedHint }}</p>
        <p v-if="waitingHint" class="px-4 pb-3 text-xs text-muted">{{ waitingHint }}</p>
        <ul v-if="logLines.length" role="list" class="max-h-[320px] overflow-y-auto overscroll-contain border-t border-border/60">
          <li
            v-for="e in logLines"
            :key="e.id"
            class="flex items-baseline gap-2 border-t border-border/40 px-4 py-1.5 first:border-t-0"
            data-testid="router-log-line"
            :data-severity="e.severityName"
          >
            <time class="shrink-0 text-[11px] tabular-nums text-subtle" :datetime="e.at" :title="formatDateTime(e.at)">{{ formatTime(e.at) }}</time>
            <Badge :tone="SEV_TONE[e.severity] || 'neutral'" size="sm" class="shrink-0">{{ e.severityName }}</Badge>
            <p class="min-w-0 break-words text-xs text-text">
              <span v-if="e.app" class="font-medium text-muted">{{ e.app }}: </span>{{ e.message }}
            </p>
          </li>
        </ul>
        <p v-else-if="router.log.length" class="px-4 pb-3 text-xs text-muted">No lines match the filter.</p>
      </div>
    </template>
  </Card>
</template>
