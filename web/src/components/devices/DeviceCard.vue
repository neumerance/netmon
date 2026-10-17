<script setup>
// One device as a stacked card (narrow panels / phones). Same data-testids as DeviceRow.
// Tapping the card body (not a control) opens the device detail panel.
import { computed } from 'vue';
import { useNow } from '../../composables/useNow.js';
import DeviceIdentity from './DeviceIdentity.vue';
import DeviceTypeBadge from './DeviceTypeBadge.vue';
import DeviceStatus from './DeviceStatus.vue';
import LatencyCell from './LatencyCell.vue';
import ThroughputCell from './ThroughputCell.vue';
import DeviceActions from './DeviceActions.vue';
import { isPrivateMac, macDashes } from './deviceUi.js';
import { isJustArrived } from './devicesState.js';

const props = defineProps({
  device: { type: Object, required: true }
});
const emit = defineEmits(['edit', 'forget', 'refingerprint', 'open']);

const now = useNow(1000);
const flash = computed(() => isJustArrived(props.device, now.value));
const privateMac = computed(() => isPrivateMac(props.device));

function onCardClick(e) {
  // Ignore clicks that land on interactive descendants (buttons, links, inputs).
  if (e.target instanceof Element && e.target.closest('button, a, input, select, textarea')) return;
  emit('open', props.device);
}
</script>

<template>
  <li
    :data-testid="`device-row-${macDashes(device.mac)}`"
    :data-mac="device.mac"
    :data-online="device.online ? 'true' : 'false'"
    :data-saved="device.saved ? 'true' : 'false'"
    :data-category="device.category ?? 'unknown'"
    class="cursor-pointer rounded-xl border border-border bg-surface p-3 transition-colors hover:border-border-strong"
    :class="flash ? 'ring-2 ring-info/40' : ''"
    @click="onCardClick"
  >
    <div class="flex items-start gap-2">
      <div class="min-w-0 flex-1" :class="device.online ? '' : 'opacity-60'">
        <DeviceIdentity openable @open="emit('open', device)" :device="device" size="lg">
          <DeviceTypeBadge
            :device="device"
            :show-icon="false"
            class="mt-0.5"
            @change-type="emit('edit', device)"
          />
        </DeviceIdentity>
      </div>
      <DeviceStatus :device="device" variant="stacked" class="shrink-0 items-end text-right" />
    </div>

    <div class="mt-2.5 space-y-1.5 pl-12" :class="device.online ? '' : 'opacity-60'">
      <div class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted">
        <span class="tabular-nums text-text">{{ device.ip || '—' }}</span>
        <span aria-hidden="true">·</span>
        <span class="font-mono text-[11px]">{{ device.mac }}</span>
        <span
          v-if="privateMac"
          data-testid="private-mac-badge"
          class="rounded bg-surface-3 px-1 text-[10px] font-medium text-muted"
          title="Private (randomized) Wi-Fi address — common on iPhone, Android and Windows. It may change if the device forgets this network."
        >Private</span>
        <template v-if="device.vendor">
          <span aria-hidden="true">·</span>
          <span class="min-w-0 truncate">{{ device.vendor }}</span>
        </template>
      </div>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <LatencyCell :device="device" variant="card" show-badge />
        <ThroughputCell :device="device" variant="card" />
      </div>
      <p v-if="device.notes" class="line-clamp-2 text-xs text-muted">{{ device.notes }}</p>
    </div>

    <div class="mt-3 border-t border-border pt-2.5">
      <DeviceActions
        :device="device"
        variant="full"
        show-redetect
        @edit="emit('edit', device)"
        @forget="emit('forget', device)"
        @refingerprint="emit('refingerprint', device)"
      />
    </div>
  </li>
</template>
