<script setup>
// Shared KPI card shell for the metrics column (DESIGN §3.2): eyebrow row (icon + LABEL + right
// slot) → body → optional footer. Built on ui/Card so the chrome matches the rest of the app.
//
// Tone overlays (danger/warning) are drawn as an absolutely positioned layer instead of swapping
// Card's border/background classes, so we never fight Card's own utilities in the cascade.
import { computed, useId } from 'vue';
import Card from '../ui/Card.vue';
import Icon from '../ui/Icon.vue';
import { state } from '../../store.js';

defineOptions({ inheritAttrs: false });

const props = defineProps({
  label: { type: String, required: true },
  icon: { type: String, default: null },
  /** 'neutral' | 'danger' | 'warning' */
  tone: { type: String, default: 'neutral' },
  /** Breathing danger glow (internet down). */
  pulse: { type: Boolean, default: false },
  /** Override automatic "stale" detection (SSE reconnecting). */
  stale: { type: Boolean, default: null },
});

const labelId = useId();

const isStale = computed(() => (props.stale ?? state.connection === 'reconnecting') && state.loaded);

const overlayClass = computed(() => {
  if (props.tone === 'danger') {
    return ['ring-1 ring-inset ring-danger/50 bg-danger/8', props.pulse ? 'nm-pulse-danger' : ''];
  }
  if (props.tone === 'warning') return ['ring-1 ring-inset ring-warning/40 bg-warning/5'];
  return null;
});
</script>

<template>
  <Card
    v-bind="$attrs"
    :padded="false"
    class="relative isolate overflow-hidden"
    :aria-labelledby="labelId"
    role="region"
  >
    <div
      v-if="overlayClass"
      aria-hidden="true"
      class="pointer-events-none absolute inset-0 -z-10 rounded-[inherit] transition-colors duration-300"
      :class="overlayClass"
    />
    <div
      class="@container flex h-full flex-col gap-1.5 px-3.5 py-3 transition-opacity duration-200"
      :class="isStale ? 'opacity-60' : ''"
    >
      <div class="flex min-w-0 items-center gap-2">
        <Icon v-if="icon" :name="icon" :size="14" class="shrink-0 text-subtle" />
        <h2 :id="labelId" class="eyebrow min-w-0 truncate">{{ label }}</h2>
        <span
          v-if="isStale"
          class="rounded-sm bg-surface-3 px-1.5 text-[10px] font-medium leading-4 text-muted"
          title="Live updates paused — reconnecting to the NetMon server"
        >Stale</span>
        <div class="ml-auto flex shrink-0 items-center gap-2">
          <slot name="aside" />
        </div>
      </div>
      <slot />
      <div v-if="$slots.footer" class="mt-auto">
        <slot name="footer" />
      </div>
    </div>
  </Card>
</template>
