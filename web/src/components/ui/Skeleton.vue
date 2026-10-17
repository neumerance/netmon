<script setup>
// Shimmering placeholder block (DESIGN §6). Static under reduced motion (handled in style.css).
defineProps({
  width: { type: [String, Number], default: '100%' },
  height: { type: [String, Number], default: 12 },
  rounded: { type: String, default: 'sm' }, // sm | md | lg | full
});
const px = (v) => (typeof v === 'number' ? `${v}px` : v);
const RADIUS = { sm: 'rounded-sm', md: 'rounded-md', lg: 'rounded-lg', full: 'rounded-full' };
</script>

<template>
  <span
    class="nm-skeleton block shrink-0"
    :class="RADIUS[rounded] || 'rounded-sm'"
    :style="{ width: px(width), height: px(height) }"
    aria-hidden="true"
  />
</template>
