# Network Notes (validated)

Validated 2026-10-17 on macOS (Darwin 25.2.0), Node v20.19.0, Wi-Fi `en0` = 10.0.0.94/24, gateway 10.0.0.1.
Cloudflare WARP is **on** on this machine (`warp=on` in trace, second default route on `utun0`), so WAN tests here measure the WARP tunnel.
Linux sections are from known formats and are **not validated on this machine** (no Linux/Docker here).

All snippets are ESM (`.mjs` / `"type":"module"`), and they use `execFile`, never `exec`, so no shell is involved.

```js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const isMac = process.platform === 'darwin';
```

---

## 1. ARP table

### Commands
- `arp -an`: **always use `-n`**. Plain `arp -a` tries a reverse DNS lookup for every entry. It ran fast here because every entry resolved to `?`, but with a slow or missing resolver it can block for seconds per entry.
- Linux: `ip neigh show` is preferred, and `arp -an` (net-tools) may not be installed. Reading `/proc/net/arp` needs no binary.

### Real macOS output (`arp -an`, trimmed; 256 lines total, 223 `(incomplete)`)
```
? (10.0.0.1) at 14:eb:b6:26:73:7d on en0 ifscope [ethernet]
? (10.0.0.2) at (incomplete) on en0 ifscope [ethernet]
? (10.0.0.11) at e4:24:6c:7e:8:94 on en0 ifscope [ethernet]
? (10.0.0.18) at c0:99:b:ad:e9:94 on en0 ifscope [ethernet]
? (10.0.0.94) at 66:f1:f9:c6:2:c2 on en0 ifscope permanent [ethernet]
? (10.0.0.255) at ff:ff:ff:ff:ff:ff on en0 ifscope [ethernet]
? (224.0.0.251) at 1:0:5e:0:0:fb on en0 ifscope permanent [ethernet]
```
Gotchas:
- **macOS does not zero-pad MAC octets** (`e4:24:6c:7e:8:94`, `1:0:5e:0:0:fb`). Normalize before comparing or vendor (OUI) lookup. `ifconfig` shows the same MAC padded (`66:f1:f9:c6:02:c2`).
- After a ping sweep the table holds an `(incomplete)` row for every probed dead IP (223 here). Filter them out.
- The host's own IP shows as `permanent`. The broadcast `.255` row is `ff:ff:ff:ff:ff:ff`. mDNS multicast `224.0.0.251` is `01:00:5e:…` and `permanent`.
- `ifscope` appears on macOS rows and there can be several interfaces, so filter by `iface` if you want only the LAN.
- ARP found **31** real neighbours while ping found **28–30** alive. Some hosts drop ICMP or are asleep. **Merge ARP and ping results**, and don't rely on ping alone.

Linux net-tools format (for reference):
```
? (192.168.1.1) at 00:11:22:33:44:55 [ether] on eth0
? (192.168.1.9) at <incomplete> on eth0
router.lan (192.168.1.1) at 00:11:22:03:44:55 [ether] PERM on eth0
```

### Parser (tested against both formats)
```js
export function normalizeMac(mac) {
  return mac.toLowerCase().split(/[:-]/).map(o => o.padStart(2, '0')).join(':');
}
const ARP_RE = /^(\S+) \((\d{1,3}(?:\.\d{1,3}){3})\) at (\S+)(.*?) on (\S+)(.*)$/;
export function parseArp(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = ARP_RE.exec(line.trim());
    if (!m) continue;
    const [, host, ip, macRaw, mid, iface, tail] = m;
    if (macRaw === '(incomplete)' || macRaw === '<incomplete>') continue;
    const mac = normalizeMac(macRaw);
    if (mac === 'ff:ff:ff:ff:ff:ff') continue;              // broadcast
    if (/^01:00:5e:|^33:33:/.test(mac)) continue;            // v4/v6 multicast MAC
    const first = +ip.split('.')[0];
    if (first >= 224 && first <= 239) continue;              // multicast IP
    out.push({ ip, mac, iface, hostname: host === '?' ? null : host,
               permanent: /\bpermanent\b|\bPERM\b/.test(mid + tail) });
  }
  return out;
}
const { stdout } = await run('arp', ['-an']);
const neighbours = parseArp(stdout); // here: 31 entries, 1 permanent (self)
```
Linux `/proc/net/arp` alternative: columns `IP address  HW type  Flags  HW address  Mask  Device`. Flags `0x0` means incomplete, `0x2` means complete and `0x6` means permanent. MACs there are already zero-padded.

---

## 2. Ping (single shot with timeout), RTT and TTL

### Flags differ between macOS and Linux. Measured on a dead host (10.0.0.250):
| macOS command | wall time | exit |
|---|---|---|
| `ping -c1 -n -W 1000 IP` | **2.02 s** | 2 |
| `ping -c1 -n -W 500 IP` | 1.53 s | 2 |
| `ping -c1 -n -t 1 IP` | **1.02 s** | 2 |
| `ping -c1 -n -W 1000 -t 1 IP` | 1.02 s | 2 |

- macOS: `-W` is the per-reply wait in **milliseconds**, but with `-c1` it is added on top of the ~1 s send interval, so `-W` alone does **not** bound the runtime. Use **`-t <seconds>`**, a hard overall deadline that only takes whole seconds. On macOS `-t` is NOT TTL (use `-m` for TTL).
- Linux (iputils): `-W <seconds>` is the reply timeout (fractions are allowed on newer iputils) and `-w <seconds>` is the overall deadline. Use `ping -c1 -n -W 1 IP`. On Linux `-t` **sets TTL**, so never pass the macOS flags there.
- Exit codes: 0 = reply, macOS 2 / Linux 1 = no reply, 64 (mac) / 2 (linux) = usage error. With `promisify(execFile)` a non-zero exit **rejects**, so catch it and treat it as down.
- zsh does not word-split `$var`, which caused `invalid count` errors while testing. That doesn't affect `execFile` with an args array.

### Real output
```
PING 10.0.0.1 (10.0.0.1): 56 data bytes
64 bytes from 10.0.0.1: icmp_seq=0 ttl=63 time=20.242 ms

--- 10.0.0.1 ping statistics ---
1 packets transmitted, 1 packets received, 0.0% packet loss
round-trip min/avg/max/stddev = 20.242/20.242/20.242/0.000 ms
```
Dead host: no `bytes from` line, `100.0% packet loss`, exit 2. On a single packet, macOS can print `stddev = nan`, so don't parse the stats line and parse the reply line instead.
Linux reply line: `64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=12.3 ms`. Very fast replies may show `time<1 ms` on some builds, which the regex below accepts.

TTL values seen: 64 (Linux/macOS/iOS/Android), 255 (some embedded/network gear), 63 for the gateway (one hop away or a mesh node), 128 would be Windows. `ttl=64` for 1.1.1.1 is because of WARP.

### Parser and sweep (validated)
```js
function pingArgs(ip, timeoutMs = 1000) {
  const s = String(Math.max(1, Math.ceil(timeoutMs / 1000)));
  return isMac ? ['-c', '1', '-n', '-t', s, ip]   // -t = deadline (s) on macOS
               : ['-c', '1', '-n', '-W', s, ip];  // -W = reply timeout (s) on Linux
}
const REPLY_RE = /ttl=(\d+)\s+time[=<]([\d.]+)\s*ms/i;
export async function ping(ip, timeoutMs = 1000) {
  try {
    const { stdout } = await run('ping', pingArgs(ip, timeoutMs), { timeout: timeoutMs + 1500 });
    const m = REPLY_RE.exec(stdout);
    return m ? { ip, alive: true, ttl: +m[1], rttMs: +m[2] } : { ip, alive: false };
  } catch (e) {
    return { ip, alive: false, code: e.code };  // e.code = exit status (2 on mac) or 'ETIMEDOUT'
  }
}
export async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}
const ips = Array.from({ length: 254 }, (_, i) => `10.0.0.${i + 1}`);
const results = await pool(ips, 64, ip => ping(ip, 1000));
```
### Sweep timing (/24, 254 hosts, concurrency 64)
- `-t 1` (1 s deadline): **4.12 s**, 28 alive (4 waves of about 1 s each, as expected).
- `-W 1000 -t 2` (first attempt): **8.11 s**, 30 alive, because dead hosts took about 2 s each.
- A 1 s timeout misses a few sleepy hosts (Wi-Fi phones with power save). Use ARP merge or a second pass at 2 s for the ones that are missing.
- `ulimit -n` here is 1048576, so 64 concurrent child processes is fine. ICMP via `/sbin/ping` needs no root on macOS (setuid or unprivileged ICMP sockets). On Linux, `ping` normally works through `net.ipv4.ping_group_range` or a file capability.
- Sample results: `{ ip:'10.0.0.1', ttl:63, rttMs:36.5 }`, `{ ip:'10.0.0.13', ttl:255, rttMs:24.7 }`. Wi-Fi LAN RTTs were 20–36 ms under sweep load (5–20 ms when idle).

---

## 3. Default gateway

### macOS: `route -n get default`
```
   route to: default
destination: default
       mask: default
    gateway: 10.0.0.1
  interface: en0
      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>
 recvpipe  sendpipe  ssthresh  rtt,msec    rttvar  hopcount      mtu     expire
       0         0         0         0         0         0      1500         0
```
`netstat -rn -f inet` shows **two** defaults here (`default 10.0.0.1 UGScg en0` and `default link#23 UCSIg utun0` from WARP), so prefer `route -n get default`, which gave en0. With a VPN, `route get` may return the `utun` interface and no `gateway:` line. Handle `gateway == null`.

### Linux: `ip -4 route show default`
```
default via 192.168.1.1 dev eth0 proto dhcp src 192.168.1.50 metric 100
```
There can be several lines (several metrics). Take the first, or the one with the lowest metric.

```js
export async function getDefaultGateway() {
  if (isMac) {
    const { stdout } = await run('route', ['-n', 'get', 'default']);
    return { gateway: /^\s*gateway:\s*(\S+)/m.exec(stdout)?.[1] ?? null,
             iface:   /^\s*interface:\s*(\S+)/m.exec(stdout)?.[1] ?? null };
  }
  const { stdout } = await run('ip', ['-4', 'route', 'show', 'default']);
  const m = /default via (\S+) dev (\S+)/.exec(stdout);
  return { gateway: m?.[1] ?? null, iface: m?.[2] ?? null };
}
// -> { gateway: '10.0.0.1', iface: 'en0' }
```
The local IP and subnet are easier to get from Node: `os.networkInterfaces().en0.find(a => a.family === 'IPv4')` gives `{ address, netmask, cidr, mac }`.

---

## 4. Interface throughput

### macOS: `netstat -ibn -I en0`
```
Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
en0        1500  <Link#14>   66:f1:f9:c6:02:c2 35896956     0 41110897759  3032963     0  624610696     0
en0        1500  fe80::c08:b fe80:e::c08:bd25: 35896956     - 41110897759  3032963     -  624610696     -
en0        1500  10/24         10.0.0.94       35896956     - 41110897759  3032963     -  624610696     -
```
Gotchas:
- **One row per address** (link, IPv6 link-local, IPv4) with identical counters. Use only the `<Link#N>` row, or you will count the bytes 3 times.
- **Columns shift**: some rows have no Address (for example `utun1 1380 <Link#19>  0 0 0 49 0 8806 0`), and Network/Address are truncated (`fe80::c08:b`). **Parse from the right**: the last 7 fields are always `Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll`.
- Interfaces marked down have a `*` suffix (`gif0*`).
- Byte counters are 64-bit (41 GB here). They can exceed 2^53 only after many PB, so `Number` is fine, but use `BigInt` if you prefer. Treat a negative delta as a counter reset or interface restart and drop that sample.

### Linux: `/proc/net/dev`
```
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
  eth0: 123456789  98765    0    0    0     0          0         0 98765432   87654    0    0    0     0       0          0
```
Split on `:` first, because the interface name can be glued to the first number (`eth0:123`). After that, rx bytes is field 0 and tx bytes is field 8.

### Two-sample Mbps (validated)
```js
import { readFile } from 'node:fs/promises';
export async function readCounters(iface) {
  if (isMac) {
    const { stdout } = await run('netstat', ['-ibn', '-I', iface]);
    for (const line of stdout.split('\n')) {
      const f = line.trim().split(/\s+/);
      if (f[0] !== iface || !/^<Link#\d+>$/.test(f[2] ?? '')) continue;
      const n = f.slice(-7);
      return { rx: Number(n[2]), tx: Number(n[5]), t: process.hrtime.bigint() };
    }
  } else {
    const text = await readFile('/proc/net/dev', 'utf8');
    for (const line of text.split('\n')) {
      const idx = line.indexOf(':');
      if (idx < 0 || line.slice(0, idx).trim() !== iface) continue;
      const f = line.slice(idx + 1).trim().split(/\s+/);
      return { rx: Number(f[0]), tx: Number(f[8]), t: process.hrtime.bigint() };
    }
  }
  throw new Error(`interface ${iface} not found`);
}
export function mbps(a, b) {
  const sec = Number(b.t - a.t) / 1e9;           // use the real elapsed time, not the nominal 1000 ms
  const d = (x, y) => (y >= x ? y - x : null);    // counter reset -> null
  const rx = d(a.rx, b.rx), tx = d(a.tx, b.tx);
  return { rxMbps: rx == null ? null : rx * 8 / sec / 1e6,
           txMbps: tx == null ? null : tx * 8 / sec / 1e6, sec };
}
// Sample: { sec: 1.006, rxMbps: 7.278, txMbps: 0.251, rxBytes: 915219, txBytes: 31555 }
```
Spawning `netstat` takes about 10 ms. For a 1 s poller, keep the previous sample and compute the delta at each tick instead of sleeping inside a request.

---

## 5. Reverse DNS (`dns.reverse`)
```js
import dns from 'node:dns/promises';
await dns.reverse('10.0.0.1');   // throws ENOTFOUND in 7 ms
await dns.reverse('10.0.0.11');  // throws ENOTFOUND in 6 ms
await dns.reverse('1.1.1.1');    // [ 'one.one.one.one' ] in 108 ms
```
- `dns.reverse` performs a real PTR query (c-ares) and **bypasses the OS resolver**, so it does **not** see mDNS/Bonjour `.local` names or `/etc/hosts`. Most consumer routers here return no PTR for LAN IPs, so expect `ENOTFOUND` and use it only as a best-effort hint.
- Always wrap it in try/catch with a timeout (`Promise.race`), because an unreachable DNS server makes it wait for the c-ares timeout (seconds). Cache the results.
- Better LAN names: `dns.lookupService(ip, 0)` (uses getnameinfo, so the OS resolver, may include mDNS on macOS, and can be slow), or mDNS/NetBIOS probes (out of scope).

---

## 6. Cloudflare endpoints (total traffic used for this research: ~4.5 MB)

### `GET https://speed.cloudflare.com/meta`: needs a `Referer` or `Origin` header
- Without the header it returns **403 with body `{}`** (it looks like an empty success if you don't check `res.ok`).
- With `Referer: https://speed.cloudflare.com/` (or `Origin: https://speed.cloudflare.com`) it returns 200:
```json
{"hostname":"speed.cloudflare.com","clientIp":"104.28.194.105","httpProtocol":"HTTP/1.1","asn":13335,
 "asOrganization":"Cloudflare, Inc.","country":"PH","city":"Manila","region":"National Capital Region",
 "postalCode":"1001","latitude":"14.6042","longitude":"120.9822",
 "colo":{"iata":"HKG","lat":22.308901,"lon":113.915001,"cca2":"HK","region":"Asia Pacific","city":"Hong Kong"}}
```
(`asn 13335 / Cloudflare, Inc.` is because WARP is on. Without WARP this shows the real ISP.)

### `GET https://speed.cloudflare.com/__down?bytes=N`
- No auth header needed. The body is N bytes of `application/octet-stream`, with `Cache-Control: no-store`.
- Useful response headers (the same data as `/meta`, so no second request is needed): `cf-meta-ip`, `colo: HKG`, `city`, `country`, `asn`, `cf-meta-request-time` (ms epoch), `Server-Timing: cfSpeedEdge;dur=2, cfSpeedWorker;dur=18, cfL4;desc="?proto=TCP&rtt=…"`.
- `bytes=0` gives a cheap latency probe (curl TTFB about 175 ms on a new connection including TLS, and about 50 ms on a reused one).
- Server processing time is in `Server-Timing` (`dur=` values sum to about 20 ms). Subtract it from TTFB for a better latency estimate.

curl sample: `size=1000000 time=0.698 ttfb=0.173 speed=1432086` (bytes/s, about 11.5 Mbps, including handshake).

### `POST https://speed.cloudflare.com/__up`
- Body: raw bytes, `Content-Type: application/octet-stream`. The response is 200 with an empty body and the header **`cf-meta-upload-bytes: 500000`**, which confirms the bytes received.
- 500 kB took 314 ms (about 12.7 Mbps wall-clock, including RTT, so it underestimates).

### `GET https://1.1.1.1/cdn-cgi/trace`: `key=value` lines
```
fl=1176f25
h=1.1.1.1
ip=104.28.194.105
ts=1792198439.000
visit_scheme=https
uag=curl/8.7.1
colo=HKG
sliver=010-tier1
http=http/2
loc=PH
tls=TLSv1.3
sni=off
warp=on
gateway=off
rbi=off
kex=X25519
```
```js
const trace = Object.fromEntries((await (await fetch('https://1.1.1.1/cdn-cgi/trace')).text())
  .trim().split('\n').map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
// trace.ip, trace.colo, trace.loc, trace.warp === 'on'
```
`warp=on` is worth showing in the UI, because it means the speed and public IP are WARP's and not the ISP's. Node's fetch gets `http=http/1.1` here (undici has no h2 by default) while curl gets `http/2`.

---

## 7. Node 20 `fetch` download Mbps: approach and pitfalls

### Approach (validated)
```js
const H = { Referer: 'https://speed.cloudflare.com/' };
export async function measureDown(bytes, timeoutMs = 15000) {
  const t0 = performance.now();
  const res = await fetch(`https://speed.cloudflare.com/__down?bytes=${bytes}`,
    { headers: H, cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const tHeaders = performance.now();
  let n = 0, tFirst = null;
  for await (const chunk of res.body) {          // stream, never buffer with arrayBuffer() for big N
    if (tFirst === null) tFirst = performance.now();
    n += chunk.byteLength;
  }
  const tEnd = performance.now();
  const bodySec = tFirst === null ? null : (tEnd - tFirst) / 1000;
  return { bytes: n, ttfbMs: tHeaders - t0,
           mbpsWall: n * 8 / ((tEnd - t0) / 1000) / 1e6,
           mbpsBody: bodySec ? n * 8 / bodySec / 1e6 : null };
}
```
Measured here (same process, consecutive requests):
| request | TTFB | body time | Mbps (wall) | Mbps (body) |
|---|---|---|---|---|
| 100 kB | 54 ms | 189 ms | 3.3 | 4.2 |
| 1 MB | 113 ms | 221 ms | 23.9 | 36.2 |
| 1 MB (again) | 110 ms | 524 ms | 12.6 | 15.3 |
| 500 kB up | – | 314 ms | 12.7 | – |

### Pitfalls
1. **Small transfers are dominated by TCP slow start and RTT.** 100 kB measured 3–4 Mbps and 1 MB measured 15–36 Mbps on the same link. For a real number, use several sizes (Cloudflare's own test ramps 100 kB → 1 MB → 10 MB → 25 MB), drop the first or smallest, and report the **90th percentile** of per-request body Mbps. Under the ~10 MB budget, 1 MB × 3–5 is the minimum that means anything.
2. **Time the body, not the request.** Wall time includes DNS, TLS and TTFB. Start the clock at the first chunk (`mbpsBody`) or subtract TTFB.
3. **Large variance between runs** (36 vs 15 Mbps back to back on Wi-Fi). Take several samples, and never trust one.
4. **Connection reuse:** undici keeps sockets alive, so the first request pays for DNS and TLS (the 0 B probe took 51 ms to headers, and curl took 175 ms on a cold connection). Warm up with `bytes=0` first. Undici's pool is 1 h1 connection per request in flight, so for parallel streams just fire several fetches concurrently.
5. **Always consume or cancel the body** (`for await` or `res.body.cancel()`). An unread body holds the socket and leaks memory. Do not `await res.arrayBuffer()` for multi-MB transfers.
6. **Check `res.ok`**: `/meta` returns 403 `{}` without a Referer, which looks valid if you only parse JSON.
7. `cache: 'no-store'` is mostly a no-op in undici (it has no HTTP cache), but it's harmless. Cloudflare already sends `no-store`. Add a `&r=${Math.random()}` cache-buster if a proxy is in the path.
8. **Uploads:** `fetch` with a `Uint8Array` body works (a streaming body needs `duplex: 'half'`). You cannot see upload progress, so time it as total time minus about one RTT, and check the `cf-meta-upload-bytes` response header.
9. Use `performance.now()` (monotonic), not `Date.now()`.
10. **VPN/WARP changes everything**: check `/cdn-cgi/trace` `warp=on` and the `/meta` `asOrganization`, and flag it. Here the egress is Cloudflare's network (HKG), not the PH ISP.
11. HTTP/1.1 only in Node fetch (curl negotiates h2). The results are comparable for single-stream bulk download.
12. Concurrent LAN ping sweeps and the speed test compete for Wi-Fi airtime, so don't run them at the same time.

---

## 8. Implementation notes for `server/src/net/*` (backend-lan)

Re-validated 2026-10-17 against the real LAN (en0 10.0.0.94/24, gw 10.0.0.1) with scratch scripts outside the repo.

### Ping flags actually used (`pinger.js`)
| platform | argv | dead-host cost |
|---|---|---|
| macOS | `ping -c 1 -n -i 0.1 -W <ms> -t <ceil(ms/1000)+1> IP` | **0.82 s** at W=700 (vs 1.72 s without `-i 0.1`) |
| Linux (iputils) | `ping -c 1 -n -W <ceil(ms/1000)> IP` | ~1 s |
| fallback | same without `-i` / `-n` | used automatically once if ping prints a usage / invalid-option error (BusyBox, very old macOS) |

- On macOS, `-c 1` waits about one send interval plus `-W` before it gives up on a dead host. An unprivileged user may set `-i 0.1`, which cuts the cost to about 0.1 s + W. A live host returns as soon as it replies (gateway: 15 ms wall time).
- IPs are checked with a strict dotted-quad regex before they reach argv. `execFile` passes no shell, and the regex keeps values like `-c` out of argv.
- The reply line must say `bytes from <target>`, so replies from some other host (broadcast or redirect) count as lost. RTT is rounded to 0.01 ms. TTL comes from the same line.
- On Linux, a missing ICMP permission (`ping_group_range` / `cap_net_raw`) is logged once.

### Discovery scan (`discovery.js`)
1. Ping-sweep `hostsToScan(network)` (+ the gateway if it is outside the /24) with concurrency 64 and a 700 ms timeout.
2. Read the neighbour table: macOS `arp -an`. On Linux the order is `ip -4 neigh show`, then `/proc/net/arp`, then `arp -an`. Keep only complete unicast entries on `network.iface` inside `network.cidr`. Drop self.
3. **Retry pass:** any host that has an ARP entry but did not answer gets one more ping at 1500 ms (concurrency 16). This catches Wi-Fi clients in power save.
4. One entry per MAC (proxy-ARP or multi-IP hosts). The preferred IP is the gateway IP, then an IP that answered, then the lowest IP.
5. Reverse DNS goes through `dns.promises.Resolver({timeout:1500, tries:1})` plus a hard 1.5 s race. Results, negative ones included, are cached per IP for 10 min.
6. Self is always appended (`hostname = os.hostname()`, `alive:true`, `inArp:false`, `ttl:null`).

Measured: **32 devices (30 alive, 2 ARP-only), 4.97 s per scan** (the sweep takes about 3.3 s, and the retry pass, ARP read and DNS take the rest). A pinger round over 31 targets at concurrency 16 took 1.23 s. Reverse DNS found a name for only 1 of 31 hosts (`pi.hole`, from a Pi-hole resolver). As expected, mDNS and NetBIOS supply most names.

### Throughput (`throughput.js`)
`netstat -ibn -I en0` `<Link#N>` row, parsed from the right. The rate is the delta over `performance.now()` time. A negative delta, an implausible delta (> 400 Gbps) or a read error resets the baseline. Each distinct error is logged once. Measured with 1 s samples while idle: 6–8 Mbps rx, 0.1–0.3 Mbps tx.

### OUI table (`oui.js`)
The table is an offline, curated subset of the IEEE MA-L registry: about **2,550 prefixes from 114 vendor organisations**, written with IEEE spelling so `fingerprint/vendorHints.js` regexes match. It favours precision over recall, so a prefix not in the table gives `null`. On this LAN only 3 of 31 neighbours resolve: TP-Link (gateway and 10.0.0.9) and MSI (10.0.0.61). Most of the others are Chinese IoT modules that the table does not list. Randomized MACs (locally administered bit set) always return `null`.

### Observations useful for fingerprinting
- **TTL 255 is mostly embedded IoT, not network gear, here.** 12 of the 31 neighbours reply with TTL 255. They look like smart plugs and bulbs, since lwIP-based firmware (ESP8266/ESP32, Tuya, Beken modules) uses TTL 255 by default. Treat TTL 255 as "embedded device" and give it only a weak router/AP weight.
- The gateway (a TP-Link mesh router) replies with **TTL 63**, not 64. It is probably a mesh node forwarding or NATing for the main unit. Accept 60–64 as "Unix-like".
- TTL 128 appeared on 10.0.0.61 (MSI, so a Windows PC) and on 10.0.0.93.
- 4 of 31 neighbours use randomized MACs (phones, tablets and Macs with private Wi-Fi addresses). This machine's own en0 address is also randomized (`66:f1:…`).

### Known limitations
- **ARP lag:** macOS keeps neighbour entries for about 20 min after a host leaves. A device that never answers ICMP, which core treats as "seen via ARP", therefore shows as offline only after its entry expires. Hosts that answer ping are detected within `offlineAfterMs`.
- MAC-NAT range extenders make every client behind them appear with the extender's MAC. Those clients collapse into one device.
- Only the primary IPv4 /24 is swept. Larger subnets are clamped to the /24 that contains this host. ARP entries elsewhere in the real subnet are still reported.
- If the network changes (another Wi-Fi, a DHCP renumber), core must re-run `getNetworkInfo()` and recreate discovery, because discovery uses the `network` object it was given.
