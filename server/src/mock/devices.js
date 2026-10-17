// Deterministic mock device table (PLAN.md §7.2).
//
// Every value here is relied on by the e2e tests and by the UI label expectations, so do not change
// strings casually. Each row carries:
//   - the raw discovery fields (mac/ip/hostname/vendor/ttl/isSelf/isGateway)
//   - the pinger wave parameters (baseLatencyMs / jitterMs / lossEvery)
//   - the fingerprint result fields (category/os/model/typeConfidence/typeEvidence/manufacturer/signals)

/** @typedef {{ mdnsServices: string[], mdnsModel: string|null, upnpDeviceType: string|null,
 *              upnpFriendlyName: string|null, upnpModel: string|null, netbiosName: string|null,
 *              openPorts: number[] }} MockSignals */

const UPNP = {
  igd: 'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  wlanAp: 'urn:schemas-upnp-org:device:WLANAccessPointDevice:1',
  renderer: 'urn:schemas-upnp-org:device:MediaRenderer:1',
  zonePlayer: 'urn:schemas-upnp-org:device:ZonePlayer:1',
};

const NO_SIGNALS = Object.freeze({
  mdnsServices: [], mdnsModel: null, upnpDeviceType: null, upnpFriendlyName: null,
  upnpModel: null, netbiosName: null, openPorts: [],
});

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** The ten devices present at start (index order = table order = `idx` used by the latency wave). */
export const MOCK_DEVICES = deepFreeze([
  {
    mac: 'a4:83:e7:1c:2d:01', ip: '192.168.1.23', hostname: 'Jons-MacBook-Pro', vendor: 'Apple, Inc.',
    isSelf: true, isGateway: false, ttl: 64,
    baseLatencyMs: null, jitterMs: null, lossEvery: 0, // self is not pinged
    category: 'laptop', os: 'macos', model: 'MacBook Pro', manufacturer: 'Apple', typeConfidence: 0.98,
    typeEvidence: ['This computer', 'mDNS model MacBookPro18,3 → MacBook Pro', 'Vendor Apple', 'TTL 64 → Unix-like'],
    signals: { ...NO_SIGNALS, mdnsServices: ['_device-info._tcp', '_companion-link._tcp', '_airplay._tcp', '_ssh._tcp'],
      mdnsModel: 'MacBookPro18,3', openPorts: [22, 5000, 7000] },
  },
  {
    mac: 'f0:9f:c2:10:00:01', ip: '192.168.1.1', hostname: 'unifi', vendor: 'Ubiquiti Inc.',
    isSelf: false, isGateway: true, ttl: 64,
    baseLatencyMs: 1.2, jitterMs: 0.3, lossEvery: 0,
    category: 'router', os: null, model: 'UniFi Dream Machine', manufacturer: 'Ubiquiti Networks', typeConfidence: 0.97,
    typeEvidence: ['Default gateway → router', 'UPnP InternetGatewayDevice', 'Vendor Ubiquiti → network gear', 'TTL 64 → Unix-like'],
    signals: { ...NO_SIGNALS, upnpDeviceType: UPNP.igd, upnpFriendlyName: 'UniFi Dream Machine', upnpModel: 'UDM',
      openPorts: [22, 53, 80, 443] },
  },
  {
    mac: '3c:7c:3f:5a:9b:03', ip: '192.168.1.45', hostname: 'DESKTOP-7Q2K9LM', vendor: 'ASUSTek COMPUTER INC.',
    isSelf: false, isGateway: false, ttl: 128,
    baseLatencyMs: 2.5, jitterMs: 0.6, lossEvery: 0,
    category: 'computer', os: 'windows', model: null, manufacturer: null, typeConfidence: 0.92,
    typeEvidence: ['Hostname DESKTOP-* → Windows', 'NetBIOS name DESKTOP-7Q2K9LM', 'TTL 128 → Windows',
      'Port 445 open (SMB)', 'Port 3389 open (Remote Desktop)'],
    signals: { ...NO_SIGNALS, netbiosName: 'DESKTOP-7Q2K9LM', openPorts: [139, 445, 3389] },
  },
  {
    mac: '5a:1f:3e:8c:44:04', ip: '192.168.1.61', hostname: 'Jons-iPhone', vendor: null, // randomized (private) MAC
    isSelf: false, isGateway: false, ttl: 64,
    baseLatencyMs: 8.0, jitterMs: 4.0, lossEvery: 0,
    // manufacturer stays null so the Device keeps vendor:null (PLAN §4.1 example).
    category: 'phone', os: 'ios', model: 'iPhone 15 Pro', manufacturer: null, typeConfidence: 0.9,
    typeEvidence: ['mDNS model iPhone16,1 → iPhone 15 Pro', 'Port 62078 open → iOS',
      'Randomized (private) MAC → mobile device', 'Hostname contains iPhone'],
    signals: { ...NO_SIGNALS, mdnsServices: ['_device-info._tcp', '_companion-link._tcp', '_apple-mobdev2._tcp'],
      mdnsModel: 'iPhone16,1', openPorts: [62078] },
  },
  {
    mac: '3c:28:6d:a1:b2:05', ip: '192.168.1.72', hostname: 'Pixel-8', vendor: 'Google, Inc.',
    isSelf: false, isGateway: false, ttl: 64,
    baseLatencyMs: 12.0, jitterMs: 5.0, lossEvery: 0,
    category: 'phone', os: 'android', model: 'Pixel 8', manufacturer: null, typeConfidence: 0.85,
    typeEvidence: ['Hostname Pixel-* → Android phone', 'Vendor Google', 'TTL 64 → Unix-like'],
    signals: { ...NO_SIGNALS },
  },
  {
    mac: '50:c7:bf:3d:7e:06', ip: '192.168.1.2', hostname: 'Deco-M5', vendor: 'TP-LINK TECHNOLOGIES CO.,LTD.',
    isSelf: false, isGateway: false, ttl: 64,
    baseLatencyMs: 2.0, jitterMs: 0.5, lossEvery: 0,
    category: 'access_point', os: null, model: 'Deco M5', manufacturer: 'TP-Link', typeConfidence: 0.88,
    typeEvidence: ['Hostname Deco-* → TP-Link mesh Wi-Fi', 'DNS + web admin on non-gateway → mesh node / secondary router',
      'UPnP WLANAccessPointDevice', 'Vendor TP-Link → network gear'],
    signals: { ...NO_SIGNALS, upnpDeviceType: UPNP.wlanAp, upnpFriendlyName: 'Deco M5', upnpModel: 'M5',
      openPorts: [53, 80, 443] },
  },
  {
    mac: 'a8:23:fe:44:19:07', ip: '192.168.1.88', hostname: 'LGwebOSTV', vendor: 'LG Electronics',
    isSelf: false, isGateway: false, ttl: 64,
    baseLatencyMs: 5.0, jitterMs: 1.5, lossEvery: 0,
    category: 'tv', os: 'other', model: 'OLED65C3', manufacturer: 'LG Electronics', typeConfidence: 0.9,
    typeEvidence: ['Hostname LGwebOSTV → LG webOS TV', 'UPnP MediaRenderer "[LG] webOS TV OLED65C3"', 'Vendor LG Electronics'],
    signals: { ...NO_SIGNALS, mdnsServices: ['_airplay._tcp', '_hap._tcp'], upnpDeviceType: UPNP.renderer,
      upnpFriendlyName: '[LG] webOS TV OLED65C3', upnpModel: 'OLED65C3', openPorts: [] },
  },
  {
    mac: '3c:52:82:7a:0c:08', ip: '192.168.1.120', hostname: 'HP-LaserJet-M404', vendor: 'HP Inc.',
    isSelf: false, isGateway: false, ttl: 64,
    baseLatencyMs: 3.0, jitterMs: 1.0, lossEvery: 0,
    category: 'printer', os: null, model: 'LaserJet Pro M404dn', manufacturer: 'HP', typeConfidence: 0.95,
    typeEvidence: ['mDNS _ipp._tcp → printer', 'Port 9100 open (raw printing)', 'Port 631 open (IPP)', 'Vendor HP'],
    signals: { ...NO_SIGNALS, mdnsServices: ['_ipp._tcp', '_printer._tcp', '_http._tcp'],
      openPorts: [80, 443, 631, 9100] },
  },
  {
    mac: '48:a6:b8:c1:d2:09', ip: '192.168.1.130', hostname: 'Sonos-Living-Room', vendor: 'Sonos, Inc.',
    isSelf: false, isGateway: false, ttl: 64,
    baseLatencyMs: 4.0, jitterMs: 1.0, lossEvery: 0,
    category: 'speaker', os: null, model: 'Sonos One', manufacturer: 'Sonos, Inc.', typeConfidence: 0.96,
    typeEvidence: ['Vendor Sonos → speaker', 'Port 1400 open (Sonos)', 'mDNS _sonos._tcp', 'UPnP ZonePlayer model Sonos One'],
    signals: { ...NO_SIGNALS, mdnsServices: ['_sonos._tcp', '_spotify-connect._tcp', '_airplay._tcp'],
      upnpDeviceType: UPNP.zonePlayer, upnpFriendlyName: 'Living Room', upnpModel: 'Sonos One', openPorts: [1400] },
  },
  {
    mac: '00:25:96:12:34:0a', ip: '192.168.1.150', hostname: null, vendor: null,
    isSelf: false, isGateway: false, ttl: 64,
    baseLatencyMs: 20.0, jitterMs: 8.0, lossEvery: 20, // every 20th sample lost => 5 % loss
    category: 'unknown', os: null, model: null, manufacturer: null, typeConfidence: 0.1,
    typeEvidence: ['No identifying services found', 'Vendor not recognized', 'TTL 64 → Unix-like'],
    signals: { ...NO_SIGNALS },
  },
]);

/** Device #11, added by POST /api/mock/state { newDevice: true }. Its wave index is 10. */
export const MOCK_NEW_DEVICE = deepFreeze({
  mac: '8c:79:f5:3a:21:0b', ip: '192.168.1.140', hostname: 'Galaxy-Tab-S9', vendor: 'Samsung Electronics Co.,Ltd',
  isSelf: false, isGateway: false, ttl: 64,
  baseLatencyMs: 9.0, jitterMs: 3.0, lossEvery: 0,
  category: 'tablet', os: 'android', model: 'Galaxy Tab S9', manufacturer: null, typeConfidence: 0.86,
  typeEvidence: ['Hostname Galaxy-Tab-* → Samsung tablet', 'Vendor Samsung', 'TTL 64 → Unix-like'],
  signals: { ...NO_SIGNALS },
});

/** All rows (including #11) in wave-index order. */
export const ALL_MOCK_DEVICES = deepFreeze([...MOCK_DEVICES, MOCK_NEW_DEVICE]);

const BY_MAC = new Map(ALL_MOCK_DEVICES.map((d, idx) => [d.mac, { row: d, idx }]));

/** @returns {{ row: object, idx: number } | null} */
export function findMockDevice(mac) {
  return (mac && BY_MAC.get(String(mac).toLowerCase())) || null;
}

/** NetworkInfo of the simulated host (PLAN §7.1). */
export const MOCK_NETWORK = deepFreeze({
  iface: 'en0', ip: '192.168.1.23', netmask: '255.255.255.0', cidr: '192.168.1.0/24', prefix: 24,
  mac: 'a4:83:e7:1c:2d:01', gateway: '192.168.1.1', platform: 'darwin',
});

/** ISP payload (minus fetchedAt) (PLAN §7.3). */
export const MOCK_ISP = deepFreeze({
  name: 'Comcast Cable Communications', asn: 7922, ip: '73.162.88.14', city: 'San Francisco',
  region: 'California', country: 'US', colo: 'SJC', source: 'mock',
});
