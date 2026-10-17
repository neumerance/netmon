<script setup>
// Small spinning loader. Decorative unless `label` is given (then announced to screen readers).
import Icon from './Icon.vue';

defineProps({
  size: { type: [Number, String], default: 16 },
  label: { type: String, default: '' },
});
</script>

<template>
  <span class="inline-flex items-center justify-center" :role="label ? 'status' : undefined">
    <Icon name="loader" :size="size" :stroke-width="2" class="nm-spin" />
    <span v-if="label" class="sr-only">{{ label }}</span>
  </span>
</template>
