<script setup>
// Segmented control (DESIGN §3.8/§4.3). options: [{ value, label, icon?, testid? }].
import Icon from './Icon.vue';

defineProps({
  modelValue: { type: [String, Number, Boolean, null], default: null },
  options: { type: Array, required: true },
  size: { type: String, default: 'md' }, // sm | md
  label: { type: String, default: null }, // aria-label for the group
});
const emit = defineEmits(['update:modelValue']);
</script>

<template>
  <div
    role="radiogroup"
    :aria-label="label || undefined"
    class="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-surface-2 p-0.5"
  >
    <button
      v-for="opt in options"
      :key="String(opt.value)"
      type="button"
      role="radio"
      :aria-checked="modelValue === opt.value ? 'true' : 'false'"
      :data-testid="opt.testid || undefined"
      class="inline-flex items-center gap-1.5 rounded-[5px] font-medium transition-colors duration-[120ms]"
      :class="[
        size === 'sm' ? 'h-6 px-2 text-[11px]' : 'h-7 px-2.5 text-xs',
        modelValue === opt.value ? 'bg-surface-3 text-text shadow-sm' : 'text-muted hover:text-text',
      ]"
      @click="emit('update:modelValue', opt.value)"
    >
      <Icon v-if="opt.icon" :name="opt.icon" :size="14" />
      {{ opt.label }}
    </button>
  </div>
</template>
