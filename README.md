# NetMon

A local network and internet monitoring dashboard. NetMon runs a small Node.js backend on your
computer that discovers every device on your LAN, works out what kind of device each one is,
watches your internet connection, and streams it all live to a Vue 3 + Tailwind CSS dashboard.

- **Devices**: every computer, phone, tablet, access point, TV, speaker, printer and so on, with IP, MAC, vendor,
  and a detected **device type** (with OS and model when they can be found).
- **Network map** (the default devices view): Internet → gateway → access points / mesh nodes → devices, drawn on a
  pan/zoom canvas. Click a device for a detail panel with everything NetMon knows about it. Drag a device onto an
  access point to set what it is **Connected via**, or drag it anywhere to pin it; this layout is saved on the server.
  Switch to the classic table with the **Map | List** toggle, or open `/?view=list`.
- **Saved devices**: give a device a name. Saved devices stay listed as *Offline · last seen 5 min ago* when they
  disconnect, and they raise an on-screen notice.
- **Per-device connection quality**: latency, jitter and packet loss with a sparkline. This computer also shows its live
  download/upload throughput.
- **Internet**: up/down status every few seconds, speed tests (download / upload / ping) automatically and on demand,
  and your ISP (name, ASN, public IP, location).
- **Alarms**: a red on-screen alarm (plus optional sound and desktop notification) when the internet goes down,
  and a warning when the measured download speed drops below a threshold (default **200 Mbps**).

Browsers cannot scan a local network, so the backend does all of the network work. The web app talks to it over
REST and Server-Sent Events (`GET /api/stream`).

---

## Requirements

- Node.js **20** or newer (developed on 20.19) and npm 10; building `NetMon.exe` needs Node 20.12+ (CI uses 22 LTS)
- macOS, Linux or Windows 10/11 x64 (see [Windows](#windows) for the installer). No root/sudo and no native modules are needed.
- The computer running NetMon must be on the network you want to monitor (Wi-Fi or Ethernet).

## Setup

```bash
npm run install:all        # installs root, server/ and web/ dependencies
npx playwright install chromium   # only needed for the e2e tests
```

(Equivalent to `npm install && npm --prefix server install && npm --prefix web install`. A plain `npm install` at the
root only installs the root tooling, `concurrently` and Playwright.)

Quick start: `npm run install:all`, then `npm run dev` and open http://localhost:5173. To try it without touching your
network, use `npm run dev:mock`. For a single-process install, use `npm run build && npm start` and open http://127.0.0.1:4000.

## Running

| Command | What it does |
|---|---|
| `npm run dev` | Backend (port 4000, auto-restart on change) + Vite dev server (port 5173). Open **http://localhost:5173** |
| `npm run dev:mock` | Same, with the backend in **mock mode** (fake network, no real scanning) |
| `npm run build` | Builds the web app into `web/dist` |
| `npm start` | Production mode: the backend serves the built app and the API. Open **http://127.0.0.1:4000** |
| `npm run start:mock` | Production server in mock mode |
| `npm run test:e2e` | Builds the web app and runs the Playwright tests against a mock-mode server on port 4100 (`NETMON_E2E_PORT=4180 npm run test:e2e` to use another port; each run uses a fresh temp data dir; screenshots go to `e2e/screenshots/`) |
| `npm --prefix server test` | Backend unit tests (Node's built-in test runner, no extra dependencies) |

First-time Playwright setup: `npx playwright install chromium`.

`npm run dev` and `npm start` both use port 4000, so stop one before starting the other, or set `PORT`.

### Environment variables (backend)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address. The API can rename and forget devices, so it only listens on loopback by default. A non-loopback `HOST` (e.g. `0.0.0.0`) is refused unless you also set `NETMON_TOKEN` or `NETMON_ALLOW_LAN=1`. |
| `NETMON_TOKEN` | unset | Shared secret required on every `/api` request, sent as the `X-NetMon-Token` header, a `?token=` query parameter or a `netmon_token` cookie. Open `http://<host>:<port>/?token=<secret>` once in a browser to store the cookie. Recommended whenever `HOST` is not loopback. |
| `NETMON_ALLOW_LAN` | unset | `1` = allow a non-loopback `HOST` **without** a token (anyone on the LAN can control NetMon). |
| `NETMON_ALLOWED_HOSTS` | unset | Comma-separated extra host names accepted in the `Host` header (e.g. a reverse-proxy name). |
| `NETMON_MOCK` | unset | `1` = mock mode (see below) |
| `NETMON_DATA_DIR` | `server/data` | Where `store.json` (saved devices, history, events, settings) is kept |

**Request protection.** Every `/api` request must address NetMon by `localhost`, a loopback IP, the configured
`HOST` (or, with a LAN `HOST`, one of this machine's addresses / names), so a DNS-rebinding page cannot reach it.
State-changing requests (`POST`/`PUT`/`DELETE`) are refused when their `Origin` is another site, and `POST`/`PUT`
bodies must be `Content-Type: application/json` (`415` otherwise).

## Using the network map

The **Devices** card opens as a map (`/?view=map`). Use the **Map | List** toggle, or `/?view=list`, for the table. Your
choice is remembered in this browser, and a `?view=` in the URL overrides it.

- **Layout**: Internet → gateway (router) → hubs (access points, mesh nodes, switches) → devices. Devices are grouped in
  sectors by type (**By type**), or placed evenly around their parent (**Flat**). Edge colour is the device's ping quality
  (green / amber / red, dashed grey when offline). Moving dots mark online links (off with reduced motion).
- **Detail panel**: click or tap a node, or focus it and press Enter, for everything about the device: name (rename inline),
  type and how it was detected, status and last seen, latency chart, latency / jitter / loss, throughput (this computer only),
  "Connected via", IP / MAC / vendor / hostname, detection evidence, recent events, and Save / Forget / Re-detect. It opens as a side panel on wide
  screens and as a full-screen sheet on phones. Esc, the × button or a click on empty canvas closes it.
- **Connected via**: choose an access point in the panel, or drag a device onto a hub (a dashed highlight shows the drop
  target). Loops are refused. Dragging a node to empty canvas pins it there. **Reset layout** unpins every node and keeps the
  "Connected via" choices. Both are stored on the server in `topology.json`, so every browser sees the same map.
- **Navigation**: drag the canvas to pan, scroll or pinch to zoom, use the toolbar's − / + / **Fit** buttons, or press
  `F`, `+` and `-` while the map has focus. Searching dims the devices that don't match. The minimap
  shows where you are, and the ⓘ button opens the legend. Small networks open fitted to the canvas. When fitting would
  make labels unreadable (big networks, phones), the map opens centred on the gateway at a readable zoom; pan or press **Fit**
  to see everything.
- On phone-sized touch screens, nodes can't be dragged (the gestures pan the map). Use the "Connected via" select instead.

## Mock mode

`NETMON_MOCK=1` replaces every network module with a deterministic simulation. It makes no network calls and
starts no child processes, and it runs on fast (about 1 s) timers. It provides:

- 10 devices: this MacBook Pro, a UniFi gateway, a Windows PC, an iPhone with a private MAC, a Pixel phone,
  a TP-Link Deco mesh access point, an LG TV, an HP printer, a Sonos speaker and an unidentified IoT device.
  Each one has realistic detection evidence.
- ISP "Comcast Cable Communications" at about 450/40 Mbps, a seeded speed history, and a startup speed test that takes about 2 s.

Change the simulated world with `POST /api/mock/state` (mock mode only):

```bash
# internet outage -> critical alarm within ~2.5 s
curl -s -XPOST localhost:4000/api/mock/state -H 'content-type: application/json' -d '{"internetDown":true}'
# slow internet -> runs a speed test, warning alarm ~2.2 s later
curl -s -XPOST localhost:4000/api/mock/state -H 'content-type: application/json' -d '{"downloadMbps":150}'
# take devices offline (replaces the offline set; [] brings all back)
curl -s -XPOST localhost:4000/api/mock/state -H 'content-type: application/json' -d '{"devicesOffline":["3c:7c:3f:5a:9b:03"]}'
# a new tablet joins
curl -s -XPOST localhost:4000/api/mock/state -H 'content-type: application/json' -d '{"newDevice":true}'
# everything back to defaults (also wipes saved devices / settings / events in the mock data dir)
curl -s -XPOST localhost:4000/api/mock/state -H 'content-type: application/json' -d '{"reset":true}'
```

In mock mode the map starts with the iPhone, Pixel 8 and LG TV connected via the Deco M5 mesh node; a `reset` restores
that layout and clears pinned positions.

A `reset` (and any change that rescans) responds only after the simulated LAN has been rescanned and typed, so
right after the `200` all mock devices are listed with their final type. A reset also cancels the startup speed test.

Use a separate `NETMON_DATA_DIR` for mock mode if you don't want to mix mock data with your real saved devices.

## API overview

All endpoints are under `/api` and return JSON. Errors look like `{ "error": "<code>", "message": "..." }`.

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Liveness, mode, uptime, number of live clients |
| `GET /api/snapshot` | Everything the dashboard needs in one document |
| `GET /api/stream` | Server-Sent Events: `snapshot`, `devices`, `device`, `internet`, `speed`, `isp`, `alerts`, `event`, `settings`, `network`, `topology` |
| `GET /api/devices` | Current device list |
| `PUT /api/devices/:mac` | Save / rename a device: `{ "name": "Living room PC", "type": null, "notes": "" }` (`type` = a category id to override detection, `null` = auto) |
| `DELETE /api/devices/:mac` | Forget a saved device (an offline device also loses its map layout entry) |
| `POST /api/devices/:mac/fingerprint` | Re-run device-type detection now (repeat requests within 30 s reuse the last port probe) |
| `POST /api/speedtest` | Start a speed test (`409` if one is running, `503` if the internet is down, `429` + `Retry-After` within 60 s of the last test in real mode) |
| `GET /api/speedtest/history?limit=200` | Past results, oldest first |
| `GET/PUT /api/settings` | `speedThresholdMbps` (1–10000), `speedTestIntervalMin` (0 = off, or 5–1440), `soundAlerts`, `activeFingerprinting` |
| `GET /api/events?limit=100` | Event log, newest first |
| `GET /api/topology` | Map layout overrides: `{ "overrides": { "<mac>": { "parentMac", "position", "updatedAt" } } }` (also in the snapshot as `topology`) |
| `PUT /api/topology/:mac` | Set "Connected via" and/or a pinned map position: `{ "parentMac": "50:c7:bf:3d:7e:06" \| null, "position": { "x": 120, "y": -40 } \| null }` (`null` parent = the gateway; the parent must be an access point, mesh node, switch or secondary router; no loops; coordinates within ±10000) |
| `DELETE /api/topology?scope=positions\|all` | Reset the map: `positions` (default) unpins every node, `all` also resets every "Connected via" (to the mock defaults in mock mode) |

MACs in URLs may use colons or dashes, in any case (`a4-83-e7-1c-2d-01`).

Watch the live stream from a terminal:

```bash
curl -N http://127.0.0.1:4000/api/stream
```

## How it works

### Device discovery
- The primary IPv4 interface (the one that owns the default route) is found with `os.networkInterfaces()` plus
  `route -n get default` on macOS or `ip route` on Linux.
- Every 30 s NetMon ping-sweeps the local /24 with bounded concurrency and reads the ARP table (`arp -an`;
  `ip neigh` on Linux). Devices are keyed by MAC address. Hostnames come from reverse DNS, mDNS and NetBIOS.
- Every listed device is pinged every 10 s to measure latency, jitter and loss, and to notice quickly when a device disconnects.
- A device is offline when it hasn't been seen for 90 s. Unsaved offline devices drop off the list after 10 min.
  Saved devices are always listed.
- "Seen" means a ping reply. For a device that is in the ARP table but did not answer, NetMon tries a TCP connect
  to a port detection found open (a refused connection counts too). Without such a port the ARP entry counts for
  devices that never answer ping, and for phones/tablets for up to 15 min after their last ping reply (Wi-Fi power save).
- The network interface is re-checked every 15 s. After a Wi-Fi change, joining a hotspot or a DHCP renumbering,
  NetMon rescans the new subnet, refreshes the ISP and logs a `network_changed` event; saved devices stay listed.
- The first scan on a fresh install (or new network) logs one "Initial scan found N devices" event instead of one per device.

### Device-type detection
NetMon detects device types without root and without native code. It collects weighted evidence and scores it:

- **MAC vendor (OUI)**: for example Sonos means a speaker, Ubiquiti/eero/TP-Link means network gear, and HP/Epson/Brother means a printer.
- **Private (randomized) MAC**: the locally-administered bit is set, which usually means a phone, tablet or laptop.
- **Hostname patterns**: `iPhone`, `MacBook`, `DESKTOP-*` (Windows), `Pixel-*`, `LGwebOSTV`, `Deco-*`, `raspberrypi`, …
- **mDNS / Bonjour** services and TXT records: Apple model ids such as `MacBookPro18,3` (MacBook Pro) and `iPhone16,1` (iPhone 15 Pro),
  Chromecast `md=`, printers (`_ipp`), AirPlay, HomeKit, Sonos, Spotify Connect, …
- **SSDP / UPnP** device descriptions: InternetGatewayDevice means a router, WLANAccessPointDevice means an access point,
  MediaRenderer means a TV or media device. These also give the friendly name, manufacturer and model.
- **NetBIOS** names (Windows), and the **ping TTL** (about 128 = Windows, about 64 = Unix-like/iOS/Android, about 255 = network gear).
- **A light TCP connect probe** of about 20 well-known ports (for example 62078 means iOS, 3389/445 means Windows, 9100/631 means a printer,
  1400 means Sonos, 8008/8009 means Chromecast). It runs only for new devices, at most hourly per device. You can switch it off in Settings
  ("active fingerprinting"). Probes are postponed while a speed test is running (a saturated link makes them time out); the
  startup speed test waits for the first detection pass.
- Weak results (unknown or below 50 % confidence) are retried every 10 min, immediately when a device that was asleep during
  its probe starts answering, and every cached result is refreshed once after a restart.
- The default gateway is always the **router**. A non-gateway device that serves DNS plus a web admin page and comes from
  a network vendor is a **Wi-Fi access point / mesh node**.

Click **Why?** next to a device type to see the evidence. A type you set yourself always wins over detection.

### Internet monitoring
- Connectivity probe every 5 s (`https://1.1.1.1/cdn-cgi/trace`, falling back to `https://www.google.com/generate_204`).
  Two consecutive failures mean the internet is **down**.
- Speed tests use Cloudflare's speed endpoints (parallel download/upload streams plus latency samples). They run every 15 min by default
  (configurable, 0 = off) and when you click **Run test**. Only one test runs at a time.
- The ISP comes from `https://speed.cloudflare.com/meta` (falling back to `https://ipinfo.io`, then plaintext `ip-api.com`, marked
  `unverified`) and is refreshed every 30 min, after an outage and after a network change.

### Persistence
Saved devices, the detection cache, settings, the last 200 speed results and the last 500 events are stored in
`server/data/store.json` (or `$NETMON_DATA_DIR/store.json`, mode 0600). Writes are debounced (0.5 s for your changes,
10 s for background bookkeeping), atomic and durable (temp file + fsync + rename; the previous copy is kept as `store.json.bak`).
If the file is corrupt, it is moved aside to `store.json.corrupt-<timestamp>` and NetMon restores `store.json.bak`, or starts fresh.

The map layout ("Connected via" choices and pinned positions, per MAC) is kept separately in `topology.json` in the same
directory, with the same write, backup and recovery rules. Layout entries for devices that leave the network are kept, so a device
returns to its place when it comes back. Forgetting a device that is offline (it then disappears from the list) also drops its
layout entry. The gateway is a fixed anchor and cannot be given a pinned position.

## Limitations

- **Per-device network speed (throughput) needs router integration.** A normal computer on the LAN cannot see other
  devices' traffic, so for other devices NetMon shows **connection quality** (latency, jitter, packet loss) instead.
  Real live download/upload rates are shown **for this computer only**, read from its interface counters.
  In the table, other devices show "—" with the tooltip "Requires router integration".
- **Offline detection lag for devices that ignore ping.** Some devices, such as Windows PCs with the default firewall, never answer ICMP.
  When detection found an open port they are checked over TCP; otherwise they are tracked through the ARP table, and macOS keeps
  ARP entries for up to about 20 minutes, so they can be reported offline late.
- **mDNS / SSDP only work on the same subnet**, and phones in deep sleep may not answer anything until they wake.
- **Private MAC addresses** (iOS, Android and Windows "random hardware addresses") have no vendor. They can also change if the
  device forgets the network, and then the device shows up as a new device.
- **"Connected via" on the map is set by you.** Without router or controller integration NetMon cannot tell which access point
  or mesh node a device is associated with, so every device is drawn under the gateway until you move it. The edge colour is the
  device's own end-to-end ping quality from this computer, not the quality of the Wi-Fi link.
- Only the /24 around this computer is scanned, even on larger subnets.
- On phones (and on big networks), the map opens at a readable zoom centred on the gateway, so outer devices may be off-screen
  until you pan or press **Fit**. The list view (`?view=list`) is often easier on a small screen.
- Speed tests measure the path from this computer. A VPN (for example Cloudflare WARP) or a slow Wi-Fi link to this computer
  limits the result.
- No user accounts: keep the default `HOST=127.0.0.1`, or set `NETMON_TOKEN` when exposing NetMon to the LAN.

## Project layout

```
server/            Node 20 ESM backend (Express)
  src/index.js     bootstrap + wiring (real vs mock)
  src/core/        state, persistence, alerts, events, SSE, device + speed-test controllers
  src/routes/      REST API
  src/net/         LAN: interface/gateway, discovery, pinger, throughput, OUI vendors
  src/net/fingerprint/  device-type detection (mDNS, SSDP, NetBIOS, ports, hostname, vendor, Apple models)
  src/internet/    connectivity probe, Cloudflare speed test, ISP lookup
  src/mock/        deterministic mock implementations (NETMON_MOCK=1)
web/               Vue 3 + Vite + Tailwind CSS v4 dashboard
e2e/               Playwright tests (run against mock mode)
  src/components/topology/  network map (Vue Flow): layout.js, TopologyMap.vue, nodes/, edges/
  src/components/detail/    device detail panel
docs/              PLAN.md (API contract), DESIGN.md (visual system), TOPOLOGY.md (map + detail panel),
                   NETWORK_NOTES.md, FINGERPRINT_NOTES.md (research notes)
```

## Windows

NetMon runs on **Windows 10 and 11 (x64)** as a normal Windows service. It does not use Docker or WSL.

### Install

1. Download `NetMon-Setup-<version>.exe` from the [Releases](https://github.com/neumerance/netmon/releases) page.
   You can check the download against the `.sha256` file next to it: `Get-FileHash .\NetMon-Setup-<version>.exe`.
2. Run it. The installer is not code-signed, so Windows SmartScreen may show "Windows protected your PC". Click
   **More info → Run anyway**. Setup needs administrator rights.
3. On the **Network access** page, choose:
   - **Allow other devices on your network to open NetMon** (on by default). Turn it off to use NetMon on this PC only.
   - **Require an access token (recommended)**. Each phone, tablet or other PC opens NetMon once with a link that
     contains the token. Without a token, anyone on your network can rename or forget devices and change settings.
   - **Port** (default `4000`, any number from 1024 to 65535).
4. On the last page, leave **Open NetMon now** ticked. The page also shows the links for this PC and for other devices.

What the installer sets up:

| | |
|---|---|
| Program | `C:\Program Files\NetMon\` with `NetMon.exe` (the web app is built in), `NetMonService.exe` ([WinSW](https://github.com/winsw/winsw) v2.12.0, MIT) and `NetMonService.xml` (the service settings) |
| Service | **NetMon** ("NetMon Network Monitor"). It starts automatically (delayed start) with Windows, even before anyone signs in. If it crashes, Windows restarts it after 5 s (three times), then every 60 s. |
| Data | `C:\ProgramData\NetMon\` (saved devices, history, settings, map layout). Only Administrators and SYSTEM can change this folder. |
| Logs | `C:\ProgramData\NetMon\logs\` (`NetMonService.out.log`, `.err.log`, `.wrapper.log`, rolled at 10 MB) |
| Firewall | Windows Defender Firewall rules for `NetMon.exe`, limited to your local subnet on **Private** and **Domain** networks: inbound TCP on the port (only with LAN access) and the UDP discovery traffic (mDNS 5353, SSDP 1900, NetBIOS 137). Ping and the other checks are outbound and need no rule. |
| Start Menu | **Open NetMon**, **NetMon logs**, **Uninstall NetMon** |

NetMon must be allowed through Windows Defender Firewall for device discovery and for access from other devices. The
installer adds the rules. If Windows treats your network as **Public**, the rules do not apply: open
**Settings → Network & internet → Wi-Fi / Ethernet → (your network)** and choose **Private network**. Other firewall
products need the same exceptions for `C:\Program Files\NetMon\NetMon.exe`.

### Open NetMon

- On this PC: **Open NetMon** in the Start Menu, or http://localhost:4000.
- From another device on the same network (with LAN access on): `http://<this-pc-ip>:4000`. Find the IP address with
  `ipconfig` (the "IPv4 Address" of your Wi-Fi or Ethernet adapter). With an access token, add `/?token=<token>` once
  per browser. The token is in the Finish page link, in the **Open NetMon** shortcut, and in
  `C:\Program Files\NetMon\NetMonService.xml` (`NETMON_TOKEN`).

### Change the port or network access

Run the installer again (the same version or a newer one). It shows your current choices, keeps your data and the
access token, and restarts the service with the new settings. Don't edit `NetMonService.xml` by hand: the installer
rewrites it.

Unattended install or upgrade:

```powershell
.\NetMon-Setup-<version>.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LAN=1 /TOKEN=1 /PORT=4000
```

(`/LAN=0` = this PC only. Options you leave out keep their previous values. The defaults are LAN=1 TOKEN=1 PORT=4000.)

### Service commands

Run these in an administrator Command Prompt or PowerShell:

```bat
sc query NetMon          :: status
net stop NetMon          :: stop (NetMon saves its data first)
net start NetMon         :: start
```

You can also use **Services** (`services.msc`) → *NetMon Network Monitor*.

### Uninstall

Use **Settings → Apps → Installed apps → NetMon → Uninstall** (or **Uninstall NetMon** in the Start Menu). This stops
and removes the service and the firewall rules. The uninstaller then asks **Also delete NetMon data?** The default is
**No**, which keeps `C:\ProgramData\NetMon` for a later reinstall. A silent uninstall (`/VERYSILENT`) always keeps the data.

### Build the installer yourself

On Windows with Node.js 22 LTS, Git and [Inno Setup 6.3+](https://jrsoftware.org/isinfo.php):

```powershell
npm ci; npm --prefix server ci; npm --prefix web ci
npm run build:exe                                   # -> dist-exe\NetMon.exe
New-Item -ItemType Directory -Force installer\build | Out-Null
Invoke-WebRequest https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe -OutFile installer\build\WinSW-x64.exe
(Get-FileHash installer\build\WinSW-x64.exe).Hash   # 05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA
iscc /DAppVersion=1.0.0 installer\netmon.iss        # -> installer\Output\NetMon-Setup-1.0.0.exe
```

The [Windows workflow](.github/workflows/windows.yml) does the same on every push and pull request. It runs the server
unit tests and the Playwright e2e tests on Windows, builds and smoke-tests `NetMon.exe`, builds the installer, and
tests a real install, upgrade and uninstall on the runner. Pushing a tag such as `v1.2.3` publishes
`NetMon-Setup-1.2.3.exe` and its `.sha256` file as a GitHub Release. `installer/make-icon.mjs` regenerates
`installer/netmon.ico`.

### Limits on Windows

- The PC must be connected to the network you want to monitor, over Ethernet or Wi-Fi. Only the /24 around its main
  adapter (the one with the default gateway) is scanned.
- Windows 10/11 x64 only. On Windows on ARM it runs under x64 emulation (untested). Docker and WSL are not supported:
  inside them NetMon would see the container's or VM's virtual network, not your LAN.
- The installer and `NetMon.exe` are not code-signed, so SmartScreen and some antivirus products warn on first run.
- The service runs as the LocalSystem account (the WinSW default).
