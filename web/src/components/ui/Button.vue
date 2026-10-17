<script setup>
// Button (PLAN §8.6). Native <button>; attrs (data-testid, aria-*, @click) fall through to it.
import { computed } from 'vue';
import Icon from './Icon.vue';
import Spinner from './Spinner.vue';

const props = defineProps({
  variant: { type: String, default: 'primary' }, // primary | secondary | ghost | danger | danger-ghost | link
  size: { type: String, default: 'md' }, // sm | md | lg
  icon: { type: String, default: null },
  iconRight: { type: String, default: null },
  loading: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  type: { type: String, default: 'button' },
  block: { type: Boolean, default: false },
});

const VARIANTS = {
  primary:
    'bg-accent text-accent-contrast hover:bg-accent/90 active:bg-accent/80 border border-transparent shadow-sm',
  secondary:
    'bg-surface-2 text-text border border-border-strong hover:bg-surface-3 active:bg-surface-3/80',
  ghost: 'bg-transparent text-muted border border-transparent hover:text-text hover:bg-surface-3',
  danger: 'bg-danger text-white hover:bg-danger/90 active:bg-danger/80 border border-transparent shadow-sm',
  'danger-ghost': 'bg-transparent text-danger-fg border border-transparent hover:bg-danger/10',
  link: 'bg-transparent text-accent-fg border border-transparent hover:underline underline-offset-2 !px-0 !h-auto',
};

const SIZES = {
  sm: 'h-7 px-2.5 gap-1.5 text-xs rounded-md',
  md: 'h-8 px-3 gap-2 text-[13px] rounded-md',
  lg: 'h-10 px-4 gap-2 text-sm rounded-md',
};

const ICON_SIZES = { sm: 14, md: 16, lg: 16 };

const classes = computed(() => [
  'inline-flex items-center justify-center font-medium leading-5 whitespace-nowrap select-none',
  'transition-colors duration-[120ms] disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none',
  VARIANTS[props.variant] || VARIANTS.primary,
  SIZES[props.size] || SIZES.md,
  props.block ? 'w-full' : '',
]);
</script>

<template>
  <button
    :type="type"
    :class="classes"
    :disabled="disabled || loading"
    :aria-busy="loading ? 'true' : undefined"
  >
    <Spinner v-if="loading" :size="ICON_SIZES[size] || 16" />
    <Icon v-else-if="icon" :name="icon" :size="ICON_SIZES[size] || 16" />
    <slot />
    <Icon v-if="iconRight && !loading" :name="iconRight" :size="ICON_SIZES[size] || 16" />
  </button>
</template>
