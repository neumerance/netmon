// REST + SSE client for the NetMon backend (PLAN.md §3, §5, §8.2).
// All paths are relative ('/api/...'): in dev Vite proxies them to the backend, in production the
// backend serves web/dist itself.

import { macToId } from './lib/format.js';

const BASE = '/api';
const DEFAULT_TIMEOUT_MS = 15000;

/** Error thrown for any non-2xx response or network failure. */
export class ApiError extends Error {
  /**
   * @param {{ status: number, code: string, message: string, details?: object|null }} init
   */
  constructor({ status = 0, code = 'error', message = 'Request failed', details = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status; // 0 = network failure / timeout
    this.code = code;
    this.details = details;
  }

  /** True when the server could not be reached at all. */
  get isNetwork() {
    return this.status === 0;
  }
}

async function request(method, path, body, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl?.signal,
      cache: 'no-store',
    });
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    throw new ApiError({
      status: 0,
      code: aborted ? 'timeout' : 'network',
      message: aborted ? "The NetMon server didn't respond in time." : "Couldn't reach the NetMon server.",
    });
  } finally {
    if (timer) clearTimeout(timer);
  }

  let data = null;
  const text = await res.text().catch(() => '');
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    throw new ApiError({
      status: res.status,
      code: data?.error || (res.status === 404 ? 'not_found' : 'http_' + res.status),
      message: data?.message || `Request failed (${res.status})`,
      details: data?.details ?? null,
    });
  }
  return data;
}

const enc = (mac) => encodeURIComponent(macToId(mac));

export const api = {
  health: () => request('GET', '/health'),
  snapshot: () => request('GET', '/snapshot'),
  devices: () => request('GET', '/devices'),
  updateDevice: (mac, body) => request('PUT', `/devices/${enc(mac)}`, body),
  deleteDevice: (mac) => request('DELETE', `/devices/${enc(mac)}`),
  // Server awaits the fingerprint for up to 15 s; give it a little headroom.
  refingerprint: (mac) => request('POST', `/devices/${enc(mac)}/fingerprint`, {}, { timeoutMs: 20000 }),
  runSpeedTest: () => request('POST', '/speedtest', {}),
  speedHistory: (limit = 200) => request('GET', `/speedtest/history?limit=${encodeURIComponent(limit)}`),
  settings: () => request('GET', '/settings'),
  updateSettings: (patch) => request('PUT', '/settings', patch),
  events: (limit = 100) => request('GET', `/events?limit=${encodeURIComponent(limit)}`),
  mockState: (body) => request('POST', '/mock/state', body),
  // Topology overrides (TOPOLOGY.md §7.2): user-set 'Connected via' parent + pinned map positions.
  topology: () => request('GET', '/topology'),
  updateTopology: (mac, body) => request('PUT', `/topology/${enc(mac)}`, body),
  resetTopology: (scope = 'positions') => request('DELETE', `/topology?scope=${encodeURIComponent(scope)}`),
  // Router integration: syslog receiver + SNMP poller (the community is write-only).
  router: () => request('GET', '/router'),
  updateRouterConfig: (patch) => request('PUT', '/router/config', patch),
  routerLog: ({ limit = 500, severity = 7, q = '' } = {}) =>
    request('GET', `/router/log?limit=${encodeURIComponent(limit)}&severity=${encodeURIComponent(severity)}&q=${encodeURIComponent(q)}`),
  clearRouterLog: () => request('DELETE', '/router/log'),
  // The server waits up to 2.5 s for the router; give it headroom.
  testRouterSnmp: (body) => request('POST', '/router/snmp/test', body, { timeoutMs: 8000 }),
};

/** SSE event names emitted by the server (PLAN §5). */
export const STREAM_EVENTS = ['snapshot', 'devices', 'device', 'internet', 'speed', 'isp', 'alerts', 'event', 'settings', 'network', 'topology',
  'router', 'routerLog'];

/**
 * Open the SSE stream with automatic reconnect.
 *
 * EventSource retries on its own while the connection is merely interrupted; when it gives up
 * (readyState CLOSED, e.g. the proxy answered 502 while the backend restarts) we recreate it with
 * exponential backoff 1 s → 10 s. On every (re)connect the server pushes a full `snapshot`, which
 * resyncs the client.
 *
 * @param {{ onEvent: (type: string, data: any) => void,
 *           onStatus?: (status: 'open'|'reconnecting', info?: { attempt: number }) => void,
 *           url?: string }} opts
 * @returns {{ close(): void, reconnect(): void }}
 */
export function connectStream({ onEvent, onStatus, url = `${BASE}/stream` } = {}) {
  let es = null;
  let closed = false;
  let retryTimer = null;
  let attempt = 0;
  let lastStatus = null;

  const MIN_BACKOFF = 1000;
  const MAX_BACKOFF = 10000;

  const status = (s) => {
    // Always report 'reconnecting' (attempt count changes), dedupe repeated 'open'.
    if (s === lastStatus && s === 'open') return;
    lastStatus = s;
    try {
      onStatus?.(s, { attempt });
    } catch (err) {
      console.warn('[api] onStatus handler failed', err);
    }
  };

  const dispatch = (type, ev) => {
    let data = null;
    try {
      data = ev.data ? JSON.parse(ev.data) : null;
    } catch (err) {
      console.warn(`[api] bad SSE payload for "${type}"`, err);
      return;
    }
    try {
      onEvent?.(type, data);
    } catch (err) {
      console.warn(`[api] SSE handler for "${type}" failed`, err);
    }
  };

  const scheduleReconnect = () => {
    if (closed || retryTimer) return;
    const delay = Math.min(MAX_BACKOFF, MIN_BACKOFF * 2 ** Math.max(0, attempt - 1));
    retryTimer = setTimeout(() => {
      retryTimer = null;
      open();
    }, delay);
  };

  const teardown = () => {
    if (es) {
      es.onopen = null;
      es.onerror = null;
      try {
        es.close();
      } catch {
        /* ignore */
      }
      es = null;
    }
  };

  function open() {
    if (closed) return;
    teardown();
    if (typeof EventSource === 'undefined') {
      console.warn('[api] EventSource not supported in this browser');
      return;
    }
    es = new EventSource(url);
    for (const type of STREAM_EVENTS) {
      es.addEventListener(type, (ev) => dispatch(type, ev));
    }
    es.onopen = () => {
      attempt = 0;
      status('open');
    };
    es.onerror = () => {
      if (closed) return;
      attempt += 1;
      status('reconnecting');
      // CLOSED means the browser will not retry by itself (HTTP error / bad content-type).
      if (!es || es.readyState === 2 /* CLOSED */) {
        teardown();
        scheduleReconnect();
      }
    };
  }

  open();

  return {
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      teardown();
    },
    /** Drop the current connection and reconnect immediately (manual "Retry now"). */
    reconnect() {
      if (closed) return;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      attempt = 0;
      open();
    },
  };
}
