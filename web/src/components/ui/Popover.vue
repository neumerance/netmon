<script setup>
// Anchored popover (PLAN §8.6, DESIGN §3.7). Controlled: parent owns `open` and listens for `close`
// (emitted on outside click, Esc, or when the anchor scrolls out of view).
//
// Slots: `trigger` (the anchor; receives { open }), default (panel content).
// The panel is teleported to <body> with fixed positioning so table/card `overflow` never clips it.
// Attrs (data-testid, aria-label, role overrides) land on the PANEL.
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue';
import { uid, focusableIn } from './overlay.js';

defineOptions({ inheritAttrs: false });

const props = defineProps({
  open: { type: Boolean, default: false },
  placement: { type: String, default: 'bottom-start' }, // (bottom|top)(-start|-end|) | (left|right)(-start)
  width: { type: [Number, String], default: null }, // e.g. 320
  offset: { type: Number, default: 6 },
  role: { type: String, default: 'dialog' },
  focusOnOpen: { type: Boolean, default: true },
  panelClass: { type: [String, Array, Object], default: '' },
  padded: { type: Boolean, default: true },
});
const emit = defineEmits(['close']);

const anchor = ref(null);
const panel = ref(null);
const pos = ref({ top: 0, left: 0, placement: props.placement });
const panelId = uid('popover');
let returnFocusTo = null;

const widthStyle = computed(() => {
  if (props.width === null || props.width === undefined) return {};
  const w = typeof props.width === 'number' ? `${props.width}px` : props.width;
  return { width: `min(${w}, calc(100vw - 16px))` };
});

function computePosition() {
  const a = anchor.value;
  const p = panel.value;
  if (!a || !p) return;
  const ar = a.getBoundingClientRect();
  const pw = p.offsetWidth;
  const ph = p.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const gap = props.offset;
  const margin = 8;
  let [side, align = 'center'] = props.placement.split('-');
  if (!props.placement.includes('-')) align = 'center';

  // Flip vertically / horizontally when there isn't room.
  if (side === 'bottom' && ar.bottom + gap + ph > vh - margin && ar.top - gap - ph > margin) side = 'top';
  else if (side === 'top' && ar.top - gap - ph < margin && ar.bottom + gap + ph < vh - margin) side = 'bottom';
  else if (side === 'right' && ar.right + gap + pw > vw - margin) side = 'left';
  else if (side === 'left' && ar.left - gap - pw < margin) side = 'right';

  let top;
  let left;
  if (side === 'bottom' || side === 'top') {
    top = side === 'bottom' ? ar.bottom + gap : ar.top - gap - ph;
    if (align === 'start') left = ar.left;
    else if (align === 'end') left = ar.right - pw;
    else left = ar.left + ar.width / 2 - pw / 2;
  } else {
    left = side === 'right' ? ar.right + gap : ar.left - gap - pw;
    top = align === 'start' ? ar.top : align === 'end' ? ar.bottom - ph : ar.top + ar.height / 2 - ph / 2;
  }
  left = Math.max(margin, Math.min(left, vw - pw - margin));
  top = Math.max(margin, Math.min(top, vh - ph - margin));
  pos.value = { top: Math.round(top), left: Math.round(left), placement: side };

  // Anchor scrolled fully out of view -> close.
  if (ar.bottom < 0 || ar.top > vh) emit('close');
}

let raf = 0;
function schedule() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    computePosition();
  });
}

function onPointerDown(e) {
  const t = e.target;
  if (panel.value?.contains(t) || anchor.value?.contains(t)) return;
  emit('close');
}

function onKeydown(e) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    emit('close');
    const el = returnFocusTo || anchor.value?.querySelector('button, [tabindex], a, input');
    el?.focus?.({ preventScroll: true });
  }
}

function attach() {
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeydown, true);
  window.addEventListener('resize', schedule);
  window.addEventListener('scroll', schedule, true);
}
function detach() {
  document.removeEventListener('pointerdown', onPointerDown, true);
  document.removeEventListener('keydown', onKeydown, true);
  window.removeEventListener('resize', schedule);
  window.removeEventListener('scroll', schedule, true);
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

watch(
  () => props.open,
  async (v) => {
    if (v) {
      returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      attach();
      await nextTick();
      computePosition();
      if (props.focusOnOpen && panel.value) {
        const first = focusableIn(panel.value)[0];
        (first || panel.value).focus({ preventScroll: true });
      }
    } else {
      detach();
    }
  },
  { immediate: true },
);

onBeforeUnmount(detach);
</script>

<template>
  <span ref="anchor" class="inline-flex max-w-full" :aria-controls="open ? panelId : undefined">
    <slot name="trigger" :open="open" />
  </span>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-[180ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]"
      leave-active-class="transition duration-[120ms] ease-in"
      enter-from-class="opacity-0 scale-[0.98]"
      leave-to-class="opacity-0 scale-[0.98]"
    >
      <div
        v-if="open"
        :id="panelId"
        ref="panel"
        :role="role"
        tabindex="-1"
        v-bind="$attrs"
        class="fixed z-40 max-h-[min(70vh,480px)] overflow-auto rounded-lg border border-border bg-overlay text-text shadow-popover outline-none"
        :class="[padded ? 'p-3' : '', panelClass, pos.placement === 'top' ? 'origin-bottom' : 'origin-top']"
        :style="{ top: pos.top + 'px', left: pos.left + 'px', ...widthStyle }"
      >
        <slot />
      </div>
    </Transition>
  </Teleport>
</template>
