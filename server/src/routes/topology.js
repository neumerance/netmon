// /api/topology routes (docs/TOPOLOGY.md §7.2). Not mounted on its own: routes/api.js calls
// `mountTopologyRoutes(router, ctx)` inside createApiRouter, after `express.json()` and BEFORE the
// 404 fallback.
//
//   GET    /api/topology                       200 { overrides }
//   PUT    /api/topology/:mac                  200 { mac, override: Override|null, overrides }
//                                              400 validation (details per field) | 404 not_found
//   DELETE /api/topology?scope=positions|all   200 { ok: true, overrides }   (default scope: positions)
//                                              400 validation (bad scope)
//
// Every successful PUT/DELETE broadcasts SSE `topology` { overrides }. No event-log entries: layout
// edits are not network events.

import express from 'express';
import {
  RESET_SCOPES, buildTopologyPayload, normalizeMacInput, validateTopologyPatch,
} from '../core/topology.js';

/** Same JSON error shape as routes/api.js: { error, message, details? }. */
function sendError(res, status, error, message, details) {
  const body = { error, message };
  if (details) body.details = details;
  res.status(status).json(body);
}

/**
 * @param {import('express').Router} router  the /api router (createApiRouter's)
 * @param {object} ctx
 * @param {object} ctx.state     core/state.js (getDevices, broadcast)
 * @param {object} ctx.store     core/store.js (getSaved)
 * @param {object} ctx.devices   core/devices.js manager (has)
 * @param {object} ctx.topology  createTopologyStore() instance
 * @returns the router (chainable)
 */
export function mountTopologyRoutes(router, { state, store, devices, topology }) {
  if (!topology) throw new TypeError('mountTopologyRoutes: ctx.topology is required');

  // No-op when the parent router already parsed the body (express.json skips parsed requests);
  // keeps this module usable on a bare router in tests.
  const json = express.json({ limit: '16kb' });

  const broadcast = () => {
    const payload = buildTopologyPayload(topology.getOverrides());
    try { state?.broadcast?.('topology', payload); } catch (err) { console.warn(`[topology] broadcast failed: ${err.message}`); }
    return payload;
  };

  router.get('/topology', (req, res) => {
    res.json(buildTopologyPayload(topology.getOverrides()));
  });

  router.put('/topology/:mac', json, (req, res) => {
    const mac = normalizeMacInput(req.params.mac);
    if (!mac) return sendError(res, 400, 'validation', 'Invalid MAC address', { mac: 'Invalid MAC address' });
    // A MAC that still has a stored override is "known" too, so a stale entry (device gone, never saved)
    // can still be cleared with { parentMac: null, position: null } instead of answering 404.
    const known = Boolean(devices?.has?.(mac)) || Boolean(store?.getSaved?.(mac)) || Boolean(topology.getOverride(mac));
    const v = validateTopologyPatch(mac, req.body, {
      devices: state?.getDevices?.() ?? [],
      overrides: topology.getOverrides(),
      known,
    });
    if (!v.ok) {
      if (v.status === 404) return sendError(res, 404, 'not_found', 'Device not found');
      return sendError(res, 400, 'validation', 'Invalid topology data', v.errors);
    }
    const override = topology.applyPatch(mac, v.value);
    const { overrides } = broadcast();
    res.json({ mac, override, overrides });
  });

  router.delete('/topology', (req, res) => {
    const raw = req.query.scope;
    const scope = raw === undefined || raw === '' ? 'positions' : raw;
    if (typeof scope !== 'string' || !RESET_SCOPES.includes(scope)) {
      return sendError(res, 400, 'validation', 'Invalid scope', { scope: `Scope must be one of: ${RESET_SCOPES.join(', ')}` });
    }
    topology.reset({ scope });
    const { overrides } = broadcast();
    res.json({ ok: true, overrides });
  });

  return router;
}
