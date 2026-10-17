<script setup>
// Recent activity for one device (TOPOLOGY.md §5.2): the global event log filtered by MAC,
// newest first, capped at `limit`.
import { computed } from 'vue';
import Icon from '../ui/Icon.vue';
import { formatDateTime, formatRelative, formatTime } from '../../lib/format.js';
import { useNow } from '../../composables/useNow.js';

const props = defineProps({
  events: { type: Array, default: () => [] },
  mac: { type: String, default: null },
  limit: { type: Number, default: 8 }
});

const now = useNow(1000);

// Static class strings (Tailwind must see complete names).
const STYLES = {
  device_new: { icon: 'plus-circle', tile: 'bg-info/12 text-info-fg' },
  device_online: { icon: 'arrow-up-circle', tile: 'bg-success/12 text-success-fg' },
  device_offline: { icon: 'circle-off', tile: 'bg-surface-3 text-muted' },
  device_saved: { icon: 'bookmark', tile: 'bg-surface-3 text-muted' },
  device_forgotten: { icon: 'trash', tile: 'bg-surface-3 text-muted' }
};
const FALLBACK = { icon: 'info', tile: 'bg-surface-3 text-muted' };

const ts = (e) => {
  const t = Date.parse(e?.at ?? '');
  return Number.isFinite(t) ? t : 0;
};

const matching = computed(() => {
  const mac = props.mac ? String(props.mac).toLowerCase() : null;
  if (!mac) return [];
  const list = (Array.isArray(props.events) ? props.events : []).filter(
    (e) => e && typeof e.mac === 'string' && e.mac.toLowerCase() === mac
  );
  // state.events is newest first already; sort defensively (stable, so ties keep that order).
  return list.map((e, i) => ({ e, i })).sort((a, b) => ts(b.e) - ts(a.e) || a.i - b.i).map((x) => x.e);
});

const items = computed(() => matching.value.slice(0, Math.max(0, props.limit)));
const more = computed(() => Math.max(0, matching.value.length - items.value.length));

const styleOf = (type) => STYLES[type] ?? FALLBACK;
const timeTitle = (at) => (at ? `${formatDateTime(at)} · ${formatRelative(at, now.value)}` : undefined);
</script>

<template>
  <div>
    <ul v-if="items.length" data-testid="detail-events" class="space-y-2">
      <li
        v-for="(e, i) in items"
        :key="e.id ?? `${e.type}-${e.at}-${i}`"
        data-testid="detail-event-item"
        :data-type="e.type"
        class="flex min-w-0 items-center gap-2.5"
      >
        <span class="grid size-6 shrink-0 place-items-center rounded-full" :class="styleOf(e.type).tile">
          <Icon :name="styleOf(e.type).icon" :size="14" />
        </span>
        <span class="min-w-0 flex-1 truncate text-[13px] text-text" :title="e.message || e.type">{{ e.message || e.type }}</span>
        <time
          class="shrink-0 text-xs tabular-nums text-muted"
          :datetime="e.at || undefined"
          :title="timeTitle(e.at)"
        >{{ formatTime(e.at) }}</time>
      </li>
    </ul>
    <p v-else data-testid="detail-events" class="text-xs text-muted">No activity for this device yet.</p>
    <p v-if="more" class="mt-2 text-xs text-subtle">+{{ more }} earlier {{ more === 1 ? 'event' : 'events' }}</p>
  </div>
</template>
