// Shared overlay mechanics for Modal / Drawer (DESIGN §4): stacking (Esc closes only the topmost),
// body scroll lock, focus trap, initial focus and focus return. Internal to components/ui.
import { watch, nextTick, onBeforeUnmount } from 'vue';

const stack = []; // overlay tokens, topmost last
let lockCount = 0;
let savedOverflow = '';
let savedPaddingRight = '';

const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export function focusableIn(el) {
  if (!el) return [];
  return Array.from(el.querySelectorAll(FOCUSABLE)).filter(
    (n) => !n.hasAttribute('inert') && n.getAttribute('aria-hidden') !== 'true' && (n.offsetParent !== null || n === document.activeElement),
  );
}

function lockScroll() {
  if (lockCount++ > 0) return;
  const body = document.body;
  savedOverflow = body.style.overflow;
  savedPaddingRight = body.style.paddingRight;
  const scrollbar = window.innerWidth - document.documentElement.clientWidth;
  body.style.overflow = 'hidden';
  if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;
}

function unlockScroll() {
  if (lockCount === 0) return;
  if (--lockCount > 0) return;
  document.body.style.overflow = savedOverflow;
  document.body.style.paddingRight = savedPaddingRight;
}

/**
 * Wire overlay behaviour to an `open` getter.
 * @param {{ isOpen: () => boolean, panelRef: import('vue').Ref<HTMLElement|null>,
 *           onClose: () => void, initialFocus?: () => (HTMLElement|null) }} opts
 */
export function useOverlay({ isOpen, panelRef, onClose, initialFocus }) {
  const token = {};
  let returnFocusTo = null;
  let active = false;

  const onKeydown = (e) => {
    if (!active || stack[stack.length - 1] !== token) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'Tab') {
      const panel = panelRef.value;
      if (!panel) return;
      const items = focusableIn(panel);
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const cur = document.activeElement;
      if (e.shiftKey && (cur === first || !panel.contains(cur))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (cur === last || !panel.contains(cur))) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  async function activate() {
    if (active) return;
    active = true;
    returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    stack.push(token);
    lockScroll();
    document.addEventListener('keydown', onKeydown, true);
    // The panel is mounted on the next render flush (setTimeout rather than rAF so focus also
    // moves in background tabs / headless runs where animation frames are throttled).
    await nextTick();
    setTimeout(() => {
      if (!active) return;
      const panel = panelRef.value;
      if (!panel) return;
      let target = initialFocus?.() || null;
      if (!target) target = panel.querySelector('[data-autofocus], [autofocus]');
      if (!target) target = panel.querySelector('input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])');
      if (!target) target = focusableIn(panel).find((n) => !n.hasAttribute('data-overlay-close')) || null;
      (target || panel).focus({ preventScroll: true });
      if (target && target.tagName === 'INPUT' && target.hasAttribute('data-select-on-focus')) target.select?.();
    }, 0);
  }

  function deactivate() {
    if (!active) return;
    active = false;
    const i = stack.indexOf(token);
    if (i !== -1) stack.splice(i, 1);
    unlockScroll();
    document.removeEventListener('keydown', onKeydown, true);
    const el = returnFocusTo;
    returnFocusTo = null;
    if (el && document.contains(el)) {
      setTimeout(() => el.focus?.({ preventScroll: true }), 0);
    }
  }

  watch(isOpen, (v) => (v ? activate() : deactivate()), { immediate: true });
  onBeforeUnmount(deactivate);

  return { isTopmost: () => stack[stack.length - 1] === token };
}

let idSeq = 0;
export function uid(prefix = 'nm') {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}
