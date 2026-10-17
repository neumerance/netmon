<script setup>
// Switch (PLAN §8.6): <button role="switch" aria-checked>. Attrs (data-testid) land on the button.
defineProps({
  modelValue: { type: Boolean, default: false },
  label: { type: String, default: null },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue']);
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="modelValue ? 'true' : 'false'"
    :aria-label="label || undefined"
    :disabled="disabled"
    class="group inline-flex shrink-0 items-center gap-2.5 rounded-full text-[13px] text-text disabled:cursor-not-allowed disabled:opacity-50"
    @click="emit('update:modelValue', !modelValue)"
  >
    <span
      class="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-[120ms]"
      :class="modelValue ? 'border-accent bg-accent' : 'border-border-strong bg-surface-3'"
      aria-hidden="true"
    >
      <span
        class="absolute left-0.5 h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform duration-[120ms]"
        :class="modelValue ? 'translate-x-4' : 'translate-x-0'"
      />
    </span>
    <span v-if="label || $slots.default" class="select-none"><slot>{{ label }}</slot></span>
  </button>
</template>
