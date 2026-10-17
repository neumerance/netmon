<script setup>
// Small status/label pill (PLAN §8.6, DESIGN §1.6 "Badge 11/16 500").
import { computed } from 'vue';
import Icon from './Icon.vue';

const props = defineProps({
  tone: { type: String, default: 'neutral' }, // neutral | success | warning | danger | info | brand (accent, critical aliases)
  dot: { type: Boolean, default: false },
  icon: { type: String, default: null },
  size: { type: String, default: 'md' }, // sm | md
});

const TONES = {
  neutral: { box: 'bg-surface-3 text-muted', dot: 'bg-subtle' },
  success: { box: 'bg-success/15 text-success-fg', dot: 'bg-success' },
  warning: { box: 'bg-warning/15 text-warning-fg', dot: 'bg-warning' },
  danger: { box: 'bg-danger/15 text-danger-fg', dot: 'bg-danger' },
  critical: { box: 'bg-danger/15 text-danger-fg', dot: 'bg-danger' },
  info: { box: 'bg-info/15 text-info-fg', dot: 'bg-info' },
  brand: { box: 'bg-accent/15 text-accent-fg', dot: 'bg-accent' },
  accent: { box: 'bg-accent/15 text-accent-fg', dot: 'bg-accent' },
  network: { box: 'bg-cat-network/15 text-cat-network', dot: 'bg-cat-network' },
  outline: { box: 'bg-transparent text-muted ring-1 ring-inset ring-border-strong', dot: 'bg-subtle' },
};

const t = computed(() => TONES[props.tone] || TONES.neutral);
</script>

<template>
  <span
    class="inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-sm font-medium tracking-[0.01em]"
    :class="[t.box, size === 'sm' ? 'h-4 px-1 text-[10px] leading-4' : 'h-5 px-1.5 text-[11px] leading-4']"
  >
    <span v-if="dot" class="h-1.5 w-1.5 shrink-0 rounded-full" :class="t.dot" aria-hidden="true" />
    <Icon v-if="icon" :name="icon" :size="size === 'sm' ? 10 : 12" />
    <span class="truncate"><slot /></span>
  </span>
</template>
