// Express router for /api/* (PLAN §3). All errors are JSON: { error, message, details? }.

import express from 'express';
import { normalizeMac } from '../net/sys.js';
import { validateSettings } from '../core/settings.js';
import { mountTopologyRoutes } from './topology.js';

// Pinned in PLAN §2.6 / §4.8 (kept locally so the API layer does not depend on the fingerprint package).
export const CATEGORIES = ['computer', 'laptop', 'phone', 'tablet', 'router', 'access_point', 'network_switch', 'tv',
  'media_player', 'speaker', 'printer', 'camera', 'console', 'nas', 'server', 'smart_home', 'wearable', 'unknown'];

const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Accepts colons, dashes, url-encoded colons, any case, unpadded octets. Returns canonical form or null. */
export function parseMac(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  try { s = decodeURIComponent(s); } catch { /* keep as-is */ }
  let mac = null;
  try { mac = normalizeMac(s); } catch { mac = null; }
  if (typeof mac !== 'string') return null;
  mac = mac.toLowerCase();
  return MAC_RE.test(mac) ? mac : null;
}

function sendError(res, status, error, message, details) {
  const body = { error, message };
  if (details) body.details = details;
  res.status(status).json(body);
}

function parseLimit(raw, def, max) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

function validateDeviceBody(body) {
  const errors = {};
  const value = {};
  if (!isPlainObject(body)) return { ok: false, errors: { _: 'Body must be a JSON object' } };

  if (typeof body.name !== 'string') errors.name = 'Name is required';
  else {
    const name = body.name.trim();
    if (name.length < 1) errors.name = 'Name is required';
    else if (name.length > 64) errors.name = 'Name must be at most 64 characters';
    else value.name = name;
  }

  if (body.type === undefined || body.type === null || body.type === '') value.type = null;
  else if (typeof body.type !== 'string' || !CATEGORIES.includes(body.type)) errors.type = 'Unknown device type';
  else value.type = body.type;

  if (body.notes === undefined || body.notes === null) value.notes = '';
  else if (typeof body.notes !== 'string') errors.notes = 'Notes must be text';
  else if (body.notes.length > 500) errors.notes = 'Notes must be at most 500 characters';
  else value.notes = body.notes;

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

/** Async route wrapper: unexpected errors become a JSON 500 instead of crashing. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * @param {object} ctx
 * @param {object} ctx.state, ctx.store, ctx.devices, ctx.speed, ctx.eventLog, ctx.sseHub
 * @param {boolean} ctx.mock
 * @param {string} ctx.version
 * @param {(patch: object) => object} [ctx.applyMockState]  mock mode only; returns MockState
 * @param {() => void} ctx.onSettingsChanged  (prev, next) hook for rescheduling etc.
 * @param {object} [ctx.topology]  core/topology.js store; mounts GET/PUT/DELETE /topology when present
 */
export function createApiRouter(ctx) {
  const { state, store, devices, speed, eventLog, sseHub, mock, version } = ctx;
  const router = express.Router();

  router.use(express.json({ limit: '64kb' }));

  // --------------------------------------------------------------- health / snapshot
  router.get('/health', (req, res) => {
    res.json({
      ok: true,
      mock,
      version,
      startedAt: state.startedAt,
      uptimeSec: Math.round(process.uptime()),
      clients: sseHub.clientCount(),
    });
  });

  router.get('/snapshot', (req, res) => res.json(state.getSnapshot()));

  router.get('/stream', (req, res) => sseHub.handler(req, res));

  // --------------------------------------------------------------- devices
  router.get('/devices', (req, res) => res.json({ devices: state.getDevices() }));

  router.put('/devices/:mac', (req, res) => {
    const mac = parseMac(req.params.mac);
    if (!mac) return sendError(res, 400, 'validation', 'Invalid MAC address', { mac: 'Invalid MAC address' });
    if (!devices.has(mac) && !store.getSaved(mac)) return sendError(res, 404, 'not_found', 'Device not found');
    const v = validateDeviceBody(req.body);
    if (!v.ok) return sendError(res, 400, 'validation', 'Invalid device data', v.errors);

    const wasSaved = Boolean(store.getSaved(mac));
    const ip = devices.get(mac)?.ip ?? null;
    store.upsertSaved(mac, { ...v.value, ...(ip ? { lastIp: ip } : {}) });
    eventLog.add({
      type: 'device_saved', level: 'info',
      message: wasSaved ? `Updated saved device "${v.value.name}"` : `Saved device "${v.value.name}"`,
      mac, data: { name: v.value.name, type: v.value.type },
    });
    devices.onSavedChanged(mac);
    res.json({ device: devices.get(mac) });
  });

  router.delete('/devices/:mac', (req, res) => {
    const mac = parseMac(req.params.mac);
    if (!mac) return sendError(res, 400, 'validation', 'Invalid MAC address', { mac: 'Invalid MAC address' });
    const saved = store.getSaved(mac);
    if (!saved) return sendError(res, 404, 'not_found', 'Device is not saved');
    store.removeSaved(mac);
    eventLog.add({ type: 'device_forgotten', level: 'info', message: `Forgot device "${saved.name}"`, mac, data: { name: saved.name } });
    devices.onForgotten(mac);
    // A forgotten device that has left the network disappears from the list: drop its pinned position
    // and "Connected via" too, so stale entries don't pile up in topology.json and every topology payload.
    // (An online device keeps its layout: it is still on the map.)
    if (!devices.has(mac) && ctx.topology?.removeOverride?.(mac)) {
      state.broadcast('topology', { overrides: ctx.topology.getOverrides() });
    }
    res.json({ ok: true });
  });

  router.post('/devices/:mac/fingerprint', wrap(async (req, res) => {
    const mac = parseMac(req.params.mac);
    if (!mac) return sendError(res, 400, 'validation', 'Invalid MAC address', { mac: 'Invalid MAC address' });
    if (!devices.has(mac)) return sendError(res, 404, 'not_found', 'Device not found');
    if (!devices.isOnline(mac)) return sendError(res, 409, 'offline', 'Device is offline');
    const device = await devices.refingerprint(mac, { timeoutMs: 15000 });
    if (!device) return sendError(res, 404, 'not_found', 'Device not found');
    res.json({ device });
  }));

  // --------------------------------------------------------------- speed test
  router.post('/speedtest', (req, res) => {
    // Manual tests are never blocked: no cooldown, and they run even while the probe says the internet is
    // down (the test itself then reports whether it could connect). Only one test runs at a time.
    const r = speed.run('manual', { ignoreInternetDown: true });
    if (r.ok) return res.status(202).json({ ok: true, started: true });
    if (r.error === 'speedtest_running') return sendError(res, 409, 'speedtest_running', 'A speed test is already running');
    return sendError(res, 500, 'internal', 'Could not start speed test');
  });

  router.get('/speedtest/history', (req, res) => {
    const limit = parseLimit(req.query.limit, 200, 200);
    res.json({ history: store.getSpeedHistory().slice(-limit) });
  });

  // --------------------------------------------------------------- settings
  router.get('/settings', (req, res) => res.json(store.getSettings()));

  router.put('/settings', (req, res) => {
    const v = validateSettings(req.body);
    if (!v.ok) return sendError(res, 400, 'validation', 'Invalid settings', v.errors);
    const prev = store.getSettings();
    const next = store.setSettings(v.value);
    const changedKeys = Object.keys(v.value).filter((k) => prev[k] !== next[k]);
    if (changedKeys.length) {
      eventLog.add({
        type: 'settings_changed', level: 'info',
        message: `Settings updated: ${changedKeys.map((k) => `${k} = ${next[k]}`).join(', ')}`,
        data: Object.fromEntries(changedKeys.map((k) => [k, next[k]])),
      });
    }
    ctx.onSettingsChanged?.(prev, next, changedKeys);
    state.broadcast('settings', next);
    res.json(next);
  });

  // --------------------------------------------------------------- events
  router.get('/events', (req, res) => {
    const limit = parseLimit(req.query.limit, 100, 500);
    res.json({ events: eventLog.list(limit) });
  });

  // --------------------------------------------------------------- mock control
  router.post('/mock/state', wrap(async (req, res) => {
    if (!mock || typeof ctx.applyMockState !== 'function') return sendError(res, 404, 'not_found', 'Not in mock mode');
    const v = validateMockBody(req.body ?? {});
    if (!v.ok) return sendError(res, 400, 'validation', 'Invalid mock state', v.errors);
    let mockState;
    try {
      // May return a promise: a reset resolves once the rescan + fingerprinting has settled, so the
      // state right after the 200 is deterministic (all mock devices listed and typed).
      mockState = await ctx.applyMockState(v.value);
    } catch (err) {
      const isValidation = err?.code === 'validation' || err?.status === 400;
      if (!isValidation) console.warn(`[api] mock state failed: ${err?.stack || err}`);
      return sendError(res, isValidation ? 400 : 500, isValidation ? 'validation' : 'internal',
        isValidation ? 'Invalid mock state' : 'Mock state update failed', err?.details);
    }
    res.json({ ok: true, mock: mockState });
  }));

  // --------------------------------------------------------------- topology (docs/TOPOLOGY.md §7.2)
  if (ctx.topology) mountTopologyRoutes(router, { state, store, devices, topology: ctx.topology });

  // --------------------------------------------------------------- fallbacks
  router.use((req, res) => sendError(res, 404, 'not_found', `No route for ${req.method} /api${req.path}`));

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err?.type === 'entity.parse.failed') return sendError(res, 400, 'invalid_json', 'Request body is not valid JSON');
    if (err?.type === 'entity.too.large') return sendError(res, 413, 'too_large', 'Request body too large');
    console.warn(`[api] ${req.method} ${req.originalUrl} failed: ${err?.stack || err}`);
    if (res.headersSent) return;
    sendError(res, 500, 'internal', 'Internal server error');
  });

  return router;
}

function validateMockBody(body) {
  if (!isPlainObject(body)) return { ok: false, errors: { _: 'Body must be a JSON object' } };
  const errors = {};
  const value = {};
  for (const [key, v] of Object.entries(body)) {
    switch (key) {
      case 'internetDown': case 'newDevice': case 'reset':
        if (typeof v !== 'boolean') errors[key] = 'Must be true or false';
        else value[key] = v;
        break;
      case 'downloadMbps': case 'uploadMbps':
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) errors[key] = 'Must be a number > 0';
        else value[key] = v;
        break;
      case 'devicesOffline': {
        if (!Array.isArray(v)) { errors[key] = 'Must be an array of MAC addresses'; break; }
        const macs = v.map((m) => parseMac(m));
        if (macs.some((m) => !m)) errors[key] = 'Contains an invalid MAC address';
        else value[key] = [...new Set(macs)];
        break;
      }
      default:
        break; // unknown keys are ignored (same leniency as mock/state.js)
    }
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}
