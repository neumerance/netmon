<script setup>
// One device as a table row (wide panels). Narrow panels use DeviceCard.vue with the same
// data-testids. Column visibility uses container queries on the panel (`@container/devices`):
//   < @5xl (1024px): Device (3rd line carries IP + MAC) | Status | Latency | Throughput | Actions
//   ≥ @4xl (896px):  + connection-quality word in the Latency column
//   ≥ @5xl:          + Address column (IP + MAC), inline re-detect icon in the type line
//   ≥ @6xl (1152px): + Vendor column
// The type label (user requirement: show what kind of device it is) is never truncated: it may
// wrap onto a second line instead. Re-detect stays reachable in the edit modal on narrow panels.
import { computed } from 'vue';
import { useNow } from '../../composables/useNow.js';
import DeviceIdentity from './DeviceIdentity.vue';
import DeviceTypeBadge from './DeviceTypeBadge.vue';
import DeviceStatus from './DeviceStatus.vue';
import LatencyCell from './LatencyCell.vue';
import ThroughputCell from './ThroughputCell.vue';
import DeviceActions from './DeviceActions.vue';
import RedetectButton from './RedetectButton.vue';
import { isPrivateMac, macDashes } from './deviceUi.js';
import { isJustArrived } from './devicesState.js';

const props = defineProps({
  device: { type: Object, required: true }
});
const emit = defineEmits(['edit', 'forget', 'refingerprint', 'open']);

const now = useNow(1000);
const dim = computed(() => (props.device.online ? '' : 'opacity-60'));
const flash = computed(() => isJustArrived(props.device, now.value));
const privateMac = computed(() => isPrivateMac(props.device));
</script>

<template>
  <tr
    :data-testid="`device-row-${macDashes(device.mac)}`"
    :data-mac="device.mac"
    :data-online="device.online ? 'true' : 'false'"
    :data-saved="device.saved ? 'true' : 'false'"
    :data-category="device.category ?? 'unknown'"
    class="border-t border-border transition-colors duration-700 first:border-t-0 hover:bg-surface-2/70"
    :class="flash ? 'bg-info/10' : ''"
  >
    <!-- Device: tile, name + badges, type label + confidence + Why? + re-detect -->
    <td class="py-2.5 pr-3 pl-4">
      <DeviceIdentity openable @open="emit('open', device)" :device="device" :class="dim">
        <DeviceTypeBadge :device="device" :show-icon="false" class="mt-0.5" @change-type="emit('edit', device)">
          <span class="hidden @5xl/devices:contents">
            <RedetectButton :device="device" variant="mini" @refingerprint="emit('refingerprint', device)" />
          </span>
        </DeviceTypeBadge>
        <!-- Address on a third line while the Address column is hidden (narrower panels) -->
        <div class="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-subtle @5xl/devices:hidden">
          <span class="shrink-0 tabular-nums text-muted">{{ device.ip || '—' }}</span>
          <span aria-hidden="true">·</span>
          <span class="min-w-0 truncate font-mono" :title="device.vendor ? `${device.mac} · ${device.vendor}` : device.mac">{{ device.mac }}</span>
          <span
            v-if="privateMac"
            data-testid="private-mac-badge"
            class="shrink-0 rounded bg-surface-3 px-1 text-[10px] font-medium text-muted"
            title="Private (randomized) Wi-Fi address — common on iPhone, Android and Windows. It may change if the device forgets this network."
          >Private</span>
        </div>
      </DeviceIdentity>
    </td>

    <!-- Address (IP + MAC) -->
    <td class="hidden px-3 py-2.5 @5xl/devices:table-cell" :class="dim">
      <div class="truncate text-[13px] tabular-nums text-text">{{ device.ip || '—' }}</div>
      <div class="mt-0.5 flex min-w-0 items-center gap-1">
        <span
          class="truncate font-mono text-[11px] text-muted"
          :title="device.vendor ? `${device.mac} · ${device.vendor}` : device.mac"
        >{{ device.mac }}</span>
        <span
          v-if="privateMac"
          data-testid="private-mac-badge"
          class="shrink-0 rounded bg-surface-3 px-1 text-[10px] font-medium text-muted"
          title="Private (randomized) Wi-Fi address — common on iPhone, Android and Windows. It may change if the device forgets this network."
        >Private</span>
      </div>
    </td>

    <!-- Vendor (very wide panels only) -->
    <td class="hidden px-3 py-2.5 @6xl/devices:table-cell" :class="dim">
      <span class="block truncate text-xs text-muted" :title="device.vendor || undefined">{{ device.vendor || '—' }}</span>
    </td>

    <!-- Status -->
    <td class="px-3 py-2.5">
      <DeviceStatus :device="device" variant="stacked" />
    </td>

    <!-- Latency -->
    <td class="px-3 py-2.5" :class="dim">
      <LatencyCell :device="device" table-badge />
    </td>

    <!-- Throughput -->
    <td class="px-3 py-2.5" :class="dim">
      <ThroughputCell :device="device" />
    </td>

    <!-- Actions (full opacity even when offline so they stay usable) -->
    <td class="py-2.5 pr-4 pl-2">
      <DeviceActions
        :device="device"
        @edit="emit('edit', device)"
        @forget="emit('forget', device)"
        @refingerprint="emit('refingerprint', device)"
      />
    </td>
  </tr>
</template>
