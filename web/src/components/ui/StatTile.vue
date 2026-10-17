<script setup>
// Compact metric tile: LABEL / value + unit / hint (PLAN §8.6).
import { computed } from 'vue';
import Icon from './Icon.vue';

const props = defineProps({
  label: { type: String, required: true },
  value: { type: [String, Number], default: '—' },
  unit: { type: String, default: null },
  icon: { type: String, default: null },
  tone: { type: String, default: 'neutral' }, // neutral | success | warning | danger | info | brand
  hint: { type: String, default: null },
  size: { type: String, default: 'md' }, // sm | md | lg
});

const VALUE_TONE = {
  neutral: 'text-text',
  success: 'text-success-fg',
  warning: 'text-warning-fg',
  danger: 'text-danger-fg',
  info: 'text-info-fg',
  brand: 'text-accent-fg',
};
const valueClass = computed(() => [
  VALUE_TONE[props.tone] || VALUE_TONE.neutral,
  props.size === 'lg' ? 'text-[28px] leading-8 max-sm:text-2xl max-sm:leading-7' : props.size === 'sm' ? 'text-base leading-6' : 'text-xl leading-7',
]);
</script>

<template>
  <div class="flex min-w-0 flex-col gap-1 rounded-md bg-surface-2 p-3">
    <div class="flex min-w-0 items-center gap-1.5">
      <Icon v-if="icon" :name="icon" :size="14" class="text-subtle" />
      <span class="eyebrow truncate">{{ label }}</span>
    </div>
    <div class="flex min-w-0 items-baseline gap-1">
      <span class="truncate font-semibold tracking-tight tabular-nums" :class="valueClass" data-testid="stat-value">{{ value }}</span>
      <span v-if="unit" class="text-[13px] font-medium text-muted">{{ unit }}</span>
    </div>
    <p v-if="hint" class="truncate text-xs text-muted">{{ hint }}</p>
    <slot name="extra" />
  </div>
</template>
