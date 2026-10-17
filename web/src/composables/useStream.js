// Live-connection helpers built on store.js (which owns the single SSE connection, see
// api.connectStream: EventSource auto-retry + manual re-create with 1 s -> 10 s backoff; each
// reconnect receives a full `snapshot`, which resyncs all state).
//
// useStream() exposes connection status for UI (TopBar live dot, backend banner) and a manual retry.
import { computed } from 'vue';
import { state, init, reconnectNow } from '../store.js';
import { useNow } from './useNow.js';

/**
 * @returns {{
 *   status: import('vue').ComputedRef<'connecting'|'open'|'reconnecting'>,
 *   isLive: import('vue').ComputedRef<boolean>,
 *   downForMs: import('vue').ComputedRef<number>,       // 0 while connected
 *   showBackendBanner: import('vue').ComputedRef<boolean>, // disconnected for > 3 s (DESIGN §6)
 *   isOffline: import('vue').ComputedRef<boolean>,      // disconnected for > 30 s
 *   attempts: import('vue').ComputedRef<number>,
 *   lastUpdateAt: import('vue').ComputedRef<number|null>,
 *   retry(): void, start(): Promise<void>
 * }}
 */
export function useStream() {
  const now = useNow(1000);
  const status = computed(() => state.connection);
  const isLive = computed(() => state.connection === 'open');
  const downForMs = computed(() => {
    if (state.connection === 'open') return 0;
    const since = state.disconnectedAt;
    return since ? Math.max(0, now.value - since) : 0;
  });
  const showBackendBanner = computed(() => state.connection === 'reconnecting' && downForMs.value > 3000);
  const isOffline = computed(() => state.connection === 'reconnecting' && downForMs.value > 30000);
  const attempts = computed(() => state.reconnectAttempts);
  const lastUpdateAt = computed(() => state.lastMessageAt);
  return {
    status,
    isLive,
    downForMs,
    showBackendBanner,
    isOffline,
    attempts,
    lastUpdateAt,
    retry: reconnectNow,
    start: init,
  };
}
