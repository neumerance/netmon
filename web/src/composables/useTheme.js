// Theme handling (PLAN §8.4, DESIGN §1.7).
// Preference ('system' | 'dark' | 'light') lives in store `ui.theme` (persisted to localStorage
// 'netmon.ui'). The resolved theme is written to <html> as BOTH `data-theme="dark|light"` (token
// overrides in style.css) and the `.dark` class (Tailwind `dark:` variant), plus `color-scheme`.
import { ref, computed, watch } from 'vue';
import { ui, setTheme as storeSetTheme } from '../store.js';


const systemDark = ref(true);
let initialized = false;

function readSystem() {
  try {
    if (typeof window === 'undefined' || !window.matchMedia) return true;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    // If the query is unsupported the browser reports media 'not all' -> treat as dark.
    if (mq.media === 'not all') return true;
    return mq.matches;
  } catch {
    return true;
  }
}

const resolved = computed(() => (ui.theme === 'system' ? (systemDark.value ? 'dark' : 'light') : ui.theme));

function apply(theme) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
}

/** Attach listeners and apply the theme once. Safe to call repeatedly. */
export function initTheme() {
  if (initialized) return;
  initialized = true;
  systemDark.value = readSystem();
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e) => {
      systemDark.value = e.matches;
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  } catch {
    /* no matchMedia */
  }
  watch(resolved, apply, { immediate: true });
}

/**
 * @returns {{ theme: import('vue').ComputedRef<'system'|'dark'|'light'>,
 *             resolved: import('vue').ComputedRef<'dark'|'light'>,
 *             isDark: import('vue').ComputedRef<boolean>,
 *             setTheme(t: string): void, toggle(): void, icon: import('vue').ComputedRef<string>,
 *             label: import('vue').ComputedRef<string> }}
 */
export function useTheme() {
  initTheme();
  const theme = computed({
    get: () => ui.theme,
    set: (t) => storeSetTheme(t),
  });
  const isDark = computed(() => resolved.value === 'dark');
  const icon = computed(() => (ui.theme === 'dark' ? 'moon' : ui.theme === 'light' ? 'sun' : 'monitor'));
  const label = computed(() =>
    ui.theme === 'dark' ? 'Theme: dark' : ui.theme === 'light' ? 'Theme: light' : `Theme: system (${resolved.value})`,
  );
  function setTheme(t) {
    storeSetTheme(t);
  }
  // Every click must visibly flip the page: from 'system' go to the opposite of what the OS
  // resolves to, then alternate dark <-> light. 'system' stays selectable in the settings drawer.
  function toggle() {
    storeSetTheme(resolved.value === 'dark' ? 'light' : 'dark');
  }
  return { theme, resolved, isDark, setTheme, toggle, icon, label };
}
