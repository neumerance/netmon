// LAN system helpers: primary interface / default gateway detection plus pure MAC, IPv4 and CIDR helpers.
// PLAN.md §2.1. Real network inspection uses execFile only (never a shell); every helper below
// `getNetworkInfo` is pure and safe to import in mock mode.

import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
// windowsHide is ignored on POSIX; on Windows it stops console windows flashing (service / tray use).
const EXEC_OPTS = { timeout: 3000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C' }, windowsHide: true };

// Interfaces that are never the LAN we want to scan (VPN tunnels, Apple AWDL/low-latency WLAN,
// bridges, container and VM networks, overlay VPNs, loopback).
const EXCLUDED_IFACE_RE =
  /^(utun|awdl|llw|bridge|docker|veth|lo|br-|virbr|vmnet|vboxnet|tun|tap|wg|zt|tailscale|anpi|ap\d|gif|stf|ipsec|ppp|ham|nordlynx|cni|flannel|cali|kube)/i;

// Windows adapter names (os.networkInterfaces() keys are adapter "friendly names": 'Ethernet', 'Wi-Fi',
// 'WLAN', 'Ethernet 2', ...). Excluded: loopback, Hyper-V/WSL/Docker internal switches, VM host-only
// adapters, Bluetooth PAN, IPv6 transition tunnels, Wi-Fi Direct virtual adapters ('Local Area Connection* N')
// and common VPN clients. An external Hyper-V switch ('vEthernet (External)') is NOT excluded: on such
// hosts it is the adapter that carries the LAN address.
const EXCLUDED_WIN_IFACE_RE =
  /^(Loopback Pseudo-Interface|vEthernet \((WSL|Default Switch|DockerNAT|nat\b)|VirtualBox|VMware|Bluetooth|Teredo|isatap|6TO4|Npcap|Hyper-V|ZeroTier|Tailscale|OpenVPN|TAP-|WireGuard|NordLynx|ProtonVPN|Mullvad|Cloudflare WARP|Local Area Connection\*|LAN-Verbindung\*|Conexi\S+n de \S+rea local\*|Connexion au r\S+seau local\*)/i;

// ------------------------------------------------------------------------------------------------
// Windows process helpers. Absolute System32 paths, so a service running as LocalSystem never runs a
// planted ping.exe / arp.exe found earlier on PATH.
// ------------------------------------------------------------------------------------------------

/** 'PING.EXE' -> 'C:\Windows\System32\PING.EXE' (from %SystemRoot%). */
export function winSystemBinary(name) {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.win32.join(root, 'System32', name);
}

/** Windows PowerShell 5.1 (ships with every Windows 10/11; pwsh 7 is optional so it is not used). */
export function winPowerShellPath() {
  return winSystemBinary(path.win32.join('WindowsPowerShell', 'v1.0', 'powershell.exe'));
}

/**
 * argv that runs `script` in Windows PowerShell. -EncodedCommand (base64 UTF-16LE) avoids every Windows
 * command-line quoting problem; progress records are silenced so they never reach stderr as CLIXML, and
 * stdout is UTF-8 so non-ASCII adapter names survive.
 */
export function powerShellArgs(script) {
  const full = "$ProgressPreference='SilentlyContinue';try{[Console]::OutputEncoding=[Text.Encoding]::UTF8}catch{};" + script;
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(full, 'utf16le').toString('base64')];
}

/** One-shot PowerShell call -> stdout. Cold start is ~0.3–1.5 s (more at boot), hence the long timeout. */
export async function runPowerShell(script, { timeoutMs = 15000, env } = {}) {
  const { stdout } = await run(winPowerShellPath(), powerShellArgs(script), {
    timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, ...(env || {}) },
  });
  return String(stdout || '');
}

// ------------------------------------------------------------------------------------------------
// IPv4 helpers
// ------------------------------------------------------------------------------------------------

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** Strict dotted-quad check (no leading zeros, no whitespace, no ranges). */
export function isValidIpv4(ip) {
  return typeof ip === 'string' && IPV4_RE.test(ip);
}

/** '192.168.1.23' -> 3232235799 (unsigned). Invalid input -> NaN. */
export function ipToInt(ip) {
  if (!isValidIpv4(ip)) return NaN;
  const p = ip.split('.');
  return ((+p[0] << 24) | (+p[1] << 16) | (+p[2] << 8) | +p[3]) >>> 0;
}

/** 3232235799 -> '192.168.1.23'. */
export function intToIp(n) {
  const v = Number(n) >>> 0;
  return `${v >>> 24}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`;
}

/** Numeric IPv4 sort comparator. Invalid / null addresses sort last (then by string). */
export function compareIp(a, b) {
  const x = ipToInt(a);
  const y = ipToInt(b);
  const xv = Number.isNaN(x);
  const yv = Number.isNaN(y);
  if (xv || yv) {
    if (xv && yv) return String(a ?? '').localeCompare(String(b ?? ''));
    return xv ? 1 : -1;
  }
  return x - y;
}

/** '255.255.255.0' -> 24. Non-contiguous / invalid masks -> null. */
export function netmaskToPrefix(mask) {
  const n = ipToInt(mask);
  if (Number.isNaN(n)) return null;
  const inv = ~n >>> 0;
  if ((inv & (inv + 1)) !== 0) return null; // ones must be contiguous from the left
  let bits = 0;
  for (let v = n; v; v = (v << 1) >>> 0) bits++;
  return bits;
}

/** 24 -> '255.255.255.0'. */
export function prefixToNetmask(prefix) {
  const p = Math.max(0, Math.min(32, Math.trunc(prefix)));
  return intToIp(p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0);
}

function maskBits(prefix) {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

/** True when `ip` lies in `cidr` ('192.168.1.0/24'). */
export function ipInCidr(ip, cidr) {
  if (typeof cidr !== 'string') return false;
  const [net, p] = cidr.split('/');
  const prefix = Number(p);
  const a = ipToInt(ip);
  const b = ipToInt(net);
  if (Number.isNaN(a) || Number.isNaN(b) || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const m = maskBits(prefix);
  return ((a & m) >>> 0) === ((b & m) >>> 0);
}

/**
 * All host IPs to sweep: every address of the subnet except network, broadcast and self.
 * Subnets larger than a /24 are clamped to the /24 that contains `info.ip` (a /16 sweep would be
 * 65k pings). /31 and /32 have no network/broadcast addresses (RFC 3021).
 */
export function hostsToScan(info) {
  if (!info || !isValidIpv4(info.ip)) return [];
  let prefix = Number.isInteger(info.prefix) ? info.prefix : netmaskToPrefix(info.netmask);
  if (prefix == null || prefix < 0 || prefix > 32) prefix = 24;
  if (prefix < 24) prefix = 24;
  const self = ipToInt(info.ip);
  const m = maskBits(prefix);
  const network = (self & m) >>> 0;
  const broadcast = (network | (~m >>> 0)) >>> 0;
  let first = network;
  let last = broadcast;
  if (prefix <= 30) {
    first = network + 1;
    last = broadcast - 1;
  }
  const out = [];
  for (let n = first; n <= last; n++) if (n !== self) out.push(intToIp(n));
  return out;
}

// ------------------------------------------------------------------------------------------------
// MAC helpers
// ------------------------------------------------------------------------------------------------

/**
 * Normalize a MAC to lowercase, zero-padded, colon-separated form.
 * Accepts ':' or '-' separators with 1–2 hex digits per octet (macOS `arp` prints '0:1a:2b:3:4:5'),
 * url-encoded colons ('%3A'), Cisco dotted ('001a.2b03.0405') and bare 12-hex strings.
 * Invalid input -> null.
 */
export function normalizeMac(s) {
  if (typeof s !== 'string') return null;
  let v = s.trim().toLowerCase().replace(/%3a/g, ':');
  if (!v) return null;
  let parts;
  if (/^[0-9a-f]{1,2}([:-][0-9a-f]{1,2}){5}$/.test(v)) {
    parts = v.split(/[:-]/);
  } else if (/^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/.test(v)) {
    v = v.replace(/\./g, '');
    parts = v.match(/../g);
  } else if (/^[0-9a-f]{12}$/.test(v)) {
    parts = v.match(/../g);
  } else {
    return null;
  }
  return parts.map((o) => o.padStart(2, '0')).join(':');
}

/** 'a4:83:e7:1c:2d:01' -> 'a4-83-e7-1c-2d-01' (URL / data-testid form). */
export function macToDashes(mac) {
  const n = normalizeMac(mac);
  return (n ?? String(mac ?? '')).replace(/:/g, '-');
}

function firstOctet(mac) {
  const n = normalizeMac(mac);
  return n ? parseInt(n.slice(0, 2), 16) : null;
}

/** Locally-administered bit set -> randomized / private Wi-Fi address (iOS, Android, Windows, macOS). */
export function isRandomizedMac(mac) {
  const o = firstOctet(mac);
  return o != null && (o & 0x02) !== 0;
}

/** Broadcast (ff:ff:ff:ff:ff:ff) or any group address (I/G bit set, e.g. 01:00:5e:.. / 33:33:..). */
export function isMulticastOrBroadcastMac(mac) {
  const o = firstOctet(mac);
  return o != null && (o & 0x01) !== 0;
}

/** All-zero MAC (seen for tunnels and some incomplete neighbour entries). */
export function isZeroMac(mac) {
  return normalizeMac(mac) === '00:00:00:00:00:00';
}

// ------------------------------------------------------------------------------------------------
// Interface / gateway detection
// ------------------------------------------------------------------------------------------------

export function isExcludedIface(name, platform = process.platform) {
  if (typeof name !== 'string' || !name) return true;
  return platform === 'win32' ? EXCLUDED_WIN_IFACE_RE.test(name) : EXCLUDED_IFACE_RE.test(name);
}

// ------------------------------------------------------------------------------------------------
// Windows default-route parsers (pure, exported for tests)
// ------------------------------------------------------------------------------------------------

// `route print -4 0.0.0.0` Active Routes rows. Headers are localized, the row layout is not:
//   '          0.0.0.0          0.0.0.0      192.168.0.1    192.168.0.101     25'
// The gateway column may be 'On-link' (localized and possibly several words, German 'Auf Verbindung').
// Persistent Routes rows have no Interface column (4 fields) and never match.
const WIN_ROUTE_ROW_RE = /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(.+?)\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d+)\s*$/;

/**
 * Default routes from `route print -4 0.0.0.0`, lowest effective metric first (stable).
 * On-link default routes (VPN / tunnel adapters with no next hop) are ignored.
 * @returns {Array<{gateway:string, ifaceIp:string, metric:number}>}
 */
export function parseWinRoutePrint(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = WIN_ROUTE_ROW_RE.exec(line);
    if (!m) continue;
    const [, gw, ifaceIp, metric] = m;
    if (!isValidIpv4(gw) || gw === '0.0.0.0' || !isValidIpv4(ifaceIp)) continue;
    rows.push({ gateway: gw, ifaceIp, metric: Number(metric) });
  }
  return rows.sort((a, b) => a.metric - b.metric);
}

/**
 * Default routes from the Get-NetRoute PowerShell fallback: ConvertTo-Json of one object or an array of
 * { NextHop, InterfaceAlias, InterfaceIndex, RouteMetric, InterfaceMetric, IPAddress }. The effective metric
 * is RouteMetric + InterfaceMetric (what `route print` shows). NextHop 0.0.0.0 = on-link -> ignored.
 * @returns {Array<{gateway:string, ifaceIp:string|null, ifaceAlias:string|null, metric:number}>}
 */
export function parseWinNetRouteJson(text) {
  let data;
  try {
    data = JSON.parse(String(text || '').replace(/^﻿/, '').trim() || 'null');
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : [];
  const rows = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const gw = r.NextHop;
    if (!isValidIpv4(gw) || gw === '0.0.0.0') continue;
    const ip = Array.isArray(r.IPAddress) ? r.IPAddress.find(isValidIpv4) : r.IPAddress;
    rows.push({
      gateway: gw,
      ifaceIp: isValidIpv4(ip) ? ip : null,
      ifaceAlias: typeof r.InterfaceAlias === 'string' && r.InterfaceAlias ? r.InterfaceAlias : null,
      metric: (Number(r.RouteMetric) || 0) + (Number(r.InterfaceMetric) || 0),
    });
  }
  return rows.sort((a, b) => a.metric - b.metric);
}

/** os.networkInterfaces() name that owns IPv4 `ip` ('192.168.0.101' -> 'Wi-Fi'), else null. */
export function ifaceNameForIp(ip, ifaces = os.networkInterfaces()) {
  if (!isValidIpv4(ip)) return null;
  for (const [name, list] of Object.entries(ifaces || {})) {
    if ((list || []).some((a) => (a.family === 'IPv4' || a.family === 4) && a.address === ip)) return name;
  }
  return null;
}

// Get-NetRoute fallback. ActiveStore only (PersistentStore would duplicate rows); IP and metric of the
// interface are joined in so the result maps to os.networkInterfaces() by IP, not only by alias.
const WIN_NETROUTE_PS =
  "$r=@(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -PolicyStore ActiveStore -ErrorAction Stop | ForEach-Object {" +
  '$i=$_.InterfaceIndex;' +
  '[pscustomobject]@{NextHop=$_.NextHop;InterfaceAlias=$_.InterfaceAlias;InterfaceIndex=$i;RouteMetric=$_.RouteMetric;' +
  'InterfaceMetric=(Get-NetIPInterface -InterfaceIndex $i -AddressFamily IPv4 -ErrorAction SilentlyContinue).InterfaceMetric;' +
  'IPAddress=@(Get-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { $_.IPAddress })}' +
  '} | Sort-Object RouteMetric);ConvertTo-Json -InputObject $r -Compress -Depth 3';

let warnedWinRoute = false;

/** Windows: `route print -4 0.0.0.0`, else PowerShell Get-NetRoute. Interface IPs are mapped to adapter names. */
async function getWinDefaultRoutes() {
  const ifaces = os.networkInterfaces();
  let rows = [];
  let routeErr = null;
  try {
    const { stdout } = await run(winSystemBinary('ROUTE.EXE'), ['print', '-4', '0.0.0.0'], EXEC_OPTS);
    rows = parseWinRoutePrint(stdout).map((r) => ({ ...r, iface: ifaceNameForIp(r.ifaceIp, ifaces) }));
  } catch (err) {
    routeErr = err;
  }
  if (!rows.some((r) => r.iface)) {
    try {
      const stdout = await runPowerShell(WIN_NETROUTE_PS);
      rows = parseWinNetRouteJson(stdout).map((r) => ({
        ...r,
        iface: ifaceNameForIp(r.ifaceIp, ifaces) ?? (r.ifaceAlias && ifaces[r.ifaceAlias] ? r.ifaceAlias : null),
      }));
    } catch (err) {
      if (!warnedWinRoute) {
        console.warn(`[sys] Windows default route lookup failed (route.exe: ${routeErr?.message || 'no usable default route'}; ` +
          `Get-NetRoute: ${err?.message || err}); using the first usable adapter`);
      }
      warnedWinRoute = true;
    }
  }
  return rows.filter((r) => r.iface);
}

/** Usable IPv4 address entries of one interface (non-internal, not link-local unless it is all we have). */
function ipv4Entries(list) {
  const v4 = (list || []).filter((a) => (a.family === 'IPv4' || a.family === 4) && !a.internal && isValidIpv4(a.address));
  const routable = v4.filter((a) => !a.address.startsWith('169.254.'));
  return routable.length ? routable : v4;
}

/**
 * Default routes as [{ gateway, iface, metric }], best first.
 * macOS: `route -n get default` (the route the kernel actually uses) then every `default` row of
 * `netstat -rn -f inet` (so a VPN that owns the default route does not hide the LAN gateway).
 * Linux: `ip -4 route show default` (lowest metric first), fallback /proc/net/route.
 * Windows: `route print -4 0.0.0.0` (lowest effective metric first, On-link ignored), fallback PowerShell
 * Get-NetRoute; the interface IP is mapped to its os.networkInterfaces() name ('Ethernet', 'Wi-Fi').
 */
export async function getDefaultRoutes(platform = process.platform) {
  const routes = [];
  const push = (gateway, iface, metric = 0) => {
    if (!iface) return;
    routes.push({ gateway: isValidIpv4(gateway) ? gateway : null, iface, metric });
  };

  if (platform === 'darwin' || platform === 'freebsd' || platform === 'openbsd') {
    try {
      const { stdout } = await run('route', ['-n', 'get', 'default'], EXEC_OPTS);
      push(/^\s*gateway:\s*(\S+)/m.exec(stdout)?.[1], /^\s*interface:\s*(\S+)/m.exec(stdout)?.[1], 0);
    } catch { /* no default route */ }
    try {
      const { stdout } = await run('netstat', ['-rn', '-f', 'inet'], EXEC_OPTS);
      let i = 1;
      for (const line of stdout.split('\n')) {
        const f = line.trim().split(/\s+/);
        if (f[0] !== 'default' || f.length < 4) continue;
        // Columns: Destination Gateway Flags Netif [Expire]
        push(f[1], f[3], i++);
      }
    } catch { /* netstat missing */ }
  } else if (platform === 'linux') {
    let ok = false;
    try {
      const { stdout } = await run('ip', ['-4', 'route', 'show', 'default'], EXEC_OPTS);
      const rows = [];
      for (const line of stdout.split('\n')) {
        const m = /^default\s+(?:via\s+(\S+)\s+)?.*?\bdev\s+(\S+)/.exec(line.trim());
        if (!m) continue;
        const metric = Number(/\bmetric\s+(\d+)/.exec(line)?.[1] ?? 0);
        rows.push({ gateway: m[1], iface: m[2], metric });
      }
      rows.sort((a, b) => a.metric - b.metric).forEach((r) => push(r.gateway, r.iface, r.metric));
      ok = rows.length > 0;
    } catch { /* iproute2 missing */ }
    if (!ok) {
      try {
        const text = await readFile('/proc/net/route', 'utf8');
        const rows = [];
        for (const line of text.split('\n').slice(1)) {
          const f = line.trim().split(/\s+/);
          if (f.length < 8 || f[1] !== '00000000') continue;
          const hex = f[2];
          // Gateway is little-endian hex: '0101A8C0' -> 192.168.1.1
          const gw = [6, 4, 2, 0].map((i) => parseInt(hex.slice(i, i + 2), 16)).join('.');
          rows.push({ gateway: gw === '0.0.0.0' ? null : gw, iface: f[0], metric: Number(f[6]) || 0 });
        }
        rows.sort((a, b) => a.metric - b.metric).forEach((r) => push(r.gateway, r.iface, r.metric));
      } catch { /* not available */ }
    }
  } else if (platform === 'win32') {
    for (const r of await getWinDefaultRoutes()) push(r.gateway, r.iface, r.metric);
  }
  return routes;
}

/**
 * Primary LAN interface + gateway (PLAN.md §2.1).
 * @returns {Promise<{iface:string, ip:string, netmask:string, cidr:string, prefix:number, mac:string|null,
 *                    gateway:string|null, platform:string}>}
 * @throws Error('no_network') when no usable IPv4 interface exists.
 */
export async function getNetworkInfo() {
  const platform = process.platform;
  const ifaces = os.networkInterfaces();
  let routes = [];
  try {
    routes = await getDefaultRoutes(platform);
  } catch (err) {
    console.warn(`[sys] default route lookup failed: ${err?.message || err}`);
  }

  const candidates = Object.keys(ifaces).filter((name) => !isExcludedIface(name, platform) && ipv4Entries(ifaces[name]).length);

  // 1) interface that owns a (usable) default route, in route preference order
  let iface = null;
  for (const r of routes) {
    if (candidates.includes(r.iface)) { iface = r.iface; break; }
  }
  // 2) else first usable non-internal IPv4 interface
  if (!iface) iface = candidates[0] ?? null;
  if (!iface) throw new Error('no_network');

  const addr = ipv4Entries(ifaces[iface])[0];
  let prefix = netmaskToPrefix(addr.netmask);
  if (prefix == null) {
    const p = Number(String(addr.cidr || '').split('/')[1]);
    prefix = Number.isInteger(p) && p >= 0 && p <= 32 ? p : 24;
  }
  const netInt = (ipToInt(addr.address) & maskBits(prefix)) >>> 0;
  const cidr = `${intToIp(netInt)}/${prefix}`;

  // Gateway: first default route through this interface whose gateway is inside the subnet
  // (falls back to any gateway on this interface, e.g. point-to-point setups).
  const own = routes.filter((r) => r.iface === iface && r.gateway);
  const gateway = (own.find((r) => ipInCidr(r.gateway, cidr)) ?? own[0])?.gateway ?? null;

  const mac = normalizeMac(addr.mac);
  return {
    iface,
    ip: addr.address,
    netmask: prefixToNetmask(prefix),
    cidr,
    prefix,
    mac: mac && mac !== '00:00:00:00:00:00' ? mac : null,
    gateway,
    platform,
  };
}
