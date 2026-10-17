<script setup>
// ISP KPI (PLAN §8.6 metrics, DESIGN §3.2): organisation, ASN, location, public IP, Cloudflare colo,
// plus the local network line (iface · ip · cidr · gateway).
// The public IP is shown in full (PLAN §11 `isp-ip` contract); it never leaves this machine.
import { computed, ref } from 'vue';
import KpiCard from './KpiCard.vue';
import Icon from '../ui/Icon.vue';
import Badge from '../ui/Badge.vue';
import { state } from '../../store.js';
import { useNow } from '../../composables/useNow.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { pastRelative } from './metricsUtil.js';

const now = useNow(5000);

const isp = computed(() => state.isp || null);
const network = computed(() => state.network || null);

const asnText = computed(() => (isp.value?.asn != null ? `AS${isp.value.asn}` : null));

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(undefined, { type: 'region' });
  } catch {
    return null;
  }
})();

const locationText = computed(() => {
  const i = isp.value;
  if (!i) return null;
  const country = i.country && i.country.length === 2 ? i.country.toUpperCase() : i.country;
  const parts = [i.city, country].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
});

const locationTitle = computed(() => {
  const i = isp.value;
  if (!i) return undefined;
  let countryName = i.country;
  try {
    if (regionNames && i.country?.length === 2) countryName = regionNames.of(i.country.toUpperCase());
  } catch {
    /* keep code */
  }
  return [i.city, i.region, countryName].filter(Boolean).join(', ') || undefined;
});


const SOURCE_LABELS = { cloudflare: 'Cloudflare', ipinfo: 'ipinfo.io', 'ip-api': 'ip-api.com', mock: 'simulated' };
const sourceLabel = computed(() => {
  const src = isp.value?.source;
  const label = SOURCE_LABELS[src] || src || null;
  // ip-api is a plaintext fallback: anything on the path could alter it (server marks it unverified).
  return label && isp.value?.unverified ? `${label} (unverified)` : label;
});

const updatedText = computed(() => {
  if (!isp.value?.fetchedAt) return null;
  return `Updated ${pastRelative(formatRelative, isp.value.fetchedAt, now.value)}${sourceLabel.value ? ` · ${sourceLabel.value}` : ''}`;
});

// Before the first successful lookup: skeleton while it is plausibly in flight, otherwise a calm
// "unavailable" message (e.g. internet down at boot). ISP lookups refresh on their own.
const mountedAt = Date.now();
const unavailable = computed(
  () => !isp.value && state.loaded && (state.internet?.status === 'down' || now.value - mountedAt > 20000),
);

const localLine = computed(() => {
  const n = network.value;
  if (!n) return null;
  return [n.iface, n.ip, n.cidr, n.gateway ? `gw ${n.gateway}` : null].filter(Boolean).join(' · ');
});

const copied = ref(false);
let copyTimer = 0;
async function copyIp() {
  const ip = isp.value?.ip;
  if (!ip) return;
  try {
    await navigator.clipboard.writeText(ip);
    copied.value = true;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copied.value = false), 1500);
  } catch {
    /* clipboard unavailable (insecure context) — ignore */
  }
}
</script>

<template>
  <KpiCard label="Internet provider" icon="building" data-testid="kpi-isp">
    <template #aside>
      <Badge v-if="isp?.colo" tone="neutral" :title="`Nearest Cloudflare data center: ${isp.colo}`">via {{ isp.colo }}</Badge>
    </template>

    <!-- Loading skeleton -->
    <div v-if="!isp && !unavailable" class="space-y-2 pt-1" aria-busy="true" aria-label="Looking up your internet provider">
      <div class="nm-skeleton h-5 w-3/4" />
      <div class="nm-skeleton h-3 w-1/2" />
      <div class="nm-skeleton h-3 w-2/5" />
      <span data-testid="isp-name" class="sr-only">—</span>
      <span data-testid="isp-ip" class="sr-only">—</span>
    </div>

    <!-- Unavailable -->
    <div v-else-if="!isp" class="space-y-1">
      <div data-testid="isp-name" class="text-[15px] font-semibold leading-5 text-muted">ISP unavailable</div>
      <p class="text-xs text-subtle">Provider lookup will retry automatically once the internet is reachable.</p>
      <span data-testid="isp-ip" class="sr-only">—</span>
    </div>

    <!-- Loaded -->
    <div v-else class="min-w-0 space-y-1">
      <div
        data-testid="isp-name"
        class="truncate text-[15px] font-semibold leading-5 tracking-[-0.01em] text-text"
        :title="isp.name || undefined"
      >{{ isp.name || 'Unknown provider' }}</div>
      <div class="flex min-w-0 items-center gap-1.5 text-xs">
        <span class="shrink-0 text-subtle">Public IP</span>
        <span data-testid="isp-ip" class="truncate font-mono text-[12px] text-text">{{ isp.ip || '—' }}</span>
        <button
          v-if="isp.ip"
          type="button"
          class="nm-icon-btn inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-subtle hover:bg-surface-3 hover:text-text"
          :aria-label="copied ? 'Copied' : 'Copy public IP'"
          :title="copied ? 'Copied' : 'Copy public IP'"
          @click="copyIp"
        >
          <Icon :name="copied ? 'check' : 'copy'" :size="13" :class="copied ? 'text-success-fg' : ''" />
        </button>
      </div>
      <!-- Compact: ASN + location on one line (full detail in the tooltip). -->
      <p
        class="truncate text-xs text-muted"
        data-testid="isp-stats"
        :title="[locationTitle, localLine && `This computer: ${localLine}`, updatedText].filter(Boolean).join(' · ') || undefined"
      >{{ [asnText, locationText].filter(Boolean).join(' · ') || '—' }}</p>
    </div>
  </KpiCard>
</template>
