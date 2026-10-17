<script setup>
// Devices list: a real <table> on wide panels, stacked cards on narrow ones (same testids).
// Only ONE of the two layouts is rendered at a time so every data-testid stays unique.
import { computed } from 'vue';
import Icon from '../ui/Icon.vue';
import DeviceRow from './DeviceRow.vue';
import DeviceCard from './DeviceCard.vue';

const props = defineProps({
  devices: { type: Array, required: true },
  /** 'table' | 'cards'. DevicesPanel decides from its measured width. */
  layout: { type: String, default: 'table' },
  sortKey: { type: String, default: 'default' },
  sortDir: { type: String, default: 'asc' },
  caption: { type: String, default: 'Devices on this network' }
});
const emit = defineEmits(['edit', 'forget', 'refingerprint', 'sort', 'open']);

const columns = computed(() => [
  { id: 'device', label: 'Device', sort: 'name', th: 'pl-4 pr-3 w-auto' },
  { id: 'address', label: 'Address', sort: 'ip', th: 'px-3 w-[144px] hidden @5xl/devices:table-cell' },
  { id: 'vendor', label: 'Vendor', sort: null, th: 'px-3 w-[160px] hidden @6xl/devices:table-cell' },
  { id: 'status', label: 'Status', sort: 'lastSeen', th: 'px-3 w-[128px]' },
  { id: 'latency', label: 'Latency', sort: 'latency', th: 'px-3 w-[88px] @3xl/devices:w-[136px] @4xl/devices:w-[184px]' },
  { id: 'throughput', label: 'Throughput', sort: null, th: 'px-3 w-[116px]', title: 'Live traffic is measured for this computer only; other devices require router integration' },
  { id: 'actions', label: 'Actions', sort: null, th: 'pl-2 pr-4 w-[120px] text-right', srOnly: true }
]);

function ariaSort(col) {
  if (!col.sort || props.sortKey !== col.sort) return undefined;
  return props.sortDir === 'desc' ? 'descending' : 'ascending';
}
</script>

<template>
  <div v-if="layout === 'table'" data-testid="devices-table">
    <table class="w-full table-fixed border-collapse text-left">
      <caption class="sr-only">{{ caption }}</caption>
      <thead>
        <tr class="border-y border-border bg-surface-2">
          <th
            v-for="col in columns"
            :key="col.id"
            scope="col"
            class="h-9 text-[11px] font-medium tracking-[0.06em] text-muted uppercase"
            :class="col.th"
            :aria-sort="ariaSort(col)"
            :title="col.title"
          >
            <span v-if="col.srOnly" class="sr-only">{{ col.label }}</span>
            <button
              v-else-if="col.sort"
              type="button"
              :data-testid="`sort-${col.sort}`"
              class="group/sort -mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 uppercase hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
              :class="sortKey === col.sort ? 'text-text' : ''"
              @click="emit('sort', col.sort)"
            >
              {{ col.label }}
              <Icon
                name="chevron-down"
                :size="12"
                class="transition-transform"
                :class="[
                  sortKey === col.sort ? 'opacity-100' : 'opacity-0 group-hover/sort:opacity-50',
                  sortKey === col.sort && sortDir === 'desc' ? '' : sortKey === col.sort ? 'rotate-180' : ''
                ]"
              />
            </button>
            <span v-else>{{ col.label }}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <DeviceRow
          v-for="d in devices"
          :key="d.mac"
          :device="d"
          @edit="emit('edit', $event)"
          @forget="emit('forget', $event)"
          @refingerprint="emit('refingerprint', $event)"
          @open="emit('open', $event)"
        />
      </tbody>
    </table>
  </div>

  <ul v-else data-testid="devices-list" role="list" class="flex flex-col gap-2 p-3">
    <DeviceCard
      v-for="d in devices"
      :key="d.mac"
      :device="d"
      @edit="emit('edit', $event)"
      @forget="emit('forget', $event)"
      @refingerprint="emit('refingerprint', $event)"
          @open="emit('open', $event)"
    />
  </ul>
</template>
