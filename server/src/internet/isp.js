// ISP / public IP lookup.
//
// Primary: https://speed.cloudflare.com/meta (needs a Referer/Origin header, otherwise 403 `{}`).
// Fallback 1: https://ipinfo.io/json (HTTPS, no key needed at our 30 min refresh).
// Fallback 2: http://ip-api.com/json (free tier is HTTP only, i.e. unauthenticated plaintext: anyone on
//             the path could forge it, so it is the last resort and its result is marked unverified).
//
// Interface (PLAN.md §2.7):
//   fetchIsp({ timeoutMs = 5000 }) -> Promise<Isp>   (rejects if both sources fail)
//   Isp = { name, asn, ip, city, region, country, colo, source: 'cloudflare'|'ip-api', fetchedAt }
//
// Caching: successful results are cached in memory. Concurrent calls share one in-flight request, and a
// caller may pass `maxAgeMs` (extension, default 0 = always fetch) to accept a recent cached value.
// `getCachedIsp()` returns the last good value (or null).

const CF_META_URL = 'https://speed.cloudflare.com/meta';
const IPINFO_URL = 'https://ipinfo.io/json';
const IP_API_URL =
  'http://ip-api.com/json/?fields=status,message,country,countryCode,regionName,city,isp,org,as,query';

let cache = null; // { value: Isp, at: number (epoch ms) }
let inFlight = null;

const MAX_FIELD = 100;
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_FIELD) : null);

function toAsn(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = v.match(/(?:AS)?\s*(\d+)/i);
    if (m) return Number(m[1]);
  }
  return null;
}

async function getJson(url, { timeoutMs, headers }) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'NetMon/1.0', Accept: 'application/json', ...headers },
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

async function fromCloudflare(timeoutMs) {
  const j = await getJson(CF_META_URL, {
    timeoutMs,
    headers: { Referer: 'https://speed.cloudflare.com/', Origin: 'https://speed.cloudflare.com' },
  });
  const name = str(j.asOrganization);
  const ip = str(j.clientIp);
  if (!name && !ip) throw new Error('empty response');
  // `colo` is an object ({ iata, city, ... }) on the current API; older responses used a plain string.
  const colo = typeof j.colo === 'string' ? str(j.colo) : str(j.colo?.iata);
  return {
    name: name || 'Unknown ISP',
    asn: toAsn(j.asn),
    ip,
    city: str(j.city),
    region: str(j.region),
    country: str(j.country),
    colo: colo ? colo.toUpperCase() : null,
    source: 'cloudflare',
    fetchedAt: new Date().toISOString(),
  };
}

async function fromIpApi(timeoutMs) {
  const j = await getJson(IP_API_URL, { timeoutMs });
  if (j.status !== 'success') throw new Error(j.message || 'lookup failed');
  return {
    name: str(j.isp) || str(j.org) || 'Unknown ISP',
    asn: toAsn(j.as),
    ip: str(j.query),
    city: str(j.city),
    region: str(j.regionName),
    country: str(j.countryCode) || str(j.country),
    colo: null,
    source: 'ip-api',
    unverified: true, // plaintext HTTP source
    fetchedAt: new Date().toISOString(),
  };
}

async function fromIpinfo(timeoutMs) {
  const j = await getJson(IPINFO_URL, { timeoutMs });
  const org = str(j.org); // "AS7922 Comcast Cable Communications, LLC"
  const ip = str(j.ip);
  if (!org && !ip) throw new Error('empty response');
  return {
    name: (org ? org.replace(/^AS\d+\s+/i, '') : null) || 'Unknown ISP',
    asn: toAsn(org),
    ip,
    city: str(j.city),
    region: str(j.region),
    country: str(j.country),
    colo: null,
    source: 'ipinfo',
    fetchedAt: new Date().toISOString(),
  };
}

async function lookup(timeoutMs) {
  const errors = [];
  for (const [label, fn] of [
    ['cloudflare', fromCloudflare],
    ['ipinfo', fromIpinfo],
    ['ip-api', fromIpApi],
  ]) {
    try {
      const value = await fn(timeoutMs);
      cache = { value, at: Date.now() };
      return { ...value };
    } catch (err) {
      const reason = err?.name === 'TimeoutError' ? 'timeout' : err?.cause?.code || err?.message || String(err);
      errors.push(`${label}: ${reason}`);
    }
  }
  throw new Error(`isp_lookup_failed: ${errors.join('; ')}`);
}

/**
 * @param {{ timeoutMs?: number, maxAgeMs?: number }} [opts]
 * @returns {Promise<object>} Isp
 */
export async function fetchIsp({ timeoutMs = 5000, maxAgeMs = 0 } = {}) {
  if (maxAgeMs > 0 && cache && Date.now() - cache.at <= maxAgeMs) return { ...cache.value };
  if (!inFlight) {
    inFlight = lookup(timeoutMs).finally(() => {
      inFlight = null;
    });
  }
  const value = await inFlight;
  return { ...value };
}

/** Last successfully fetched Isp, or null. */
export function getCachedIsp() {
  return cache ? { ...cache.value } : null;
}
