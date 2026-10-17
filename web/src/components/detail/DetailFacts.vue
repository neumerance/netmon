<script setup>
// Key facts grid of the device detail panel (TOPOLOGY.md §5.2).
// IP / MAC rows have a copy button (navigator.clipboard, icon swaps to a check for 1.5 s) and emit
// `copy(kind, value)` after a successful copy. Missing values render "—" in text-subtle.
import { computed, onBeforeUnmount, ref } from 'vue';
import IconButton from '../ui/IconButton.vue';
import { OS_LABELS } from '../../lib/deviceTypes.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { useNow } from '../../composables/useNow.js';

const props = defineProps({
  device: { type: Object, required: true },
  /** e.g. "Deco-M5" / "Gateway (default)" / "Gateway". */
  parentLabel: { type: String, default: '' }
});
const emit = defineEmits(['copy']);

const now = useNow(1000);

const copied = ref({ ip: false, mac: false });
const timers = {};

async function copy(kind, value) {
  if (!value) return;
  let ok = false;
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(String(value));
      ok = true;
    }
  } catch {
    ok = false;
  }
  if (!ok) return;
  copied.value = { ...copied.value, [kind]: true };
  clearTimeout(timers[kind]);
  timers[kind] = setTimeout(() => {
    copied.value = { ...copied.value, [kind]: false };
  }, 1500);
  emit('copy', kind, String(value));
}

onBeforeUnmount(() => {
  for (const t of Object.values(timers)) clearTimeout(t);
});

const clean = (v) => (v == null || String(v).trim() === '' ? null : String(v));

const osText = computed(() => {
  const os = props.device.os;
  if (!os) return null;
  return OS_LABELS[os] ?? os;
});

const firstSeen = computed(() => props.device.firstSeen || null);
const lastSeen = computed(() => props.device.lastSeen || null);
/** Relative time, clamped so a server clock slightly ahead of ours never reads "in a moment". */
const rel = (iso) => {
  const t = Date.parse(iso);
  return formatRelative(Number.isFinite(t) ? Math.min(t, now.value) : iso, now.value);
};

const notes = computed(() => clean(props.device.notes));

/** Plain text rows (label, value); the IP/MAC/time rows are rendered explicitly below. */
const plainRows = computed(() => [
  { key: 'vendor', label: 'Vendor', value: clean(props.device.vendor) },
  { key: 'hostname', label: 'Hostname', value: clean(props.device.hostname) },
  { key: 'os', label: 'OS', value: osText.value },
  { key: 'model', label: 'Model', value: clean(props.device.model) }
]);
</script>

<template>
  <dl class="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 text-[13px]">
    <!-- IP -->
    <dt class="text-muted">IP address</dt>
    <dd class="flex min-w-0 items-center gap-1">
      <span
        data-testid="detail-ip"
        class="min-w-0 truncate tabular-nums"
        :class="device.ip ? 'text-text' : 'text-subtle'"
      >{{ device.ip || '—' }}</span>
      <IconButton
        v-if="device.ip"
        :icon="copied.ip ? 'check' : 'copy'"
        :label="copied.ip ? 'Copied' : 'Copy IP address'"
        size="sm"
        class="-my-1.5 !h-6 !w-6"
        :class="copied.ip ? '!text-success-fg' : ''"
        data-testid="detail-copy-ip-btn"
        @click="copy('ip', device.ip)"
      />
    </dd>

    <!-- MAC -->
    <dt class="text-muted">MAC address</dt>
    <dd class="flex min-w-0 items-center gap-1">
      <span data-testid="detail-mac" class="min-w-0 truncate font-mono text-xs text-text">{{ device.mac }}</span>
      <IconButton
        :icon="copied.mac ? 'check' : 'copy'"
        :label="copied.mac ? 'Copied' : 'Copy MAC address'"
        size="sm"
        class="-my-1.5 !h-6 !w-6"
        :class="copied.mac ? '!text-success-fg' : ''"
        data-testid="detail-copy-mac-btn"
        @click="copy('mac', device.mac)"
      />
    </dd>

    <template v-for="row in plainRows" :key="row.key">
      <dt class="text-muted">{{ row.label }}</dt>
      <dd
        class="min-w-0 break-words"
        :class="row.value ? 'text-text' : 'text-subtle'"
        :data-testid="`detail-${row.key}`"
      >{{ row.value ?? '—' }}</dd>
    </template>

    <!-- First / last seen -->
    <dt class="text-muted">First seen</dt>
    <dd class="min-w-0" data-testid="detail-first-seen">
      <template v-if="firstSeen">
        <span class="text-text tabular-nums">{{ formatDateTime(firstSeen) }}</span>
        <span class="block text-xs text-muted">{{ rel(firstSeen) }}</span>
      </template>
      <span v-else class="text-subtle">—</span>
    </dd>

    <dt class="text-muted">Last seen</dt>
    <dd class="min-w-0" data-testid="detail-last-seen">
      <template v-if="lastSeen">
        <span class="text-text tabular-nums">{{ formatDateTime(lastSeen) }}</span>
        <span class="block text-xs text-muted">{{ device.online ? 'just now' : rel(lastSeen) }}</span>
      </template>
      <span v-else class="text-subtle">—</span>
    </dd>

    <!-- Connected via -->
    <dt class="text-muted">Connected via</dt>
    <dd
      class="min-w-0 truncate"
      :class="parentLabel ? 'text-text' : 'text-subtle'"
      :title="parentLabel || undefined"
      data-testid="detail-parent"
    >{{ parentLabel || '—' }}</dd>

    <!-- Notes -->
    <template v-if="notes">
      <dt class="text-muted">Notes</dt>
      <dd class="min-w-0 whitespace-pre-wrap break-words text-text" data-testid="detail-notes">{{ notes }}</dd>
    </template>
  </dl>
</template>
