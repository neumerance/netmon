// Event log: persisted (via store, capped at 500) and pushed to listeners (SSE `event`).

const LEVELS = new Set(['info', 'warning', 'critical']);

export function createEventLog({ store, onEvent }) {
  let counter = 0;

  function add({ type, level = 'info', message, mac = null, data = null }) {
    const now = Date.now();
    counter = (counter + 1) % 1_000_000;
    const event = {
      id: `ev_${now}_${counter}`,
      at: new Date(now).toISOString(),
      type,
      level: LEVELS.has(level) ? level : 'info',
      message: String(message ?? type),
      mac: mac ?? null,
      data: data ?? null,
    };
    try { store.addEvent(event); } catch (err) { console.warn(`[events] persist failed: ${err.message}`); }
    try { onEvent?.(event); } catch (err) { console.warn(`[events] listener failed: ${err.message}`); }
    return event;
  }

  /** Newest first. */
  function list(limit = 100) {
    const n = Math.max(1, Math.min(500, Number.isFinite(limit) ? Math.floor(limit) : 100));
    return store.getEvents().slice(-n).reverse();
  }

  return { add, list };
}
