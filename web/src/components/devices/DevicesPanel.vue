<script setup>
// Devices panel (PLAN.md §8.6, TOPOLOGY.md §8/§10.6): Card "Devices" with counts, composition chips
// (type filter), toolbar (status tabs, type select, sort, search) and either the topology map (default)
// or the device table / cards. Filters drive both views (the map highlights matches). Owns the edit
// modal + forget dialog (list) and the device detail panel (both views). Takes no props, emits
// nothing; reads/writes store.js.
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Card from '../ui/Card.vue';
import Icon from '../ui/Icon.vue';
import EmptyState from '../ui/EmptyState.vue';
import Segmented from '../ui/Segmented.vue';
import DeviceDetailPanel from '../detail/DeviceDetailPanel.vue';
import {
  counts as countsRef,
  devicesSorted,
  filteredDevices as filteredRef,
  mapHighlight,
  resetLayout,
  selectDevice,
  selectedDevice,
  setDeviceParent,
  setDevicesView,
  setNodePosition,
  setFilter,
  setSearch,
  setTypeFilter,
  state,
  typeCounts as typeCountsRef,
  ui
} from '../../store.js';
import { CATEGORY_LABELS, deviceDisplayName, deviceTypeLabel, typeSummaryText } from '../../lib/deviceTypes.js';
import TypeSummary from './TypeSummary.vue';
import DeviceToolbar from './DeviceToolbar.vue';
import DeviceTable from './DeviceTable.vue';
import DeviceEditModal from './DeviceEditModal.vue';
import ForgetDeviceDialog from './ForgetDeviceDialog.vue';
import { sortDevices } from './deviceUi.js';
import { devicesUi, redetectDevice, setSort, trackDevices } from './devicesState.js';

// Vue Flow + the map live in their own chunk so the list view / first paint don't pay for them.
const TopologyMap = defineAsyncComponent(() => import('../topology/TopologyMap.vue'));

/* ---------------------------------------------------------------- view (map | list) */

const VIEW_OPTIONS = [
  { value: 'map', label: 'Map', icon: 'network', testid: 'view-toggle-map' },
  { value: 'list', label: 'List', icon: 'list', testid: 'view-toggle-list' }
];
const isMap = computed(() => ui.devicesView === 'map');

/* ---------------------------------------------------------------- layout (table vs cards) */

const TABLE_MIN_WIDTH = 760; // px of panel width; below this (e.g. 768px tablets) the stacked cards show full type labels
const root = ref(null);
const width = ref(typeof window !== 'undefined' ? window.innerWidth : 1280);
let ro = null;

onMounted(() => {
  if (root.value) width.value = root.value.clientWidth || width.value;
  if (typeof ResizeObserver !== 'undefined' && root.value) {
    ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect?.width ?? 0);
      if (w > 0) width.value = w;
    });
    ro.observe(root.value);
  }
});
onBeforeUnmount(() => ro?.disconnect());

const layout = computed(() => (width.value >= TABLE_MIN_WIDTH ? 'table' : 'cards'));

/* ---------------------------------------------------------------- data */

const counts = computed(() => countsRef.value ?? { total: 0, online: 0, offline: 0, saved: 0, savedOffline: 0 });
const filtered = computed(() => filteredRef.value ?? []);

const sorted = computed(() =>
  sortDevices(filtered.value, devicesUi.sortKey, devicesUi.sortDir, {
    nameOf: deviceDisplayName,
    typeOf: deviceTypeLabel
  })
);

// Keep row order stable while the pointer is over the list (so "Save" doesn't jump away from
// the cursor when latency-sorted rows reshuffle). New devices are appended; removed ones drop.
const hovering = ref(false);
const frozenOrder = ref(null);
let unfreezeTimer = null;
function onPointerEnter() {
  hovering.value = true;
  frozenOrder.value = sorted.value.map((d) => d.mac);
  clearTimeout(unfreezeTimer);
  unfreezeTimer = setTimeout(() => (frozenOrder.value = null), 5000); // never freeze for long
}
function onPointerLeave() {
  hovering.value = false;
  frozenOrder.value = null;
  clearTimeout(unfreezeTimer);
}
onBeforeUnmount(() => clearTimeout(unfreezeTimer));

const displayed = computed(() => {
  const list = sorted.value;
  const order = frozenOrder.value;
  if (!order || devicesUi.sortKey === 'default') return list;
  const rank = new Map(order.map((mac, i) => [mac, i]));
  return list
    .map((d, i) => ({ d, r: rank.has(d.mac) ? rank.get(d.mac) : order.length + i }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.d);
});

// Sort/filter changes made by the user always apply immediately.
watch(
  () => [devicesUi.sortKey, devicesUi.sortDir, ui.filter, ui.typeFilter, ui.search],
  () => {
    if (frozenOrder.value) frozenOrder.value = sorted.value.map((d) => d.mac);
  }
);

// Track arrivals for the "New" badge / highlight.
watch(
  () => state.devices,
  (list) => trackDevices(list),
  { immediate: true, deep: false }
);

const subtitle = computed(() => {
  const c = counts.value;
  if (!state.loaded) return 'Loading…';
  const parts = [`${c.online} online`];
  if (c.offline) parts.push(`${c.offline} offline`);
  if (c.saved) parts.push(`${c.saved} saved`);
  const cidr = state.network?.cidr;
  if (cidr) parts.push(cidr);
  return parts.join(' · ');
});

const summaryText = computed(() => typeSummaryText(typeCountsRef.value ?? {}, { max: 4 }));
const summaryTitle = computed(() => typeSummaryText(typeCountsRef.value ?? {}, { max: 99 }));

const scanning = computed(() => Boolean(state.network?.scanning) || !state.network?.firstScanDone);
const filtersActive = computed(() => ui.filter !== 'all' || ui.typeFilter !== 'all' || Boolean(ui.search?.trim()));

const emptyState = computed(() => {
  if (!state.loaded) return null;
  if (state.devices.length === 0) {
    if (!state.network) {
      return {
        icon: 'wifi-off',
        title: 'No network connection',
        message: 'NetMon could not find an active network interface on this computer.'
      };
    }
    if (scanning.value) {
      return {
        icon: 'radar',
        title: `Scanning ${state.network.cidr ?? 'your network'}…`,
        message: 'Devices appear as they answer. This takes about 10 seconds.',
        spinning: true
      };
    }
    return {
      icon: 'network',
      title: 'No devices found',
      message: 'Make sure this computer is connected to your local network.'
    };
  }
  if (displayed.value.length > 0) return null;
  const q = ui.search?.trim();
  if (q) return { icon: 'search', title: `No devices match “${q}”`, message: 'Try a name, IP or MAC address.', clear: true };
  if (ui.filter === 'saved' && ui.typeFilter === 'all') {
    return {
      icon: 'star',
      title: 'No saved devices yet',
      message: 'Save a device to name it and get notified when it disconnects.'
    };
  }
  if (ui.filter === 'offline' && ui.typeFilter === 'all') {
    return { icon: 'check-circle', title: 'Everything is online', message: 'No known device is offline right now.', success: true };
  }
  const type = ui.typeFilter !== 'all' ? CATEGORY_LABELS[ui.typeFilter] ?? ui.typeFilter : null;
  return {
    icon: 'filter',
    title: type ? `No ${ui.filter === 'all' ? '' : `${ui.filter} `}devices of type “${type}”` : 'No devices match these filters',
    message: 'Change or clear the filters to see more devices.',
    clear: true
  };
});

function clearFilters() {
  setFilter('all');
  setTypeFilter('all');
  setSearch('');
}

/* ---------------------------------------------------------------- modals */

const editMac = ref(null);
const editSnapshot = ref(null); // last known copy, in case the device leaves the live list
const editFocusType = ref(false);
const forgetMac = ref(null);
const forgetSnapshot = ref(null);

function liveDevice(mac, snapshot) {
  if (!mac) return null;
  return state.devices.find((d) => d.mac === mac) ?? snapshot;
}
const editDevice = computed(() => liveDevice(editMac.value, editSnapshot.value));
const forgetDeviceObj = computed(() => liveDevice(forgetMac.value, forgetSnapshot.value));

function openEdit(device, { focusType = false } = {}) {
  if (!device) return;
  editSnapshot.value = { ...device };
  editFocusType.value = focusType;
  editMac.value = device.mac;
}
function closeEdit() {
  editMac.value = null;
}
function openForget(device) {
  if (!device) return;
  forgetSnapshot.value = { ...device };
  forgetMac.value = device.mac;
}
function closeForget() {
  forgetMac.value = null;
}
function forgetFromModal(device) {
  closeEdit();
  openForget(device);
}
function onRefingerprint(device) {
  redetectDevice(device);
}

/* ---------------------------------------------------------------- map + detail panel */

const map = ref(null);
const SIDE_PANEL_MIN = 720; // px of panel width; below this the detail panel is a full-screen sheet
const panelMode = computed(() => (width.value >= SIDE_PANEL_MIN ? 'side' : 'sheet'));

// Keep a snapshot of the selected device so the panel can say "no longer on the network" if it leaves.
const lastSelectedSnapshot = ref(null);
watch(selectedDevice, (d) => {
  if (d) lastSelectedSnapshot.value = d;
});
watch(
  () => ui.selectedMac,
  (m) => {
    if (!m || m !== lastSelectedSnapshot.value?.mac) lastSelectedSnapshot.value = selectedDevice.value ?? null;
    if (m && isMap.value) nextTick(() => map.value?.centerOn?.(m, panelMode.value === 'sheet' ? { panelWidth: 0 } : undefined));
  }
);
const detailDevice = computed(
  () => selectedDevice.value ?? (lastSelectedSnapshot.value?.mac === ui.selectedMac ? lastSelectedSnapshot.value : null)
);

function openDetail(device) {
  if (device?.mac) selectDevice(device.mac);
}
function closeDetail() {
  const m = ui.selectedMac;
  selectDevice(null);
  if (isMap.value && m) nextTick(() => map.value?.focusNode?.(m));
}
function onReparent(mac, parentMac) {
  setDeviceParent(mac, parentMac, { clearPosition: true }).catch(() => {});
}
function onMove(mac, pos) {
  setNodePosition(mac, pos).catch(() => {});
}
function onResetLayout() {
  resetLayout()
    .then(() => nextTick(() => map.value?.fitView?.()))
    .catch(() => {});
}
function onViewChange(v) {
  setDevicesView(v);
}

// Map view: how many devices the current filters match (map dims the rest).
const highlightCount = computed(() => (mapHighlight.value instanceof Set ? mapHighlight.value.size : null));
</script>

<template>
  <Card title="Devices" :subtitle="subtitle" :padded="false" data-testid="devices-panel">
    <template #actions>
      <div class="flex items-center gap-3">
        <Segmented
          :model-value="ui.devicesView"
          :options="VIEW_OPTIONS"
          size="sm"
          label="Devices view"
          class="order-last"
          @update:model-value="onViewChange"
        />
        <span v-if="summaryText" class="hidden max-w-[26rem] truncate text-xs text-muted xl:inline" :title="summaryTitle" data-testid="type-summary-text">{{ summaryText }}</span>
        <span
          v-if="state.network?.scanning"
          class="inline-flex items-center gap-1.5 text-xs text-subtle"
          title="Scanning the local network"
        >
          <Icon name="radar" :size="14" class="nm-spin" />
          <span class="hidden sm:inline">Scanning</span>
        </span>
      </div>
    </template>

    <div ref="root" class="@container/devices">
      <div class="space-y-3 px-4 pt-1 pb-3">
        <TypeSummary />
        <DeviceToolbar />
      </div>

      <!-- Map view (TOPOLOGY.md §8.2) -->
      <template v-if="isMap">
        <div
          v-if="highlightCount !== null"
          class="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border bg-surface-2/50 px-4 py-1.5 text-xs text-muted"
          data-testid="map-filter-bar"
          role="status"
        >
          <Icon name="filter" :size="13" class="text-subtle" />
          <span v-if="highlightCount > 0">Highlighting {{ highlightCount }} of {{ counts.total }} devices</span>
          <span v-else class="text-warning-fg">No devices match these filters</span>
          <button
            type="button"
            class="ml-auto inline-flex h-6 items-center gap-1 rounded-md px-2 font-medium text-text ring-1 ring-border-strong ring-inset hover:bg-surface-3"
            data-testid="clear-filters-btn"
            @click="clearFilters"
          >
            <Icon name="x" :size="12" />
            Clear filters
          </button>
        </div>
        <div
          class="relative h-[clamp(520px,68vh,640px)] overflow-hidden border-t border-border max-md:h-[62svh] max-md:min-h-[420px]"
          data-testid="map-container"
        >
          <TopologyMap
            ref="map"
            :devices="devicesSorted"
            :isp="state.isp"
            :internet="state.internet"
            :speed="state.speed"
            :network="state.network"
            :overrides="state.topology.overrides"
            :selected-mac="ui.selectedMac"
            :highlight="mapHighlight"
            :loaded="state.loaded"
            @select="selectDevice"
            @move="onMove"
            @reparent="onReparent"
            @reset-layout="onResetLayout"
          />
          <DeviceDetailPanel
            :open="!!ui.selectedMac"
            :device="detailDevice"
            :mode="panelMode"
            :devices="state.devices"
            :overrides="state.topology.overrides"
            :events="state.events"
            @close="closeDetail"
            @reparent="onReparent"
            @select="selectDevice"
          />
        </div>
      </template>

      <!-- Initial skeleton -->
      <div v-else-if="!state.loaded" class="divide-y divide-border border-t border-border" aria-hidden="true">
        <div v-for="i in 6" :key="i" class="flex items-center gap-3 px-4 py-3">
          <div class="nm-skeleton size-8 shrink-0 rounded-lg" />
          <div class="flex-1 space-y-1.5">
            <div class="nm-skeleton h-3 w-40" />
            <div class="nm-skeleton h-2.5 w-28" />
          </div>
          <div class="nm-skeleton hidden h-3 w-16 sm:block" />
          <div class="nm-skeleton hidden h-3 w-20 md:block" />
        </div>
      </div>

      <!-- Empty / scanning / no-results -->
      <div v-else-if="emptyState" class="border-t border-border" data-testid="devices-empty">
        <EmptyState
          :icon="emptyState.icon"
          :title="emptyState.title"
          :message="emptyState.message"
          :tone="emptyState.success ? 'success' : 'neutral'"
        >
          <template v-if="emptyState.clear" #actions>
            <button
              type="button"
              class="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium text-text ring-1 ring-border-strong ring-inset hover:bg-surface-3"
              data-testid="clear-filters-btn"
              @click="clearFilters"
            >
              <Icon name="x" :size="14" />
              Clear filters
            </button>
          </template>
        </EmptyState>
      </div>

      <!-- List -->
      <div v-else @pointerenter="onPointerEnter" @pointerleave="onPointerLeave">
        <DeviceTable
          :devices="displayed"
          @open="openDetail($event)"
          :layout="layout"
          :sort-key="devicesUi.sortKey"
          :sort-dir="devicesUi.sortDir"
          :caption="state.network?.cidr ? `Devices on ${state.network.cidr}` : 'Devices on this network'"
          @sort="setSort($event)"
          @edit="openEdit($event)"
          @forget="openForget($event)"
          @refingerprint="onRefingerprint($event)"
        />
        <p
          v-if="filtersActive && displayed.length < counts.total"
          class="border-t border-border px-4 py-2 text-xs text-subtle"
        >
          Showing {{ displayed.length }} of {{ counts.total }} devices ·
          <button type="button" class="font-medium text-accent-fg hover:underline" @click="clearFilters">Show all</button>
        </p>
      </div>
      <template v-if="!isMap">
        <!-- Detail panel in list view: a non-modal side panel pinned to the viewport's right edge
             (or the full-screen sheet on narrow screens). -->
        <div
          v-if="panelMode === 'side'"
          class="pointer-events-none fixed inset-y-0 right-0 z-40 w-[428px] max-w-full *:pointer-events-auto"
        >
          <DeviceDetailPanel
            :open="!!ui.selectedMac"
            :device="detailDevice"
            mode="side"
            :devices="state.devices"
            :overrides="state.topology.overrides"
            :events="state.events"
            @close="closeDetail"
            @reparent="onReparent"
            @select="selectDevice"
          />
        </div>
        <DeviceDetailPanel
          v-else
          :open="!!ui.selectedMac"
          :device="detailDevice"
          mode="sheet"
          :devices="state.devices"
          :overrides="state.topology.overrides"
          :events="state.events"
          @close="closeDetail"
          @reparent="onReparent"
          @select="selectDevice"
        />
      </template>
    </div>

    <!-- Overlays (teleported by ui/Modal); kept inside the Card so the panel has a single root
         element and attributes from App (e.g. grid classes) fall through to the Card. -->
    <DeviceEditModal
      :open="!!editMac"
      :device="editDevice"
      :focus-type="editFocusType"
      @close="closeEdit"
      @forget="forgetFromModal"
    />
    <ForgetDeviceDialog :open="!!forgetMac" :device="forgetDeviceObj" @close="closeForget" />

    <template #footer>
      <p class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
        <span v-if="isMap" class="inline-flex items-center gap-1.5">
          <Icon name="network" :size="13" />
          Lines show the path from the internet to each device; colours reflect ping quality from this computer.
        </span>
        <span v-else class="inline-flex items-center gap-1.5">
          <Icon name="activity" :size="13" />
          Latency, jitter and loss are measured by pinging each device from this computer.
        </span>
        <span class="inline-flex items-center gap-1.5">
          <Icon name="info" :size="13" />
          Per-device throughput requires router integration; live traffic is shown for this computer.
        </span>
      </p>
    </template>
  </Card>
</template>
