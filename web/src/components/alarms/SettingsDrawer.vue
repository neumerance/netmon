<script setup>
// SettingsDrawer — right-side drawer bound to ui.settingsOpen.
//
// Server-backed settings (draft, saved with "Save"):
//   speedThresholdMbps (1–10000), speedTestIntervalMin (0 = off, or 5–1440),
//   soundAlerts, activeFingerprinting.
// Browser-local preferences (apply immediately): desktop notifications, theme.
//
// Validation is done client-side first (inline per-field errors + `settings-error`
// summary) and server 400 `details` are mapped back onto the fields.
import { computed, reactive, ref, watch } from 'vue';
import { state, ui, closeSettings, updateSettings, pushToast } from '../../store.js';
import { api } from '../../api.js';
import { useTheme } from '../../composables/useTheme.js';
import { useSound } from '../../composables/useSound.js';
import { useNotifications } from '../../composables/useNotifications.js';
import { formatDuration } from '../../lib/format.js';
import Drawer from '../ui/Drawer.vue';
import Button from '../ui/Button.vue';
import Toggle from '../ui/Toggle.vue';
import Icon from '../ui/Icon.vue';

const { theme, setTheme } = useTheme();
const sound = useSound();
const notifications = useNotifications();

const LIMITS = {
  thresholdMin: 1,
  thresholdMax: 10000,
  intervalMin: 5,
  intervalMax: 1440,
};
const INTERVAL_PRESETS = [0, 5, 15, 30, 60];

const draft = reactive({
  speedThresholdMbps: 200,
  speedTestIntervalMin: 15,
  soundAlerts: true,
  activeFingerprinting: true,
});
const errors = reactive({});
const serverError = ref('');
const saving = ref(false);
const health = ref(null);

function resetDraft() {
  const s = state.settings || {};
  draft.speedThresholdMbps = s.speedThresholdMbps ?? 200;
  draft.speedTestIntervalMin = s.speedTestIntervalMin ?? 15;
  draft.soundAlerts = s.soundAlerts !== false;
  draft.activeFingerprinting = s.activeFingerprinting !== false;
  for (const k of Object.keys(errors)) delete errors[k];
  serverError.value = '';
}

async function loadHealth() {
  try {
    health.value = await api.health();
  } catch {
    health.value = null;
  }
}

watch(
  () => ui.settingsOpen,
  (open) => {
    if (open) {
      resetDraft();
      loadHealth();
    }
  },
  { immediate: true },
);

// --- Validation -------------------------------------------------------------
function toNumber(v) {
  if (v === '' || v === null || v === undefined) return NaN;
  return typeof v === 'number' ? v : Number(String(v).trim());
}

function validateThreshold() {
  const n = toNumber(draft.speedThresholdMbps);
  if (!Number.isFinite(n)) errors.speedThresholdMbps = 'Enter a speed in Mbps.';
  else if (n < LIMITS.thresholdMin || n > LIMITS.thresholdMax)
    errors.speedThresholdMbps = `Must be between ${LIMITS.thresholdMin} and ${LIMITS.thresholdMax} Mbps.`;
  else delete errors.speedThresholdMbps;
}

function validateInterval() {
  const n = toNumber(draft.speedTestIntervalMin);
  if (!Number.isFinite(n) || !Number.isInteger(n)) errors.speedTestIntervalMin = 'Enter whole minutes (0 turns automatic tests off).';
  else if (n !== 0 && (n < LIMITS.intervalMin || n > LIMITS.intervalMax))
    errors.speedTestIntervalMin = `Use 0 (off) or ${LIMITS.intervalMin}–${LIMITS.intervalMax} minutes.`;
  else delete errors.speedTestIntervalMin;
}

function validateAll() {
  validateThreshold();
  validateInterval();
  return Object.keys(errors).length === 0;
}

const errorSummary = computed(() => {
  if (serverError.value) return serverError.value;
  const msgs = Object.values(errors);
  if (!msgs.length) return '';
  return msgs.length === 1 ? `Please fix: ${msgs[0]}` : `Please fix ${msgs.length} fields below.`;
});

const FIELD_LABELS = {
  speedThresholdMbps: 'Speed alert threshold',
  speedTestIntervalMin: 'Automatic test interval',
  soundAlerts: 'Sound alerts',
  activeFingerprinting: 'Active fingerprinting',
};

// --- Save -------------------------------------------------------------------
async function save() {
  serverError.value = '';
  if (!validateAll()) return;
  saving.value = true;
  try {
    await updateSettings({
      speedThresholdMbps: toNumber(draft.speedThresholdMbps),
      speedTestIntervalMin: toNumber(draft.speedTestIntervalMin),
      soundAlerts: !!draft.soundAlerts,
      activeFingerprinting: !!draft.activeFingerprinting,
    });
    pushToast({ level: 'success', title: 'Settings saved', timeoutMs: 0, autoDismissMs: 4000 });
    closeSettings();
  } catch (err) {
    const details = err?.details && typeof err.details === 'object' ? err.details : null;
    if (details && Object.keys(details).length) {
      for (const [k, msg] of Object.entries(details)) {
        if (k in FIELD_LABELS) errors[k] = String(msg);
      }
      serverError.value = Object.entries(details)
        .map(([k, msg]) => `${FIELD_LABELS[k] || k}: ${msg}`)
        .join(' · ');
    } else {
      serverError.value = err?.message ? `Couldn't save settings — ${err.message}` : "Couldn't save settings.";
    }
  } finally {
    saving.value = false;
  }
}

function cancel() {
  resetDraft();
  closeSettings();
}

function setIntervalPreset(v) {
  draft.speedTestIntervalMin = v;
  validateInterval();
}

// --- Sound / notifications ----------------------------------------------------
async function testSound() {
  await sound.unlock();
  sound.playAlarm('critical', { force: true });
}

const notifyChecked = computed(() => notifications.active.value);
const notifyHelper = computed(() => {
  switch (notifications.permission.value) {
    case 'unsupported':
      return 'This browser does not support desktop notifications.';
    case 'denied':
      return 'Blocked by the browser — allow notifications for this site to enable.';
    case 'granted':
      return notifications.enabled.value
        ? 'You will be notified when the internet goes down or slows, even if this tab is in the background.'
        : 'Notifications are off for this browser.';
    default:
      return 'Get a desktop notification when the internet goes down or slows (stored in this browser only).';
  }
});
async function onNotifyToggle(v) {
  if (!v) {
    notifications.setEnabled(false);
    return;
  }
  if (notifications.permission.value === 'granted') {
    notifications.setEnabled(true);
    return;
  }
  const res = await notifications.request();
  if (res === 'granted') {
    notifications.setEnabled(true);
    notifications.notify('NetMon notifications enabled', 'You will be alerted when the internet goes down.', {
      force: true,
      tag: 'netmon-test',
    });
  }
}

// --- Theme --------------------------------------------------------------------
const THEMES = [
  { id: 'system', label: 'System', icon: 'monitor' },
  { id: 'dark', label: 'Dark', icon: 'moon' },
  { id: 'light', label: 'Light', icon: 'sun' },
];
const currentTheme = computed(() => theme?.value ?? ui.theme ?? 'system');

// --- About --------------------------------------------------------------------
const aboutRows = computed(() => {
  const rows = [];
  const h = health.value;
  rows.push(['Mode', state.mock ? 'Mock data' : 'Live']);
  if (h?.version) rows.push(['Version', h.version]);
  if (typeof h?.uptimeSec === 'number') rows.push(['Backend uptime', formatDuration(h.uptimeSec * 1000)]);
  const n = state.network;
  if (n?.cidr) rows.push(['Scanning', `${n.cidr}${n.iface ? ` on ${n.iface}` : ''}`]);
  return rows;
});

const inputBase =
  'h-9 w-[140px] rounded-md border bg-surface-2 px-3 text-[13px] text-text tabular-nums outline-none transition-colors placeholder:text-subtle focus-visible:border-accent';
</script>

<template>
  <Drawer
    :open="ui.settingsOpen"
    title="Settings"
    side="right"
    data-testid="settings-drawer"
    @close="cancel"
  >
    <form class="flex flex-col" novalidate @submit.prevent="save">
      <!-- Alerts -->
      <section class="flex flex-col gap-5 border-b border-border pb-5" aria-labelledby="alm-settings-alerts">
        <h3 id="alm-settings-alerts" class="eyebrow">Alerts</h3>

        <div class="flex flex-col gap-1.5">
          <label for="alm-threshold" class="text-[13px] font-medium text-text">Speed alert threshold</label>
          <div class="flex items-center gap-2">
            <input
              id="alm-threshold"
              v-model.number="draft.speedThresholdMbps"
              type="number"
              inputmode="decimal"
              :min="LIMITS.thresholdMin"
              :max="LIMITS.thresholdMax"
              step="10"
              :class="[inputBase, errors.speedThresholdMbps ? 'border-danger' : 'border-border-strong']"
              data-testid="threshold-input"
              :aria-invalid="errors.speedThresholdMbps ? 'true' : 'false'"
              aria-describedby="alm-threshold-help"
              @blur="validateThreshold"
              @input="errors.speedThresholdMbps && validateThreshold()"
            />
            <span class="text-[13px] text-muted">Mbps</span>
          </div>
          <p v-if="errors.speedThresholdMbps" id="alm-threshold-help" class="text-xs text-danger-fg">
            {{ errors.speedThresholdMbps }}
          </p>
          <p v-else id="alm-threshold-help" class="text-xs text-muted">
            Show a warning when download speed is below this. Default 200 Mbps.
          </p>
        </div>

        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <p id="alm-sound-label" class="text-[13px] font-medium text-text">Sound alerts</p>
            <p class="text-xs text-muted">
              Beep repeatedly while the internet is down; a soft chime when it slows.
              <button
                type="button"
                class="ml-1 font-medium text-accent-fg underline-offset-2 hover:underline"
                data-testid="test-sound-btn"
                @click="testSound"
              >
                Test sound
              </button>
            </p>
          </div>
          <Toggle
            v-model="draft.soundAlerts"
            data-testid="sound-toggle"
            aria-labelledby="alm-sound-label"
          />
        </div>

        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <p id="alm-notify-label" class="text-[13px] font-medium text-text">Desktop notifications</p>
            <p class="text-xs text-muted">{{ notifyHelper }}</p>
          </div>
          <Toggle
            :model-value="notifyChecked"
            :disabled="notifications.permission.value === 'unsupported' || notifications.permission.value === 'denied'"
            data-testid="notifications-toggle"
            aria-labelledby="alm-notify-label"
            @update:model-value="onNotifyToggle"
          />
        </div>
      </section>

      <!-- Speed tests -->
      <section class="flex flex-col gap-1.5 border-b border-border py-5" aria-labelledby="alm-settings-speed">
        <h3 id="alm-settings-speed" class="eyebrow mb-3.5">Speed tests</h3>
        <label for="alm-interval" class="text-[13px] font-medium text-text">Automatic test interval</label>
        <div class="flex flex-wrap items-center gap-2">
          <input
            id="alm-interval"
            v-model.number="draft.speedTestIntervalMin"
            type="number"
            inputmode="numeric"
            min="0"
            :max="LIMITS.intervalMax"
            step="1"
            :class="[inputBase, 'w-[100px]', errors.speedTestIntervalMin ? 'border-danger' : 'border-border-strong']"
            data-testid="speedtest-interval-input"
            :aria-invalid="errors.speedTestIntervalMin ? 'true' : 'false'"
            aria-describedby="alm-interval-help"
            @blur="validateInterval"
            @input="errors.speedTestIntervalMin && validateInterval()"
          />
          <span class="text-[13px] text-muted">min</span>
          <div class="ml-1 flex flex-wrap gap-1" role="group" aria-label="Interval presets">
            <button
              v-for="p in INTERVAL_PRESETS"
              :key="p"
              type="button"
              class="h-7 rounded-sm border px-2 text-xs tabular-nums transition-colors"
              :class="
                Number(draft.speedTestIntervalMin) === p
                  ? 'border-accent/60 bg-accent/15 text-accent-fg'
                  : 'border-border bg-surface-2 text-muted hover:bg-surface-3 hover:text-text'
              "
              :aria-pressed="Number(draft.speedTestIntervalMin) === p ? 'true' : 'false'"
              @click="setIntervalPreset(p)"
            >
              {{ p === 0 ? 'Off' : p }}
            </button>
          </div>
        </div>
        <p v-if="errors.speedTestIntervalMin" id="alm-interval-help" class="text-xs text-danger-fg">
          {{ errors.speedTestIntervalMin }}
        </p>
        <p v-else id="alm-interval-help" class="text-xs text-muted">
          0 turns automatic tests off. Each test downloads roughly 100–300 MB, depending on your speed.
        </p>
      </section>

      <!-- Device detection -->
      <section class="flex flex-col gap-3 border-b border-border py-5" aria-labelledby="alm-settings-detect">
        <h3 id="alm-settings-detect" class="eyebrow">Device detection</h3>
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <p id="alm-fp-label" class="text-[13px] font-medium text-text">Active fingerprinting</p>
            <p class="text-xs text-muted">
              Briefly probes common ports and NetBIOS on new devices to identify them. Turn off for passive
              detection only (mDNS, SSDP, vendor, hostname).
            </p>
          </div>
          <Toggle
            v-model="draft.activeFingerprinting"
            data-testid="fingerprint-toggle"
            aria-labelledby="alm-fp-label"
          />
        </div>
      </section>

      <!-- Appearance (applies immediately, browser-local) -->
      <section class="flex flex-col gap-3 border-b border-border py-5" aria-labelledby="alm-settings-theme">
        <h3 id="alm-settings-theme" class="eyebrow">Appearance</h3>
        <div
          class="inline-flex self-start rounded-md border border-border bg-surface-2 p-0.5"
          role="radiogroup"
          aria-label="Theme"
          data-testid="setting-theme"
        >
          <button
            v-for="t in THEMES"
            :key="t.id"
            type="button"
            role="radio"
            :aria-checked="currentTheme === t.id ? 'true' : 'false'"
            class="inline-flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-xs font-medium transition-colors"
            :class="currentTheme === t.id ? 'bg-surface-3 text-text shadow-card' : 'text-muted hover:text-text'"
            @click="setTheme(t.id)"
          >
            <Icon :name="t.icon" :size="14" />
            {{ t.label }}
          </button>
        </div>
      </section>

      <!-- About -->
      <section class="flex flex-col gap-2 pt-5" aria-labelledby="alm-settings-about">
        <h3 id="alm-settings-about" class="eyebrow">About</h3>
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <template v-for="[k, v] in aboutRows" :key="k">
            <dt class="text-subtle">{{ k }}</dt>
            <dd class="truncate text-muted tabular-nums">{{ v }}</dd>
          </template>
        </dl>
        <p class="text-xs text-subtle">
          Shortcuts: <kbd class="font-mono">M</kbd> mute · <kbd class="font-mono">,</kbd> settings ·
          <kbd class="font-mono">T</kbd> theme. Data stays on this machine.
        </p>
      </section>

      <!-- Hidden submit so Enter in a field saves -->
      <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
    </form>

    <template #footer>
      <!-- Error summary lives in the footer so showing/hiding it never shifts the form fields
           (a blur-triggered re-layout would otherwise swallow the click that caused the blur). -->
      <div
        v-if="errorSummary"
        class="flex w-full items-start gap-2 rounded-md border border-danger/40 bg-danger/12 px-3 py-2 text-[13px] text-danger-fg"
        role="alert"
        data-testid="settings-error"
      >
        <Icon name="alert-triangle" :size="16" class="mt-0.5 shrink-0" />
        <span>{{ errorSummary }}</span>
      </div>
      <div class="flex w-full items-center justify-end gap-2">
        <Button variant="secondary" data-testid="settings-cancel-btn" @click="cancel">Cancel</Button>
        <Button variant="primary" :loading="saving" data-testid="settings-save-btn" @click="save">Save</Button>
      </div>
    </template>
  </Drawer>
</template>
