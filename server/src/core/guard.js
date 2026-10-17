// HTTP request guard for /api (DNS-rebinding + cross-site request protection, optional token).
//
// NetMon has no user accounts: by default it binds 127.0.0.1 and trusts the local browser. That is only
// safe if a *web page* cannot talk to it:
//   - DNS rebinding: evil.example re-resolves to 127.0.0.1, so the browser treats the API as same-origin.
//     The Host header still says "evil.example" -> rejected unless it names a loopback / configured host.
//   - Cross-site "simple" requests (form posts, text/plain fetch) need no CORS preflight -> rejected when
//     the Origin (or Sec-Fetch-Site) says the request came from another site, and every POST/PUT must be
//     JSON (a cross-site page cannot send application/json without a preflight we never answer).
//   - Optional shared token (NETMON_TOKEN) for LAN exposure (HOST=0.0.0.0): header X-NetMon-Token,
//     query ?token= (EventSource cannot set headers) or cookie netmon_token.

import os from 'node:os';
import crypto from 'node:crypto';

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isLoopbackHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/** Split a Host header value into its hostname (lowercase, IPv6 brackets removed). */
export function hostnameOf(hostHeader) {
  const v = String(hostHeader || '').trim().toLowerCase();
  if (!v) return '';
  if (v.startsWith('[')) {
    const end = v.indexOf(']');
    return end > 0 ? v.slice(1, end) : v;
  }
  const i = v.lastIndexOf(':');
  return i > 0 && v.indexOf(':') === i ? v.slice(0, i) : v;
}

function localAddresses() {
  const out = new Set();
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) if (a?.address) out.add(String(a.address).toLowerCase());
    }
  } catch { /* ignore */ }
  try {
    const h = os.hostname().toLowerCase();
    if (h) { out.add(h); out.add(h.replace(/\.local$/, '')); out.add(`${h.replace(/\.local$/, '')}.local`); }
  } catch { /* ignore */ }
  return out;
}

/**
 * @param {object} o
 * @param {string} o.host          the configured bind HOST
 * @param {boolean} [o.allowLan]   HOST is a non-loopback address the user opted into
 * @param {string|null} [o.token]  shared secret required on every /api request when set
 * @param {string[]} [o.extraHosts] NETMON_ALLOWED_HOSTS
 */
export function createApiGuard({ host, allowLan = false, token = null, extraHosts = [] }) {
  const configured = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  const wildcard = configured === '0.0.0.0' || configured === '::' || configured === '';
  const extra = new Set(extraHosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean));
  let lanNames = null;
  let lanNamesAt = 0;

  function hostAllowed(name) {
    if (!name) return false;
    if (isLoopbackHost(name) || LOOPBACK_NAMES.has(name)) return true;
    if (extra.has(name)) return true;
    if (name === configured && !wildcard) return true;
    if (allowLan) {
      // Interfaces change (Wi-Fi roaming), so refresh the list at most every 30 s.
      if (!lanNames || Date.now() - lanNamesAt > 30_000) { lanNames = localAddresses(); lanNamesAt = Date.now(); }
      if (lanNames.has(name)) return true;
    }
    return false;
  }

  function originAllowed(origin) {
    if (!origin || origin === 'null') return origin !== 'null';
    try {
      const u = new URL(origin);
      return hostAllowed(u.hostname.toLowerCase().replace(/^\[|\]$/g, ''));
    } catch {
      return false;
    }
  }

  function tokenFrom(req) {
    const h = req.get('x-netmon-token');
    if (h) return h;
    if (typeof req.query?.token === 'string') return req.query.token;
    const cookie = req.get('cookie') || '';
    const m = /(?:^|;\s*)netmon_token=([^;]+)/.exec(cookie);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function tokenOk(given) {
    if (!token) return true;
    if (typeof given !== 'string') return false;
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  const deny = (res, status, error, message) => res.status(status).json({ error, message });

  return function apiGuard(req, res, next) {
    if (!hostAllowed(hostnameOf(req.get('host')))) {
      return deny(res, 403, 'forbidden_host', 'Requests must address NetMon by localhost or its configured host name');
    }
    if (!tokenOk(tokenFrom(req))) return deny(res, 401, 'unauthorized', 'Missing or wrong NetMon token');

    if (STATE_CHANGING.has(req.method)) {
      const origin = req.get('origin');
      if (origin !== undefined && !originAllowed(origin)) {
        return deny(res, 403, 'forbidden_origin', 'Cross-site requests are not allowed');
      }
      const site = req.get('sec-fetch-site');
      if (site === 'cross-site') return deny(res, 403, 'forbidden_origin', 'Cross-site requests are not allowed');
      if ((req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') && !req.is('application/json')) {
        return deny(res, 415, 'unsupported_media_type', 'Request body must be JSON (Content-Type: application/json)');
      }
    }
    return next();
  };
}
