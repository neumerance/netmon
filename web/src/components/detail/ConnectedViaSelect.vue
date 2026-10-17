<script setup>
// "Connected via" (or "Uplink" for hubs) select of the device detail panel (TOPOLOGY.md §5.2).
//
// NetMon cannot see which access point a client uses (no router integration), so the user picks it.
// Options come from layout.js hubOptions(); the selected value is the effective parent from
// resolveParents(). Emits `change(parentMac|null)` only on a real change, then shows a spinner until
// the `overrides` prop reflects the new value (or 5 s pass, after which it shows the props value).
// Hidden for the gateway.
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import Icon from '../ui/Icon.vue';
import Spinner from '../ui/Spinner.vue';
import { hubOptions, isHub, resolveParents } from '../topology/layout.js';
import { categoryLabel, deviceDisplayName } from '../../lib/deviceTypes.js';
import { uid } from '../ui/overlay.js';

const PENDING_TIMEOUT_MS = 5000;

const props = defineProps({
  device: { type: Object, required: true },
  devices: { type: Array, default: () => [] },
  overrides: { type: Object, default: () => ({}) },
  disabled: { type: Boolean, default: false }
});
const emit = defineEmits(['change']);

const selectId = uid('connected-via');
const helpId = uid('connected-via-help');

const mac = computed(() => props.device?.mac ?? null);
const hidden = computed(() => !props.device || Boolean(props.device.isGateway));
const deviceIsHub = computed(() => isHub(props.device));
const label = computed(() => (deviceIsHub.value ? 'Uplink' : 'Connected via'));

const options = computed(() => (hidden.value ? [] : hubOptions(props.device, props.devices, props.overrides)));
const hubCount = computed(() => options.value.filter((o) => o.value !== null).length);

/** Native <select> values are strings: "" = gateway, hub values = colon MAC. */
const selectOptions = computed(() =>
  options.value.map((o) => {
    if (o.value === null) {
      return {
        value: '',
        text: o.sublabel ? `Gateway — ${o.sublabel} (default)` : 'Gateway (default)'
      };
    }
    // Category only ("Wi-Fi access point"): the full type label repeats the model the name usually has.
    const hub = (props.devices || []).find((d) => d?.mac === o.value);
    const sub = hub ? categoryLabel(hub.category) : o.sublabel;
    const base = sub ? `${o.label} · ${sub}` : o.label;
    return { value: o.value, text: o.online === false ? `${base} (offline)` : base };
  })
);

const resolved = computed(() => {
  if (hidden.value || !mac.value) return { parentMac: null, source: 'default' };
  return resolveParents(props.devices, props.overrides).get(mac.value) ?? { parentMac: null, source: 'default' };
});
const effectiveValue = computed(() => resolved.value.parentMac ?? '');

/* ---------------------------------------------------------------- pending state */
const pendingValue = ref(null); // string ('' = gateway) while waiting for the overrides prop
let pendingTimer = null;

function clearPending() {
  pendingValue.value = null;
  clearTimeout(pendingTimer);
  pendingTimer = null;
}

watch(effectiveValue, (v) => {
  if (pendingValue.value !== null && v === pendingValue.value) clearPending();
});
// The store rolled back (request rejected) or the change resolves to something else locally (loop / not a
// hub): stop showing the rejected value right away instead of after the 5 s timeout.
watch(
  () => props.overrides,
  () => {
    if (pendingValue.value !== null && effectiveValue.value !== pendingValue.value) clearPending();
  }
);
// A different device is shown: drop any pending state from the previous one.
watch(mac, clearPending);
onBeforeUnmount(clearPending);

// Touch phones cannot drag map nodes (TopologyMap disables dragging there), so don't suggest it.
const noDrag = ref(false);
let mql = null;
const onMq = (e) => (noDrag.value = e.matches);
try {
  mql = window.matchMedia?.('(pointer: coarse) and (max-width: 767px)') ?? null;
  if (mql) {
    noDrag.value = mql.matches;
    mql.addEventListener?.('change', onMq);
  }
} catch {
  mql = null;
}
onBeforeUnmount(() => mql?.removeEventListener?.('change', onMq));

const pending = computed(() => pendingValue.value !== null);
const currentValue = computed(() => (pending.value ? pendingValue.value : effectiveValue.value));

function onChange(e) {
  const v = String(e.target.value ?? '');
  if (v === currentValue.value) return;
  if (v === effectiveValue.value) {
    // Back to what the server already has (e.g. changed twice quickly): nothing to send.
    clearPending();
    return;
  }
  pendingValue.value = v;
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingValue.value = null;
    pendingTimer = null;
  }, PENDING_TIMEOUT_MS);
  emit('change', v === '' ? null : v);
}

/* ---------------------------------------------------------------- helper text */
/** Stored-but-unusable parent (resolveParents source 'fallback'). */
const fallbackText = computed(() => {
  if (resolved.value.source !== 'fallback' || !mac.value) return '';
  const stored = props.overrides?.[mac.value]?.parentMac;
  if (!stored) return '';
  const parent = (props.devices || []).find((d) => d?.mac === String(stored).toLowerCase());
  const name = parent ? deviceDisplayName(parent) : String(stored);
  if (!parent) return `Usually via ${name} — not on the network right now`;
  return `Usually via ${name} — not available as an access point right now`;
});

const noHubs = computed(() => hubCount.value === 0);
const isDisabled = computed(() => props.disabled || noHubs.value);
</script>

<template>
  <div v-if="!hidden" data-testid="detail-connected-via-field" :data-source="resolved.source">
    <label :for="selectId" class="eyebrow mb-2 block">{{ label }}</label>
    <div class="flex items-center gap-2">
      <div class="relative min-w-0 flex-1">
        <select
          :id="selectId"
          data-testid="detail-connected-via"
          :value="noHubs ? '' : currentValue"
          :disabled="isDisabled"
          :aria-describedby="helpId"
          :aria-busy="pending ? 'true' : 'false'"
          class="h-9 w-full appearance-none truncate rounded-md border border-border-strong bg-surface pr-8 pl-3 text-sm text-text shadow-xs focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent/40 disabled:cursor-not-allowed disabled:opacity-60"
          @change="onChange"
        >
          <option v-if="noHubs" value="">Gateway</option>
          <template v-else>
            <option v-for="o in selectOptions" :key="o.value || 'gateway'" :value="o.value">{{ o.text }}</option>
          </template>
        </select>
        <Icon
          name="chevron-down"
          :size="16"
          class="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-subtle"
        />
      </div>
      <Spinner v-if="pending" :size="14" label="Saving connection" class="shrink-0 text-muted" />
    </div>
    <p v-if="fallbackText" class="mt-1.5 text-xs text-warning-fg" data-testid="detail-connected-via-fallback">
      {{ fallbackText }}
    </p>
    <p :id="helpId" class="mt-1.5 text-xs text-muted">
      <template v-if="noHubs && deviceIsHub">No other access points or mesh nodes found on this network.</template>
      <template v-else-if="noHubs">No access points or mesh nodes found on this network.</template>
      <template v-else-if="noDrag">NetMon can't see which access point a device uses. Pick it here.</template>
      <template v-else>NetMon can't see which access point a device uses. Pick it here or drag the device onto an access point on the map.</template>
    </p>
  </div>
</template>
