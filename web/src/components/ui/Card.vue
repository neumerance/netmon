<script setup>
// Surface container (PLAN §8.6). Header renders when `title` or the `actions`/`header` slot is used.
defineProps({
  title: { type: String, default: null },
  subtitle: { type: String, default: null },
  padded: { type: Boolean, default: true },
  as: { type: String, default: 'section' },
});
</script>

<template>
  <component
    :is="as"
    class="flex min-w-0 flex-col rounded-lg border border-border bg-surface shadow-card"
  >
    <header
      v-if="title || subtitle || $slots.actions || $slots.header"
      class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3.5"
      :class="padded ? 'pb-0' : 'pb-3'"
    >
      <slot name="header">
        <div class="min-w-0 flex-1">
          <h2 v-if="title" class="truncate text-[13px] font-semibold leading-5 text-text">{{ title }}</h2>
          <p v-if="subtitle" class="truncate text-xs text-muted">{{ subtitle }}</p>
        </div>
      </slot>
      <div v-if="$slots.actions" class="ml-auto flex shrink-0 items-center gap-2">
        <slot name="actions" />
      </div>
    </header>
    <div class="min-w-0 flex-1" :class="padded ? 'p-4' : ''">
      <slot />
    </div>
    <footer v-if="$slots.footer" class="border-t border-border px-4 py-3">
      <slot name="footer" />
    </footer>
  </component>
</template>
