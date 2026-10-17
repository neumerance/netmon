<script setup>
// "Why this type?" section of the device detail panel (TOPOLOGY.md §5.2). Same content as the
// table's EvidencePopover, laid out inline: confidence line (+ meter), evidence list, and a
// "Wrong? Change type" link that emits `change-type` (the panel opens DeviceEditModal focus-type).
import { computed } from 'vue';
import Icon from '../ui/Icon.vue';
import { deviceTypeLabel } from '../../lib/deviceTypes.js';
import { confidencePercent } from '../devices/deviceUi.js';

const props = defineProps({
  device: { type: Object, required: true },
  /** Disable "Change type" (e.g. the device is no longer on the network). */
  disabled: { type: Boolean, default: false }
});
const emit = defineEmits(['change-type']);

const evidence = computed(() =>
  (Array.isArray(props.device.typeEvidence) ? props.device.typeEvidence : [])
    .filter((e) => e != null && String(e).trim() !== '')
    .map((e) => String(e))
);
const isUser = computed(() => props.device.typeSource === 'user');
const pct = computed(() => confidencePercent(props.device.typeConfidence));

/** What auto-detection says when the user has overridden the type. */
const autoLabel = computed(() => {
  const d = props.device;
  if (!isUser.value || !d.autoCategory) return null;
  return deviceTypeLabel({ ...d, category: d.autoCategory });
});
</script>

<template>
  <div data-testid="detail-evidence-section" :data-source="isUser ? 'user' : 'auto'">
    <template v-if="isUser">
      <p class="text-[13px] text-text">
        Set by you<template v-if="autoLabel"><span class="text-muted"> · auto-detect would say {{ autoLabel }} ({{ pct }}%)</span></template>
      </p>
    </template>
    <template v-else>
      <p class="text-[13px] text-text">
        Detected automatically<span class="text-muted"> · {{ pct }}% confidence</span>
      </p>
      <div
        class="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-surface-3"
        role="meter"
        aria-label="Detection confidence"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="pct"
      >
        <div class="h-full rounded-full bg-accent transition-[width] duration-300" :style="{ width: `${pct}%` }" />
      </div>
    </template>

    <ul v-if="evidence.length" data-testid="detail-evidence" class="mt-3 space-y-1.5">
      <li v-for="(e, i) in evidence" :key="i" class="flex items-start gap-2 text-xs leading-4 text-muted">
        <Icon name="check" :size="14" class="mt-px shrink-0 text-success-fg" />
        <span class="min-w-0 break-words">{{ e }}</span>
      </li>
    </ul>
    <p v-else data-testid="detail-evidence-empty" class="mt-3 text-xs leading-5 text-muted">
      <template v-if="device.fingerprinting">Identifying this device…</template>
      <template v-else>Not enough information yet. Detection improves as the device responds to discovery.</template>
    </p>

    <p class="mt-3 flex items-center gap-1.5 text-xs text-muted">
      Wrong?
      <button
        type="button"
        data-testid="detail-change-type-btn"
        class="rounded-sm text-xs font-medium text-accent-fg underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:no-underline"
        :disabled="disabled"
        @click="emit('change-type')"
      >
        Change type
      </button>
    </p>
  </div>
</template>
