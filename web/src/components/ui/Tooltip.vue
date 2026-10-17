<script setup>
// Tooltip (PLAN §8.6, DESIGN §9). Wraps its slot in an inline span that carries `title` (a11y +
// test fallback). On hover (300 ms delay) / keyboard focus (immediate) / touch tap a styled bubble
// is shown, teleported to <body> so overflow containers never clip it; while it's visible the native
// `title` is temporarily removed to avoid a double tooltip.
import { ref, computed, nextTick, onBeforeUnmount } from 'vue';
import { uid } from './overlay.js';

// Two root nodes (wrapper + teleport): bind attrs (data-testid, class) to the wrapper explicitly.
defineOptions({ inheritAttrs: false });

const props = defineProps({
  text: { type: String, default: '' },
  placement: { type: String, default: 'top' }, // top | bottom
  delay: { type: Number, default: 300 },
  disabled: { type: Boolean, default: false },
  block: { type: Boolean, default: false },
});

const wrap = ref(null);
const bubble = ref(null);
const visible = ref(false);
const suppressTitle = ref(false);
const pos = ref({ top: 0, left: 0, side: props.placement });
const id = uid('tooltip');
let timer = null;
let touchTimer = null;

const active = computed(() => !props.disabled && !!props.text);

function place() {
  const w = wrap.value;
  const b = bubble.value;
  if (!w || !b) return;
  const r = w.getBoundingClientRect();
  const bw = b.offsetWidth;
  const bh = b.offsetHeight;
  const margin = 8;
  let side = props.placement;
  let top = side === 'bottom' ? r.bottom + 6 : r.top - 6 - bh;
  if (side === 'top' && top < margin) {
    side = 'bottom';
    top = r.bottom + 6;
  } else if (side === 'bottom' && top + bh > window.innerHeight - margin) {
    side = 'top';
    top = r.top - 6 - bh;
  }
  let left = r.left + r.width / 2 - bw / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - bw - margin));
  pos.value = { top: Math.round(top), left: Math.round(left), side };
}

async function show(immediate = false) {
  if (!active.value) return;
  clearTimeout(timer);
  const run = async () => {
    suppressTitle.value = true;
    visible.value = true;
    await nextTick();
    place();
  };
  if (immediate || props.delay <= 0) run();
  else timer = setTimeout(run, props.delay);
}

function hide() {
  clearTimeout(timer);
  clearTimeout(touchTimer);
  visible.value = false;
  suppressTitle.value = false;
}

function onPointerEnter(e) {
  if (e.pointerType === 'touch') return;
  suppressTitle.value = true; // hide the native title while hovering
  show(false);
}
function onPointerLeave(e) {
  if (e.pointerType === 'touch') return;
  hide();
}
function onPointerDown(e) {
  if (e.pointerType !== 'touch' || !active.value) return;
  if (visible.value) return hide();
  show(true);
  touchTimer = setTimeout(hide, 2500);
}

window.addEventListener('scroll', hide, { passive: true, capture: true });
onBeforeUnmount(() => {
  hide();
  window.removeEventListener('scroll', hide, { capture: true });
});
</script>

<template>
  <span
    ref="wrap"
    v-bind="$attrs"
    :class="block ? 'flex min-w-0' : 'inline-flex max-w-full'"
    :title="active && !suppressTitle ? text : undefined"
    :aria-describedby="visible ? id : undefined"
    @pointerenter="onPointerEnter"
    @pointerleave="onPointerLeave"
    @pointerdown="onPointerDown"
    @focusin="show(true)"
    @focusout="hide"
  >
    <slot />
  </span>
  <Teleport to="body">
    <span
      v-if="visible && active"
      :id="id"
      ref="bubble"
      role="tooltip"
      class="pointer-events-none fixed z-[80] max-w-[min(280px,calc(100vw-16px))] rounded-md border border-border bg-overlay px-2 py-1 text-xs leading-4 text-text shadow-popover animate-nm-fade-in"
      :style="{ top: pos.top + 'px', left: pos.left + 'px' }"
    >
      {{ text }}
    </span>
  </Teleport>
</template>
