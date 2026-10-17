<script setup>
// ToastHost — renders `state.toasts` as a stack (bottom-right on desktop, full
// width at the bottom on mobile; newest on top, max 4 visible).
//
// Auto-dismiss: `toast.autoDismissMs` (host-managed, pausable) when provided, else
// `toast.timeoutMs` (0 = sticky), else by level (info/success 6 s, warning/error 10 s).
// Hovering or focusing a toast pauses the host timer (the store's own timer for
// `timeoutMs > 0` toasts is not pausable). Removal always goes through
// store.removeToast(id), which is idempotent.
//
// Optional `toast.action = { label, onClick }` renders an inline action button.
//
// Stacking: z-[45] sits above popovers (z-40) but BELOW the drawer (z-50) and modals (z-60), so
// a toast can never cover the Settings drawer's Save/Cancel footer or a dialog's buttons.
import { computed, onBeforeUnmount, reactive, watch } from 'vue';
import { state, removeToast } from '../../store.js';
import Icon from '../ui/Icon.vue';

const MAX_VISIBLE = 4;
const DEFAULT_TIMEOUT = { info: 6000, success: 6000, warning: 10000, error: 10000 };

const LEVELS = {
  success: { bar: 'bg-success', icon: 'check', iconClass: 'text-success', kind: 'success' },
  info: { bar: 'bg-info', icon: 'info', iconClass: 'text-info', kind: 'info' },
  warning: { bar: 'bg-warning', icon: 'alert-triangle', iconClass: 'text-warning', kind: 'warning' },
  error: { bar: 'bg-danger', icon: 'alert-octagon', iconClass: 'text-danger', kind: 'danger' },
};
function meta(t) {
  return LEVELS[t.level] || LEVELS.info;
}

const visible = computed(() => (state.toasts || []).slice(-MAX_VISIBLE).reverse());

// --- Timers -----------------------------------------------------------------
// id -> { handle, remaining, startedAt, paused }
const timers = new Map();
const pausedIds = reactive(new Set());

function timeoutFor(t) {
  // `autoDismissMs` (extra field) = host-managed timer that honours hover/focus pause;
  // callers pass `timeoutMs: 0` so the store doesn't remove the toast on its own.
  if (typeof t.autoDismissMs === 'number' && Number.isFinite(t.autoDismissMs)) return t.autoDismissMs;
  if (typeof t.timeoutMs === 'number' && Number.isFinite(t.timeoutMs)) return t.timeoutMs;
  return DEFAULT_TIMEOUT[t.level] ?? 6000;
}

function arm(id, ms) {
  const entry = timers.get(id) || {};
  clearTimeout(entry.handle);
  entry.remaining = ms;
  entry.startedAt = Date.now();
  entry.handle = setTimeout(() => dismiss(id), ms);
  timers.set(id, entry);
}

function dismiss(id) {
  const entry = timers.get(id);
  if (entry) clearTimeout(entry.handle);
  timers.delete(id);
  pausedIds.delete(id);
  removeToast(id);
}

function pause(id) {
  const entry = timers.get(id);
  if (!entry || pausedIds.has(id)) return;
  clearTimeout(entry.handle);
  entry.remaining = Math.max(1000, entry.remaining - (Date.now() - entry.startedAt));
  pausedIds.add(id);
}

function resume(id) {
  const entry = timers.get(id);
  if (!entry || !pausedIds.has(id)) return;
  pausedIds.delete(id);
  arm(id, entry.remaining);
}

watch(
  () => (state.toasts || []).map((t) => t.id),
  (ids) => {
    const live = new Set(ids);
    // Arm timers for new toasts.
    for (const t of state.toasts || []) {
      if (timers.has(t.id)) continue;
      const ms = timeoutFor(t);
      if (ms > 0) arm(t.id, ms);
      else timers.set(t.id, { handle: null, remaining: 0, startedAt: Date.now() });
    }
    // Drop timers of toasts removed elsewhere.
    for (const id of [...timers.keys()]) {
      if (!live.has(id)) {
        clearTimeout(timers.get(id).handle);
        timers.delete(id);
        pausedIds.delete(id);
      }
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  for (const entry of timers.values()) clearTimeout(entry.handle);
  timers.clear();
});

function runAction(t) {
  try {
    t.action?.onClick?.();
  } finally {
    dismiss(t.id);
  }
}
</script>

<template>
  <div
    class="pointer-events-none fixed inset-x-3 bottom-[calc(12px+env(safe-area-inset-bottom))] z-[45] flex flex-col gap-3 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-[360px]"
    role="status"
    aria-live="polite"
    aria-relevant="additions"
    data-testid="toast-host"
  >
    <TransitionGroup name="alm-toast">
      <div
        v-for="t in visible"
        :key="t.id"
        class="pointer-events-auto relative flex items-start gap-3 overflow-hidden rounded-lg border border-border bg-overlay p-3 pl-4 shadow-popover"
        data-testid="toast"
        :data-level="t.level || 'info'"
        :data-kind="t.kind || meta(t).kind"
        @mouseenter="pause(t.id)"
        @mouseleave="resume(t.id)"
        @focusin="pause(t.id)"
        @focusout="resume(t.id)"
      >
        <span class="absolute inset-y-0 left-0 w-[3px]" :class="meta(t).bar" aria-hidden="true" />
        <Icon :name="meta(t).icon" :size="16" class="mt-0.5 shrink-0" :class="meta(t).iconClass" />
        <div class="min-w-0 flex-1">
          <p class="text-[13px] font-semibold leading-5 text-text">{{ t.title }}</p>
          <p v-if="t.message" class="mt-0.5 text-xs leading-4 text-muted break-words">{{ t.message }}</p>
          <button
            v-if="t.action && t.action.label"
            type="button"
            class="mt-2 inline-flex h-7 items-center rounded-md border border-border-strong px-2.5 text-xs font-medium text-text hover:bg-surface-3"
            data-testid="toast-action"
            @click="runAction(t)"
          >
            {{ t.action.label }}
          </button>
        </div>
        <button
          type="button"
          class="-mr-1 -mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-subtle hover:bg-surface-3 hover:text-text"
          data-testid="toast-close"
          aria-label="Dismiss notification"
          @click="dismiss(t.id)"
        >
          <Icon name="x" :size="14" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.alm-toast-enter-active {
  transition: transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.alm-toast-leave-active {
  transition: opacity 140ms cubic-bezier(0.4, 0, 1, 1);
}
.alm-toast-enter-from {
  transform: translateY(8px);
  opacity: 0;
}
.alm-toast-leave-to {
  opacity: 0;
}
.alm-toast-move {
  transition: transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
</style>
