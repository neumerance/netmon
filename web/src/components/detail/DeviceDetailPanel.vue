<script setup>
// Device detail panel (TOPOLOGY.md §5.1).
//
// Two modes:
//  - 'side'  absolute slide-over on the right of the map wrapper (non-modal: the canvas stays
//            interactive; selecting another node swaps the content without re-animating).
//  - 'sheet' full-screen sheet teleported to <body> (role=dialog, aria-modal, focus trap and body
//            scroll lock via ui/overlay.js useOverlay).
// Close: X, Esc (see onDocKeydown / onOverlayEscape for the exceptions), or the parent setting
// `open=false` (empty-canvas click). The parent returns focus to the map node after closing.
//
// When the device disappears from `devices` (offline unsaved dropped, forgotten offline) the last
// snapshot keeps rendering with a banner and every action except Close is disabled.
//
// Store usage: only existing actions (saveDevice, pushToast) + state.mock (ping interval for the
// chart tooltip). Re-parenting is emitted (`reparent`) — the integrator wires it to the store.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from '../ui/Icon.vue';
import IconButton from '../ui/IconButton.vue';
import Button from '../ui/Button.vue';
import Sparkline from '../ui/Sparkline.vue';
import { useOverlay, uid } from '../ui/overlay.js';
import QualityBadge from '../devices/QualityBadge.vue';
import DeviceEditModal from '../devices/DeviceEditModal.vue';
import ForgetDeviceDialog from '../devices/ForgetDeviceDialog.vue';
import {
  OFFLINE_TILE,
  QUALITY,
  categoryTint,
  connectionQuality,
  formatRate,
  isPrivateMac
} from '../devices/deviceUi.js';
import { isRedetecting, redetectDevice } from '../devices/devicesState.js';
import { OS_ICONS, OS_LABELS, deviceDisplayName, deviceIcon, deviceTypeLabel } from '../../lib/deviceTypes.js';
import { formatDateTime, formatMs, formatPercent, formatRelative } from '../../lib/format.js';
import { useNow } from '../../composables/useNow.js';
import { pushToast, saveDevice, state } from '../../store.js';
import { isHub, resolveParents } from '../topology/layout.js';
import DetailFacts from './DetailFacts.vue';
import DetailLatencyChart from './DetailLatencyChart.vue';
import DetailEvidence from './DetailEvidence.vue';
import DetailEvents from './DetailEvents.vue';
import ConnectedViaSelect from './ConnectedViaSelect.vue';

const NAME_MAX = 64;
const THROUGHPUT_SAMPLES = 60;
// Ping cadence from PLAN.md §6.6 (REAL_TIMINGS / MOCK_TIMINGS.pingIntervalMs). The snapshot does not
// carry timings, so the chart tooltip derives sample ages from the mock flag.
const PING_INTERVAL_MS = { real: 10000, mock: 1000 };

const props = defineProps({
  /** Live Device (the parent passes the store copy, or its last snapshot once it is gone). */
  device: { type: Object, default: null },
  open: { type: Boolean, default: false },
  /** 'side' | 'sheet' */
  mode: { type: String, default: 'side' },
  /** All devices (hub options, parent name, presence check). */
  devices: { type: Array, default: () => [] },
  overrides: { type: Object, default: () => ({}) },
  /** state.events (newest first). */
  events: { type: Array, default: () => [] }
});
const emit = defineEmits(['close', 'reparent', 'select']);

const now = useNow(1000);

const rootEl = ref(null);
const headingEl = ref(null);
const nameBtnEl = ref(null);
const nameInputEl = ref(null);
const bodyEl = ref(null);
const headingId = uid('detail-heading');
const nameErrorId = uid('detail-name-error');

/* ------------------------------------------------------------------ device + snapshot */
const snapshot = ref(null);
watch(
  () => props.device,
  (d) => {
    if (d && d.mac) snapshot.value = d;
  },
  { immediate: true }
);

/** What we render: the live device, else the last one we saw. */
const shown = computed(() => props.device ?? snapshot.value);
const mac = computed(() => shown.value?.mac ?? null);
const isSheet = computed(() => props.mode === 'sheet');
const isOpen = computed(() => props.open && !!shown.value);

/** The device is no longer in the device list -> snapshot banner, actions disabled. */
const gone = computed(() => {
  if (!shown.value) return false;
  if (!props.device) return true;
  const list = Array.isArray(props.devices) ? props.devices : [];
  if (!list.length) return false; // nothing to compare against (e.g. devices not passed)
  return !list.some((d) => d?.mac === shown.value.mac);
});

/* ------------------------------------------------------------------ header */
const name = computed(() => deviceDisplayName(shown.value));
const typeLabel = computed(() => deviceTypeLabel(shown.value));
const online = computed(() => Boolean(shown.value?.online));
const isSelf = computed(() => Boolean(shown.value?.isSelf));
const isGateway = computed(() => Boolean(shown.value?.isGateway));
const tileClass = computed(() => (online.value ? categoryTint(shown.value?.category).tile : OFFLINE_TILE));
const osIcon = computed(() => (shown.value?.os ? OS_ICONS[shown.value.os] ?? null : null));
const osLabel = computed(() => (shown.value?.os ? OS_LABELS[shown.value.os] ?? shown.value.os : null));

const statusText = computed(() => {
  if (online.value) return 'Online';
  const ls = shown.value?.lastSeen;
  if (!ls) return 'Offline';
  // Clamp to "now" so a server clock slightly ahead of ours never reads "in a moment".
  const t = Date.parse(ls);
  return `Offline · last seen ${formatRelative(Number.isFinite(t) ? Math.min(t, now.value) : ls, now.value)}`;
});
const statusTitle = computed(() => {
  const ls = shown.value?.lastSeen;
  const base = online.value ? 'Online' : 'Offline';
  return ls ? `${base} · last seen ${formatDateTime(ls)}` : base;
});

const privateMac = computed(() => isPrivateMac(shown.value));
const userTyped = computed(() => shown.value?.typeSource === 'user');

/* ------------------------------------------------------------------ inline rename */
const editing = ref(false);
const draft = ref('');
const nameError = ref('');
const savingName = ref(false);

async function startEdit() {
  if (gone.value || !shown.value) return;
  draft.value = name.value.slice(0, NAME_MAX);
  nameError.value = '';
  editing.value = true;
  await nextTick();
  nameInputEl.value?.focus();
  nameInputEl.value?.select();
}

function cancelEdit({ refocus = true } = {}) {
  if (!editing.value) return;
  editing.value = false;
  nameError.value = '';
  if (refocus) nextTick(() => nameBtnEl.value?.focus({ preventScroll: true }));
}

async function commitEdit({ fromBlur = false } = {}) {
  if (!editing.value || savingName.value) return;
  const d = shown.value;
  const value = draft.value.trim();
  if (!value) {
    if (fromBlur) cancelEdit({ refocus: false });
    else {
      nameError.value = 'Give this device a name.';
      nameInputEl.value?.focus();
    }
    return;
  }
  if (value.length > NAME_MAX) {
    nameError.value = `Keep the name under ${NAME_MAX} characters.`;
    return;
  }
  const unchanged = value === (d?.name ?? name.value);
  // Blur only saves real changes; Enter on an unchanged name of a saved device just closes.
  if (unchanged && (fromBlur || d?.saved)) {
    cancelEdit({ refocus: !fromBlur });
    return;
  }
  if (!d || gone.value) return;
  savingName.value = true;
  nameError.value = '';
  try {
    await saveDevice(d.mac, { name: value, type: d.userType ?? null, notes: d.notes ?? '' });
    pushToast({ level: 'success', title: `Renamed to “${value}”` });
    editing.value = false;
    if (!fromBlur) nextTick(() => nameBtnEl.value?.focus({ preventScroll: true }));
  } catch (err) {
    // The store already toasted the failure; surface field errors inline.
    const details = err?.details && typeof err.details === 'object' ? err.details : null;
    nameError.value = details?.name ? String(details.name) : "Couldn't rename — try again.";
  } finally {
    savingName.value = false;
  }
}

function onNameKeydown(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    commitEdit();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    cancelEdit();
  }
}

/* ------------------------------------------------------------------ connection */
const quality = computed(() => (isSelf.value ? 'self' : connectionQuality(shown.value)));
const qualityStyle = computed(() => QUALITY[quality.value] ?? QUALITY.none);
const latencyHistory = computed(() =>
  Array.isArray(shown.value?.latencyHistory) ? shown.value.latencyHistory : []
);
const pingIntervalMs = computed(() => (state.mock ? PING_INTERVAL_MS.mock : PING_INTERVAL_MS.real));

const latencyClass = computed(() => {
  if (!online.value || shown.value?.latencyMs == null) return 'text-subtle';
  return qualityStyle.value.text;
});
const lossClass = computed(() => {
  const l = shown.value?.lossPct;
  if (!online.value || l == null) return 'text-subtle';
  if (l >= 5) return 'text-danger-fg';
  if (l > 0) return 'text-warning-fg';
  return 'text-text';
});
const valueClass = computed(() => (online.value ? 'text-text' : 'text-subtle'));

/* ---- self throughput: client-side ring buffer of rx/tx captured while open ---- */
const rxBuf = ref([]);
const txBuf = ref([]);
const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

function resetThroughput() {
  rxBuf.value = [];
  txBuf.value = [];
}
watch(
  () => [isOpen.value, shown.value],
  ([openNow, d], [, prev] = []) => {
    if (!openNow || !d?.isSelf) {
      if (rxBuf.value.length) resetThroughput();
      return;
    }
    if (prev && prev.mac !== d.mac) resetThroughput();
    const rx = num(d.rxMbps);
    const tx = num(d.txMbps);
    rxBuf.value = [...rxBuf.value, rx].slice(-THROUGHPUT_SAMPLES);
    txBuf.value = [...txBuf.value, tx].slice(-THROUGHPUT_SAMPLES);
  },
  { immediate: true }
);
const throughputMax = computed(() => {
  let m = 0;
  for (const v of rxBuf.value) if (v != null && v > m) m = v;
  for (const v of txBuf.value) if (v != null && v > m) m = v;
  return Math.max(1, m * 1.2);
});

// Width of the self throughput chart (ResizeObserver, rAF-debounced).
const tpWrap = ref(null);
const tpWidth = ref(300);
let tpRo = null;
let tpRaf = 0;
function measureTp() {
  tpRaf = 0;
  const w = tpWrap.value?.clientWidth;
  if (w) tpWidth.value = Math.round(w);
}
watch(tpWrap, (el) => {
  tpRo?.disconnect();
  tpRo = null;
  if (!el) return;
  measureTp();
  if (typeof ResizeObserver !== 'undefined') {
    tpRo = new ResizeObserver(() => {
      if (!tpRaf) tpRaf = requestAnimationFrame(measureTp);
    });
    tpRo.observe(el);
  }
});

/* ------------------------------------------------------------------ connected via / facts */
const parentLabel = computed(() => {
  const d = shown.value;
  if (!d) return '';
  if (d.isGateway) return 'Internet';
  const r = resolveParents(props.devices, props.overrides).get(d.mac);
  if (r?.parentMac) {
    const hub = (props.devices || []).find((x) => x?.mac === r.parentMac);
    return hub ? deviceDisplayName(hub) : r.parentMac;
  }
  return r?.source === 'user' ? 'Gateway' : 'Gateway (default)';
});

/* Hubs and the gateway: the devices the map draws under them (direct children of the effective tree). */
const CHILDREN_MAX = 50;
const showChildren = computed(() => !!shown.value && (isGateway.value || isHub(shown.value)));
const children = computed(() => {
  if (!showChildren.value) return [];
  const d = shown.value;
  const parents = resolveParents(props.devices, props.overrides);
  const want = d.isGateway ? null : d.mac;
  return (props.devices || [])
    .filter((x) => x && x.mac !== d.mac && !x.isGateway && parents.has(x.mac) && (parents.get(x.mac).parentMac ?? null) === want)
    .map((x) => {
      const q = connectionQuality(x);
      return {
        mac: x.mac,
        name: deviceDisplayName(x),
        icon: deviceIcon(x),
        online: !!x.online,
        tile: x.online ? categoryTint(x.category).tile : OFFLINE_TILE,
        dot: x.online ? QUALITY[q]?.dot || 'bg-border-strong' : 'bg-surface border border-subtle',
        latency: x.online && x.latencyMs != null ? formatMs(x.latencyMs) : x.online ? '' : 'Offline'
      };
    })
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, undefined, { numeric: true }));
});

function onReparent(parentMac) {
  if (!mac.value || gone.value) return;
  emit('reparent', mac.value, parentMac);
}

/* ------------------------------------------------------------------ actions */
const editOpen = ref(false);
const editFocusType = ref(false);
const forgetOpen = ref(false);
const redetecting = computed(() => isRedetecting(mac.value));

function openEdit(focusType = false) {
  if (gone.value) return;
  editFocusType.value = focusType;
  editOpen.value = true;
}
function openForget() {
  if (gone.value) return;
  editOpen.value = false;
  forgetOpen.value = true;
}
async function redetect() {
  if (gone.value || !shown.value?.online) return;
  await redetectDevice(shown.value);
}

function close() {
  emit('close');
}

/* ------------------------------------------------------------------ keyboard / focus */
// Sheet mode: useOverlay owns Esc (capture phase, topmost overlay only), the focus trap, scroll lock
// and initial focus (the heading). Esc while renaming cancels the rename instead of closing.
function onOverlayEscape() {
  if (editing.value) cancelEdit();
  else close();
}
useOverlay({
  isOpen: () => isOpen.value && isSheet.value,
  panelRef: rootEl,
  onClose: onOverlayEscape,
  initialFocus: () => headingEl.value
});

// Side mode: document-level Esc (bubble phase), ignored when already handled, while renaming, or
// while another modal dialog (edit / forget / settings …) is open.
function onDocKeydown(e) {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  if (!isOpen.value || isSheet.value || editing.value) return;
  const modal = document.querySelector('[aria-modal="true"]');
  if (modal && modal !== rootEl.value) return;
  close();
}

// "On open from keyboard, focus moves to the heading": remember the last input modality.
let lastInputKeyboard = false;
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta']);
const onAnyKeydown = (e) => {
  if (!MODIFIERS.has(e.key)) lastInputKeyboard = true;
};
const onAnyPointerdown = () => {
  lastInputKeyboard = false;
};

onMounted(() => {
  document.addEventListener('keydown', onDocKeydown);
  document.addEventListener('keydown', onAnyKeydown, true);
  document.addEventListener('pointerdown', onAnyPointerdown, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onDocKeydown);
  document.removeEventListener('keydown', onAnyKeydown, true);
  document.removeEventListener('pointerdown', onAnyPointerdown, true);
  tpRo?.disconnect();
  if (tpRaf) cancelAnimationFrame(tpRaf);
});

watch(isOpen, async (o, was) => {
  if (o && !was && !isSheet.value && lastInputKeyboard) {
    await nextTick();
    setTimeout(() => headingEl.value?.focus({ preventScroll: true }), 0);
  }
  if (!o) {
    cancelEdit({ refocus: false });
    editOpen.value = false;
    forgetOpen.value = false;
  }
});

// Another device selected: reset per-device UI and scroll the body back to the top.
watch(mac, (m, prev) => {
  if (m === prev) return;
  cancelEdit({ refocus: false });
  if (bodyEl.value) bodyEl.value.scrollTop = 0;
});

/* ------------------------------------------------------------------ presentation */
const rootClass = computed(() =>
  isSheet.value
    ? 'fixed inset-0 z-50 flex flex-col bg-overlay text-text outline-none pt-[env(safe-area-inset-top)]'
    : 'absolute inset-y-0 right-0 z-10 flex w-[380px] max-w-[calc(100%-48px)] flex-col border-l border-border bg-overlay text-text shadow-modal outline-none'
);
const transition = computed(() =>
  isSheet.value
    ? {
        enterActive: 'transition-transform duration-[240ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]',
        leaveActive: 'transition-transform duration-[180ms] ease-[cubic-bezier(0.4,0,1,1)]',
        from: 'translate-y-full'
      }
    : {
        enterActive: 'transition-transform duration-[240ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]',
        leaveActive: 'transition-transform duration-[180ms] ease-[cubic-bezier(0.4,0,1,1)]',
        from: 'translate-x-full'
      }
);

const BADGE = 'inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium ring-1 ring-inset';
</script>

<template>
  <Teleport to="body" :disabled="!isSheet">
    <Transition
      :enter-active-class="transition.enterActive"
      :leave-active-class="transition.leaveActive"
      :enter-from-class="transition.from"
      :leave-to-class="transition.from"
    >
      <aside
        v-if="isOpen"
        ref="rootEl"
        data-testid="device-detail-panel"
        :data-mac="mac"
        :data-mode="isSheet ? 'sheet' : 'side'"
        :data-gone="gone ? 'true' : 'false'"
        :role="isSheet ? 'dialog' : 'complementary'"
        :aria-modal="isSheet ? 'true' : undefined"
        :aria-labelledby="headingId"
        tabindex="-1"
        :class="rootClass"
      >
        <!-- ============================== Header ============================== -->
        <header class="shrink-0 border-b border-border px-4 pt-4 pb-3">
          <div class="flex items-start gap-3">
            <span
              class="relative grid size-12 shrink-0 place-items-center rounded-xl transition-colors duration-300"
              :class="tileClass"
              aria-hidden="true"
            >
              <Icon :name="deviceIcon(shown)" :size="24" />
            </span>

            <div class="min-w-0 flex-1 pt-0.5">
              <div class="flex min-w-0 items-center gap-0.5" :class="editing ? 'sr-only' : ''">
                <h2 :id="headingId" ref="headingEl" tabindex="-1" class="min-w-0 outline-none">
                  <button
                    ref="nameBtnEl"
                    type="button"
                    data-testid="detail-name"
                    class="block max-w-full truncate rounded-sm text-left text-base leading-6 font-semibold tracking-[-0.01em] text-text decoration-border-strong decoration-dotted underline-offset-4 hover:underline disabled:cursor-default disabled:hover:no-underline"
                    :title="gone ? name : `${name} — click to rename`"
                    :disabled="gone"
                    @click="startEdit"
                  >{{ name }}</button>
                </h2>
                <IconButton
                  v-if="!gone"
                  icon="pencil"
                  label="Rename device"
                  size="sm"
                  class="shrink-0"
                  data-testid="detail-name-edit-btn"
                  @click="startEdit"
                />
              </div>

              <div v-if="editing" class="min-w-0">
                <div class="flex items-center gap-2">
                  <input
                    ref="nameInputEl"
                    v-model="draft"
                    data-testid="detail-name-input"
                    type="text"
                    autocomplete="off"
                    spellcheck="false"
                    :maxlength="NAME_MAX"
                    :disabled="savingName"
                    aria-label="Device name"
                    :aria-invalid="nameError ? 'true' : 'false'"
                    :aria-describedby="nameErrorId"
                    class="h-8 w-full min-w-0 rounded-md border bg-surface px-2.5 text-sm font-medium text-text shadow-xs placeholder:text-subtle focus-visible:outline-2 focus-visible:outline-offset-0 disabled:opacity-60"
                    :class="
                      nameError
                        ? 'border-danger focus-visible:outline-danger/40'
                        : 'border-border-strong focus-visible:border-accent focus-visible:outline-accent/40'
                    "
                    placeholder="e.g. Living room TV"
                    @keydown="onNameKeydown"
                    @blur="commitEdit({ fromBlur: true })"
                  />
                </div>
                <p
                  :id="nameErrorId"
                  class="mt-1 text-xs"
                  :class="nameError ? 'text-danger-fg' : 'text-muted'"
                  :role="nameError ? 'alert' : undefined"
                >
                  <template v-if="nameError">{{ nameError }}</template>
                  <template v-else-if="!shown.saved">Naming a device also saves it.</template>
                  <template v-else>Enter to save · Esc to cancel</template>
                </p>
              </div>

              <p class="mt-0.5 flex min-w-0 items-center gap-1.5 text-[13px] text-muted">
                <span
                  data-testid="detail-type"
                  :data-category="shown.category ?? 'unknown'"
                  :data-os="shown.os ?? ''"
                  class="min-w-0 truncate"
                  :title="osLabel ? `${typeLabel} (${osLabel})` : typeLabel"
                >{{ typeLabel }}</span>
                <Icon
                  v-if="osIcon"
                  :name="osIcon"
                  :size="12"
                  class="shrink-0 text-subtle"
                  role="img"
                  :aria-label="osLabel"
                  aria-hidden="false"
                />
              </p>
            </div>

            <IconButton
              icon="x"
              label="Close details"
              class="-mt-1 -mr-1.5 shrink-0"
              data-testid="detail-close-btn"
              @click="close"
            />
          </div>

          <!-- Status + badges -->
          <div class="mt-3 flex flex-wrap items-center gap-1.5">
            <span
              data-testid="detail-status"
              :data-status="online ? 'online' : 'offline'"
              :title="statusTitle"
              class="inline-flex max-w-full items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset"
              :class="online ? 'bg-success/12 text-success-fg ring-success/25' : 'bg-surface-3 text-muted ring-border-strong'"
            ><span
                aria-hidden="true"
                class="size-1.5 shrink-0 rounded-full transition-colors duration-300"
                :class="online ? 'bg-success' : 'border border-subtle bg-transparent'"
              /><span class="truncate">{{ statusText }}</span></span>

            <span
              v-if="isSelf"
              data-testid="detail-badge-self"
              :class="BADGE"
              class="bg-accent/12 text-accent-fg ring-accent/25"
            >This device</span>
            <span
              v-if="isGateway"
              data-testid="detail-badge-gateway"
              :class="BADGE"
              class="bg-cat-network/12 text-cat-network ring-cat-network/25"
            >Gateway</span>
            <span
              v-if="privateMac"
              data-testid="detail-badge-private"
              :class="BADGE"
              class="bg-surface-3 text-muted ring-border-strong"
              title="Private (randomized) Wi-Fi address — it may change if the device forgets this network."
            ><Icon name="shield" :size="12" />Private address</span>
            <span
              v-if="shown.saved"
              data-testid="detail-badge-saved"
              :class="BADGE"
              class="bg-surface-3 text-muted ring-border-strong"
            ><Icon name="star-filled" :size="12" class="text-warning" />Saved</span>
            <span
              v-if="userTyped"
              data-testid="detail-badge-usertype"
              :class="BADGE"
              class="bg-surface-3 text-muted ring-border-strong"
            ><Icon name="edit" :size="12" />Type set by you</span>
          </div>
        </header>

        <div
          v-if="gone"
          data-testid="detail-gone-banner"
          role="status"
          class="flex shrink-0 items-center gap-2 border-b border-border bg-surface-2 px-4 py-2 text-[13px] text-muted"
        >
          <Icon name="circle-off" :size="16" class="shrink-0 text-subtle" />
          This device is no longer on the network.
        </div>

        <!-- ============================== Body ============================== -->
        <div ref="bodyEl" class="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain px-4 py-4">
          <!-- Connection -->
          <section :aria-labelledby="`${headingId}-conn`">
            <h3 :id="`${headingId}-conn`" class="eyebrow mb-2">Connection</h3>

            <!-- Self: live throughput instead of latency -->
            <template v-if="isSelf">
              <div ref="tpWrap" class="relative h-14 w-full" aria-hidden="true">
                <div class="absolute inset-0">
                  <Sparkline
                    :values="rxBuf"
                    :width="tpWidth"
                    :height="56"
                    tone="accent"
                    :max-scale="throughputMax"
                    :null-ticks="false"
                  />
                </div>
                <div class="absolute inset-0">
                  <Sparkline
                    :values="txBuf"
                    :width="tpWidth"
                    :height="56"
                    tone="info"
                    :fill="false"
                    :max-scale="throughputMax"
                    :null-ticks="false"
                  />
                </div>
              </div>
              <div class="mt-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span class="eyebrow">Throughput</span>
                <span
                  data-testid="detail-throughput"
                  :data-rx="shown.rxMbps ?? ''"
                  :data-tx="shown.txMbps ?? ''"
                  class="text-[15px] font-semibold tabular-nums text-text"
                ><span class="text-accent-fg">↓</span> {{ formatRate(shown.rxMbps) }}
                  <span class="text-info-fg">↑</span> {{ formatRate(shown.txMbps) }}
                  <span class="text-xs font-normal text-muted">Mbps</span></span>
              </div>
              <p class="mt-1 text-xs text-muted">Latency isn't measured for this computer.</p>
            </template>

            <!-- Everyone else: latency chart + stats -->
            <template v-else>
              <DetailLatencyChart
                :values="latencyHistory"
                :quality="quality"
                :muted="!online"
                :interval-ms="pingIntervalMs"
              />
              <p v-if="!online" class="mt-1 text-xs text-subtle">Last values before it went offline</p>
              <p v-else-if="quality === 'noping'" class="mt-1 text-xs text-muted">
                No ping reply — this device blocks ping (ICMP), so NetMon only sees it through ARP.
              </p>

              <dl class="mt-3 grid grid-cols-4 gap-2">
                <div class="min-w-0 rounded-lg bg-surface-2 px-2.5 py-2">
                  <dt class="text-[10px] leading-4 font-medium tracking-[0.06em] text-subtle uppercase">Latency</dt>
                  <dd data-testid="detail-latency" class="truncate text-[15px] font-semibold tabular-nums" :class="latencyClass">
                    {{ formatMs(shown.latencyMs) }}
                  </dd>
                </div>
                <div class="min-w-0 rounded-lg bg-surface-2 px-2.5 py-2">
                  <dt class="text-[10px] leading-4 font-medium tracking-[0.06em] text-subtle uppercase">Jitter</dt>
                  <dd data-testid="detail-jitter" class="truncate text-[15px] font-semibold tabular-nums" :class="shown.jitterMs == null ? 'text-subtle' : valueClass">
                    {{ formatMs(shown.jitterMs) }}
                  </dd>
                </div>
                <div class="min-w-0 rounded-lg bg-surface-2 px-2.5 py-2">
                  <dt class="text-[10px] leading-4 font-medium tracking-[0.06em] text-subtle uppercase">Loss</dt>
                  <dd data-testid="detail-loss" class="truncate text-[15px] font-semibold tabular-nums" :class="lossClass">
                    {{ formatPercent(shown.lossPct) }}
                  </dd>
                </div>
                <div class="min-w-0 rounded-lg bg-surface-2 px-2.5 py-2">
                  <dt class="text-[10px] leading-4 font-medium tracking-[0.06em] text-subtle uppercase">Quality</dt>
                  <dd data-testid="detail-quality" :data-quality="quality" class="flex h-[22px] items-center">
                    <QualityBadge v-if="quality !== 'none'" :quality="quality" />
                    <span v-else class="text-[15px] font-semibold text-subtle">—</span>
                  </dd>
                </div>
              </dl>

              <div class="mt-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <span class="eyebrow">Throughput</span>
                <span data-testid="detail-throughput" data-rx="" data-tx="" class="text-[13px] text-muted">
                  <span class="text-text">—</span> Requires router integration
                </span>
              </div>
            </template>
          </section>

          <!-- Connected via / Uplink -->
          <section v-if="!isGateway">
            <ConnectedViaSelect
              :device="shown"
              :devices="devices"
              :overrides="overrides"
              :disabled="gone"
              @change="onReparent"
            />
          </section>

          <!-- Connected devices (hubs + gateway) -->
          <section v-if="showChildren" :aria-labelledby="`${headingId}-children`" data-testid="detail-children">
            <h3 :id="`${headingId}-children`" class="eyebrow mb-2">Connected devices ({{ children.length }})</h3>
            <p v-if="!children.length" class="text-[13px] text-muted">
              No devices are connected via {{ isGateway ? 'the gateway' : 'this access point' }} on the map.
            </p>
            <ul v-else class="-mx-2 flex flex-col">
              <li v-for="c in children.slice(0, CHILDREN_MAX)" :key="c.mac">
                <button
                  type="button"
                  class="flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
                  data-testid="detail-child"
                  :data-mac="c.mac"
                  @click="emit('select', c.mac)"
                >
                  <span class="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md" :class="c.tile">
                    <Icon :name="c.icon" :size="16" />
                    <span class="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-surface" :class="c.dot" aria-hidden="true" />
                  </span>
                  <span class="min-w-0 flex-1 truncate text-[13px] text-text" :title="c.name">{{ c.name }}</span>
                  <span class="shrink-0 text-xs tabular-nums text-muted">{{ c.latency }}</span>
                </button>
              </li>
            </ul>
            <p v-if="children.length > CHILDREN_MAX" class="mt-1 text-xs text-muted">
              and {{ children.length - CHILDREN_MAX }} more — see the List view
            </p>
          </section>

          <!-- Details -->
          <section :aria-labelledby="`${headingId}-facts`">
            <h3 :id="`${headingId}-facts`" class="eyebrow mb-2">Details</h3>
            <DetailFacts :device="shown" :parent-label="parentLabel" />
          </section>

          <!-- Why this type? -->
          <section :aria-labelledby="`${headingId}-why`">
            <h3 :id="`${headingId}-why`" class="eyebrow mb-2">Why this type?</h3>
            <DetailEvidence :device="shown" :disabled="gone" @change-type="openEdit(true)" />
          </section>

          <!-- Recent activity -->
          <section :aria-labelledby="`${headingId}-events`">
            <h3 :id="`${headingId}-events`" class="eyebrow mb-2">Recent activity</h3>
            <DetailEvents :events="events" :mac="mac" />
          </section>
        </div>

        <!-- ============================== Footer ============================== -->
        <footer
          class="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-4 py-3"
          :class="isSheet ? 'pb-[max(0.75rem,env(safe-area-inset-bottom))]' : ''"
        >
          <Button
            variant="primary"
            :icon="shown.saved ? 'edit' : 'star'"
            class="!h-9"
            data-testid="detail-save-btn"
            :disabled="gone"
            @click="openEdit(false)"
          >{{ shown.saved ? 'Edit' : 'Save device' }}</Button>
          <Button
            variant="secondary"
            icon="refresh"
            class="!h-9"
            data-testid="detail-redetect-btn"
            :loading="redetecting"
            :disabled="gone || !online"
            :title="!online ? 'Device is offline — re-detect needs it online' : 'Run device-type detection again'"
            @click="redetect"
          >Re-detect</Button>
          <Button
            v-if="shown.saved"
            variant="danger-ghost"
            icon="trash"
            class="ml-auto !h-9"
            data-testid="detail-forget-btn"
            :disabled="gone"
            @click="openForget"
          >Forget</Button>
        </footer>
      </aside>
    </Transition>
  </Teleport>

  <!-- Overlays owned by this panel instance (teleported to <body> by Modal). -->
  <DeviceEditModal
    :open="editOpen && !!shown"
    :device="shown"
    :focus-type="editFocusType"
    @close="editOpen = false"
    @forget="openForget"
  />
  <ForgetDeviceDialog :open="forgetOpen && !!shown" :device="shown" @close="forgetOpen = false" />
</template>
