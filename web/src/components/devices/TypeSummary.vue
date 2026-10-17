<script setup>
// Network composition: one chip per device category present ("4 Computers", "2 Phones", …)
// plus a thin proportional bar. Clicking a chip toggles ui.typeFilter (single category).
import { computed } from 'vue';
import Icon from '../ui/Icon.vue';
import {
  devicesByCategory as byCategoryRef,
  setTypeFilter,
  typeCounts as typeCountsRef,
  ui
} from '../../store.js';
import { CATEGORIES, CATEGORY_ICONS, CATEGORY_LABELS, CATEGORY_PLURALS } from '../../lib/deviceTypes.js';
import { categoryTint } from './deviceUi.js';

const typeCounts = computed(() => typeCountsRef.value ?? {});
const byCategory = computed(() => byCategoryRef.value ?? {});

function capitalize(s) {
  const str = String(s ?? '');
  return str ? str[0].toUpperCase() + str.slice(1) : str;
}

const chips = computed(() => {
  // Table order from CATEGORIES, with "unknown" always last.
  const order = [...CATEGORIES.filter((c) => c !== 'unknown'), 'unknown'];
  // Include categories the server knows but the client table does not (defensive).
  for (const c of Object.keys(typeCounts.value)) if (!order.includes(c)) order.splice(order.length - 1, 0, c);
  return order
    .map((id) => {
      const count = Number(typeCounts.value[id] ?? 0);
      const list = byCategory.value[id] ?? [];
      const offline = list.filter((d) => !d.online).length;
      const name = count === 1 ? CATEGORY_LABELS[id] ?? id : capitalize(CATEGORY_PLURALS[id] ?? id);
      return { id, count, offline, name, icon: CATEGORY_ICONS[id] ?? 'question', tint: categoryTint(id) };
    })
    .filter((c) => c.count > 0);
});

const total = computed(() => chips.value.reduce((s, c) => s + c.count, 0));

function toggle(id) {
  setTypeFilter(ui.typeFilter === id ? 'all' : id);
}
</script>

<template>
  <div v-if="chips.length" data-testid="composition-strip" class="space-y-2">
    <div
      class="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none] @2xl/devices:flex-wrap [&::-webkit-scrollbar]:hidden"
      role="group"
      aria-label="Filter by device type"
    >
      <button
        v-for="c in chips"
        :key="c.id"
        type="button"
        :data-testid="`type-chip-${c.id}`"
        :data-count="c.count"
        :aria-pressed="ui.typeFilter === c.id ? 'true' : 'false'"
        :title="c.offline ? `${c.count} ${c.name.toLowerCase()} · ${c.offline} offline` : `${c.count} ${c.name.toLowerCase()}`"
        class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        :class="
        ui.typeFilter === c.id
          ? [c.tint.active, 'text-text']
          : 'border-border bg-surface text-muted hover:border-border-strong hover:text-text'
      "
        @click="toggle(c.id)"
      >
        <Icon :name="c.icon" :size="14" :class="c.tint.text" />
        <span class="font-semibold tabular-nums">{{ c.count }}</span>
        <span>{{ c.name }}</span>
        <span v-if="c.offline" class="text-[11px] text-subtle">· {{ c.offline }} off</span>
      </button>
      <button
        v-if="ui.typeFilter !== 'all'"
        type="button"
        data-testid="type-chip-clear"
        class="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-medium text-muted hover:text-text"
        @click="setTypeFilter('all')"
      >
        <Icon name="x" :size="12" />
        Clear
      </button>
    </div>

    <!-- Proportional composition bar (decorative; the chips carry the numbers) -->
    <div class="hidden h-1 w-full gap-0.5 overflow-hidden rounded-full @3xl/devices:flex" aria-hidden="true">
      <span
        v-for="c in chips"
        :key="c.id"
        class="h-full transition-[flex-grow] duration-500 first:rounded-l-full last:rounded-r-full"
        :class="[c.tint.dot, ui.typeFilter !== 'all' && ui.typeFilter !== c.id ? 'opacity-25' : 'opacity-70']"
        :style="{ flexGrow: c.count, flexBasis: 0 }"
        :title="`${c.name}: ${c.count} of ${total}`"
      />
    </div>
  </div>
</template>
