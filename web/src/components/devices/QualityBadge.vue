<script setup>
// Connection-quality word badge: Good / Fair / Poor / Offline (PLAN.md §8.6 thresholds).
import { computed } from 'vue';
import { QUALITY } from './deviceUi.js';

const props = defineProps({
  quality: { type: String, default: 'none' }
});

const style = computed(() => QUALITY[props.quality] ?? QUALITY.none);
</script>

<template>
  <span
    v-if="quality !== 'none'"
    data-testid="quality-badge"
    :data-quality="quality"
    class="inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-[11px] font-medium ring-1 ring-inset"
    :class="style.badge"
  >{{ style.label }}</span>
</template>
