<script setup>
// Devices toolbar: status tabs (All / Online / Offline / Saved with counts), type filter
// <select>, sort <select>, and search. Bound to the global `ui` store (filter, typeFilter,
// search) plus the local sort state. `/` focuses search, Esc clears it.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from '../ui/Icon.vue';
import {
  counts as countsRef,
  filterCounts as filterCountsRef,
  typeCounts as typeCountsRef,
  setFilter,
  setSearch,
  setTypeFilter,
  ui
} from '../../store.js';
import { CATEGORIES, CATEGORY_LABELS } from '../../lib/deviceTypes.js';
import { SORT_KEYS } from './deviceUi.js';
import { devicesUi, setSort } from './devicesState.js';

const searchEl = ref(null);

const counts = computed(() => countsRef.value ?? { total: 0, online: 0, offline: 0, saved: 0, savedOffline: 0 });
// Tab counts reflect the type-filtered + searched set (DESIGN.md §3.4) so they match what is shown.
const tabCounts = computed(() => {
  const f = filterCountsRef?.value;
  if (f) return { all: f.all, online: f.online, offline: f.offline, saved: f.saved };
  const c = counts.value;
  return { all: c.total, online: c.online, offline: c.offline, saved: c.saved };
});
const typeCounts = computed(() => typeCountsRef.value ?? {});

const tabs = computed(() => [
  { id: 'all', label: 'All', count: tabCounts.value.all },
  { id: 'online', label: 'Online', count: tabCounts.value.online },
  { id: 'offline', label: 'Offline', count: tabCounts.value.offline },
  { id: 'saved', label: 'Saved', count: tabCounts.value.saved }
]);

/** Every category is selectable (values: 'all' + CATEGORIES ids); present ones show a count. */
const typeOptions = computed(() =>
  CATEGORIES.map((id) => {
    const n = typeCounts.value[id] ?? 0;
    return { id, label: n ? `${CATEGORY_LABELS[id] ?? id} (${n})` : CATEGORY_LABELS[id] ?? id };
  })
);

const sortValue = computed({
  get: () => `${devicesUi.sortKey}:${devicesUi.sortDir}`,
  set: (v) => {
    const [key, dir] = String(v).split(':');
    setSort(key, dir);
  }
});
const sortOptions = computed(() =>
  SORT_KEYS.flatMap((k) =>
    k.id === 'default'
      ? [{ value: 'default:asc', label: k.label }]
      : [
          { value: `${k.id}:asc`, label: `${k.label} ${k.id === 'lastSeen' ? '(recent first)' : k.id === 'latency' ? '(low → high)' : '(A → Z)'}` },
          { value: `${k.id}:desc`, label: `${k.label} ${k.id === 'lastSeen' ? '(oldest first)' : k.id === 'latency' ? '(high → low)' : '(Z → A)'}` }
        ]
  )
);

function onSearchInput(e) {
  setSearch(e.target.value);
}
function onSearchKeydown(e) {
  if (e.key === 'Escape' && ui.search) {
    e.stopPropagation();
    setSearch('');
  }
}
function clearSearch() {
  setSearch('');
  searchEl.value?.focus();
}

function isTypingTarget(el) {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}
function onGlobalKeydown(e) {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (isTypingTarget(document.activeElement)) return;
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return; // a modal is open
  e.preventDefault();
  searchEl.value?.focus();
  searchEl.value?.select();
}
onMounted(() => window.addEventListener('keydown', onGlobalKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKeydown));

const selectClass =
  'h-8 appearance-none rounded-md border border-border bg-surface pr-7 pl-2.5 text-xs font-medium text-text shadow-xs focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent/40';
</script>

<template>
  <div class="flex flex-col gap-2.5 @5xl/devices:flex-row @5xl/devices:items-center @5xl/devices:justify-between">
    <!-- Status tabs -->
    <div
      class="-mx-1 flex items-center gap-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      role="group"
      aria-label="Filter devices by status"
    >
      <button
        v-for="t in tabs"
        :key="t.id"
        type="button"
        :data-testid="`filter-${t.id}`"
        :aria-pressed="ui.filter === t.id ? 'true' : 'false'"
        class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        :class="
        ui.filter === t.id
          ? 'bg-surface-3 text-text shadow-sm ring-1 ring-inset ring-border-strong'
          : 'text-muted hover:bg-surface-3 hover:text-text'
      "
        @click="setFilter(t.id)"
      >
        {{ t.label }}
        <span
          class="rounded px-1 text-[11px] tabular-nums"
          :class="
        ui.filter === t.id
          ? 'bg-accent/15 text-accent-fg'
          : 'bg-surface-3 text-muted'
      "
        >{{ t.count }}</span>
      </button>
    </div>

    <div class="grid min-w-0 grid-cols-2 items-center gap-2 @xl/devices:flex">
      <!-- Type filter -->
      <label class="relative min-w-0 @xl/devices:shrink-0">
        <span class="sr-only">Filter by device type</span>
        <select
          data-testid="type-filter"
          :value="ui.typeFilter"
          :class="selectClass"
          class="w-full @xl/devices:w-auto @xl/devices:max-w-[11rem]"
          @change="setTypeFilter($event.target.value)"
        >
          <option value="all">All types</option>
          <option v-for="o in typeOptions" :key="o.id" :value="o.id">{{ o.label }}</option>
        </select>
        <Icon
          name="chevron-down"
          :size="14"
          class="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-subtle"
        />
      </label>

      <!-- Sort -->
      <label class="relative min-w-0 @xl/devices:shrink-0">
        <span class="sr-only">Sort devices</span>
        <select
          v-model="sortValue"
          data-testid="device-sort"
          :class="selectClass"
          class="w-full @xl/devices:w-auto @xl/devices:max-w-[9.5rem]"
          title="Sort devices"
        >
          <option v-for="o in sortOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <Icon
          name="chevron-down"
          :size="14"
          class="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-subtle"
        />
      </label>

      <!-- Search -->
      <label class="relative order-first col-span-2 min-w-0 @xl/devices:order-none @xl/devices:flex-1 @5xl/devices:w-60 @5xl/devices:flex-none">
        <span class="sr-only">Search devices</span>
        <Icon
          name="search"
          :size="14"
          class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-subtle"
        />
        <input
          ref="searchEl"
          data-testid="search-input"
          type="search"
          autocomplete="off"
          spellcheck="false"
          placeholder="Search name, IP, MAC, vendor…"
          :value="ui.search"
          class="h-8 w-full rounded-md border border-border bg-surface pr-8 pl-8 text-xs text-text shadow-xs placeholder:text-subtle focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent/40 [&::-webkit-search-cancel-button]:hidden"
          @input="onSearchInput"
          @keydown="onSearchKeydown"
        />
        <button
          v-if="ui.search"
          type="button"
          class="absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded text-subtle hover:bg-surface-3 hover:text-text"
          aria-label="Clear search"
          @click="clearSearch"
        >
          <Icon name="x" :size="12" />
        </button>
        <kbd
          v-else
          class="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded border border-border px-1 font-sans text-[10px] text-subtle sm:block"
        >/</kbd>
      </label>
    </div>
  </div>
</template>
