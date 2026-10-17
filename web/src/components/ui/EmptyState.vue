<script setup>
// Centered empty / zero-data state (DESIGN §6).
import Icon from './Icon.vue';

defineProps({
  icon: { type: String, default: 'info' },
  title: { type: String, required: true },
  message: { type: String, default: '' },
  tone: { type: String, default: 'neutral' }, // neutral | success
  compact: { type: Boolean, default: false },
});
</script>

<template>
  <div class="flex flex-col items-center justify-center text-center" :class="compact ? 'gap-2 px-4 py-6' : 'gap-3 px-6 py-10'">
    <div
      class="flex items-center justify-center rounded-lg"
      :class="[compact ? 'h-10 w-10' : 'h-12 w-12', tone === 'success' ? 'bg-success/12 text-success' : 'bg-surface-2 text-subtle']"
    >
      <Icon :name="icon" :size="compact ? 20 : 24" />
    </div>
    <div class="max-w-sm">
      <p class="text-[13px] font-medium text-text">{{ title }}</p>
      <p v-if="message" class="mt-1 text-xs text-muted">{{ message }}</p>
    </div>
    <div v-if="$slots.actions" class="mt-1 flex flex-wrap items-center justify-center gap-2">
      <slot name="actions" />
    </div>
  </div>
</template>
