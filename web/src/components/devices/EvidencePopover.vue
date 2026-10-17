<script setup>
// "Why this device type?" popover (DESIGN.md §3.7).
//
// Self-contained instead of ui/Popover: it is teleported to <body> and positioned `fixed`
// against its trigger, so it is never clipped by the table/card containers (overflow) and it
// does not shift table layout. Closes on outside pointerdown, Esc (focus returns to trigger)
// and window resize. On scroll it follows its trigger (repositioned once per frame) and only
// closes when the trigger has scrolled fully out of the viewport — so the scroll that brought
// the trigger into view, or a small scroll to read the panel on a phone, never closes it.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import Icon from '../ui/Icon.vue';
import {
  CATEGORY_LABELS,
  OS_LABELS,
  deviceIcon,
  deviceTypeLabel
} from '../../lib/deviceTypes.js';
import { categoryTint, confidencePercent } from './deviceUi.js';

const props = defineProps({
  open: { type: Boolean, default: false },
  device: { type: Object, required: true },
  /** Trigger element (the "Why?" button) used for positioning and focus return. */
  anchor: { type: Object, default: null }
});
const emit = defineEmits(['close', 'change-type']);

const panel = ref(null);
const pos = ref({ top: 0, left: 0, width: 320, placement: 'bottom' });

const evidence = computed(() =>
  (Array.isArray(props.device.typeEvidence) ? props.device.typeEvidence : [])
    .filter((e) => e != null && String(e).trim() !== '')
    .map((e) => String(e))
);
const isUser = computed(() => props.device.typeSource === 'user');
const label = computed(() => deviceTypeLabel(props.device));
const pct = computed(() => confidencePercent(props.device.typeConfidence));
const tint = computed(() => categoryTint(props.device.category));

/** What auto-detection says, shown when the user has overridden the type. */
const autoLabel = computed(() => {
  const d = props.device;
  if (!isUser.value || !d.autoCategory) return null;
  return deviceTypeLabel({ ...d, category: d.autoCategory });
});

const facts = computed(() => {
  const d = props.device;
  const out = [];
  if (d.os) out.push(['OS', OS_LABELS[d.os] ?? d.os]);
  if (d.model) out.push(['Model', d.model]);
  if (d.vendor) out.push(['Vendor', d.vendor]);
  if (isUser.value && d.autoCategory && d.autoCategory !== d.category) {
    out.push(['Detected as', CATEGORY_LABELS[d.autoCategory] ?? d.autoCategory]);
  }
  return out;
});

function place() {
  const el = props.anchor;
  if (!el || typeof el.getBoundingClientRect !== 'function') return;
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(320, vw - 16);
  const panelH = panel.value?.offsetHeight || 260;
  let left = Math.min(Math.max(8, r.left), vw - width - 8);
  let top = r.bottom + 6;
  let placement = 'bottom';
  if (top + panelH > vh - 8 && r.top - 6 - panelH >= 8) {
    top = r.top - 6 - panelH;
    placement = 'top';
  }
  pos.value = { top: Math.max(8, top), left, width, placement };
}

function onPointerDown(e) {
  const t = e.target;
  if (panel.value?.contains(t)) return;
  if (props.anchor?.contains?.(t)) return; // trigger toggles itself
  emit('close');
}
function onKeydown(e) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    emit('close');
    props.anchor?.focus?.();
  }
}
let raf = 0;
function followAnchor() {
  raf = 0;
  if (!props.open) return;
  const el = props.anchor;
  if (!el || typeof el.getBoundingClientRect !== 'function') return;
  const r = el.getBoundingClientRect();
  if (r.bottom < 0 || r.top > window.innerHeight || (r.width === 0 && r.height === 0)) {
    emit('close');
    return;
  }
  place();
}
function onScroll(e) {
  if (panel.value && e.target instanceof Node && panel.value.contains(e.target)) return;
  if (raf) return;
  raf = requestAnimationFrame(followAnchor);
}
function onResize() {
  emit('close');
}

function bind() {
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeydown, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);
}
function unbind() {
  document.removeEventListener('pointerdown', onPointerDown, true);
  document.removeEventListener('keydown', onKeydown, true);
  window.removeEventListener('scroll', onScroll, true);
  window.removeEventListener('resize', onResize);
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

watch(
  () => props.open,
  async (open) => {
    if (open) {
      place();
      bind();
      await nextTick();
      place(); // re-place with the real height
      panel.value?.focus({ preventScroll: true });
    } else {
      unbind();
    }
  },
  { immediate: true }
);

onBeforeUnmount(unbind);

function changeType() {
  emit('change-type');
  emit('close');
}
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="opacity-0 scale-[0.98]"
      leave-active-class="transition duration-100 ease-in"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        ref="panel"
        data-testid="device-evidence"
        role="dialog"
        aria-label="Why this device type"
        tabindex="-1"
        class="fixed z-40 rounded-xl border border-border bg-overlay p-3 text-left shadow-popover outline-none"
        :class="pos.placement === 'top' ? 'origin-bottom-left' : 'origin-top-left'"
        :style="{ top: `${pos.top}px`, left: `${pos.left}px`, width: `${pos.width}px` }"
      >
        <div class="flex items-start gap-2.5">
          <span class="grid size-8 shrink-0 place-items-center rounded-lg" :class="tint.tile">
            <Icon :name="deviceIcon(device)" :size="18" />
          </span>
          <div class="min-w-0 flex-1">
            <p class="truncate text-[13px] font-semibold text-text" :title="label">{{ label }}</p>
            <p v-if="isUser" class="mt-0.5 text-xs text-muted">
              Set by you<template v-if="autoLabel"> · auto-detect would say {{ autoLabel }} ({{ pct }}%)</template>
            </p>
            <template v-else>
              <p class="mt-0.5 text-xs text-muted">
                Detected automatically · {{ pct }}% confidence
              </p>
              <div
                class="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-surface-3"
                role="meter"
                aria-label="Detection confidence"
                aria-valuemin="0"
                aria-valuemax="100"
                :aria-valuenow="pct"
              >
                <div class="h-full rounded-full bg-accent" :style="{ width: `${pct}%` }" />
              </div>
            </template>
          </div>
        </div>

        <div
          v-if="facts.length"
          class="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs"
        >
          <template v-for="[k, v] in facts" :key="k">
            <span class="text-muted">{{ k }}</span>
            <span class="truncate font-medium text-text" :title="v">{{ v }}</span>
          </template>
        </div>

        <div class="my-3 h-px bg-surface-3" />

        <p class="mb-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-muted">
          Evidence
        </p>
        <ul v-if="evidence.length" class="max-h-48 space-y-1.5 overflow-y-auto pr-1">
          <li
            v-for="(e, i) in evidence"
            :key="i"
            class="flex items-start gap-2 text-xs leading-4 text-muted"
          >
            <Icon name="check" :size="14" class="mt-px shrink-0 text-success-fg" />
            <span class="min-w-0 break-words">{{ e }}</span>
          </li>
        </ul>
        <p v-else class="text-xs leading-5 text-muted">
          <template v-if="device.fingerprinting">Identifying this device…</template>
          <template v-else>
            Not enough information yet. Detection improves as the device responds to discovery.
          </template>
        </p>

        <div class="mt-3 flex items-center justify-between gap-2 border-t border-border pt-2.5">
          <span class="text-xs text-muted">Wrong?</span>
          <button
            type="button"
            class="rounded-md px-2 py-1 text-xs font-medium text-accent-fg hover:bg-accent/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            @click="changeType"
          >
            Change type
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
