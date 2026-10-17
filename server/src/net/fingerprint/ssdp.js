/**
 * SSDP / UPnP discovery over plain dgram. Sends M-SEARCH (ssdp:all and
 * upnp:rootdevice), also listens for NOTIFY announcements when port 1900 can be
 * shared, then fetches each device's LOCATION description XML (2 s timeout) and
 * regex-parses deviceType, friendlyName, manufacturer, modelName, modelNumber.
 *
 * Only LOCATION URLs that point back at the announcing LAN address are fetched,
 * so a device cannot make the server fetch arbitrary hosts.
 */
import dgram from 'node:dgram';
import { isValidIpv4, ipInCidr } from '../sys.js';

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const FETCH_TIMEOUT_MS = 2000;
const MAX_XML_BYTES = 64 * 1024;
const MAX_FIELD_LEN = 128;
const MAX_LOCATIONS_PER_IP = 4;
const MAX_FETCH_QUEUE = 64;
const MAX_SERVER_HEADER = 160;
const MAX_DEVICE_TYPES = 16;
const REFETCH_OK_MS = 30 * 60 * 1000;
const REFETCH_FAIL_MS = 5 * 60 * 1000;
const FETCH_CONCURRENCY = 4;

function mSearch(st, mx = 2) {
  return Buffer.from(
    'M-SEARCH * HTTP/1.1\r\n'
    + `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n`
    + 'MAN: "ssdp:discover"\r\n'
    + `MX: ${mx}\r\n`
    + `ST: ${st}\r\n`
    + 'USER-AGENT: NetMon/1.0 UPnP/1.1\r\n\r\n',
  );
}

/** Parse an SSDP datagram's headers into a lowercase-keyed object. */
export function parseSsdpMessage(text) {
  const lines = String(text).split(/\r?\n/);
  const headers = { _start: lines[0] || '' };
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return headers;
}

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();
}

/**
 * Linear-time element extraction (no backtracking regex over the whole body): finds `<name>` or
 * `<ns:name>` openings with indexOf and the matching close within a bounded window.
 */
function* elements(body, name, max = Infinity) {
  const lower = body.toLowerCase();
  const needle = name.toLowerCase();
  let from = 0;
  let count = 0;
  let nextClose = -2; // cached position of the next '</' (positions only move forward -> linear overall)
  while (count < max) {
    const at = lower.indexOf(`${needle}>`, from);
    if (at < 0) return;
    from = at + needle.length + 1;
    // Opening tag: '<name>' or '<prefix:name>' immediately before.
    const lt = lower.lastIndexOf('<', at);
    if (lt < 0 || at - lt > 33) continue;
    const prefix = lower.slice(lt + 1, at);
    if (!(prefix === '' || (/^[a-z0-9_]+:$/.test(prefix)))) continue;
    if (nextClose !== -1 && nextClose < from) nextClose = lower.indexOf('</', from);
    if (nextClose === -1) return; // no closing tag anywhere after this point
    const close = nextClose;
    if (close - from > 4096) continue;
    const end = lower.indexOf('>', close);
    if (end < 0 || end - close > 40) continue;
    const closeName = lower.slice(close + 2, end).replace(/^[a-z0-9_]+:/, '');
    if (closeName !== needle) continue;
    count++;
    yield body.slice(from, close);
    from = end + 1;
  }
}

const clipField = (v) => (v && v.length > MAX_FIELD_LEN ? `${v.slice(0, MAX_FIELD_LEN - 1)}…` : v);

/**
 * Parse the root <device> of a UPnP description. Returns
 * { deviceType, friendlyName, manufacturer, modelName, modelNumber, modelDescription, deviceTypes }.
 */
export function parseDescriptionXml(xml) {
  const text = String(xml || '').slice(0, MAX_XML_BYTES);
  const start = text.search(/<device[\s>]/i);
  const body = start >= 0 ? text.slice(start) : text;
  const tag = (name) => {
    for (const raw of elements(body, name, 1)) {
      const v = clipField(decodeEntities(raw));
      return v || null;
    }
    return null;
  };
  const deviceTypes = [...elements(body, 'deviceType', MAX_DEVICE_TYPES)]
    .map((v) => clipField(decodeEntities(v)))
    .filter(Boolean);
  return {
    deviceType: tag('deviceType'),
    friendlyName: tag('friendlyName'),
    manufacturer: tag('manufacturer'),
    modelName: tag('modelName'),
    modelNumber: tag('modelNumber'),
    modelDescription: tag('modelDescription'),
    deviceTypes: [...new Set(deviceTypes)],
  };
}

/** Relative importance of a device type when one IP exposes several roots. */
function typeRank(deviceType) {
  const t = deviceType || '';
  if (/InternetGatewayDevice/i.test(t)) return 10;
  if (/WLANAccessPointDevice/i.test(t)) return 9;
  if (/ZonePlayer/i.test(t)) return 9;
  if (/MediaRenderer/i.test(t)) return 8;
  if (/Printer/i.test(t)) return 8;
  if (/WFADevice/i.test(t)) return 7;
  if (/dial-multiscreen/i.test(t)) return 6;
  if (/MediaServer/i.test(t)) return 5;
  if (/Basic/i.test(t)) return 2;
  return 3;
}

function safeLocation(location, ip, avoidPort = null) {
  try {
    if (typeof location !== 'string' || location.length > 512) return null;
    const u = new URL(location);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.hostname !== ip) return null; // only fetch from the device that announced it
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    if (!Number.isInteger(port) || port < 1 || port > 65535 || port === avoidPort) return null;
    return u.toString();
  } catch {
    return null;
  }
}

async function fetchDescription(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'manual' });
  if (!res.ok) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    throw new Error(`HTTP ${res.status}`);
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of res.body) {
    size += chunk.byteLength;
    if (size > MAX_XML_BYTES) break;
    chunks.push(Buffer.from(chunk));
  }
  return parseDescriptionXml(Buffer.concat(chunks).toString('utf8'));
}

/**
 * @param {object} o
 * @param {string|null} [o.interfaceIp]  IPv4 of the monitored interface (multicast egress + membership)
 * @param {string|null} [o.cidr]         monitored subnet: datagrams from elsewhere are dropped
 * @param {string|null} [o.selfIp]       this host (never fetched)
 */
export function createSsdpBrowser({ onUpdate, windowMs = 3000, interfaceIp = null, cidr = null, selfIp = null } = {}) {
  const avoidPort = Number.parseInt(process.env.PORT, 10) || 4000;
  const fromLan = (ip) => isValidIpv4(ip) && !ip.startsWith('127.') && ip !== selfIp && (!cidr || ipInCidr(ip, cidr));
  let sock = null;
  let notifySock = null;
  let started = false;
  let searching = null;
  let warned = false;
  const timers = new Set();

  // ip -> { servers: Map(location -> server), descs: Map(location -> desc), fetchedAt: Map(location -> {at, ok}) }
  const byIp = new Map();
  const fetchQueue = [];
  const inFlight = new Set();
  let activeFetches = 0;
  const idleWaiters = [];

  function later(fn, ms) {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
    return t;
  }

  function record(ip) {
    let r = byIp.get(ip);
    if (!r) {
      if (byIp.size >= 1024) byIp.delete(byIp.keys().next().value);
      r = { servers: new Map(), descs: new Map(), fetchedAt: new Map() };
      byIp.set(ip, r);
    }
    return r;
  }

  function merged(ip) {
    const r = byIp.get(ip);
    if (!r) return null;
    const locations = [...new Set([...r.servers.keys(), ...r.descs.keys()])];
    if (!locations.length) return null;
    let best = null;
    let bestRank = -1;
    for (const loc of locations) {
      const d = r.descs.get(loc);
      const rank = d ? typeRank(d.deviceType) + 1 : 0;
      if (rank > bestRank) { best = loc; bestRank = rank; }
    }
    const d = r.descs.get(best) || {};
    const allTypes = new Set();
    for (const desc of r.descs.values()) for (const t of desc.deviceTypes || []) allTypes.add(t);
    return {
      server: r.servers.get(best) || [...r.servers.values()][0] || null,
      location: best,
      deviceType: d.deviceType || null,
      friendlyName: d.friendlyName || null,
      manufacturer: d.manufacturer || null,
      modelName: d.modelName || null,
      modelNumber: d.modelNumber || null,
      modelDescription: d.modelDescription || null,
      deviceTypes: [...allTypes],
      servers: [...new Set(r.servers.values())].filter(Boolean),
    };
  }

  function notify(ip) {
    try { onUpdate?.(ip); } catch (err) { console.warn('[fingerprint/ssdp] onUpdate failed:', err?.message || err); }
  }

  function pumpFetches() {
    while (started && activeFetches < FETCH_CONCURRENCY && fetchQueue.length) {
      const { ip, url } = fetchQueue.shift();
      activeFetches++;
      const before = JSON.stringify(merged(ip));
      fetchDescription(url)
        .then((desc) => {
          const r = record(ip);
          r.descs.set(url, desc);
          r.fetchedAt.set(url, { at: Date.now(), ok: true });
        })
        .catch(() => {
          record(ip).fetchedAt.set(url, { at: Date.now(), ok: false });
        })
        .finally(() => {
          activeFetches--;
          inFlight.delete(url);
          if (started && JSON.stringify(merged(ip)) !== before) notify(ip);
          pumpFetches();
          if (activeFetches === 0 && fetchQueue.length === 0) {
            while (idleWaiters.length) idleWaiters.shift()();
          }
        });
    }
  }

  function handleMessage(msg, rinfo) {
    if (!rinfo || !rinfo.address || !fromLan(rinfo.address)) return;
    if (msg.length > 4096) return;
    const h = parseSsdpMessage(msg.toString('utf8'));
    const isNotify = /^NOTIFY/i.test(h._start);
    if (isNotify && /byebye/i.test(h.nts || '')) return;
    if (!h.location) return;
    const ip = rinfo.address;
    const url = safeLocation(h.location, ip, avoidPort);
    if (!url) return;
    const r = record(ip);
    const hadServer = r.servers.has(url);
    // A device has a handful of root descriptions at most; ignore an endless stream of new LOCATIONs.
    if (!hadServer && r.servers.size >= MAX_LOCATIONS_PER_IP) return;
    const server = typeof h.server === 'string' ? h.server.slice(0, MAX_SERVER_HEADER) : null;
    r.servers.set(url, server || r.servers.get(url) || null);
    const last = r.fetchedAt.get(url);
    const stale = !last || Date.now() - last.at > (last.ok ? REFETCH_OK_MS : REFETCH_FAIL_MS);
    if (stale && !inFlight.has(url) && fetchQueue.length < MAX_FETCH_QUEUE) {
      inFlight.add(url);
      fetchQueue.push({ ip, url });
      pumpFetches();
    } else if (!hadServer) {
      notify(ip);
    }
  }

  function open() {
    if (!sock) {
      try {
        sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        sock.on('message', (m, r) => { try { handleMessage(m, r); } catch { /* ignore */ } });
        sock.on('error', (err) => {
          if (!warned) { warned = true; console.warn('[fingerprint/ssdp] socket error:', err?.message || err); }
          closeSock();
        });
        sock.bind(0, () => {
          if (interfaceIp && isValidIpv4(interfaceIp)) {
            try { sock?.setMulticastInterface(interfaceIp); } catch { /* fall back to the kernel route */ }
          }
        });
      } catch (err) {
        if (!warned) { warned = true; console.warn('[fingerprint/ssdp] cannot open socket:', err?.message || err); }
        sock = null;
      }
    }
    if (!notifySock) {
      // Passive NOTIFY listener on 1900; optional (fails quietly if not shareable).
      try {
        const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        notifySock = s;
        s.on('message', (m, r) => { try { handleMessage(m, r); } catch { /* ignore */ } });
        s.on('error', () => { closeNotify(); });
        s.bind(SSDP_PORT, () => {
          try {
            if (interfaceIp && isValidIpv4(interfaceIp)) s.addMembership(SSDP_ADDR, interfaceIp);
            else s.addMembership(SSDP_ADDR);
          } catch { closeNotify(); }
        });
      } catch {
        notifySock = null;
      }
    }
  }

  function closeSock() {
    const s = sock;
    sock = null;
    if (s) { try { s.removeAllListeners('message'); s.on('error', () => {}); s.close(); } catch { /* ignore */ } }
  }
  function closeNotify() {
    const s = notifySock;
    notifySock = null;
    if (s) { try { s.removeAllListeners('message'); s.on('error', () => {}); s.close(); } catch { /* ignore */ } }
  }

  function send(buf) {
    if (!sock) return;
    try { sock.send(buf, SSDP_PORT, SSDP_ADDR, () => {}); } catch { /* socket not bound yet / closed */ }
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
      fetchQueue.length = 0;
      while (idleWaiters.length) idleWaiters.shift()();
      closeSock();
      closeNotify();
    },

    /** Send M-SEARCH twice, wait windowMs for replies, then for description fetches (bounded). */
    searchNow() {
      if (searching) return searching;
      if (!started) return Promise.resolve();
      if (!sock) { warned = false; open(); }
      searching = new Promise((resolve) => {
        const fire = () => {
          if (!started) return;
          send(mSearch('ssdp:all'));
          send(mSearch('upnp:rootdevice'));
        };
        // Give bind() a tick before the first send.
        later(fire, 50);
        later(fire, 800);
        later(() => {
          const done = () => { searching = null; resolve(); };
          if (activeFetches === 0 && fetchQueue.length === 0) return done();
          let finished = false;
          const finish = () => { if (!finished) { finished = true; done(); } };
          idleWaiters.push(finish);
          later(finish, FETCH_TIMEOUT_MS + 500);
        }, windowMs);
      });
      return searching;
    },

    /** Merged UpnpInfo for an IP, or null. */
    get(ip) {
      return merged(ip);
    },
  };
}
