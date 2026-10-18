// /api/router/* — router integration (syslog receiver + SNMP poller). Mounted by routes/api.js.
//
//   GET    /router              { config, status, ports }   (config never contains the SNMP community)
//   PUT    /router/config       partial { syslog?: {...}, snmp?: {...} } -> { config, status, ports }
//   GET    /router/log          ?limit=1..2000&severity=0..7&q=text -> { entries } newest first
//   DELETE /router/log          -> { ok: true }
//   POST   /router/snmp/test    { host?, community? } -> { ok, host, system?, ports?, error? }

import { validateRouterConfig, isIPv4 } from '../core/routerStore.js';

function sendError(res, status, error, message, details) {
  const body = { error, message };
  if (details) body.details = details;
  res.status(status).json(body);
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function mountRouterRoutes(router, { routerStore, monitor, eventLog, broadcast }) {
  router.get('/router', (req, res) => res.json(monitor.getPublic()));

  router.put('/router/config', wrap(async (req, res) => {
    const v = validateRouterConfig(req.body);
    if (!v.ok) return sendError(res, 400, 'validation', 'Invalid router settings', v.errors);
    const before = routerStore.publicConfig();
    routerStore.updateConfig(v.value);
    const after = routerStore.publicConfig();
    const changes = [];
    for (const section of ['syslog', 'snmp']) {
      for (const [k, val] of Object.entries(after[section])) {
        if (before[section][k] !== val && k !== 'communityFromEnv') changes.push(k === 'communitySet' ? 'snmp community' : `${section}.${k} = ${val}`);
      }
    }
    if (v.value.snmp && 'community' in v.value.snmp && !changes.includes('snmp community')) changes.push('snmp community');
    if (changes.length) {
      eventLog.add({ type: 'settings_changed', level: 'info', message: `Router settings updated: ${changes.join(', ')}` });
    }
    await monitor.apply();
    const body = monitor.getPublic();
    broadcast('router', body);
    res.json(body);
  }));

  router.get('/router/log', (req, res) => {
    const limit = Math.min(2000, Math.max(1, Number.parseInt(req.query.limit, 10) || 200));
    const sev = Number.parseInt(req.query.severity, 10);
    const maxSeverity = Number.isInteger(sev) && sev >= 0 && sev <= 7 ? sev : 7;
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
    res.json({ entries: routerStore.getLog({ limit, maxSeverity, q }) });
  });

  router.delete('/router/log', (req, res) => {
    routerStore.clearLog();
    broadcast('routerLog', { cleared: true });
    res.json({ ok: true });
  });

  router.post('/router/snmp/test', wrap(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const errors = {};
    if (body.host !== undefined && body.host !== '' && !isIPv4(body.host)) errors.host = 'Must be an IPv4 address';
    if (body.community !== undefined && (typeof body.community !== 'string' || body.community.length > 64)) errors.community = 'Must be text (at most 64 characters)';
    if (Object.keys(errors).length) return sendError(res, 400, 'validation', 'Invalid test parameters', errors);
    res.json(await monitor.testSnmp({ host: body.host || undefined, community: body.community || undefined }));
  }));
}
