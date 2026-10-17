# Fingerprint Notes (device-type detection)

Owner: backend-fingerprint. Code: `server/src/net/fingerprint/`. Validated 2026-10-17 on macOS (Darwin 25.2.0),
Node 20.19, Wi-Fi `en0` 10.0.0.94/24, gateway 10.0.0.1, 32 neighbours. Linux paths use the same pure-JS sockets
and were not run on Linux.

## 1. Pipeline

```
updateDevices(list) ──► ip→device map (late passive answers are attributed by IP)
start()  ──► mDNS browser (multicast-dns, reuseAddr) + SSDP browser (dgram) ─ browse now, then every passiveBrowseMs
fingerprint(device) ─► queue (concurrency 2, one task per MAC, force upgrades a queued task)
   1. wait for the first passive browse (≤ 6 s, released at once by stop())
   2. in parallel: mDNS reverse-PTR query for the IP (1.2 s)          [passive]
                   TCP connect probe of 20 ports (400 ms, 6 at a time) [active]
                   NetBIOS node-status, UDP 137 (800 ms)               [active]
      then:        HTTP banner of the first open web port (1.5 s)      [active]
   3. classify() (pure) ─► onResult(mac, result)
passive mDNS/SSDP update for an IP that already has a result ─► re-classify after 1 s ─► onResult only if
category/os/model/manufacturer/first name changed
```
Active steps run only when `settings.activeFingerprinting !== false` and the MAC has not been actively probed in the
last `activeProbeMinIntervalMs` (1 h), unless `force` or the IP changed. Self is never port-probed. Cached active
results are reused for re-classification only while the IP is the same. `fingerprint()` never rejects, callbacks
are wrapped, and `stop()` closes every socket (verified: the test process exits with no open handles).

Measured cost: 32 devices in 13–14 s at concurrency 4 (about 28 s at the default 2). Passive-only takes about 12 s,
which is mostly the first browse window plus the reverse-PTR waits.

## 2. Scoring

Every signal produces Hints `{ category?, os?, model?, weight, evidence }`.
- Category score = noisy-OR `1 − Π(1 − w)` over hints for that category. The winner is the max. Below **0.25** the
  result is `unknown` (confidence = max(0.05, score)).
- `typeConfidence` = the winner's score, minus 0.15 if the runner-up is within 0.1 (floor 0.05). Two decimals.
- OS is scored the same way. The threshold is **0.3**. A confident OS adds an internal category hint without evidence:
  windows→computer ×0.5, macos→computer ×0.45, ios→phone ×0.55 (tablet ×0.2), ipados→tablet ×0.6,
  android→phone ×0.5, tvos→media_player ×0.6, chromeos→laptop ×0.5.
- If the OS is still null, it comes from the vendor family and the category: an Apple-ish device gives
  phone→ios, tablet→ipados, laptop/computer→macos, media_player→tvos. An Android OEM on phone/tablet gives android.
  iOS on a tablet is rewritten to iPadOS.
- Non-gateway `router` hints are multiplied by 0.7, so mesh nodes and extenders land on `access_point`. The gateway
  is always `router` (≥ 0.95).
- Model: the highest-weight hint whose category matches the winner. A longer name that extends it ("Sonos" →
  "Sonos One", "iPhone" → "iPhone 15 Pro") is preferred when it is within 0.25.
- Name hints (DNS, mDNS host/instance, NetBIOS, UPnP friendlyName, Cast `fn`) keep only the strongest hint per
  category. Names are not added up, because they are correlated. Factors: DNS/mDNS hostname 1.0, NetBIOS/Cast 0.95,
  UPnP/mDNS instance 0.85.
- Evidence: hints that support the chosen category/OS come first, strongest first, then hints with no type
  information, then contradicting hints. Duplicates are removed and the list is capped at 8.
  `No identifying services found` / `Vendor not recognized` are added like in the mock.

### Weight table (final)
| Signal | Hint | Weight |
|---|---|---|
| Default gateway | router | 0.95 (forced winner) |
| This computer (`isSelf`) | computer/laptop + OS from `process.platform` | 0.6 |
| mDNS / sysctl Apple model id (`appleModels.js`) | category + OS + friendly model | 0.9 |
| mDNS `_ipp/_ipps/_printer/_pdl-datastream` | printer (0.15 on a Mac = printer sharing) | 0.85 |
| mDNS printer `ty`/`product` | printer model | 0.7 |
| mDNS `_googlecast` `md=` | Chromecast→media_player, Home/Nest→speaker, Hub→smart_home, TV brand→tv | 0.6–0.85 |
| mDNS `_sonos`, `_hue`, `_esphomelib`, `_qdiscover`, `_ASUSTOR_*`, Synology `vendor=` | speaker / smart_home / nas | 0.85 |
| mDNS `_hap` (`ci=` HomeKit category) | camera / tv / speaker / media / smart_home | 0.65 |
| mDNS `_home-assistant` | server/linux | 0.8 |
| mDNS `_androidtvremote2` | tv 0.55 + media_player 0.45, android | |
| mDNS `_apple-mobdev2` | phone/ios | 0.5 |
| mDNS `_workstation` | computer/linux | 0.45 |
| mDNS device-info `model=Xserve/RackMac/MacSamba` | nas (Samba Time Machine icon) | 0.4 |
| mDNS `_companion-link` | evidence + "Apple device" for OS resolution | 0.3 |
| UPnP InternetGatewayDevice | router (gateway) / access_point (non-gateway) | 0.8 / 0.75 |
| UPnP WLANAccessPointDevice / WFADevice (WPS) | access_point (router if gateway) | 0.8 / 0.6 |
| UPnP ZonePlayer | speaker + model | 0.85 |
| UPnP MediaRenderer | TV brand→tv 0.8, Sonos→speaker, Roku→media_player, else media 0.5 + tv 0.4 | |
| UPnP camera model (`IPC-*`, NVR, DVR) | camera | 0.7 |
| UPnP manufacturer | vendor hint +0.1 (cap 0.7) | |
| UPnP SERVER header Windows / Darwin | windows 0.5 / macos 0.4 | |
| NetBIOS name, real MAC | windows | 0.45 |
| NetBIOS name, MAC 00:00:00:00:00:00 (Samba) | linux | 0.35 |
| NetBIOS `MAC-xxxxxx` or Apple device | macos | 0.2 |
| Hostname exact patterns (`hostname.js`) | e.g. DESKTOP-* / LAPTOP-* / iPhone / Pixel / Deco / LGwebOSTV | 0.6–0.8 |
| Hostname generic words (laptop, desktop, tablet, phone, server) | | 0.4–0.5 |
| Port 62078 | phone/ios 0.7 + tablet 0.2 | |
| Port 3389 | computer/windows | 0.5 |
| Ports 139+445 (not Apple, not Samba) | computer/windows | 0.5 |
| Port 548 | macos 0.4 (nas 0.3 with NAS vendor) | |
| Port 9100 / 631 | printer 0.7 / 0.4–0.5 | |
| Port 1400 / 8060 / 8008-8009 | speaker (Sonos) / media_player (Roku) / media_player (Cast) | 0.7 / 0.7 / 0.6 |
| Port 5001 / 5000 (no AirPlay) / 32400 | nas 0.45 / nas 0.2 / server 0.4 + nas 0.25 | |
| Non-gateway 53 + 80/443 + (network vendor, UPnP AP/IGD or router web UI) | access_point "DNS + web admin on non-gateway → mesh node / secondary router" | 0.75 |
| Non-gateway 53 otherwise | server 0.2, access_point 0.15 | |
| HTTP banner (`http.js`): Dahua/Hikvision UI assets, NVR/DVR title | camera | 0.65–0.75 |
| HTTP: Pi-hole / Home Assistant / Proxmox titles | server/linux | 0.7 |
| HTTP: NAS UIs, printer servers (HP-ChaiSOE, EmWeb, ...) | nas / printer | 0.7–0.75 |
| HTTP: router admin pages (TP-Link `webpages/login.html`, LuCI, Tenda, UniFi, ...) | access_point 0.5 / router | |
| HTTP: lwIP server, Shelly/Tasmota/ESPHome/solar inverters | smart_home | 0.45–0.6 |
| TTL ≤ 64 | evidence "TTL 64 → Unix-like" only | |
| TTL 65–128 | computer + windows | 0.3 |
| TTL > 128 | smart_home 0.15, access_point 0.12, switch 0.1 | |
| TTL > 128 and no open TCP ports (active) | smart_home | 0.3 |
| Randomized MAC (locally administered bit) | phone 0.35, tablet 0.15, laptop 0.12 | |
| Vendor (`vendorHints.js`) | single-purpose vendors 0.5–0.7; network gear router+AP 0.35; PC NICs computer 0.3; Apple/Samsung/Google weak OS only | |

## 3. Ground truth on the validation LAN (10.0.0.0/24)

"Truth" is the real device type as established by hand from mDNS/SSDP dumps, HTTP pages (curl) and NetBIOS,
independent of the classifier. Final run (active fingerprinting on):

| IP | MAC | Truth (how we know) | Classified | Conf | OK |
|---|---|---|---|---|---|
| .1 | 14:eb:b6 | TP-Link router, gateway | router | 0.98 | yes |
| .9 | 60:a4:b7 | TP-Link NVR (HTTPS title "NVR") | camera | 0.65 | yes |
| .10 | 78:72:64 | ASUSTOR AS3302T NAS (mDNS `_ASUSTOR_ADM`, Samba) | nas/linux, ASUSTOR AS3302Tv2 | 0.91 | yes |
| .11 | e4:24:6c | Dahua IPC-HDW2439TN camera (UPnP) | camera, Dahua IPC-HDW2439TN… | 0.99 | yes |
| .12 .13 .15 .17 .19 | various | Dahua camera / NVR web UI (`jsBase/widget/js/dui.password.js`) | camera | 0.75 | yes |
| .16 | fc:b6:9d | Dahua IPC-HDW2439TN camera (UPnP) | camera | 0.99 | yes |
| .18 | c0:99:0b | embedded device, thttpd only, not identifiable | unknown | 0.05 | n/a |
| .55 .58 .59 .78 .79 .80 .81 .85 .96 | various | IoT (TTL 255, no TCP services, lwIP-style) | smart_home | 0.41 | likely |
| .57 | ac:86:74 | SSH only, nothing else exposed | unknown | 0.15 | n/a |
| .61 | 00:d8:61 (MSI) | Windows PC DESKTOP-8UO3KFS (NetBIOS, TTL 128) | computer/windows | 0.96 | yes |
| .77 | b8:3a:08 | Tenda AX1500 router used as AP (UPnP IGD + WPS, non-gateway) | access_point, Tenda AX1500 | 0.97 | yes |
| .93 | c8:a3:62 | Windows PC DESKTOP-PA53U7E | computer/windows | 0.95 | yes |
| .94 | 66:f1:f9 (private) | this MacBook Pro (Mac15,6) | laptop/macos, MacBook Pro | 0.99 | yes |
| .95 | 9e:14:6d (private) | iPhone ("iPhone" apple-midi instance, 62078) | phone/ios, iPhone | 0.96 | yes |
| .97 | aa:13:1d (private) | phone asleep (no ping, no ports) | phone | 0.35 | likely |
| .98 | a6:40:1b (private) | iPhone (62078) | phone/ios | 0.88 | yes |
| .99 | 80:f3:da | Solis solar inverter Wi-Fi logger (lwIP, realm "solis") | smart_home | 0.81 | yes |
| .100 | 68:1d:ef | Pi-hole + OpenClaw Linux box (`pi.hole`, Pi-hole UI) | server/linux, Pi-hole | 0.93 | yes |
| .101 | 3a:f0:62 (private) | MacBook Pro 13" M2 (Mac14,7) | laptop/macos, MacBook Pro | 0.96 | yes |
| .102 | 80:47:86 | intermittent, 8080 showed a Pi-hole page once | unknown | 0.05 | n/a |

Result: all 29 identifiable devices get a correct or plausible category. 10 of them are "likely": the 9 IoT rows
and the sleeping phone. The remaining 3 expose nothing usable and are honestly `unknown`. With active probing **off** (passive only), routers, the NAS, the UPnP cameras, the Tenda AP, both Macs,
the iPhone and the Pi-hole are still right. The other Dahua cameras, the IoT devices, the inverter and the Windows
PCs (TTL 128 only → computer/windows 0.41) drop to unknown or low confidence. That is expected, because
`activeFingerprinting` is the switch that trades accuracy for quietness.

## 4. Field observations / gotchas
- mDNS answers are **intermittent**. Sleeping iPhones and some Macs answer only some browses, so the browser sends
  three query rounds per window (0 s, 1 s, 2.5 s) and keeps results across browses. Passive updates re-classify later.
- Attribute mDNS data through records (instance → SRV target → A), not the packet source. Bonjour sleep proxies
  answer for other hosts. macOS also loops our own host's answers back from 127.0.0.1, and those are ignored.
- TXT keys depend on the service: `_raop` `md=0,1,2` is a codec list, not a model, while `_googlecast` `md=` is the
  model. Keys are whitelisted per service.
- Samba/NAS boxes advertise `_device-info` `model=Xserve` (Time Machine icon). That is treated as a NAS hint, not
  as an Apple device.
- macOS answers NetBIOS too (`MAC-96F52F`, real MAC), so NetBIOS alone is not proof of Windows. Samba answers with
  an all-zero MAC.
- macOS has AirPlay receiver ports 5000/7000 open, so 5000 alone is not a Synology NAS.
- Some embedded HTTP servers send `Content-Length` together with chunked encoding (the TP-Link gateway). Node's strict
  parser rejects this, so `http.js` uses `insecureHTTPParser`. Self-signed TLS is accepted, only `GET /` is sent,
  at most one same-host redirect is followed, and the body is capped at 64 KB.
- SSDP: the gateway here does not answer M-SEARCH at all. Mesh/AP routers do (IGD + WFADevice). LOCATION is
  fetched only when it points at the announcing IP.
- Private (randomized) MACs: 4 of 32 devices here. They never have an OUI vendor, so the type depends on mDNS,
  62078 and names.

## 5. Limitations
- mDNS/SSDP/NetBIOS only work on the same L2 segment, so devices behind another router or a guest VLAN are not
  visible.
- Devices with no services and an unknown OUI stay `unknown`. Users can override the type (user type always wins in core).
- Many OUIs on this LAN are missing from `oui.js` (Dahua `e4:24:6c` `fc:b6:9d` `6c:1c:71` `c0:39:5a`, ASUSTOR `78:72:64`,
  Tenda `b8:3a:08`, and others). Detection here relied on mDNS/UPnP/HTTP instead. Adding them improves the
  passive-only mode.
- Port and HTTP probes can show up in IDS logs. They are rate-limited (new devices, at most hourly) and can be
  disabled with `activeFingerprinting`.
