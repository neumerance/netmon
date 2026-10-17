# NetMon — Build Plan (single source of truth)

Nine coders work **in parallel on disjoint files** and never talk to each other. Everything that crosses a
file boundary is pinned here. If something you need is not in this document, implement it **inside your own
files** (defensively) — never edit a file you do not own, and never create another owner's file (no stubs).

Conventions for everyone:

- Node 20.19, npm 10, **ESM everywhere** (`"type": "module"`), plain JavaScript, no TypeScript.
- Backend: only Node built-ins + `express` + `multicast-dns`. No native modules, no root required.
- Frontend: Vue 3.5 `<script setup>` SFCs, Tailwind CSS v4, no extra UI/chart/icon libraries (icons are inline SVG in `Icon.vue`, charts are hand-written SVG).
- All timestamps on the wire are **ISO-8601 strings** (`new Date().toISOString()`), all durations in ms, all speeds in **Mbps (decimal, 1 Mbps = 1,000,000 bit/s)** as numbers rounded to 1 decimal.
- **MAC format**: inside JSON always lowercase, zero-padded, colon-separated: `"a4:83:e7:1c:2d:01"`. In **URLs and data-testids** use dashes: `a4-83-e7-1c-2d-01`. The server accepts either form (dashes, colons, url-encoded colons, any case) in `:mac` params and normalizes.
- `null` (never `undefined`) for unknown values in JSON.
- No emojis in UI copy; use icons.

---

## 1. File tree and ownership

Owners: **core** = backend-core, **lan** = backend-lan, **fp** = backend-fingerprint, **inet** = backend-internet,
**mock** = backend-mock, **fnd** = frontend-foundation, **dev** = frontend-devices, **met** = frontend-metrics,
**alm** = frontend-alarms, **qa** = later test phase (not one of the nine).

```
netmon/
├─ package.json                         core   root scripts + devDeps (concurrently, @playwright/test)
├─ playwright.config.js                 core
├─ README.md                            core
├─ .gitignore                           core   (node_modules, web/dist, server/data, test-results, playwright-report)
├─ docs/
│  ├─ PLAN.md                           (this file, planner)
│  ├─ DESIGN.md                         fnd    visual language, tokens, layout, component usage
│  ├─ NETWORK_NOTES.md                  lan    platform commands/parsing notes, limitations
│  └─ FINGERPRINT_NOTES.md              fp     signals, weights, known devices, limitations
├─ e2e/                                 qa     *.spec.js (written later against §7 + §11)
├─ server/
│  ├─ package.json                      core
│  ├─ data/                             (runtime, gitignored; store.json)
│  └─ src/
│     ├─ index.js                       core   bootstrap + wiring (real vs mock)
│     ├─ core/
│     │  ├─ timings.js                  core   REAL_TIMINGS
│     │  ├─ store.js                    core   persistence (atomic JSON)
│     │  ├─ settings.js                 core   defaults + validation
│     │  ├─ state.js                    core   in-memory state + EventEmitter
│     │  ├─ devices.js                  core   device merge / online-offline / fingerprint scheduling
│     │  ├─ speed.js                    core   speed test controller (one at a time, auto schedule)
│     │  ├─ alerts.js                   core   pure alert computation
│     │  ├─ events.js                   core   event log
│     │  └─ sse.js                      core   SSE hub
│     ├─ routes/
│     │  └─ api.js                      core   Express router for /api/*
│     ├─ net/
│     │  ├─ sys.js                      lan    interface / gateway / MAC + CIDR helpers
│     │  ├─ discovery.js                lan    ping sweep + arp
│     │  ├─ pinger.js                   lan    ping(), per-device latency sampling (incl. TTL)
│     │  ├─ throughput.js               lan    self rx/tx counters
│     │  ├─ oui.js                      lan    MAC prefix -> vendor table
│     │  └─ fingerprint/
│     │     ├─ index.js                 fp     createFingerprinter + classify (scoring)
│     │     ├─ categories.js            fp     CATEGORIES, OS_VALUES, labels (server copy)
│     │     ├─ mdns.js                  fp
│     │     ├─ ssdp.js                  fp
│     │     ├─ netbios.js               fp
│     │     ├─ ports.js                 fp
│     │     ├─ hostname.js              fp
│     │     ├─ vendorHints.js           fp
│     │     └─ appleModels.js           fp
│     ├─ internet/
│     │  ├─ probe.js                    inet
│     │  ├─ speedtest.js                inet
│     │  └─ isp.js                      inet
│     └─ mock/
│        ├─ index.js                    mock   re-exports every drop-in + applyMockState etc.
│        ├─ devices.js                  mock   the deterministic device table (§7)
│        ├─ state.js                    mock   mutable mock world state
│        ├─ net.js                      mock   getNetworkInfo, createDiscovery, createPinger, createThroughputMonitor
│        ├─ fingerprint.js              mock   createFingerprinter
│        └─ internet.js                 mock   createProbe, runSpeedTest, fetchIsp, seedSpeedHistory
└─ web/
   ├─ package.json                      fnd
   ├─ index.html                        fnd
   ├─ vite.config.js                    fnd
   ├─ public/favicon.svg                fnd
   └─ src/
      ├─ main.js                        fnd
      ├─ App.vue                        fnd    layout; imports components by exact paths (§8.5)
      ├─ style.css                      fnd    @import "tailwindcss"; dark variant; @theme tokens
      ├─ api.js                         fnd    REST + SSE client
      ├─ store.js                       fnd    reactive store (§8.1)
      ├─ lib/
      │  ├─ deviceTypes.js              fnd    categories/OS labels, icons, deviceTypeLabel (§4.8)
      │  └─ format.js                   fnd    formatting helpers (§8.3)
      ├─ composables/
      │  ├─ useNow.js                   fnd
      │  ├─ useTheme.js                 fnd
      │  ├─ useClickOutside.js          fnd
      │  ├─ useSound.js                 alm
      │  ├─ useNotifications.js         alm
      │  └─ useTitleAlert.js            alm
      └─ components/
         ├─ ui/                         fnd    Card, Button, Badge, Icon, Modal, Drawer, Popover, Tooltip,
         │                                     Toggle, Spinner, Sparkline, StatTile, EmptyState, ConfirmDialog
         ├─ devices/                    dev    DevicesPanel + children (§8.6)
         ├─ metrics/                    met    InternetStatusCard, SpeedTestCard, SpeedGauge, IspCard,
         │                                     SpeedHistoryChart, LocalThroughputCard, EventsPanel
         └─ alarms/                     alm    TopBar, AlertStack, ToastHost, SettingsDrawer, AlarmController
```

Who runs `npm install`: **core** runs it in root and `server/`; **fnd** runs it in `web/`. Nobody else
installs anything. All dependencies are listed in §9 — do not add others.

---

## 2. Backend module interfaces (exact)

Every factory returns a plain object. Every `start()` is idempotent and non-blocking (kicks off timers and
an immediate first run); every `stop()` clears all timers/sockets and is idempotent. Callbacks must never
throw into the caller — modules wrap their own errors and log via `console.warn('[module] ...')`.
Options named `intervalMs`/`timeoutMs` are passed by core from the timings object (§6.6), so real and mock
factories must accept the **same option names**.

### 2.1 `server/src/net/sys.js` (lan)

```js
export async function getNetworkInfo(): Promise<NetworkInfo>
// NetworkInfo = { iface: 'en0', ip: '192.168.1.23', netmask: '255.255.255.0', cidr: '192.168.1.0/24',
//                 prefix: 24, mac: 'a4:83:e7:1c:2d:01', gateway: '192.168.1.1' | null, platform: 'darwin'|'linux'|... }
// Primary = first non-internal IPv4 iface that owns the default route (macOS `route -n get default`,
// Linux `ip route show default`), else first non-internal IPv4 (skip utun*, awdl*, llw*, bridge*, docker*, veth*, lo*).
// Throws Error('no_network') if none.
export function normalizeMac(s: string): string | null      // '0:1A:2b:3:4:5' -> '00:1a:2b:03:04:05'; also accepts '-' separators; invalid -> null
export function macToDashes(mac: string): string            // 'a4:83:...' -> 'a4-83-...'
export function isRandomizedMac(mac: string): boolean       // (firstOctet & 0x02) !== 0
export function isMulticastOrBroadcastMac(mac: string): boolean
export function ipToInt(ip: string): number
export function intToIp(n: number): string
export function compareIp(a: string, b: string): number     // numeric sort helper
export function hostsToScan(info: NetworkInfo): string[]    // all host IPs in the subnet, excluding network+broadcast+self;
                                                            // if prefix < 24, scan only the /24 containing info.ip
```

### 2.2 `server/src/net/oui.js` (lan)

```js
export function lookupVendor(mac: string): string | null    // by first 3 octets; randomized MAC -> null
export const OUI_TABLE: Record<string, string>              // 'a4:83:e7' -> 'Apple, Inc.'  (several hundred common prefixes:
                                                            // Apple, Samsung, Google, Amazon, Sonos, Roku, Ubiquiti, eero, TP-Link,
                                                            // Netgear, ASUS, Linksys, Aruba, Cisco/Meraki, Arris, Technicolor, Sagemcom,
                                                            // HP, Epson, Brother, Canon, Nintendo, Sony, Microsoft, Synology, QNAP,
                                                            // Hikvision, Wyze, Ring, Arlo, Espressif, Tuya, Shelly, Signify, Intel,
                                                            // Realtek, Dell, Lenovo, ASUSTek, Raspberry Pi, LG, Vizio, TCL, Xiaomi, OnePlus...)
```
Vendor strings should match the canonical IEEE organisation names (fp's `vendorHints.js` matches them by
case-insensitive regex, e.g. `/apple/i`, `/sonos/i`, `/tp-?link/i`).

### 2.3 `server/src/net/pinger.js` (lan)

```js
export async function ping(ip: string, { timeoutMs = 1000 } = {}): Promise<PingResult>
// PingResult = { alive: boolean, rttMs: number|null, ttl: number|null }
// macOS: ping -c 1 -W <timeoutMs> -t <ceil(timeoutMs/1000)+1> ip ; Linux: ping -c 1 -W <ceil(timeoutMs/1000)> ip ; parse 'time=' and 'ttl='.

export function createPinger({ intervalMs = 10000, timeoutMs = 1000, concurrency = 16, onSample }): Pinger
// Pinger = { setTargets(targets: Array<{ mac, ip }>): void, start(): void, stop(): void,
//            pingNow(): Promise<void> }   // runs one round over current targets immediately
// Each round pings every target (bounded concurrency) and calls, per target:
// onSample({ mac, ip, alive, rttMs, ttl, at })   // at = ISO time
```

### 2.4 `server/src/net/discovery.js` (lan)

```js
export function createDiscovery({ network /* NetworkInfo */, intervalMs = 30000, concurrency = 64,
                                  pingTimeoutMs = 700, onDevices }): Discovery
// Discovery = { start(): void, stop(): void, scanNow(): Promise<RawDevice[]> }
// A scan = ping-sweep hostsToScan(network) with ping() + parse `arp -an` (Linux fallback: `ip neigh`).
// Calls onDevices(rawDevices, { scannedAt, durationMs }) after every scan (also for scanNow()).
// RawDevice = {
//   mac, ip,
//   hostname: string|null,   // dns.promises.reverse(ip) best-effort, 1.5 s timeout, cached per ip 10 min, trailing '.' stripped
//   vendor: string|null,     // lookupVendor(mac)
//   alive: boolean,          // answered ICMP in this sweep
//   inArp: boolean,          // complete entry in ARP/neigh table during this scan
//   ttl: number|null,        // from the sweep reply
//   isSelf: boolean, isGateway: boolean
// }
// Self is always included (mac/ip from network, alive:true, inArp:false). Skip incomplete, broadcast, multicast,
// and entries on other interfaces. Overlapping scans are not allowed (scanNow while scanning returns the in-flight promise).
```

### 2.5 `server/src/net/throughput.js` (lan)

```js
export async function readCounters(ifaceName: string): Promise<{ rxBytes: number, txBytes: number, at: number /* ms epoch */ }>
// macOS: `netstat -ibn` (row for iface with <Link#> address); Linux: /proc/net/dev
export function createThroughputMonitor({ ifaceName, intervalMs = 2000, onSample }): { start(), stop() }
// onSample({ rxMbps, txMbps, at /* ISO */ })  — computed from counter deltas; first sample after 2 reads; counter wrap -> skip.
```

### 2.6 `server/src/net/fingerprint/*` (fp)

`categories.js`:
```js
export const CATEGORIES = ['computer','laptop','phone','tablet','router','access_point','network_switch','tv',
  'media_player','speaker','printer','camera','console','nas','server','smart_home','wearable','unknown'];
export const OS_VALUES = ['windows','macos','ios','ipados','android','linux','chromeos','tvos','other'];
export const CATEGORY_LABELS = { /* same labels as web/src/lib/deviceTypes.js §4.8 */ };
export const OS_LABELS = { /* same as §4.8 */ };
```

`index.js`:
```js
export function createFingerprinter({ getSettings /* () => Settings */, onResult, concurrency = 2,
                                      passiveBrowseMs = 300000, activeProbeMinIntervalMs = 3600000 }): Fingerprinter
// Fingerprinter = {
//   start(): void,              // opens mDNS + SSDP sockets, browses immediately and every passiveBrowseMs
//   stop(): void,
//   updateDevices(devices: Array<{ mac, ip, hostname, vendor, isGateway, isSelf, ttl }>): void,
//                               // ip->device map so late passive mDNS/SSDP answers can be attributed
//   fingerprint(device, { force = false } = {}): Promise<FingerprintResult>,
//                               // queued (concurrency); gathers passive info for device.ip, then if
//                               // getSettings().activeFingerprinting && (force || last active probe of this
//                               // mac > activeProbeMinIntervalMs ago): probePorts + queryNetbios. Then classify().
//                               // Always also calls onResult(mac, result). Never rejects (errors -> evidence-less result).
// }
// When new passive mDNS/SSDP data arrives for a known device whose classification changes, call onResult(mac, result).

export function classify(input: ClassifyInput): FingerprintResult        // pure, deterministic, unit-testable
// ClassifyInput = { mac, ip, hostname, vendor, isGateway, isSelf, randomizedMac, ttl,
//                   openPorts: number[]|null, mdns: MdnsInfo|null, upnp: UpnpInfo|null, netbiosName: string|null }

// FingerprintResult = {
//   category: Category,              // never null; 'unknown' if best score < 0.25
//   os: Os | null,
//   model: string | null,            // friendly: 'MacBook Pro', 'iPhone 15 Pro', 'Sonos One', 'Chromecast', 'Deco M5'
//   manufacturer: string | null,     // from UPnP/mDNS when available (used if OUI vendor is null)
//   typeConfidence: number,          // 0..1, 2 decimals
//   typeEvidence: string[],          // human readable, strongest first, e.g. 'mDNS model MacBookPro18,3 → MacBook Pro',
//                                    // 'TTL 128 → Windows', 'Port 62078 open → iOS', 'Vendor Sonos → speaker',
//                                    // 'Randomized (private) MAC → mobile device', 'Default gateway → router'
//   hostnameHints: string[],         // names learned from mDNS/NetBIOS/UPnP friendlyName, best first, e.g. ['Jons-iPhone']
//   signals: { ttl, openPorts, mdnsServices: string[], mdnsModel: string|null, upnpDeviceType: string|null,
//              upnpFriendlyName: string|null, upnpModel: string|null, netbiosName: string|null },
//   activeProbed: boolean,
//   fingerprintedAt: string          // ISO
// }
```

Sub-modules (fp-internal, but pinned so the scoring stays coherent):
```js
// mdns.js
export function createMdnsBrowser({ onUpdate /* (ip) => void */ }): { start(), stop(), browseNow(): Promise<void>, get(ip): MdnsInfo|null }
// MdnsInfo = { hostname: 'Jons-iPhone.local'|null, services: ['_companion-link._tcp', ...], model: 'iPhone16,1'|null,
//              txt: Record<string,string>, instanceNames: string[] }
// Browse _services._dns-sd._udp.local, then PTR for each service; read _device-info._tcp TXT model=, _googlecast TXT md= fn=,
// _airplay/_raop TXT model=/am=. Uses 'multicast-dns' (reuseAddr). Must not crash if port 5353 is busy.
// ssdp.js
export function createSsdpBrowser({ onUpdate }): { start(), stop(), searchNow(): Promise<void>, get(ip): UpnpInfo|null }
// UpnpInfo = { server, location, deviceType, friendlyName, manufacturer, modelName, modelNumber }   (XML fetched from LOCATION, 2 s timeout, regex-parsed)
// netbios.js
export async function queryNetbios(ip, { timeoutMs = 800 } = {}): Promise<{ name: string, group: string|null } | null>
// ports.js
export const DEFAULT_PORTS = [22,53,80,139,443,445,548,631,1400,3389,5000,5001,7000,8008,8009,8060,8080,9100,32400,62078];
export async function probePorts(ip, { ports = DEFAULT_PORTS, timeoutMs = 400, concurrency = 6 } = {}): Promise<number[]>
// hostname.js / vendorHints.js
export function hostnameHints(hostname: string|null): Hint[]
export function vendorHints(vendor: string|null): Hint[]
// Hint = { category?: Category, os?: Os, model?: string, weight: number /* 0..1 */, evidence: string }
// appleModels.js
export function appleModelInfo(modelId: string): { name: string, category: Category, os: Os } | null
// 'MacBookPro18,3' -> { name:'MacBook Pro', category:'laptop', os:'macos' }; 'iPhone16,1' -> { name:'iPhone 15 Pro', category:'phone', os:'ios' }
```

Scoring guidance (fp may tune; document final table in FINGERPRINT_NOTES.md): collect Hints from all
signals; per category score = noisy-OR `1 - Π(1 - w)`; winner = max; `typeConfidence = winner` minus 0.15 if
runner-up is within 0.1 (floor 0.05). OS and model chosen the same way among hints carrying them. Reference
weights: isGateway 0.95; mDNS/Apple model id 0.9; UPnP deviceType 0.8; Sonos/Roku/printer
service ports (1400/8060/9100/631) 0.7; hostname exact patterns 0.6–0.8; vendor category hint 0.3–0.6
(generic vendors like Apple/Samsung only imply OS, not category); TTL 0.3 (OS only: 128→windows, 255→network
gear 0.3 to router/access_point); randomized MAC 0.35 split phone/tablet/laptop (phone highest); port 62078 →
ios 0.7; 3389/445+139 → windows 0.5; 548 → macos 0.5; 8008/8009 → media_player (Chromecast) 0.6. Non-gateway
answering 53 and 80/443 with network vendor or UPnP AP/IGD → `access_point` 0.75 (evidence
"DNS + web admin on non-gateway → mesh node / secondary router"). Gateway always wins `router`.

### 2.7 `server/src/internet/*` (inet)

```js
// probe.js
export function createProbe({ intervalMs = 5000, timeoutMs = 3000, failuresForDown = 2, onStatus }): Probe
// Probe = { start(), stop(), checkNow(): Promise<InternetStatus> }
// Each check: GET https://1.1.1.1/cdn-cgi/trace (timeout) else GET https://www.google.com/generate_204. Success = HTTP 2xx/204.
// Status 'unknown' until first check; 'up' after any success; 'down' after failuresForDown consecutive failures.
// onStatus(InternetStatus) after EVERY check:
// InternetStatus = { status: 'unknown'|'up'|'down', since: ISO /* time of last status change */, lastCheckedAt: ISO,
//                    latencyMs: number|null /* HTTP RTT of the successful check */, consecutiveFailures: number,
//                    target: '1.1.1.1'|'google.com'|null, error: string|null }

// speedtest.js
export async function runSpeedTest({ onProgress, signal } = {}): Promise<SpeedTestRaw>
// Cloudflare: latency = 20 x GET https://speed.cloudflare.com/__down?bytes=0 (median = pingMs, mean abs successive diff = jitterMs);
// download = 4 parallel streams of __down?bytes=25000000 for ~8 s (ramp sizes ok); upload = POST https://speed.cloudflare.com/__up
// 4 parallel, ~6 s. Abortable via signal (reject AbortError). Rejects Error('speedtest_failed: ...') on network failure.
// onProgress({ phase: 'latency'|'download'|'upload', percent /* 0..100 OVERALL: latency 0-10, download 10-60, upload 60-100 */,
//              currentMbps: number|null })   // at most every 200 ms
// SpeedTestRaw = { downloadMbps, uploadMbps, pingMs, jitterMs, colo: string|null, durationMs, bytesDown, bytesUp }

// isp.js
export async function fetchIsp({ timeoutMs = 5000 } = {}): Promise<Isp>
// https://speed.cloudflare.com/meta, fallback http://ip-api.com/json. Rejects if both fail.
// Isp = { name: 'Comcast Cable Communications', asn: 7922 | null, ip: '73.162.88.14', city, region, country /* 'US' */,
//         colo: 'SJC'|null, source: 'cloudflare'|'ip-api'|'mock', fetchedAt: ISO }
```

### 2.8 `server/src/mock/index.js` (mock)

Exports **drop-in replacements with identical signatures** plus mock control:
```js
export { getNetworkInfo, createDiscovery, createPinger, createThroughputMonitor } from './net.js';
export { createFingerprinter } from './fingerprint.js';
export { createProbe, runSpeedTest, fetchIsp, seedSpeedHistory } from './internet.js';
export const MOCK_TIMINGS = { /* §6.6 */ };
export function applyMockState(patch): { state: MockState, effects: { rescan: boolean, runSpeedTest: boolean, reprobe: boolean, reset: boolean } }
export function getMockState(): MockState
export function resetMockState(): void
// Pure helpers (normalizeMac, isRandomizedMac, macToDashes, compareIp) are NOT re-exported: core imports them from
// ../net/sys.js in both modes (pure functions, no I/O). Mock may import them too.
export function seedSpeedHistory(now = Date.now()): SpeedResult[]   // see §7.4
```
`classify` is not needed in mock. Mock modules must make **no network calls and no child processes**.

### 2.9 Core (core)

```js
// core/timings.js
export const REAL_TIMINGS = { /* §6.6 */ };
// core/settings.js
export const DEFAULT_SETTINGS = { speedThresholdMbps: 200, speedTestIntervalMin: 15, soundAlerts: true, activeFingerprinting: true };
export function validateSettings(patch): { ok: true, value: Partial<Settings> } | { ok: false, errors: Record<string,string> }
// core/store.js
export function createStore({ dataDir }): Store   // load() reads data/store.json (missing/corrupt -> defaults, corrupt file renamed *.corrupt-<ts>)
// Store = { load(), flush(), resetAll(),
//   getSettings(), setSettings(patch),
//   listSaved(), getSaved(mac), upsertSaved(mac, {name,type,notes}), removeSaved(mac),
//   getKnown(mac), upsertKnown(mac, {ip,hostname,vendor,lastSeen,firstSeen}),
//   getFingerprint(mac), setFingerprint(mac, {ip, at, result}),
//   getSpeedHistory(), addSpeedResult(r),           // cap 200
//   getEvents(), addEvent(e) }                      // cap 500
// Writes debounced 500 ms, atomic write to store.json.tmp then fs.rename.
// core/alerts.js
export function computeAlerts({ internet, speed, devices, settings, firstScanDone, previous /* Alert[] */ }): Alert[]
// core/events.js
export function createEventLog({ store, onEvent }): { add({ type, level, message, mac?, data? }): Event, list(limit) }
// core/sse.js
export function createSseHub({ getSnapshot, heartbeatMs = 15000 }): { handler(req, res), broadcast(type, data), clientCount() }
// core/state.js — createState({ store, timings, eventLog }) -> EventEmitter with getSnapshot(), getDevices(), getDevice(mac) ...
// core/devices.js, core/speed.js — internal to core.
```

`server/src/index.js` wiring (core):
```
const MOCK = process.env.NETMON_MOCK === '1'
const impl = MOCK ? await import('./mock/index.js') : { ...net/sys, net/discovery, net/pinger, net/throughput,
              net/fingerprint/index, internet/probe, internet/speedtest, internet/isp }   // dynamic imports
timings = MOCK ? impl.MOCK_TIMINGS : REAL_TIMINGS
dataDir = process.env.NETMON_DATA_DIR || server/data (resolved from import.meta.url, not cwd)
store.load(); network = await impl.getNetworkInfo()
discovery = impl.createDiscovery({ network, intervalMs: timings.scanIntervalMs, onDevices: devices.applyScan })
pinger    = impl.createPinger({ intervalMs: timings.pingIntervalMs, onSample: devices.applyPingSample })
thr       = impl.createThroughputMonitor({ ifaceName: network.iface, intervalMs: timings.throughputIntervalMs, onSample: devices.applySelfThroughput })
fp        = impl.createFingerprinter({ getSettings: store.getSettings, onResult: devices.applyFingerprint, passiveBrowseMs: timings.fingerprintPassiveBrowseMs })
probe     = impl.createProbe({ intervalMs: timings.probeIntervalMs, timeoutMs: timings.probeTimeoutMs, onStatus: state.setInternet })
speed     = createSpeedController({ runSpeedTest: impl.runSpeedTest, ... })
isp refresh: impl.fetchIsp() at boot and every timings.ispRefreshMs (and right after internet goes down->up)
Express: app.use('/api', apiRouter); serve web/dist (resolved from import.meta.url) with SPA fallback for non-/api GETs.
listen(PORT || 4000, HOST || '127.0.0.1'); log 'NetMon listening on http://HOST:PORT (mock|real)'.
SIGINT/SIGTERM: stop all modules, store.flush(), exit.
```
If `getNetworkInfo` throws in real mode, the server still starts (network = null, devices empty, event logged).

---

## 3. REST API (core) — base `/api`, JSON, errors `{ "error": "<code>", "message": "...", "details"?: {} }`

| Method & path | Success | Errors |
|---|---|---|
| `GET /api/health` | `200 { "ok": true, "mock": true, "version": "1.0.0", "startedAt": ISO, "uptimeSec": 12, "clients": 1 }` | — |
| `GET /api/snapshot` | `200 Snapshot` (below) | — |
| `GET /api/devices` | `200 { "devices": Device[] }` | — |
| `PUT /api/devices/:mac` | `200 { "device": Device }` — saves/updates. Body `{ "name": "Living room PC", "type": "computer" \| null, "notes": "" }`. `name` required, trimmed 1–64 chars; `type` null (=auto) or a CATEGORIES id; `notes` optional string ≤ 500 (default ""). | `400 validation` (details per field), `404 not_found` (MAC neither currently known nor saved) |
| `DELETE /api/devices/:mac` | `200 { "ok": true }` — forgets the saved entry (name/type/notes). Online device stays listed unsaved; offline unsaved device disappears. | `404 not_found` (not saved) |
| `POST /api/devices/:mac/fingerprint` | `200 { "device": Device }` — re-detects with `force:true`, awaits result (timeout 15 s → returns current device). Ignored user type remains (user always wins). | `404 not_found` (not currently online), `409 offline` |
| `POST /api/speedtest` | `202 { "ok": true, "started": true }` (trigger `manual`) | `409 speedtest_running`, `503 internet_down` |
| `GET /api/speedtest/history?limit=200` | `200 { "history": SpeedResult[] }` chronological (oldest first), default/max 200 | — |
| `GET /api/settings` | `200 Settings` | — |
| `PUT /api/settings` | `200 Settings` — partial patch | `400 validation` (unknown key or out of range) |
| `GET /api/events?limit=100` | `200 { "events": Event[] }` newest first, default 100, max 500 | — |
| `POST /api/mock/state` | `200 { "ok": true, "mock": MockState }` | `404 not_found` when not in mock mode, `400 validation` |
| `GET /api/stream` | SSE (§5) | — |

Settings validation: `speedThresholdMbps` number 1–10000; `speedTestIntervalMin` integer, `0` (= auto off) or 5–1440;
`soundAlerts` boolean; `activeFingerprinting` boolean. Changing `speedTestIntervalMin` reschedules `nextAutoAt`;
changing `speedThresholdMbps` recomputes alerts immediately.

Example `GET /api/snapshot` (mock mode, abbreviated arrays):
```json
{
  "mock": true,
  "serverTime": "2026-10-17T15:04:05.000Z",
  "network": { "iface": "en0", "ip": "192.168.1.23", "netmask": "255.255.255.0", "cidr": "192.168.1.0/24", "prefix": 24,
               "mac": "a4:83:e7:1c:2d:01", "gateway": "192.168.1.1", "platform": "darwin",
               "scanning": false, "lastScanAt": "2026-10-17T15:04:04.500Z", "firstScanDone": true },
  "devices": [ { "...": "Device, see §4.1" } ],
  "internet": { "status": "up", "since": "2026-10-17T15:00:00.000Z", "lastCheckedAt": "2026-10-17T15:04:05.000Z",
                "latencyMs": 14, "consecutiveFailures": 0, "target": "1.1.1.1", "error": null },
  "speed": { "running": false, "progress": null, "last": { "...": "SpeedResult" }, "lastError": null,
             "nextAutoAt": "2026-10-17T15:15:00.000Z", "history": [ "...last 50 SpeedResult, oldest first" ] },
  "isp": { "name": "Comcast Cable Communications", "asn": 7922, "ip": "73.162.88.14", "city": "San Francisco",
           "region": "California", "country": "US", "colo": "SJC", "source": "mock", "fetchedAt": "2026-10-17T15:00:00.100Z" },
  "alerts": [],
  "settings": { "speedThresholdMbps": 200, "speedTestIntervalMin": 15, "soundAlerts": true, "activeFingerprinting": true },
  "events": [ "...last 100 Event, newest first" ]
}
```
`isp` is `null` until first fetch succeeds. `speed.last` is `null` until a result exists.

---

## 4. Data models

### 4.1 Device (wire shape, produced by core/devices.js)
```json
{
  "mac": "5a:1f:3e:8c:44:04",
  "ip": "192.168.1.61",
  "hostname": "Jons-iPhone",
  "vendor": null,
  "name": "Jon's iPhone",
  "saved": true,
  "notes": "",
  "online": true,
  "isSelf": false,
  "isGateway": false,
  "randomizedMac": true,
  "firstSeen": "2026-10-17T14:00:00.000Z",
  "lastSeen": "2026-10-17T15:04:04.000Z",
  "category": "phone",
  "autoCategory": "phone",
  "os": "ios",
  "model": "iPhone 15 Pro",
  "typeConfidence": 0.9,
  "typeEvidence": ["mDNS model iPhone16,1 → iPhone 15 Pro", "Port 62078 open → iOS", "Randomized (private) MAC → mobile device", "TTL 64 → Unix-like"],
  "typeSource": "auto",
  "userType": null,
  "fingerprinting": false,
  "latencyMs": 8.4,
  "jitterMs": 3.9,
  "lossPct": 0,
  "ttl": 64,
  "latencyHistory": [7.9, 8.8, null, 8.1],
  "rxMbps": null,
  "txMbps": null
}
```
Rules:
- `hostname` = DNS reverse name, else `hostnameHints[0]`, else null. The server strips a trailing `.` and the suffixes `.local`, `.lan`, `.home`, `.localdomain`.
- `vendor` = OUI vendor, else fingerprint `manufacturer`, else null.
- `category` = `userType ?? autoCategory`; `typeSource` = `userType ? 'user' : 'auto'`. Before first fingerprint: `autoCategory 'unknown'`, `typeConfidence 0`, `typeEvidence []`, `fingerprinting true`.
- `latencyHistory`: last ≤ 30 samples, oldest first, `null` = lost ping. `latencyMs` = mean of non-null in last 10 samples; `jitterMs` = mean absolute difference of consecutive non-null samples in that window; `lossPct` = % lost over the whole history (0–100, 1 decimal). All `null` when no samples (e.g. self — self is not pinged; offline saved devices keep last values but UI greys them).
- `rxMbps`/`txMbps`: only for `isSelf` (from throughput monitor), `null` for every other device.
- Saved devices that are not currently seen are still listed (`online:false`, `lastSeen` from store, `ip` last known).

### 4.2 SpeedResult
```json
{ "id": "st_1729177445000", "at": "2026-10-17T15:04:05.000Z", "trigger": "manual",
  "downloadMbps": 452.3, "uploadMbps": 41.2, "pingMs": 12.0, "jitterMs": 1.5,
  "colo": "SJC", "durationMs": 2000, "bytesDown": 250000000, "bytesUp": 20000000 }
```
`trigger`: `'auto' | 'manual' | 'startup'`. Only successful tests become SpeedResults; failures set `speed.lastError = { message, at }`.

### 4.3 Speed state (snapshot `speed`)
`{ running: boolean, progress: { phase: 'latency'|'download'|'upload', percent: 0..100, currentMbps: number|null } | null, last: SpeedResult|null, lastError: {message, at}|null, nextAutoAt: ISO|null, history: SpeedResult[] }`

### 4.4 Isp — §2.7.  InternetStatus — §2.7.

### 4.5 Alert
```json
{ "id": "slow_speed", "level": "warning", "kind": "slow_speed",
  "title": "Internet speed below 200 Mbps",
  "message": "Last test measured 152.4 Mbps download (threshold 200 Mbps).",
  "since": "2026-10-17T15:04:05.000Z", "mac": null }
```
- `internet_down`: id `internet_down`, level `critical`, title `Internet is down`, message `No internet connectivity — last successful check <relative-free ISO in data>`; `since = internet.since`.
- `slow_speed`: id `slow_speed`, level `warning`, `since` = `at` of the SpeedResult that first went below.
- `device_offline`: id `device_offline:<mac>`, level `info`, title `<name> is offline`, message `Last seen <ISO>`, `mac` set, `since = lastSeen`.
Alerts array order: critical, warning, info; then `since` ascending.

### 4.6 Event
```json
{ "id": "ev_1729177445000_3", "at": "2026-10-17T15:04:05.000Z", "type": "device_offline", "level": "info",
  "message": "Living room PC went offline", "mac": "3c:7c:3f:5a:9b:03", "data": null }
```
Types / levels: `device_new` (info) "New device on network: <hostname|vendor|ip>", `device_online` (info), `device_offline` (warning),
`device_saved` (info), `device_forgotten` (info), `internet_down` (critical), `internet_restored` (info, `data.downtimeMs`),
`speedtest_complete` (info; warning if below threshold; `data` = SpeedResult), `speedtest_failed` (warning), `settings_changed` (info),
`server_started` (info). `device_online`/`device_offline` are logged **only for saved devices**. `device_new` is logged for a MAC
never seen before (persisted in `store.known`), not on every restart.

### 4.7 Settings — §2.9 `DEFAULT_SETTINGS`. Per-browser prefs (theme, mute, dismissed alerts) live in `localStorage`, not the server.

### 4.8 Categories, OS, labels, icons — `web/src/lib/deviceTypes.js` (fnd) and `server/.../categories.js` (fp)

| id | label | plural (chips) | icon |
|---|---|---|---|
| computer | Computer | computers | desktop |
| laptop | Laptop | laptops | laptop |
| phone | Phone | phones | phone |
| tablet | Tablet | tablets | tablet |
| router | Router | routers | router |
| access_point | Wi-Fi access point | access points | wifi |
| network_switch | Network switch | switches | switch |
| tv | TV | TVs | tv |
| media_player | Streaming device | streaming devices | cast |
| speaker | Smart speaker | speakers | speaker |
| printer | Printer | printers | printer |
| camera | Camera | cameras | camera |
| console | Game console | consoles | gamepad |
| nas | NAS | NAS | database |
| server | Server | servers | server |
| smart_home | Smart home | smart home | home |
| wearable | Wearable | wearables | watch |
| unknown | Unknown device | unknown | question |

OS labels: windows `Windows`, macos `macOS`, ios `iOS`, ipados `iPadOS`, android `Android`, linux `Linux`, chromeos `ChromeOS`,
tvos `tvOS`, other `Other`; null → `—`. OS icon names: windows `windows`, macos/ios/ipados/tvos `apple`, android `android`, linux `linux`, others none.

`web/src/lib/deviceTypes.js` exports (exact):
```js
export const CATEGORIES            // array of ids, table order
export const CATEGORY_LABELS       // { id: label }
export const CATEGORY_PLURALS      // { id: plural }
export const CATEGORY_ICONS        // { id: iconName }
export const OS_LABELS             // { os: label }
export const OS_ICONS              // { os: iconName }
export const TYPE_GROUPS = { computers: ['computer','laptop','server'], mobile: ['phone','tablet','wearable'],
  network: ['router','access_point','network_switch'], media: ['tv','media_player','speaker','console'],
  home: ['smart_home','camera'], office: ['printer','nas'], other: ['unknown'] };
export function deviceTypeLabel(device): string
export function deviceIcon(device): string                  // CATEGORY_ICONS[device.category] ?? 'question'
export function confidenceLevel(c): 'high'|'medium'|'low'    // >=0.75 high, >=0.45 medium, else low
export function deviceDisplayName(device): string            // name || hostname || model || vendor || ip || mac
```
`deviceTypeLabel` algorithm (exact):
```
base =
  (computer|laptop|server) & macos -> 'Mac'; & windows -> 'Windows PC'; & linux -> 'Linux PC'; & chromeos -> 'Chromebook'
  phone & ios -> 'iPhone';  phone & android -> 'Android phone'
  tablet & ipados -> 'iPad'; tablet & android -> 'Android tablet'
  router & device.isGateway -> 'Router (gateway)'
  tv|media_player & tvos -> 'Apple TV'
  otherwise CATEGORY_LABELS[category]
if !model -> base
else if model.toLowerCase().startsWith(base.toLowerCase()) -> model          // 'iPhone 15 Pro', 'Windows PC'
else -> `${base} · ${model}`                                                // 'Mac · MacBook Pro', 'Router (gateway) · UniFi Dream Machine'
```

---

## 5. SSE — `GET /api/stream` (core)

Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`; `res.flushHeaders()`.
Frame format: `event: <type>\ndata: <JSON>\n\n`. Heartbeat comment `:hb\n\n` every 15 s. On connect the server immediately sends `snapshot`.

| event | payload | when |
|---|---|---|
| `snapshot` | Snapshot (§3) | on connect |
| `devices` | `Device[]` (full list, same order as GET /api/devices) | after every scan, after removals, and coalesced ping/throughput updates (at most once per `timings.devicesBroadcastMs`) |
| `device` | `Device` | single-device change: user save/forget-edit, fingerprint result, online↔offline transition |
| `internet` | InternetStatus | after every probe check (mock: every 1 s) |
| `speed` | Speed state **without** `history` | start, every progress tick, completion, failure, nextAutoAt change. On completion `last` is the new result; client appends it to its history if the `id` is new |
| `isp` | Isp | after each successful fetch |
| `alerts` | `Alert[]` (full list) | whenever the computed list changes (deep compare of ids+since+message) |
| `event` | Event | each new event |
| `settings` | Settings | after PUT /api/settings and after reset |
| `network` | network object (as in snapshot) | iface/ip/gateway change, scan start/end |

After `POST /api/mock/state {reset:true}` core broadcasts a fresh `snapshot` to all clients (the client replaces all state on `snapshot`).
Device list order everywhere: gateway first, then self, then by numeric IP; offline devices (saved) after online ones, by name.

---

## 6. Semantics

### 6.1 Online / offline (core/devices.js)
- A device is **seen** at time t when: it answered ICMP in a sweep (`alive`), or a pinger sample succeeded, or — only for devices
  that have *never* answered ICMP this session (`answersIcmp=false`, e.g. Windows firewall) — it had a complete ARP entry in a scan.
- `lastSeen` = last seen time. `online = now - lastSeen <= timings.offlineAfterMs`. Re-evaluated on every scan, ping round and a 1 s tick.
- Known limitation (document in NETWORK_NOTES.md): ARP entries for non-ICMP devices can linger ~20 min on macOS, so their offline detection lags.
- Pinger targets = all currently-listed devices except self (online ones plus saved offline ones at last IP, so returns are detected fast).
- Unsaved devices that go offline remain listed as Offline for `timings.dropUnsavedAfterMs`, then are removed from the live list (still in `store.known`).
- `store.known[mac].lastSeen` updated at most every 60 s per device (to limit writes); saved devices' lastSeen persisted the same way and on transition to offline.
- IP change for same MAC: update ip, keep identity; triggers re-fingerprint.

### 6.2 Alert rules (core/alerts.js, pure, recomputed on any input change)
- `internet_down` present iff `internet.status === 'down'`.
- `slow_speed` present iff `internet.status !== 'down'` AND `speed.last` exists AND `speed.last.downloadMbps < settings.speedThresholdMbps` (strict `<`; exactly 200 is not slow). Clears when a newer result is ≥ threshold or threshold is lowered below it. `since` preserved across recomputes while it stays active.
- `device_offline:<mac>` present iff device is saved AND `!online` AND `network.firstScanDone` (no alert storm at boot).
- Existing alert objects keep their original `since` (taken from `previous`) while continuously active.
- Client-side dismissal (warning/info only) hides an alert until its `since` changes. Critical alerts cannot be dismissed.

### 6.3 Speed test controller (core/speed.js)
- One test at a time; `POST /api/speedtest` while running → 409; while internet down → 503.
- Auto: if `speedTestIntervalMin > 0`, `nextAutoAt = lastTestEnd + interval`; auto tests skipped (and rescheduled) while internet is down.
- Startup: after `timings.startupSpeedTestDelayMs`, run a `startup` test if `speed.last` is null or older than the interval. In mock mode always run it.
- Progress events throttled to ≥100 ms apart. On success: store result, set `last`, event `speedtest_complete`, recompute alerts. On failure: `lastError`, event `speedtest_failed`.
- Reset (mock) aborts a running test via AbortController.

### 6.4 Internet / ISP
- Probe drives `internet`. Transition up→down: event `internet_down`; down→up: event `internet_restored` with downtime, immediate ISP refetch.
- ISP fetch failures keep the last value (no event).

### 6.5 Fingerprint scheduling (core/devices.js)
- After every scan call `fp.updateDevices(list)`. For each online device: fingerprint if no cache, cached `ip` ≠ current ip, cache older than `timings.refingerprintMs` (6 h), or user requested (force). Queue is inside fp; core does not await on the scan path.
- Results (from `fingerprint()` or passive `onResult`) are written to `store.fingerprints[mac] = { ip, at, result }` and applied to the Device; broadcast `device`.
- On boot cached fingerprints are applied immediately (devices show their type before re-detection).
- `activeFingerprinting=false` → fp skips port + NetBIOS probes (passive mDNS/SSDP/hostname/vendor/TTL only).

### 6.6 Timings
```js
REAL_TIMINGS = { scanIntervalMs: 30000, pingIntervalMs: 10000, throughputIntervalMs: 2000, probeIntervalMs: 5000,
  probeTimeoutMs: 3000, ispRefreshMs: 1800000, devicesBroadcastMs: 2000, offlineAfterMs: 90000, dropUnsavedAfterMs: 600000,
  refingerprintMs: 21600000, startupSpeedTestDelayMs: 5000, fingerprintPassiveBrowseMs: 300000 }
MOCK_TIMINGS = { scanIntervalMs: 1000, pingIntervalMs: 1000, throughputIntervalMs: 1000, probeIntervalMs: 1000,
  probeTimeoutMs: 500, ispRefreshMs: 60000, devicesBroadcastMs: 500, offlineAfterMs: 2500, dropUnsavedAfterMs: 30000,
  refingerprintMs: 21600000, startupSpeedTestDelayMs: 300, fingerprintPassiveBrowseMs: 60000 }
```

### 6.7 Persistence — `server/data/store.json` (or `$NETMON_DATA_DIR/store.json`)
```json
{ "version": 1,
  "settings": { "speedThresholdMbps": 200, "speedTestIntervalMin": 15, "soundAlerts": true, "activeFingerprinting": true },
  "saved": { "3c:7c:3f:5a:9b:03": { "mac": "3c:7c:3f:5a:9b:03", "name": "Living room PC", "type": null, "notes": "",
             "savedAt": "...", "updatedAt": "...", "lastSeen": "...", "lastIp": "192.168.1.45" } },
  "known": { "<mac>": { "mac": "...", "ip": "...", "hostname": "...", "vendor": "...", "firstSeen": "...", "lastSeen": "..." } },
  "fingerprints": { "<mac>": { "ip": "...", "at": "...", "result": { "...": "FingerprintResult" } } },
  "speedHistory": [ "SpeedResult (≤200, oldest first)" ],
  "events": [ "Event (≤500, oldest first on disk)" ] }
```
`resetAll()` restores this to an empty default (settings = DEFAULT_SETTINGS).

---

## 7. Mock mode (`NETMON_MOCK=1`) — testers rely on every value here

### 7.1 Network
`getNetworkInfo()` → `{ iface:'en0', ip:'192.168.1.23', netmask:'255.255.255.0', cidr:'192.168.1.0/24', prefix:24, mac:'a4:83:e7:1c:2d:01', gateway:'192.168.1.1', platform:'darwin' }`

### 7.2 Devices (all online at start; mock fingerprinter returns exactly these fields after 200 ms; mock discovery returns mac/ip/hostname/vendor/ttl/isSelf/isGateway)

| # | mac | ip | hostname | vendor | category | os | model | conf | ttl | base latency / jitter / loss |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | a4:83:e7:1c:2d:01 (self) | 192.168.1.23 | Jons-MacBook-Pro | Apple, Inc. | laptop | macos | MacBook Pro | 0.98 | 64 | self: not pinged; rx/tx live |
| 2 | f0:9f:c2:10:00:01 (gateway) | 192.168.1.1 | unifi | Ubiquiti Inc. | router | null | UniFi Dream Machine | 0.97 | 64 | 1.2 / 0.3 / 0 |
| 3 | 3c:7c:3f:5a:9b:03 | 192.168.1.45 | DESKTOP-7Q2K9LM | ASUSTek COMPUTER INC. | computer | windows | null | 0.92 | 128 | 2.5 / 0.6 / 0 |
| 4 | 5a:1f:3e:8c:44:04 (randomized) | 192.168.1.61 | Jons-iPhone | null | phone | ios | iPhone 15 Pro | 0.90 | 64 | 8.0 / 4.0 / 0 |
| 5 | 3c:28:6d:a1:b2:05 | 192.168.1.72 | Pixel-8 | Google, Inc. | phone | android | Pixel 8 | 0.85 | 64 | 12.0 / 5.0 / 0 |
| 6 | 50:c7:bf:3d:7e:06 | 192.168.1.2 | Deco-M5 | TP-LINK TECHNOLOGIES CO.,LTD. | access_point | null | Deco M5 | 0.88 | 64 | 2.0 / 0.5 / 0 |
| 7 | a8:23:fe:44:19:07 | 192.168.1.88 | LGwebOSTV | LG Electronics | tv | other | OLED65C3 | 0.90 | 64 | 5.0 / 1.5 / 0 |
| 8 | 3c:52:82:7a:0c:08 | 192.168.1.120 | HP-LaserJet-M404 | HP Inc. | printer | null | LaserJet Pro M404dn | 0.95 | 64 | 3.0 / 1.0 / 0 |
| 9 | 48:a6:b8:c1:d2:09 | 192.168.1.130 | Sonos-Living-Room | Sonos, Inc. | speaker | null | Sonos One | 0.96 | 64 | 4.0 / 1.0 / 0 |
| 10 | 00:25:96:12:34:0a | 192.168.1.150 | null | null | unknown | null | null | 0.10 | 64 | 20.0 / 8.0 / 5% (every 20th sample lost) |

`newDevice` adds #11: `8c:79:f5:3a:21:0b`, `192.168.1.140`, `Galaxy-Tab-S9`, `Samsung Electronics Co.,Ltd`, tablet, android, `Galaxy Tab S9`, 0.86, ttl 64, 9.0/3.0/0.

Evidence (`typeEvidence`, exact strings, strongest first):
1. `This computer`, `mDNS model MacBookPro18,3 → MacBook Pro`, `Vendor Apple`, `TTL 64 → Unix-like`
2. `Default gateway → router`, `UPnP InternetGatewayDevice`, `Vendor Ubiquiti → network gear`, `TTL 64 → Unix-like`
3. `Hostname DESKTOP-* → Windows`, `NetBIOS name DESKTOP-7Q2K9LM`, `TTL 128 → Windows`, `Port 445 open (SMB)`, `Port 3389 open (Remote Desktop)`
4. `mDNS model iPhone16,1 → iPhone 15 Pro`, `Port 62078 open → iOS`, `Randomized (private) MAC → mobile device`, `Hostname contains iPhone`
5. `Hostname Pixel-* → Android phone`, `Vendor Google`, `TTL 64 → Unix-like`
6. `Hostname Deco-* → TP-Link mesh Wi-Fi`, `DNS + web admin on non-gateway → mesh node / secondary router`, `UPnP WLANAccessPointDevice`, `Vendor TP-Link → network gear`
7. `Hostname LGwebOSTV → LG webOS TV`, `UPnP MediaRenderer "[LG] webOS TV OLED65C3"`, `Vendor LG Electronics`
8. `mDNS _ipp._tcp → printer`, `Port 9100 open (raw printing)`, `Port 631 open (IPP)`, `Vendor HP`
9. `Vendor Sonos → speaker`, `Port 1400 open (Sonos)`, `mDNS _sonos._tcp`, `UPnP ZonePlayer model Sonos One`
10. `No identifying services found`, `Vendor not recognized`, `TTL 64 → Unix-like`
11. `Hostname Galaxy-Tab-* → Samsung tablet`, `Vendor Samsung`, `TTL 64 → Unix-like`

`hostnameHints` = `[hostname]` when hostname non-null else `[]`. `activeProbed` true (false if activeFingerprinting off).
Expected UI labels: 1 `Mac · MacBook Pro`, 2 `Router (gateway) · UniFi Dream Machine`, 3 `Windows PC`, 4 `iPhone 15 Pro`,
5 `Android phone · Pixel 8`, 6 `Wi-Fi access point · Deco M5`, 7 `TV · OLED65C3`, 8 `Printer · LaserJet Pro M404dn`,
9 `Smart speaker · Sonos One`, 10 `Unknown device`, 11 `Android tablet · Galaxy Tab S9`.
Initial `typeCounts`: laptop 1, router 1, computer 1, phone 2, access_point 1, tv 1, printer 1, speaker 1, unknown 1.

### 7.3 Behaviour & determinism (no `Math.random`; use a tick counter)
- Discovery: every 1 s `onDevices` with all devices not in `devicesOffline` (`alive:true`, `inArp:true`).
- Pinger: every 1 s per target: offline target → `alive:false`; else `rttMs = round1(base + jitter * sin(tick*0.7 + idx))`, `ttl` from table; device 10 loses every 20th sample.
- Throughput (self): `rxMbps = round1(24 + 8*sin(tick/5))`, `txMbps = round1(3 + sin(tick/7))`.
- Probe: every 1 s; `internetDown` → failure; otherwise success latency 14 ms, target `1.1.1.1`. Same 2-consecutive-failure rule → down ≈ 2 s after `internetDown:true`; up ≤ 1 s after `internetDown:false`.
- `runSpeedTest`: if `internetDown` reject after 300 ms with `Error('speedtest_failed: internet unreachable')`. Else 2000 ms total, progress every 100 ms: latency 0–300 ms (percent 0→10, currentMbps null), download 300–1300 ms (10→60, currentMbps ramps to target), upload 1300–2000 ms (60→100). Result: `downloadMbps = state.downloadMbps` (default 450.0), `uploadMbps = state.uploadMbps` (default 40.0), `pingMs 12.0`, `jitterMs 1.5`, `colo 'SJC'`, `durationMs 2000`, `bytesDown = round(downloadMbps*125000*1)`, `bytesUp = round(uploadMbps*125000*0.7)`. Honors `signal`.
- `fetchIsp`: resolves after 50 ms with `{ name:'Comcast Cable Communications', asn:7922, ip:'73.162.88.14', city:'San Francisco', region:'California', country:'US', colo:'SJC', source:'mock', fetchedAt:<now> }`; rejects while `internetDown`.
- Fingerprinter: `fingerprint()` resolves after 200 ms with the table row (+ `fingerprintedAt`), calls `onResult`. Unknown MACs → `unknown`, conf 0.
- `seedSpeedHistory(now)`: 24 results, `trigger:'auto'`, at `now - (24-i)*15min` (i=0..23), `downloadMbps = 430 + (i*7 % 40)`, `uploadMbps = 38 + (i % 5)`, `pingMs = 11 + (i % 4)`, `jitterMs 1.2`, `colo 'SJC'`, ids `st_seed_<i>`. Core calls it in mock mode whenever speed history is empty (boot and after reset). Then the startup test runs (≈2.3 s after boot) and appends a 450/40 result.

### 7.4 `POST /api/mock/state`
Body (all optional): `{ "internetDown": bool, "downloadMbps": number>0, "uploadMbps": number>0, "devicesOffline": string[] (MACs, colon or dash), "newDevice": bool, "reset": bool }`.
- `devicesOffline` **replaces** the offline set (send `[]` to bring all back). `newDevice:true` adds #11 (idempotent); `false` removes it.
- `reset:true` (processed first): mock world back to defaults (internet up, 450/40, all 10 online, no #11) AND core: aborts running speed test, `store.resetAll()`, clears live device list + ping windows, re-seeds history, recomputes alerts, broadcasts `snapshot`, then triggers a rescan. No speed test is run after reset (`last` = newest seeded entry, ≥ 430 Mbps, so no slow alert).
- Effects returned by `applyMockState` and executed by core: `rescan` (devicesOffline/newDevice/reset → `discovery.scanNow()` + `pinger.pingNow()`), `runSpeedTest` (`downloadMbps` or `uploadMbps` provided → core starts a `manual` test if none running; if running, it queues exactly one follow-up), `reprobe` (`internetDown` provided → `probe.checkNow()`).
- Response `{ ok:true, mock: { internetDown, downloadMbps, uploadMbps, devicesOffline, newDevice } }` returned after effects are *started* (not completed).
- Expected timings for tests: slow alert ≈ 2.2 s after `downloadMbps:150`; internet-down banner ≤ 2.5 s; saved device offline ≈ 2.5–3.5 s; device back online ≤ 1.5 s.

---

## 8. Frontend contract

### 8.1 `web/src/store.js` (fnd) — reactive singleton, no Pinia
```js
export const state = reactive({
  loaded: false, connection: 'connecting' /* 'connecting'|'open'|'reconnecting' */, mock: false, serverTime: null,
  network: null, devices: [], internet: { status: 'unknown', since: null, lastCheckedAt: null, latencyMs: null, consecutiveFailures: 0 },
  speed: { running: false, progress: null, last: null, lastError: null, nextAutoAt: null, history: [] },
  isp: null, alerts: [], settings: { speedThresholdMbps: 200, speedTestIntervalMin: 15, soundAlerts: true, activeFingerprinting: true },
  events: [], toasts: []
});
export const ui = reactive({   // persisted to localStorage key 'netmon.ui' (theme, muted, dismissed only)
  filter: 'all' /* 'all'|'online'|'offline'|'saved' */, typeFilter: 'all' /* 'all'|category */, search: '',
  theme: 'system' /* 'light'|'dark'|'system' */, muted: false, dismissed: {} /* { [alertId]: since } */,
  settingsOpen: false
});
// computed (exported as computed refs)
export const devicesSorted       // §5 order
export const filteredDevices     // devicesSorted filtered by ui.filter (offline = !online), ui.typeFilter, ui.search
                                 // (search: case-insensitive over name, hostname, ip, mac, vendor, model, deviceTypeLabel)
export const devicesByCategory   // { [category]: Device[] } over all devices
export const typeCounts          // { [category]: number } only categories with count > 0, over all devices
export const visibleAlerts       // state.alerts minus dismissed (critical never dismissed)
export const topAlertLevel       // 'critical'|'warning'|'info'|null over visibleAlerts
export const counts              // { total, online, offline, saved, savedOffline }
export const isSlow              // state.speed.last && last.downloadMbps < settings.speedThresholdMbps
// actions (all return Promises; on HTTP error they pushToast({level:'error'}) and rethrow)
export function init()                                    // GET /api/snapshot then connect SSE; idempotent
export function saveDevice(mac, { name, type, notes })    // PUT; updates state.devices from response
export function forgetDevice(mac)                         // DELETE
export function refingerprint(mac)                        // POST .../fingerprint; returns Device
export function runSpeedTest()                            // POST /api/speedtest; 409 -> toast 'A speed test is already running' (no throw)
export function updateSettings(patch)                     // PUT; returns Settings; 400 -> throws Error with .details
export function dismissAlert(id)
export function setFilter(f), setTypeFilter(t), setSearch(s), setTheme(t), toggleMute(), openSettings(), closeSettings()
export function pushToast({ level /* 'info'|'success'|'warning'|'error' */, title, message = '', timeoutMs = 5000 }): id
export function removeToast(id)
```
SSE handling: `snapshot` replaces everything; `devices` replaces list; `device` upserts by mac (removes nothing);
`internet`/`isp`/`alerts`/`settings`/`network` replace; `speed` merges (keeps `history`, appends `last` if new id, cap 200);
`event` unshifts (cap 200). Connection: `open` on EventSource open; on error → `reconnecting`, EventSource auto-retries;
if closed, reconnect with backoff 1 s → 10 s.

### 8.2 `web/src/api.js` (fnd)
```js
export const api = { health(), snapshot(), devices(), updateDevice(mac, body), deleteDevice(mac), refingerprint(mac),
  runSpeedTest(), speedHistory(limit), settings(), updateSettings(patch), events(limit), mockState(body) };
// mac converted with macToId(); throws ApiError { status, code, message, details }
export class ApiError extends Error {}
export function connectStream({ onEvent /* (type, data) */, onStatus /* ('open'|'reconnecting') */ }): { close() }
```

### 8.3 `web/src/lib/format.js` (fnd)
```js
formatMbps(n)          // null -> '—'; <10 -> 1 decimal '7.4'; else integer '452'; >=1000 -> '1.25 Gbps' (returns full string incl unit)
formatMbpsValue(n)     // number part only ('452', '7.4', '—') — used inside data-testid speed-* elements
formatMs(n)            // null -> '—'; <10 -> '2.5 ms'; else '14 ms'
formatPercent(n)       // '0%', '5%'
formatRelative(iso, now = Date.now())   // 'just now' (<10 s), '42 s ago', '3 min ago', '2 h ago', '3 d ago'
formatDuration(ms)     // '45 s', '3 min', '1 h 12 min'
formatTime(iso)        // locale 'HH:MM:SS'
formatDateTime(iso)
macToId(mac)           // 'a4:83:...' -> 'a4-83-...'
idToMac(id)
```

### 8.4 Composables
- `useNow(intervalMs = 1000): Ref<number>` (fnd) — shared ticker (one interval per intervalMs).
- `useTheme(): { theme: Ref, isDark: ComputedRef<boolean>, setTheme(t), toggle() }` (fnd) — toggles `.dark` on `<html>`; cycle light→dark→system on toggle.
- `useClickOutside(elRef, handler)` (fnd).
- `useSound(): { unlocked: Ref<boolean>, unlock(), playAlarm(level /* 'critical'|'warning' */), playChime() }` (alm) — WebAudio oscillator beeps, no audio files; unlock on first user gesture.
- `useNotifications(): { permission: Ref<'default'|'granted'|'denied'|'unsupported'>, request(), notify(title, body) }` (alm).
- `useTitleAlert(): void` (alm) — while `topAlertLevel === 'critical'` alternate `document.title` between `Internet down — NetMon` and `NetMon` every 1 s; warning → `Slow internet — NetMon`; else `NetMon`.

### 8.5 `App.vue` (fnd) — exact imports and layout
```js
import TopBar from './components/alarms/TopBar.vue'
import AlertStack from './components/alarms/AlertStack.vue'
import ToastHost from './components/alarms/ToastHost.vue'
import SettingsDrawer from './components/alarms/SettingsDrawer.vue'
import AlarmController from './components/alarms/AlarmController.vue'
import InternetStatusCard from './components/metrics/InternetStatusCard.vue'
import SpeedTestCard from './components/metrics/SpeedTestCard.vue'
import IspCard from './components/metrics/IspCard.vue'
import SpeedHistoryChart from './components/metrics/SpeedHistoryChart.vue'
import LocalThroughputCard from './components/metrics/LocalThroughputCard.vue'
import EventsPanel from './components/metrics/EventsPanel.vue'
import DevicesPanel from './components/devices/DevicesPanel.vue'
```
**All of these take no props and emit nothing**; they read/write `store.js`. Layout (max-w-[1440px], px-4 sm:px-6):
```
<TopBar/>                                   sticky top
<AlertStack/>                               full-width banners under top bar
grid lg:grid-cols-3 gap-4 : InternetStatusCard | SpeedTestCard | IspCard
grid xl:grid-cols-3 gap-4 : DevicesPanel (xl:col-span-2) | aside: LocalThroughputCard, SpeedHistoryChart, EventsPanel
<SettingsDrawer/> <ToastHost/> <AlarmController/>
```
App calls `init()` on mount, shows a full-page skeleton until `state.loaded`. Body background `bg-slate-50 dark:bg-slate-950`.
Default theme `system`.

### 8.6 Components

UI kit (fnd) — `web/src/components/ui/` (all forward `$attrs`, so callers can set `data-testid`):
| file | props | emits / slots |
|---|---|---|
| Card.vue | `title?`, `subtitle?`, `padded=true` | slots: default, `actions` (header right), `footer` |
| Button.vue | `variant='primary'|'secondary'|'ghost'|'danger'`, `size='sm'|'md'`, `icon?`, `loading=false`, `disabled=false`, `type='button'` | native click; slot default |
| Badge.vue | `tone='neutral'|'success'|'warning'|'danger'|'info'|'brand'`, `dot=false` | slot |
| Icon.vue | `name` (string), `size=20` | — renders inline SVG (24 viewBox, stroke currentColor); unknown name → `question`. Required names: all CATEGORY_ICONS + OS_ICONS + `globe activity arrow-down arrow-up gauge zap alert-triangle alert-octagon info x check search settings sun moon monitor bell bell-off volume volume-x refresh play trash edit star star-filled chevron-down chevron-right clock signal wifi-off plug filter help-circle external dot` |
| Modal.vue | `open`, `title`, `width='md'` | `close`; slots default, `footer`. Esc/backdrop closes; focus trap; teleport to body |
| Drawer.vue | `open`, `title`, `side='right'` | `close`; slots default, `footer` |
| Popover.vue | `open`, `placement='bottom-start'` | `close`; slots `trigger`, default (closes on outside click/Esc) |
| Tooltip.vue | `text` | slot (CSS hover/focus tooltip; also sets `title` attr for a11y fallback) |
| Toggle.vue | `modelValue: boolean`, `label?`, `disabled` | `update:modelValue`; renders `<button role="switch" :aria-checked>` |
| Spinner.vue | `size=16` | — |
| Sparkline.vue | `values: (number|null)[]`, `width=96`, `height=24`, `tone='brand'`, `fill=true` | — nulls render gaps; empty → flat dashed line |
| StatTile.vue | `label`, `value`, `unit?`, `icon?`, `tone='neutral'`, `hint?` | slot `extra` |
| EmptyState.vue | `icon`, `title`, `message?` | slot `actions` |
| ConfirmDialog.vue | `open`, `title`, `message`, `confirmLabel='Confirm'`, `danger=false`, `confirmTestid?` | `confirm`, `cancel` (confirm button gets `data-testid=confirmTestid`) |

Devices (dev) — `web/src/components/devices/`:
| file | props | emits |
|---|---|---|
| DevicesPanel.vue | — | — (Card "Devices" with counts; contains toolbar, TypeSummary, DeviceTable, DeviceEditModal, ForgetDeviceDialog) |
| DeviceToolbar.vue | — | — (filter buttons, type-filter select, search input; bound to `ui`) |
| TypeSummary.vue | — | — (chips per category with count; click toggles `setTypeFilter`) |
| DeviceTable.vue | `devices: Device[]` | `edit(device)`, `forget(device)`, `refingerprint(device)` (table on ≥md, stacked cards on mobile — same testids) |
| DeviceRow.vue | `device` | `edit`, `forget`, `refingerprint` |
| DeviceTypeBadge.vue | `device` | — (icon + label + OS icon + confidence dots + "Why?" button → Popover with evidence) |
| LatencyCell.vue | `device` | — (quality dot + `formatMs` + Sparkline of latencyHistory; tooltip with jitter/loss) |
| DeviceEditModal.vue | `device: Device|null`, `open` | `close`, `saved(device)` |
| ForgetDeviceDialog.vue | `device: Device|null`, `open` | `close`, `forgotten(mac)` |

Connection quality (dev): good = latency < 30 && loss < 2 (emerald), fair = latency < 100 && loss < 10 (amber), else poor (rose); offline grey.
Row content: type icon, display name (+ hostname/IP/MAC secondary, vendor), type badge, status pill ("Online" / "Offline · last seen 3 min ago"),
latency cell, throughput cell, actions (save/edit star, re-detect, forget when saved). Self row tagged "This device", gateway "Gateway".

Metrics (met) — `web/src/components/metrics/`: `InternetStatusCard.vue` (big status: Online/Offline/Checking, since, probe latency; red pulsing when down),
`SpeedTestCard.vue` (download/upload/ping tiles, threshold marker, last tested relative time, next auto, Run test button, progress bar with phase + live Mbps; uses `SpeedGauge.vue` (met-internal) for the live dial), `IspCard.vue` (ISP name, ASN, public IP, city/country, colo; plus local network line iface · ip · cidr · gateway),
`SpeedHistoryChart.vue` (SVG line/area of download+upload over history, dashed threshold line, hover tooltip), `LocalThroughputCard.vue` (this computer live rx/tx from the `isSelf` device, rolling 60-point client-side buffer, sparkline),
`EventsPanel.vue` (scrollable newest-first event list, level icon, relative time, filter none).

Alarms (alm) — `web/src/components/alarms/`: `TopBar.vue` (logo "NetMon", network name/cidr, connection-status pill, "MOCK" badge when `state.mock`, mute, theme toggle, settings button; top border turns red when critical),
`AlertStack.vue` (one banner per visible alert: critical = solid rose with pulsing icon, warning = amber, info = sky; dismiss X for non-critical), `ToastHost.vue` (bottom-right stack of `state.toasts`),
`SettingsDrawer.vue` (Drawer: threshold Mbps, speed test interval, sound toggle, fingerprint toggle, desktop notifications button, Save/Cancel; validation errors inline; success → toast "Settings saved", close),
`AlarmController.vue` (renderless): watches `state.alerts` — on newly raised critical: `playAlarm('critical')` (3 beeps) and repeat every 30 s while active; newly raised warning: one `playAlarm('warning')`; only if `settings.soundAlerts && !ui.muted`. Desktop notification for new critical/warning if permission granted. Watches `state.events` (new ids only, not on initial load/snapshot): toasts for `device_new` (info), `internet_restored` (success), `device_offline` (warning), `speedtest_complete` after a manual test (success). Calls `useTitleAlert()`.

---

## 9. Dependencies (complete list — nobody adds more)

Root `package.json` (core): `"private": true, "type": "module"`, devDependencies `concurrently ^9.1.0`, `@playwright/test ^1.50.0`.
Scripts:
```
"dev":         "concurrently -k -n server,web -c blue,green \"npm:dev:server\" \"npm:dev:web\"",
"dev:mock":    "concurrently -k -n server,web -c blue,green \"npm:dev:server:mock\" \"npm:dev:web\"",
"dev:server":  "npm --prefix server run dev",
"dev:server:mock": "NETMON_MOCK=1 npm --prefix server run dev",
"dev:web":     "npm --prefix web run dev",
"build":       "npm --prefix web run build",
"start":       "npm --prefix server start",
"start:mock":  "NETMON_MOCK=1 npm --prefix server start",
"install:all": "npm install && npm --prefix server install && npm --prefix web install",
"test:e2e":    "npm run build && playwright test"
```
core also runs `npx playwright install chromium` once.

`server/package.json` (core): `"type": "module"`, `"engines": {"node": ">=20"}`, dependencies `express ^4.21.2`, `multicast-dns ^7.2.5`. Scripts `"dev": "node --watch src/index.js"`, `"start": "node src/index.js"`, `"mock": "NETMON_MOCK=1 node src/index.js"`.

`web/package.json` (fnd): `"type": "module"`, dependencies `vue ^3.5.13`; devDependencies `vite ^6.0.7`, `@vitejs/plugin-vue ^5.2.1`, `tailwindcss ^4.0.0`, `@tailwindcss/vite ^4.0.0`. Scripts `dev` (vite), `build` (vite build), `preview`.

`web/vite.config.js`: plugins `[vue(), tailwindcss()]`, `server: { port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:4000', changeOrigin: true } } }`
(use `127.0.0.1`, not `localhost`: Node may resolve `localhost` to `::1` while the server binds `127.0.0.1`). Build to `web/dist`.
`style.css`: `@import "tailwindcss"; @custom-variant dark (&:where(.dark, .dark *));` plus `@theme` font stack
`--font-sans: "Inter var", Inter, ui-sans-serif, system-ui, ...` (no remote font loading). Palette: slate neutrals, indigo brand,
emerald ok, amber warning, rose critical, sky info (details in DESIGN.md).

---

## 10. `playwright.config.js` (core)
```js
import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const dataDir = process.env.NETMON_E2E_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'netmon-e2e-'));
process.env.NETMON_E2E_DATA_DIR = dataDir;   // keep one dir across config re-evaluation in workers
export default defineConfig({
  testDir: './e2e', workers: 1, fullyParallel: false, retries: 0, timeout: 30_000, expect: { timeout: 7_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://localhost:4100', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node server/src/index.js', url: 'http://127.0.0.1:4100/api/health', reuseExistingServer: false, timeout: 30_000,
    env: { NETMON_MOCK: '1', NETMON_DATA_DIR: dataDir, PORT: '4100', HOST: '127.0.0.1' }
  }
});
```
`web/dist` must be built beforehand (`npm run test:e2e` does it). Tests call `POST /api/mock/state {reset:true}` in `beforeEach`.

---

## 11. data-testid contract (owner in brackets)

| testid | element / attributes / content | owner |
|---|---|---|
| `alert-banner` | one per visible alert; `data-level="critical|warning|info"`, `data-kind="<kind>"`; contains title text. Dismiss button `alert-dismiss` (non-critical only) | alm |
| `internet-status` | `data-status="up|down|unknown"`; text `Online` / `Offline` / `Checking…` | met |
| `speed-download` / `speed-upload` / `speed-ping` | text = number only via `formatMbpsValue`/ms number (e.g. `452`, `40.0`→`40`, `12`); `data-value` = raw number or empty | met |
| `isp-name`, `isp-ip` | ISP name text; public IP text (`—` when null) | met |
| `run-speedtest-btn` | button; `disabled` while running | met |
| `speedtest-progress` | rendered only while running; `data-phase`, `data-percent` | met |
| `device-row-<mac-dashes>` | row root; `data-online="true|false"`, `data-saved="true|false"`, `data-category` | dev |
| `device-name` | inside row; `deviceDisplayName` | dev |
| `device-status` | inside row; `data-status="online|offline"`; text starts with `Online` or `Offline` (offline: `Offline · last seen 3 min ago`) | dev |
| `device-type` | inside row; `data-category`, `data-os` (empty string when null), text = `deviceTypeLabel` | dev |
| `device-type-why` | button inside row opening evidence popover | dev |
| `device-evidence` | popover container; one `<li>` per evidence string | dev |
| `device-latency` | inside row; text `formatMs(latencyMs)` (`—` for self/none) | dev |
| `device-throughput` | inside row; self: `↓ 24.0 ↑ 3.0 Mbps`-style text with `data-rx`/`data-tx`; others text `—` with tooltip/title `Requires router integration` | dev |
| `save-device-btn` | inside row; label `Save` (unsaved) / `Edit` (saved); opens DeviceEditModal | dev |
| `device-name-input`, `device-type-select`, `device-notes-input`, `save-confirm-btn` | in DeviceEditModal; select option values: `""` = Auto-detect, then CATEGORIES ids | dev |
| `forget-device-btn` | inside row, only when saved | dev |
| `forget-confirm-btn` | confirm button in ForgetDeviceDialog | dev |
| `refingerprint-btn` | inside row ("Re-detect"); spinner while pending | dev |
| `filter-all`, `filter-online`, `filter-offline`, `filter-saved` | buttons; `aria-pressed` | dev |
| `type-filter` | `<select>`; values `all` + category ids | dev |
| `type-chip-<category>` | chip button per category with count>0; `data-count`; `aria-pressed` | dev |
| `search-input` | text input | dev |
| `settings-btn`, `theme-toggle`, `connection-status` (`data-status="open|connecting|reconnecting"`), `mute-btn` (`data-muted`) | in TopBar | alm |
| `threshold-input` (number), `speedtest-interval-input`, `sound-toggle`, `fingerprint-toggle` (Toggle, `aria-checked`), `settings-save-btn`, `settings-error` | in SettingsDrawer | alm |
| `events-panel` | panel root; items `event-item` with `data-type` | met |
| `toast` | each toast; `data-level` | alm |

All row-action buttons are always rendered (not hover-only). Every testid above is unique on the page except per-row/per-item ones.

---

## 12. Working rules, self-checks, done criteria

- **Own only your files.** Missing collaborator file = expected during parallel work; do not create it.
- Backend coders self-check with `node --input-type=module -e "import('./server/src/...')"` smoke scripts in your scratchpad; lan/fp/inet may hit the real LAN/internet; mock must not.
- core verifies with `NETMON_MOCK=1 PORT=4100 node server/src/index.js` + `curl` once mock exists; fnd verifies `npm --prefix web run build` once all imported files exist (until then, check own SFCs compile with `@vue/compiler-sfc`).
- Write only to stdout via `console.log/warn` with a `[module]` prefix; no noisy per-ping logs.
- Docs: fnd writes DESIGN.md, lan NETWORK_NOTES.md, fp FINGERPRINT_NOTES.md, core README.md (setup, scripts, mock mode, limitations: per-device throughput needs router integration, ARP lag, mDNS/SSDP on same subnet only).
- Done = your files exist at the exact paths, exports/props/testids match this plan exactly, no console errors in mock mode.
