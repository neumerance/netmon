<script setup>
// Square icon-only button (DESIGN §3.1). `label` becomes aria-label (required for a11y) and title.
import { computed } from 'vue';
import Icon from './Icon.vue';
import Spinner from './Spinner.vue';

const props = defineProps({
  icon: { type: String, required: true },
  label: { type: String, required: true },
  size: { type: String, default: 'md' }, // sm (28) | md (32) | lg (40)
  active: { type: Boolean, default: false },
  tone: { type: String, default: 'neutral' }, // neutral | danger | accent
  loading: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  showTitle: { type: Boolean, default: true },
});

const box = computed(() => ({ sm: 'h-7 w-7', md: 'h-8 w-8', lg: 'h-10 w-10' })[props.size] || 'h-8 w-8');
const iconSize = computed(() => ({ sm: 14, md: 16, lg: 18 })[props.size] || 16);
const toneClass = computed(() => {
  if (props.tone === 'danger') return 'text-danger-fg hover:bg-danger/10 ring-1 ring-danger/40';
  if (props.tone === 'accent') return 'text-accent-fg hover:bg-accent/10';
  return props.active ? 'text-text bg-surface-3' : 'text-muted hover:text-text hover:bg-surface-3';
});
</script>

<template>
  <button
    type="button"
    class="nm-icon-btn inline-flex shrink-0 items-center justify-center rounded-md transition-colors duration-[120ms] disabled:cursor-not-allowed disabled:opacity-50"
    :class="[box, toneClass]"
    :aria-label="label"
    :title="showTitle ? label : undefined"
    :disabled="disabled || loading"
    :aria-busy="loading ? 'true' : undefined"
  >
    <Spinner v-if="loading" :size="iconSize" />
    <Icon v-else :name="icon" :size="iconSize" />
  </button>
</template>
