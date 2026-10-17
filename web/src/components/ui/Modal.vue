<script setup>
// Dialog (PLAN §8.6, DESIGN §4). Teleported to body; scrim backdrop; focus trap; Esc and backdrop
// close (emit 'close' — the parent owns `open`). Attrs (data-testid etc.) land on the dialog panel.
// On narrow screens it renders as a bottom sheet.
import { ref, computed, useSlots } from 'vue';
import Icon from './Icon.vue';
import { useOverlay, uid } from './overlay.js';

defineOptions({ inheritAttrs: false });

const props = defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: '' },
  description: { type: String, default: '' },
  width: { type: String, default: 'md' }, // sm 400 | md 480 | lg 640 | xl 800
  role: { type: String, default: 'dialog' }, // dialog | alertdialog
  closeOnBackdrop: { type: Boolean, default: true },
  showClose: { type: Boolean, default: true },
  sheet: { type: Boolean, default: true }, // bottom sheet below 640px
  initialFocus: { type: String, default: null }, // CSS selector inside the panel
});
const emit = defineEmits(['close']);
const slots = useSlots();

const panel = ref(null);
const titleId = uid('modal-title');
const descId = uid('modal-desc');

const WIDTHS = { sm: 'sm:max-w-[400px]', md: 'sm:max-w-[480px]', lg: 'sm:max-w-[640px]', xl: 'sm:max-w-[800px]' };
const widthClass = computed(() => WIDTHS[props.width] || WIDTHS.md);

function close() {
  emit('close');
}

useOverlay({
  isOpen: () => props.open,
  panelRef: panel,
  onClose: close,
  initialFocus: () => (props.initialFocus && panel.value ? panel.value.querySelector(props.initialFocus) : null),
});

let downOnBackdrop = false;
function onBackdropDown(e) {
  downOnBackdrop = e.target === e.currentTarget;
}
function onBackdropClick(e) {
  if (props.closeOnBackdrop && downOnBackdrop && e.target === e.currentTarget) close();
  downOnBackdrop = false;
}

const hasHeader = computed(() => !!props.title || !!slots.header);
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-opacity duration-[120ms] ease-out"
      leave-active-class="transition-opacity duration-[120ms] ease-in"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        class="fixed inset-0 z-[60] flex justify-center bg-scrim"
        :class="sheet ? 'items-end sm:items-center sm:p-4' : 'items-center p-4'"
        @mousedown="onBackdropDown"
        @click="onBackdropClick"
      >
        <div
          ref="panel"
          v-bind="$attrs"
          :role="role"
          aria-modal="true"
          :aria-labelledby="hasHeader ? titleId : undefined"
          :aria-describedby="description ? descId : undefined"
          tabindex="-1"
          class="relative flex max-h-[90vh] w-full flex-col overflow-hidden border border-border bg-overlay text-text shadow-modal outline-none animate-nm-slide-up"
          :class="[widthClass, sheet ? 'rounded-t-xl sm:rounded-xl pb-[env(safe-area-inset-bottom)] sm:pb-0' : 'rounded-xl']"
        >
          <header v-if="hasHeader" class="flex items-start gap-3 px-5 pt-4 pb-3">
            <div class="min-w-0 flex-1">
              <slot name="header">
                <h2 :id="titleId" class="text-base font-semibold leading-6 tracking-[-0.01em]">{{ title }}</h2>
              </slot>
              <p v-if="description" :id="descId" class="mt-0.5 text-[13px] text-muted">{{ description }}</p>
            </div>
            <button
              v-if="showClose"
              type="button"
              data-overlay-close
              class="-mr-1.5 -mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-3 hover:text-text"
              aria-label="Close"
              @click="close"
            >
              <Icon name="x" :size="16" />
            </button>
          </header>
          <div class="min-h-0 flex-1 overflow-y-auto px-5" :class="hasHeader ? 'pb-4' : 'py-4'">
            <slot />
          </div>
          <footer v-if="$slots.footer" class="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
            <slot name="footer" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
