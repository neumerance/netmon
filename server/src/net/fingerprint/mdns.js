/**
 * Passive + active mDNS / DNS-SD (Bonjour) browser built on the pure-JS
 * 'multicast-dns' package. Collects, per IPv4 address: the .local hostname,
 * advertised service types, instance names, the hardware model and a few
 * interesting TXT keys.
 *
 * Attribution: answers are attributed through the records themselves
 * (instance -> SRV target -> A record) and only fall back to the packet's
 * source address. That matters because Bonjour sleep proxies (Apple TV, HomePod)
 * answer on behalf of sleeping Macs and iPhones.
 *
 * The socket uses reuseAddr so it can coexist with mDNSResponder / avahi on
 * port 5353. If the socket cannot be opened the browser simply returns no data.
 */
import makeMdns from 'multicast-dns';
import { ipInCidr } from '../sys.js';

/** Service types queried directly on every browse (besides the meta query). */
export const KNOWN_SERVICES = [
  '_device-info._tcp', '_airplay._tcp', '_raop._tcp', '_companion-link._tcp', '_googlecast._tcp',
  '_ipp._tcp', '_ipps._tcp', '_printer._tcp', '_pdl-datastream._tcp', '_uscan._tcp', '_scanner._tcp',
  '_hap._tcp', '_homekit._tcp', '_sonos._tcp', '_spotify-connect._tcp', '_amzn-wplay._tcp', '_amzn-alexa._tcp',
  '_smb._tcp', '_afpovertcp._tcp', '_adisk._tcp', '_ssh._tcp', '_workstation._tcp', '_rfb._tcp',
  '_apple-mobdev2._tcp', '_androidtvremote2._tcp', '_hue._tcp', '_esphomelib._tcp', '_home-assistant._tcp',
  '_matter._tcp', '_airport._tcp', '_sleep-proxy._udp', '_googlezone._tcp', '_nvstream._tcp', '_axis-video._tcp',
  '_rtsp._tcp', '_http._tcp', '_qdiscover._tcp', '_mi-connect._udp', '_miio._udp', '_viziocast._tcp',
];

const META = '_services._dns-sd._udp.local';

// TXT keys worth keeping, per service (keys mean different things in different
// services: "md" is the model on _googlecast but a codec list on _raop).
const PRINTER_KEYS = ['ty', 'product', 'usb_mfg', 'usb_mdl', 'note'];
const SERVICE_TXT_KEYS = {
  '_googlecast._tcp': ['md', 'fn'],
  '_device-info._tcp': ['osxvers'],
  '_ipp._tcp': PRINTER_KEYS, '_ipps._tcp': PRINTER_KEYS, '_printer._tcp': PRINTER_KEYS, '_pdl-datastream._tcp': PRINTER_KEYS,
  '_hap._tcp': ['ci'],
  '_airplay._tcp': [], '_raop._tcp': [], '_companion-link._tcp': [],
};
const DEFAULT_TXT_KEYS = ['model', 'vendor', 'manufacturer', 'mfg', 'mdl', 'version'];

const MAX_ENTRIES = 1024;
const MAX_NAME_CACHE = 4096;
// Per-IP bounds: anything on the LAN can answer mDNS, and this data is persisted + broadcast.
const MAX_SERVICES_PER_IP = 32;
const MAX_INSTANCES_PER_IP = 8;
const MAX_LABEL_LEN = 64;
const MAX_HOSTNAME_LEN = 253;

const clipLabel = (v, n = MAX_LABEL_LEN) => (typeof v === 'string' && v.length > n ? v.slice(0, n) : v);

const lc = (s) => (typeof s === 'string' ? s.toLowerCase() : '');
const isIPv4 = (s) => typeof s === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(s);

/** '_ipp._tcp.local' -> '_ipp._tcp' */
export function normalizeService(name) {
  if (typeof name !== 'string') return null;
  const m = /(_[^.]+\._(?:tcp|udp))(?:\.local)?\.?$/i.exec(name);
  return m ? m[1] : null;
}

/** Split 'Jonathan’s MacBook Pro._airplay._tcp.local' into label + service. */
export function splitInstance(fullName) {
  if (typeof fullName !== 'string') return null;
  const m = /^(.*?)\.(_[^.]+\._(?:tcp|udp))\.local\.?$/i.exec(fullName);
  if (!m) return null;
  return { label: m[1], service: m[2] };
}

/** Parse multicast-dns TXT data (Buffer | Buffer[] | string) into a key/value map. */
export function parseTxt(data) {
  const out = {};
  const parts = Array.isArray(data) ? data : [data];
  for (const p of parts) {
    if (p == null) continue;
    const s = Buffer.isBuffer(p) ? p.toString('utf8') : String(p);
    const i = s.indexOf('=');
    if (i <= 0) continue;
    const k = s.slice(0, i).trim();
    const v = s.slice(i + 1).trim();
    if (k && !(k in out)) out[k] = v;
  }
  return out;
}

/** '94.0.0.10.in-addr.arpa' -> '10.0.0.94' */
function reverseNameToIp(name) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.in-addr\.arpa\.?$/i.exec(name || '');
  return m ? `${m[4]}.${m[3]}.${m[2]}.${m[1]}` : null;
}
function ipToReverseName(ip) {
  return `${ip.split('.').reverse().join('.')}.in-addr.arpa`;
}

/**
 * @param {object} o
 * @param {string|null} [o.interfaceIp]  IPv4 of the monitored interface (multicast egress)
 * @param {string|null} [o.cidr]         monitored subnet: answers/addresses outside it are ignored
 */
export function createMdnsBrowser({ onUpdate, windowMs = 4000, interfaceIp = null, cidr = null } = {}) {
  const onLan = (ip) => isIPv4(ip) && !ip.startsWith('127.') && (!cidr || ipInCidr(ip, cidr));
  let mdns = null;
  let started = false;
  let browsing = null; // in-flight browseNow promise
  let flushTimer = null;
  let warned = false;
  const timers = new Set();

  const byIp = new Map(); // ip -> entry
  const hostToIp = new Map(); // 'host.local' -> ip
  const instToHost = new Map(); // full instance name -> 'host.local'
  const labelToHost = new Map(); // instance label -> 'host.local'
  const seenServiceTypes = new Set();
  let browseQueried = null; // service types queried during the current browse
  const pending = new Set();

  function later(fn, ms) {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
    return t;
  }

  function entry(ip) {
    let e = byIp.get(ip);
    if (!e) {
      if (byIp.size >= MAX_ENTRIES) byIp.delete(byIp.keys().next().value);
      e = { hostname: null, services: new Set(), model: null, modelRank: 0, txt: {}, instanceNames: new Set() };
      byIp.set(ip, e);
    }
    return e;
  }

  function addService(e, svc) {
    if (!svc || e.services.has(svc) || e.services.size >= MAX_SERVICES_PER_IP) return;
    e.services.add(clipLabel(svc));
  }
  function addInstance(e, label) {
    if (!label || e.instanceNames.has(label) || e.instanceNames.size >= MAX_INSTANCES_PER_IP) return;
    e.instanceNames.add(clipLabel(label));
  }
  const cleanHost = (name) => clipLabel(String(name).replace(/\.$/, ''), MAX_HOSTNAME_LEN);

  function signature(e) {
    return e ? `${e.hostname}|${[...e.services].join(',')}|${e.model}|${JSON.stringify(e.txt)}|${[...e.instanceNames].join(',')}` : '';
  }

  function capMap(m) {
    if (m.size > MAX_NAME_CACHE) m.clear();
  }

  function setModel(e, value, rank) {
    if (!value || rank <= e.modelRank) return;
    e.model = value;
    e.modelRank = rank;
  }

  function resolveHostIp(host) {
    return host ? hostToIp.get(lc(host)) || null : null;
  }

  function resolveInstanceIp(fullName, senderIp) {
    const host = instToHost.get(lc(fullName));
    let ip = resolveHostIp(host);
    if (!ip) {
      const parts = splitInstance(fullName);
      // "CA3ADE1C5FC9@Jonathan’s MacBook Pro" (RAOP) shares the label after '@'.
      const label = parts ? lc(parts.label.replace(/^[0-9A-F]{12}@/i, '')) : null;
      if (label) ip = resolveHostIp(labelToHost.get(label));
    }
    return ip || senderIp;
  }

  function handleResponse(res, rinfo) {
    const sender = rinfo && onLan(rinfo.address) ? rinfo.address : null;
    if (!sender) return; // only the monitored LAN (no loopback / other links / VPN)
    const records = [...(res.answers || []), ...(res.additionals || []), ...(res.authorities || [])];
    const touched = new Map(); // ip -> signature before

    const touch = (ip) => {
      if (!ip || !onLan(ip)) return null;
      if (!touched.has(ip)) touched.set(ip, signature(byIp.get(ip)));
      return entry(ip);
    };

    // Pass 1: name -> address knowledge.
    for (const r of records) {
      if (!r || typeof r.name !== 'string') continue;
      if (r.type === 'A' && onLan(r.data)) {
        hostToIp.set(lc(r.name), r.data);
        capMap(hostToIp);
      } else if (r.type === 'SRV' && r.data && r.data.target) {
        instToHost.set(lc(r.name), lc(r.data.target));
        const parts = splitInstance(r.name);
        if (parts) labelToHost.set(lc(parts.label.replace(/^[0-9A-F]{12}@/i, '')), lc(r.data.target));
        capMap(instToHost);
        capMap(labelToHost);
      } else if (r.type === 'PTR' && typeof r.data === 'string') {
        const ip = reverseNameToIp(r.name);
        if (ip && onLan(ip)) {
          hostToIp.set(lc(r.data), ip);
          const e = touch(ip);
          if (e) e.hostname = cleanHost(r.data);
        }
      }
    }

    // Pass 2: attribute records to addresses.
    for (const r of records) {
      if (!r || typeof r.name !== 'string') continue;
      try {
        if (r.type === 'A' && isIPv4(r.data)) {
          const e = touch(r.data);
          if (!e) continue;
          if (!e.hostname || /\.local$/i.test(r.name)) e.hostname = cleanHost(r.name);
        } else if (r.type === 'PTR' && typeof r.data === 'string') {
          if (lc(r.name) === lc(META)) {
            const svc = normalizeService(r.data);
            if (!svc) continue;
            seenServiceTypes.add(svc);
            const se = touch(sender);
            if (se) addService(se, svc);
            if (browseQueried && !browseQueried.has(svc)) {
              browseQueried.add(svc);
              query([{ name: `${svc}.local`, type: 'PTR' }]);
            }
          } else if (!reverseNameToIp(r.name)) {
            const svc = normalizeService(r.name);
            const parts = splitInstance(r.data);
            if (!svc || !parts) continue;
            const ip = resolveInstanceIp(r.data, sender);
            const e = touch(ip);
            if (!e) continue;
            addService(e, svc);
            const label = parts.label.replace(/^[0-9A-F]{12}@/i, '');
            if (label) addInstance(e, label);
          }
        } else if (r.type === 'SRV' && r.data && r.data.target) {
          const parts = splitInstance(r.name);
          const ip = resolveHostIp(r.data.target) || sender;
          const e = touch(ip);
          if (!e || !parts) continue;
          addService(e, parts.service);
          if (!e.hostname) e.hostname = cleanHost(r.data.target);
        } else if (r.type === 'TXT') {
          const parts = splitInstance(r.name);
          if (!parts) continue;
          const ip = resolveInstanceIp(r.name, sender);
          const e = touch(ip);
          if (!e) continue;
          const svc = lc(parts.service);
          if (svc !== '_device-info._tcp') addService(e, parts.service);
          const kv = parseTxt(r.data);
          const allowed = SERVICE_TXT_KEYS[svc] || DEFAULT_TXT_KEYS;
          for (const [k, v] of Object.entries(kv)) {
            const key = lc(k);
            if (!allowed.includes(key) || !v || v.length > 120) continue;
            if (!(key in e.txt)) e.txt[key] = v;
          }
          const get = (name) => {
            const k = Object.keys(kv).find((x) => lc(x) === name);
            return k ? kv[k] : null;
          };
          const m = (name) => { const v = get(name); return v && v.length <= MAX_LABEL_LEN ? v : null; };
          if (svc === '_device-info._tcp') setModel(e, m('model'), 4);
          else if (svc === '_airplay._tcp') setModel(e, m('model'), 3);
          else if (svc === '_companion-link._tcp') setModel(e, m('rpmd'), 3);
          else if (svc === '_raop._tcp') setModel(e, m('am'), 2);
        }
      } catch {
        /* malformed record: ignore */
      }
    }

    for (const [ip, before] of touched) {
      if (signature(byIp.get(ip)) !== before) pending.add(ip);
    }
    if (pending.size && !flushTimer) {
      flushTimer = later(() => {
        flushTimer = null;
        const ips = [...pending];
        pending.clear();
        for (const ip of ips) {
          try { onUpdate?.(ip); } catch (err) { console.warn('[fingerprint/mdns] onUpdate failed:', err?.message || err); }
        }
      }, 300);
    }
  }

  function open() {
    if (mdns) return true;
    try {
      // `interface` pins multicast egress + membership to the monitored link; `bind` must stay 0.0.0.0
      // (binding 5353 to the unicast address stops multicast delivery on macOS/BSD).
      mdns = makeMdns(interfaceIp && isIPv4(interfaceIp)
        ? { reuseAddr: true, loopback: true, interface: interfaceIp, bind: '0.0.0.0' }
        : { reuseAddr: true, loopback: true });
      mdns.on('response', (res, rinfo) => {
        try { handleResponse(res, rinfo); } catch (err) { console.warn('[fingerprint/mdns] response handling failed:', err?.message || err); }
      });
      mdns.on('error', (err) => {
        if (!warned) {
          warned = true;
          console.warn('[fingerprint/mdns] socket error (mDNS disabled until next browse):', err?.message || err);
        }
        close();
      });
      mdns.on('warning', () => {});
      return true;
    } catch (err) {
      if (!warned) {
        warned = true;
        console.warn('[fingerprint/mdns] cannot open mDNS socket:', err?.message || err);
      }
      mdns = null;
      return false;
    }
  }

  function close() {
    const m = mdns;
    mdns = null;
    if (m) {
      try { m.removeAllListeners('response'); m.on('error', () => {}); m.destroy(); } catch { /* ignore */ }
    }
  }

  function query(questions) {
    if (!mdns) return;
    try {
      mdns.query({ questions }, (err) => { if (err && !warned) { warned = true; console.warn('[fingerprint/mdns] query failed:', err.message); } });
    } catch { /* socket closed underneath us */ }
  }

  function sendBrowseQueries() {
    query([{ name: META, type: 'PTR' }]);
    for (let i = 0; i < KNOWN_SERVICES.length; i += 10) {
      query(KNOWN_SERVICES.slice(i, i + 10).map((s) => ({ name: `${s}.local`, type: 'PTR' })));
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      open();
    },

    stop() {
      started = false;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      flushTimer = null;
      pending.clear();
      browseQueried = null;
      close();
    },

    /** Send the meta query + known-service queries (twice) and collect for windowMs. */
    browseNow() {
      if (browsing) return browsing;
      if (!started) return Promise.resolve();
      if (!mdns) { warned = false; open(); }
      browsing = new Promise((resolve) => {
        browseQueried = new Set(KNOWN_SERVICES);
        sendBrowseQueries();
        // Repeat: sleepy Wi-Fi devices often miss the first multicast query.
        later(() => { if (started) sendBrowseQueries(); }, 1000);
        later(() => { if (started) sendBrowseQueries(); }, 2500);
        later(() => {
          browseQueried = null;
          browsing = null;
          resolve();
        }, windowMs);
      });
      return browsing;
    },

    /** Ask the network for the .local name of one IP (reverse PTR); waits up to timeoutMs. */
    resolveIp(ip, { timeoutMs = 1200 } = {}) {
      if (!started || !isIPv4(ip)) return Promise.resolve(this.get(ip));
      if (!mdns) open();
      query([{ name: ipToReverseName(ip), type: 'PTR' }]);
      return new Promise((resolve) => {
        later(() => resolve(this.get(ip)), timeoutMs);
      });
    },

    /** MdnsInfo for an IP, or null when nothing was heard from it. */
    get(ip) {
      const e = byIp.get(ip);
      if (!e) return null;
      return {
        hostname: e.hostname,
        services: [...e.services].sort(),
        model: e.model,
        txt: { ...e.txt },
        instanceNames: [...e.instanceNames],
      };
    },

    /** Service types seen anywhere on the LAN (diagnostics). */
    serviceTypes() {
      return [...seenServiceTypes].sort();
    },
  };
}
