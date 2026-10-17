<script setup>
// Inline SVG icon (DESIGN §7). Decorative by default (aria-hidden); icon-only buttons put the
// aria-label on the button, never on the svg. Unknown names fall back to 'help-circle'.
import { computed } from 'vue';
import { iconMarkup, resolveIconName } from './icons.js';

const props = defineProps({
  name: { type: String, default: 'help-circle' },
  size: { type: [Number, String], default: 20 },
  strokeWidth: { type: [Number, String], default: 1.75 },
});

const warned = new Set();

const markup = computed(() => {
  const m = iconMarkup(props.name);
  if (m) return m;
  if (import.meta.env.DEV && props.name && !warned.has(props.name)) {
    warned.add(props.name);
    console.warn(`[Icon] unknown icon "${props.name}", using help-circle`);
  }
  return iconMarkup('help-circle');
});

const resolvedName = computed(() => resolveIconName(props.name) || 'help-circle');
</script>

<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    :width="size"
    :height="size"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
    class="nm-icon shrink-0"
    :data-icon="resolvedName"
    v-html="markup"
  />
</template>
