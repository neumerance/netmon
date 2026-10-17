<script setup>
// Side drawer (PLAN §8.6, DESIGN §4.3): 400px right sheet (full screen on mobile), scrim, focus trap,
// Esc/backdrop close via emit('close'). Attrs (data-testid) land on the drawer panel.
import { ref } from 'vue';
import Icon from './Icon.vue';
import { useOverlay, uid } from './overlay.js';

defineOptions({ inheritAttrs: false });

const props = defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: '' },
  side: { type: String, default: 'right' }, // right | left
  width: { type: String, default: '400px' },
  closeOnBackdrop: { type: Boolean, default: true },
});
const emit = defineEmits(['close']);

const panel = ref(null);
const titleId = uid('drawer-title');

function close() {
  emit('close');
}

useOverlay({ isOpen: () => props.open, panelRef: panel, onClose: close });
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-opacity duration-[240ms] ease-out"
      leave-active-class="transition-opacity duration-[180ms] ease-in"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <div v-if="open" class="fixed inset-0 z-50 bg-scrim" aria-hidden="true" @click="closeOnBackdrop && close()" />
    </Transition>
    <Transition
      enter-active-class="transition-transform duration-[240ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]"
      leave-active-class="transition-transform duration-[180ms] ease-[cubic-bezier(0.4,0,1,1)]"
      :enter-from-class="side === 'left' ? '-translate-x-full' : 'translate-x-full'"
      :leave-to-class="side === 'left' ? '-translate-x-full' : 'translate-x-full'"
    >
      <aside
        v-if="open"
        ref="panel"
        v-bind="$attrs"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="title ? titleId : undefined"
        tabindex="-1"
        class="fixed inset-y-0 z-50 flex w-full flex-col bg-overlay text-text shadow-modal outline-none sm:max-w-[var(--nm-drawer-w)]"
        :class="side === 'left' ? 'left-0 sm:border-r sm:border-border' : 'right-0 sm:border-l sm:border-border'"
        :style="{ '--nm-drawer-w': width }"
      >
        <header class="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
          <slot name="header">
            <h2 :id="titleId" class="min-w-0 flex-1 truncate text-base font-semibold tracking-[-0.01em]">{{ title }}</h2>
          </slot>
          <button
            type="button"
            data-overlay-close
            class="-mr-1.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-3 hover:text-text"
            aria-label="Close"
            @click="close"
          >
            <Icon name="x" :size="16" />
          </button>
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <slot />
        </div>
        <footer
          v-if="$slots.footer"
          class="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        >
          <slot name="footer" />
        </footer>
      </aside>
    </Transition>
  </Teleport>
</template>
