// LAN device discovery: ICMP ping sweep of the local subnet merged with the kernel neighbour (ARP) table.
// PLAN.md §2.4. Devices are keyed by MAC; hostnames come from best-effort reverse DNS.
//
// Why both: some hosts drop ICMP (Windows firewall, sleeping phones) but still answer ARP, and the
// sweep itself is what populates the ARP table for everyone else. See docs/NETWORK_NOTES.md §1–2.

import os from 'node:os';
import dns from 'node:dns';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  normalizeMac, isMulticastOrBroadcastMac, isZeroMac, isValidIpv4, ipInCidr, hostsToScan, compareIp,
} from './sys.js';
import { ping, pool } from './pinger.js';
import { lookupVendor } from './oui.js';

const run = promisify(execFile);
const EXEC_OPTS = { timeout: 5000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } };
const IS_LINUX = process.platform === 'linux';

const DNS_TIMEOUT_MS = 1500;
const DNS_CACHE_MS = 10 * 60 * 1000;
const RETRY_TIMEOUT_MS = 1500; // second, slower ping for ARP-present but silent hosts (Wi-Fi power save)

// ------------------------------------------------------------------------------------------------
// Neighbour table parsers (pure, exported for tests)
// ------------------------------------------------------------------------------------------------

// BSD/macOS and Linux net-tools `arp -an`:
//   '? (10.0.0.11) at e4:24:6c:7e:8:94 on en0 ifscope [ethernet]'
//   '? (192.168.1.1) at 00:11:22:33:44:55 [ether] on eth0'
const ARP_RE = /^(\S+) \((\d{1,3}(?:\.\d{1,3}){3})\) at (\S+)(.*?) on (\S+)(.*)$/;

/** @returns {Array<{ip, mac, iface, permanent}>} complete unicast entries only */
export function parseArpOutput(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const m = ARP_RE.exec(raw.trim());
    if (!m) continue;
    const [, , ip, macRaw, mid, iface, tail] = m;
    if (/incomplete/i.test(macRaw)) continue;
    const entry = makeEntry(ip, macRaw, iface, /\bpermanent\b|\bPERM\b/.test(mid + tail));
    if (entry) out.push(entry);
  }
  return out;
}

// iproute2 `ip -4 neigh show`:
//   '192.168.1.1 dev eth0 lladdr 00:11:22:33:44:55 REACHABLE'
//   '192.168.1.9 dev eth0  FAILED' / 'INCOMPLETE'
export function parseIpNeighOutput(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const f = raw.trim().split(/\s+/);
    if (f.length < 4) continue;
    const ip = f[0];
    const dev = f[f.indexOf('dev') + 1];
    const li = f.indexOf('lladdr');
    if (f.indexOf('dev') < 0 || li < 0) continue;
    const state = f[f.length - 1].toUpperCase();
    if (state === 'INCOMPLETE' || state === 'FAILED') continue;
    const entry = makeEntry(ip, f[li + 1], dev, state === 'PERMANENT' || state === 'NOARP');
    if (entry) out.push(entry);
  }
  return out;
}

// /proc/net/arp: 'IP address  HW type  Flags  HW address  Mask  Device'; flags 0x0 = incomplete.
export function parseProcNetArp(text) {
  const out = [];
  for (const raw of String(text || '').split('\n').slice(1)) {
    const f = raw.trim().split(/\s+/);
    if (f.length < 6) continue;
    const flags = parseInt(f[2], 16);
    if (!(flags & 0x2)) continue;
    const entry = makeEntry(f[0], f[3], f[5], (flags & 0x4) !== 0);
    if (entry) out.push(entry);
  }
  return out;
}

function makeEntry(ip, macRaw, iface, permanent) {
  if (!isValidIpv4(ip)) return null;
  const mac = normalizeMac(macRaw);
  if (!mac || isZeroMac(mac) || isMulticastOrBroadcastMac(mac)) return null;
  const first = Number(ip.split('.')[0]);
  if (first >= 224) return null; // multicast / reserved IPs
  return { ip, mac, iface: iface || null, permanent: Boolean(permanent) };
}

/** Read the neighbour table with the best tool available on this platform. */
export async function readNeighbours() {
  if (IS_LINUX) {
    try {
      const { stdout } = await run('ip', ['-4', 'neigh', 'show'], EXEC_OPTS);
      return parseIpNeighOutput(stdout);
    } catch { /* iproute2 missing -> /proc */ }
    try {
      return parseProcNetArp(await readFile('/proc/net/arp', 'utf8'));
    } catch { /* fall through to arp */ }
  }
  // `-n`: never reverse-resolve (plain `arp -a` can block seconds per entry).
  const { stdout } = await run('arp', ['-an'], EXEC_OPTS);
  return parseArpOutput(stdout);
}

// ------------------------------------------------------------------------------------------------
// Reverse DNS (best-effort, cached, bounded)
// ------------------------------------------------------------------------------------------------

const dnsCache = new Map(); // ip -> { name, at }
let resolver = null;

function getResolver() {
  if (!resolver) {
    try {
      resolver = new dns.promises.Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
    } catch {
      resolver = dns.promises; // very old runtimes: no options
    }
  }
  return resolver;
}

function cleanHostname(name) {
  if (typeof name !== 'string') return null;
  const v = name.trim().replace(/\.$/, '');
  if (!v || isValidIpv4(v) || v.length > 253) return null;
  return v;
}

export async function reverseLookup(ip) {
  const hit = dnsCache.get(ip);
  if (hit && Date.now() - hit.at < DNS_CACHE_MS) return hit.name;
  let name = null;
  let timer;
  try {
    const names = await Promise.race([
      getResolver().reverse(ip),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), DNS_TIMEOUT_MS); }),
    ]);
    name = cleanHostname(Array.isArray(names) ? names[0] : null);
  } catch {
    name = null;
  } finally {
    clearTimeout(timer);
  }
  dnsCache.set(ip, { name, at: Date.now() });
  if (dnsCache.size > 2048) dnsCache.delete(dnsCache.keys().next().value);
  return name;
}

// ------------------------------------------------------------------------------------------------
// Discovery
// ------------------------------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {object} o.network  NetworkInfo from sys.getNetworkInfo()
 * @param {(devices: RawDevice[], meta: {scannedAt: string, durationMs: number}) => void} o.onDevices
 */
export function createDiscovery({ network, intervalMs = 30000, concurrency = 64, pingTimeoutMs = 700, onDevices, onScanStart } = {}) {
  let timer = null;
  let running = false;
  let inFlight = null;
  let warnedArp = false;

  const selfHostname = cleanHostname(os.hostname());

  function emit(devices, meta) {
    if (typeof onDevices !== 'function') return;
    try {
      onDevices(devices, meta);
    } catch (err) {
      console.warn(`[discovery] onDevices failed: ${err?.message || err}`);
    }
  }

  function selfDevice() {
    return {
      mac: network.mac,
      ip: network.ip,
      hostname: selfHostname,
      vendor: network.mac ? lookupVendor(network.mac) : null,
      alive: true,
      inArp: false,
      ttl: null,
      isSelf: true,
      isGateway: false,
    };
  }

  async function scan() {
    const t0 = Date.now();
    if (typeof onScanStart === 'function') {
      try { onScanStart(); } catch (err) { console.warn(`[discovery] onScanStart failed: ${err?.message || err}`); }
    }
    if (!network || !isValidIpv4(network.ip)) {
      const meta = { scannedAt: new Date().toISOString(), durationMs: Date.now() - t0 };
      emit([], meta);
      return [];
    }

    // 1) Ping sweep (also primes the ARP cache).
    const targets = hostsToScan(network);
    if (network.gateway && isValidIpv4(network.gateway) && network.gateway !== network.ip && !targets.includes(network.gateway)) {
      targets.push(network.gateway);
    }
    const results = new Map(); // ip -> PingResult
    await pool(targets, concurrency, async (ip) => {
      results.set(ip, await ping(ip, { timeoutMs: pingTimeoutMs }));
    });

    // 2) Neighbour table, restricted to our interface and subnet.
    let neigh = [];
    try {
      neigh = await readNeighbours();
      warnedArp = false;
    } catch (err) {
      if (!warnedArp) console.warn(`[discovery] reading the ARP table failed: ${err?.message || err}`);
      warnedArp = true;
    }
    const isOurs = (e) =>
      (!e.iface || e.iface === network.iface) &&
      (ipInCidr(e.ip, network.cidr) || e.ip === network.gateway) &&
      e.ip !== network.ip &&
      e.mac !== network.mac;
    neigh = neigh.filter(isOurs);

    // 3) Second, slower ping for hosts that are in ARP but stayed silent (sleepy Wi-Fi clients).
    const silent = [...new Set(neigh.map((e) => e.ip))].filter((ip) => !results.get(ip)?.alive);
    if (silent.length) {
      await pool(silent, 16, async (ip) => {
        const r = await ping(ip, { timeoutMs: RETRY_TIMEOUT_MS });
        if (r.alive) results.set(ip, r);
      });
    }

    // 4) One entry per MAC. Prefer the gateway IP, then an IP that answered, then the lowest IP.
    const byMac = new Map();
    for (const e of neigh) {
      const prev = byMac.get(e.mac);
      if (!prev) { byMac.set(e.mac, e); continue; }
      const rank = (x) => (x.ip === network.gateway ? 2 : 0) + (results.get(x.ip)?.alive ? 1 : 0);
      if (rank(e) > rank(prev) || (rank(e) === rank(prev) && compareIp(e.ip, prev.ip) < 0)) byMac.set(e.mac, e);
    }

    // 5) Reverse DNS (bounded, cached).
    const entries = [...byMac.values()];
    const names = await pool(entries, 16, (e) => reverseLookup(e.ip));

    const devices = entries.map((e, i) => {
      const r = results.get(e.ip);
      return {
        mac: e.mac,
        ip: e.ip,
        hostname: names[i] ?? null,
        vendor: lookupVendor(e.mac),
        alive: Boolean(r?.alive),
        inArp: true,
        ttl: r?.alive ? r.ttl ?? null : null,
        isSelf: false,
        isGateway: e.ip === network.gateway,
      };
    });
    if (network.mac) devices.push(selfDevice());
    devices.sort((a, b) => compareIp(a.ip, b.ip));

    const meta = { scannedAt: new Date().toISOString(), durationMs: Date.now() - t0 };
    emit(devices, meta);
    return devices;
  }

  function scanNow() {
    if (inFlight) return inFlight;
    inFlight = scan()
      .catch((err) => {
        console.warn(`[discovery] scan failed: ${err?.stack || err}`);
        return [];
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  function schedule(delay) {
    if (!running) return;
    clearTimeout(timer);
    timer = setTimeout(tick, Math.max(0, delay));
    timer.unref?.();
  }

  async function tick() {
    if (!running) return;
    const started = Date.now();
    await scanNow();
    schedule(intervalMs - (Date.now() - started));
  }

  return {
    start() {
      if (running) return;
      running = true;
      schedule(0);
    },
    stop() {
      running = false;
      clearTimeout(timer);
      timer = null;
    },
    scanNow,
  };
}
