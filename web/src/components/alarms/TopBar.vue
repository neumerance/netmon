<script setup>
// TopBar — sticky application header.
// Left: logo + "NetMon", network context (iface · cidr · gw), MOCK badge.
// Right: live-connection status, theme toggle, mute, settings.
// Keyboard shortcuts (ignored while typing): M = mute, "," = settings, T = cycle theme.
// The bottom border turns red while a critical alert is active.
import { computed, onMounted, onBeforeUnmount } from 'vue';
import { state, ui, topAlertLevel, toggleMute, openSettings } from '../../store.js';
import { useTheme } from '../../composables/useTheme.js';
import { useSound } from '../../composables/useSound.js';
import Icon from '../ui/Icon.vue';
import Badge from '../ui/Badge.vue';
import Tooltip from '../ui/Tooltip.vue';

const { theme, resolved: resolvedTheme, toggle: toggleTheme } = useTheme();
const sound = useSound();

const critical = computed(() => topAlertLevel.value === 'critical');

const network = computed(() => state.network);
const networkText = computed(() => {
  const n = network.value;
  if (!n) return null;
  const parts = [];
  if (n.iface) parts.push(n.iface);
  if (n.cidr) parts.push(n.cidr);
  if (n.gateway) parts.push(`gw ${n.gateway}`);
  return parts.join(' · ') || null;
});
const networkTooltip = computed(() => {
  const n = network.value;
  if (!n) return '';
  return [
    n.iface && `Interface ${n.iface}`,
    n.ip && `This computer ${n.ip}`,
    n.mac && `MAC ${n.mac}`,
    n.gateway && `Gateway ${n.gateway}`,
  ]
    .filter(Boolean)
    .join(' · ');
});

// --- Connection status -------------------------------------------------------
const connection = computed(() => state.connection || 'connecting');
const connectionMeta = computed(() => {
  switch (connection.value) {
    case 'open':
      return { label: 'Live', dot: 'bg-success', halo: true, aria: 'Live updates: connected' };
    case 'reconnecting':
      return { label: 'Reconnecting…', dot: 'bg-warning', halo: false, aria: 'Live updates: reconnecting' };
    default:
      return { label: 'Connecting…', dot: 'bg-subtle', halo: false, aria: 'Live updates: connecting' };
  }
});

// --- Mute -------------------------------------------------------------------
const muted = computed(() => !!ui.muted);
const muteLabel = computed(() => (muted.value ? 'Unmute alarm sounds' : 'Mute alarm sounds'));
// Make the mute button easy to find while an alarm is sounding (or muted during an outage).
const muteAlarming = computed(() => sound.sounding.value || (muted.value && critical.value));

function onMute() {
  toggleMute();
  // A click is a user gesture: take the chance to unlock audio for later alarms.
  sound.unlock();
}

// --- Shortcuts --------------------------------------------------------------
function isTyping(e) {
  const t = e.target;
  if (!t || !(t instanceof Element)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
function onKeydown(e) {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e)) return;
  // Don't hijack keys while a modal/drawer is open.
  if (ui.settingsOpen || document.querySelector('[aria-modal="true"]')) return;
  if (e.key === 'm' || e.key === 'M') {
    e.preventDefault();
    onMute();
  } else if (e.key === ',') {
    e.preventDefault();
    openSettings();
  } else if (e.key === 't' || e.key === 'T') {
    e.preventDefault();
    toggleTheme();
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

const iconBtn =
  'nm-icon-btn inline-flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors duration-[120ms] hover:bg-surface-3 hover:text-text';
</script>

<template>
  <header
    class="sticky top-0 z-30 border-b bg-surface/85 backdrop-blur supports-[backdrop-filter]:bg-surface/75"
    :class="critical ? 'border-danger' : 'border-border'"
    :data-critical="critical ? 'true' : 'false'"
  >
    <!-- 2px red rule while internet is down -->
    <div v-if="critical" class="absolute inset-x-0 bottom-0 h-0.5 bg-danger" aria-hidden="true" />
    <div class="mx-auto flex h-14 max-w-[1440px] items-center gap-3 px-4 sm:px-6">
      <!-- Brand -->
      <div class="flex shrink-0 items-center gap-2 whitespace-nowrap">
        <span
          class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent text-accent-contrast"
          aria-hidden="true"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="5" r="2.25" />
            <circle cx="5" cy="18" r="2.25" />
            <circle cx="19" cy="18" r="2.25" />
            <path d="M10.9 6.9 6.1 16M13.1 6.9 17.9 16M7.25 18h9.5" />
          </svg>
        </span>
        <span class="text-[15px] font-semibold tracking-[-0.01em] text-text">NetMon</span>
      </div>

      <!-- Network context -->
      <template v-if="networkText">
        <span class="hidden h-5 w-px bg-border md:block" aria-hidden="true" />
        <span
          class="hidden min-w-0 truncate text-[13px] text-muted tabular-nums md:block"
          :title="networkTooltip"
          data-testid="network-context"
        >
          {{ networkText }}
        </span>
      </template>

      <Tooltip v-if="state.mock" text="Showing simulated devices (NETMON_MOCK=1)">
        <Badge tone="warning" data-testid="mock-badge" class="shrink-0">MOCK<span class="max-sm:hidden">&nbsp;DATA</span></Badge>
      </Tooltip>

      <div class="ml-auto flex items-center gap-1 sm:gap-1.5">
        <!-- Live connection status (not a button) -->
        <div
          class="mr-1 flex items-center gap-2 rounded-md px-2 py-1 text-[13px] text-muted"
          data-testid="connection-status"
          :data-status="connection"
          role="status"
          :aria-label="connectionMeta.aria"
          :title="connectionMeta.aria"
        >
          <span class="relative inline-flex h-2 w-2" aria-hidden="true">
            <span
              v-if="connectionMeta.halo"
              class="nm-ping absolute inline-flex h-full w-full rounded-full"
              :class="connectionMeta.dot"
            />
            <span class="relative inline-flex h-2 w-2 rounded-full" :class="connectionMeta.dot" />
          </span>
          <span class="hidden sm:inline">{{ connectionMeta.label }}</span>
        </div>

        <!-- Theme: simple light/dark switch (sun ◐ moon). Click or Space/Enter flips it. -->
        <button
          type="button"
          role="switch"
          data-testid="theme-toggle"
          :data-theme="resolvedTheme"
          :aria-checked="resolvedTheme === 'dark' ? 'true' : 'false'"
          aria-label="Dark mode"
          :title="resolvedTheme === 'dark' ? 'Dark mode — click for light' : 'Light mode — click for dark'"
          class="relative inline-flex h-7 w-[52px] shrink-0 items-center rounded-full border border-border bg-surface-2 transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          @click="toggleTheme()"
        >
          <span
            aria-hidden="true"
            class="absolute left-[3px] top-[3px] h-5 w-5 rounded-full bg-surface shadow-sm ring-1 ring-border transition-transform duration-200 ease-out motion-reduce:transition-none"
            :class="resolvedTheme === 'dark' ? 'translate-x-6' : 'translate-x-0'"
          />
          <Icon name="sun" :size="12" class="relative ml-[7px]" :class="resolvedTheme === 'dark' ? 'text-subtle' : 'text-warning-fg'" />
          <Icon name="moon" :size="12" class="relative ml-auto mr-[7px]" :class="resolvedTheme === 'dark' ? 'text-accent-fg' : 'text-subtle'" />
        </button>

        <!-- Mute -->
        <button
          type="button"
          :class="[iconBtn, muteAlarming ? '!text-danger ring-1 ring-danger/40' : '']"
          data-testid="mute-btn"
          :data-muted="muted ? 'true' : 'false'"
          :aria-pressed="muted ? 'true' : 'false'"
          :aria-label="muteLabel"
          :title="`${muteLabel} (M)`"
          @click="onMute"
        >
          <Icon :name="muted ? 'bell-off' : 'bell'" :size="18" />
        </button>

        <!-- Settings -->
        <button
          type="button"
          :class="iconBtn"
          data-testid="settings-btn"
          aria-label="Open settings"
          title="Settings (,)"
          :aria-expanded="ui.settingsOpen ? 'true' : 'false'"
          @click="openSettings()"
        >
          <Icon name="settings" :size="18" />
        </button>
      </div>
    </div>
  </header>
</template>
