/**
 * Device-type fingerprinting: orchestrator + weighted-evidence classifier.
 *
 * Signals (see docs/FINGERPRINT_NOTES.md for the full weight table):
 *   passive  - OUI vendor, randomized MAC bit, DNS/mDNS/NetBIOS/UPnP names, ping TTL,
 *              mDNS/Bonjour services + TXT model ids, SSDP/UPnP device descriptions
 *   active   - light TCP connect probe of ~20 ports, NetBIOS node-status query
 *              (skipped when settings.activeFingerprinting is false)
 *
 * Every signal becomes one or more Hints { category?, os?, model?, weight, evidence }.
 * Per category the score is the noisy-OR 1 - Π(1 - w); the best category wins
 * ('unknown' below 0.25). OS and model are chosen the same way. classify() is pure.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { CATEGORIES } from './categories.js';
import { appleModelInfo, isAppleModelId } from './appleModels.js';
import { hostnameHints, cleanHostname } from './hostname.js';
import { vendorHints, shortVendor, isNetworkVendor, isAppleVendor, isAndroidVendor } from './vendorHints.js';
import { createMdnsBrowser, normalizeService } from './mdns.js';
import { createSsdpBrowser } from './ssdp.js';
import { probePorts, DEFAULT_PORTS } from './ports.js';
import { queryNetbios } from './netbios.js';
import { probeHttp, httpHints } from './http.js';

export { CATEGORIES, OS_VALUES, CATEGORY_LABELS, OS_LABELS } from './categories.js';
export { DEFAULT_PORTS } from './ports.js';

const UNKNOWN_THRESHOLD = 0.25;
const FAKE_APPLE_ICON = /^(xserve|rackmac|macsamba|timecapsule\d*,?\d*|airport\d*,?\d*|macpro|powermac)$/i;
const OS_THRESHOLD = 0.3;
const MAX_EVIDENCE = 8;
// Bounds for LAN-supplied strings that end up in store.json and every SSE devices broadcast.
const MAX_EVIDENCE_LEN = 120;
const MAX_HOSTNAME_HINTS = 5;
const MAX_MDNS_SERVICES = 24;
const MAX_SIGNAL_LEN = 128;
// Re-detection requested via the API within this window reuses the last active probe (no port-scan loop).
const FORCE_MIN_INTERVAL_MS = 30_000;

const clip = (v, n = MAX_SIGNAL_LEN) => (typeof v === 'string' ? (v.length > n ? `${v.slice(0, n - 1)}…` : v) : v ?? null);
// Network-gear vendors that also sell lots of smart plugs / bulbs / cameras (Kasa, Tapo, mydlink, ...).
const NET_VENDOR_WITH_IOT = /tp-?link|d-link|tenda|mercusys|meross/i;

const round2 = (n) => Math.round(n * 100) / 100;
const noisyOr = (weights) => 1 - weights.reduce((p, w) => p * (1 - Math.max(0, Math.min(1, w))), 1);

const PLATFORM_OS = { darwin: 'macos', win32: 'windows', linux: 'linux' };

// Category implied by a confidently detected OS (weight multiplier of the OS score).
const OS_IMPLIES = {
  windows: [['computer', 0.5]],
  macos: [['computer', 0.45]],
  ios: [['phone', 0.55], ['tablet', 0.2]],
  ipados: [['tablet', 0.6]],
  android: [['phone', 0.5], ['tablet', 0.15]],
  tvos: [['media_player', 0.6]],
  chromeos: [['laptop', 0.5]],
};

const TV_BRANDS = /\b(lg|webos|samsung|tizen|sony|bravia|vizio|tcl|hisense|philips|panasonic|sharp|toshiba|insignia|skyworth|metz|loewe|tv)\b/i;

// ---------------------------------------------------------------------------
// mDNS service -> hints
// ---------------------------------------------------------------------------

function googlecastHints(txt) {
  const md = txt.md || '';
  const fn = txt.fn || '';
  const label = md || 'Google Cast device';
  const ev = `mDNS _googlecast._tcp model "${label}"`;
  // Dongles / streamers first; then TV sets with Google TV built in ("Hisense Google TV", "TCL Smart TV",
  // or a bare model with fn "Living Room TV") before the generic Google TV / speaker rules.
  const tvWord = /\btv\b/i.test(md);
  if (/^chromecast|^google tv( streamer)?$|streamer/i.test(md.trim())) return [{ category: 'media_player', model: md, weight: 0.85, evidence: ev }];
  if (/nest hub|home hub|smart display|lenovo smart|nest hub max/i.test(md)) return [{ category: 'smart_home', model: md, weight: 0.75, evidence: ev }];
  if (TV_BRANDS.test(md.replace(/\btv\b/ig, '')) && (tvWord || !/soundbar|speaker|audio|srs|bar\b/i.test(md))) {
    return [{ category: 'tv', model: md || null, weight: 0.8, evidence: ev }];
  }
  if (!tvWord && /home|nest|speaker|audio|mini|max|soundbar|jbl|sony srs|bose|onkyo|denon|marantz|yamaha/i.test(md)) return [{ category: 'speaker', model: md, weight: 0.8, evidence: ev }];
  if (tvWord || /\btv\b/i.test(fn)) return [{ category: 'tv', model: md || null, weight: 0.75, evidence: ev }];
  if (/shield/i.test(md)) return [{ category: 'media_player', os: 'android', model: md, weight: 0.8, evidence: ev }];
  return [{ category: 'media_player', model: md || null, weight: 0.6, evidence: ev }];
}

const HAP_CATEGORY = { 17: 'camera', 18: 'camera', 31: 'tv', 33: 'router', 34: 'speaker', 35: 'media_player', 36: 'media_player' };

function printerModelFromTxt(txt) {
  const raw = txt.ty || (txt.product ? txt.product.replace(/^\(|\)$/g, '') : null)
    || (txt.usb_mdl ? `${txt.usb_mfg ? `${txt.usb_mfg} ` : ''}${txt.usb_mdl}` : null);
  if (!raw) return null;
  // "HP LaserJet Pro M404dn" -> "LaserJet Pro M404dn" (vendor is shown separately)
  return raw.replace(/^(hp|hewlett[- ]packard|epson|brother|canon)\s+/i, '').trim() || raw;
}

/**
 * Hints from the set of mDNS services. ctx: { appleComputer, apple, gateway }.
 */
function mdnsServiceHints(services, txt, ctx) {
  const out = [];
  const has = (s) => services.has(s);
  const printerSvc = ['_ipp._tcp', '_ipps._tcp', '_printer._tcp', '_pdl-datastream._tcp'].find(has);
  if (printerSvc) {
    if (ctx.appleComputer) {
      out.push({ category: 'printer', weight: 0.15, evidence: `mDNS ${printerSvc} (printer sharing)` });
    } else {
      out.push({ category: 'printer', weight: 0.85, evidence: `mDNS ${printerSvc} → printer` });
      const model = printerModelFromTxt(txt);
      if (model) out.push({ category: 'printer', model, weight: 0.7, evidence: `mDNS printer model ${model}` });
    }
  } else if (has('_uscan._tcp') || has('_scanner._tcp')) {
    out.push({ category: 'printer', weight: 0.6, evidence: 'mDNS scanner service → printer / MFP' });
  }
  if (has('_googlecast._tcp')) out.push(...googlecastHints(txt));
  if (has('_sonos._tcp')) out.push({ category: 'speaker', model: 'Sonos', weight: 0.85, evidence: 'mDNS _sonos._tcp' });
  if (has('_spotify-connect._tcp')) out.push({ category: 'speaker', weight: 0.3, evidence: 'mDNS _spotify-connect._tcp (Spotify Connect)' });
  if (has('_amzn-wplay._tcp')) out.push({ category: 'media_player', os: 'android', model: 'Fire TV', weight: 0.6, evidence: 'mDNS _amzn-wplay._tcp → Fire TV' });
  if (has('_amzn-alexa._tcp')) out.push({ category: 'speaker', model: 'Amazon Echo', weight: 0.6, evidence: 'mDNS _amzn-alexa._tcp → Echo' });
  if (has('_googlezone._tcp')) out.push({ category: 'speaker', weight: 0.35, evidence: 'mDNS _googlezone._tcp (Google speaker group)' });
  if (has('_hap._tcp') || has('_homekit._tcp')) {
    if (ctx.apple) {
      out.push({ weight: 0.05, evidence: 'mDNS _hap._tcp (HomeKit)' });
    } else {
      const ci = Number(txt.ci);
      const cat = HAP_CATEGORY[ci] || 'smart_home';
      const category = cat === 'router' && !ctx.gateway ? 'access_point' : cat;
      out.push({ category, weight: 0.65, evidence: `mDNS _hap._tcp → HomeKit accessory${ci ? ` (category ${ci})` : ''}` });
    }
  }
  if (has('_matter._tcp') && !ctx.apple) out.push({ category: 'smart_home', weight: 0.45, evidence: 'mDNS _matter._tcp → Matter device' });
  if (has('_hue._tcp')) out.push({ category: 'smart_home', model: 'Philips Hue Bridge', weight: 0.85, evidence: 'mDNS _hue._tcp → Hue bridge' });
  if (has('_esphomelib._tcp')) out.push({ category: 'smart_home', model: 'ESPHome device', weight: 0.85, evidence: 'mDNS _esphomelib._tcp → ESPHome' });
  if (has('_mi-connect._udp') || has('_miio._udp')) out.push({ category: 'smart_home', weight: 0.5, evidence: 'mDNS Xiaomi IoT service' });
  if (has('_home-assistant._tcp')) out.push({ category: 'server', os: 'linux', model: 'Home Assistant', weight: 0.8, evidence: 'mDNS _home-assistant._tcp → Home Assistant' });
  if (has('_workstation._tcp')) out.push({ category: 'computer', os: 'linux', weight: 0.45, evidence: 'mDNS _workstation._tcp → Linux (Avahi)' });
  if (has('_rfb._tcp') && !ctx.apple) out.push({ category: 'computer', weight: 0.3, evidence: 'mDNS _rfb._tcp (screen sharing)' });
  if (has('_nvstream._tcp')) out.push({ category: 'computer', os: 'windows', weight: 0.4, evidence: 'mDNS _nvstream._tcp (GameStream host)' });
  if (has('_adisk._tcp') && !ctx.appleComputer) out.push({ category: 'nas', weight: 0.35, evidence: 'mDNS _adisk._tcp (Time Machine disk)' });
  if (has('_afpovertcp._tcp') && !ctx.apple) out.push({ category: 'nas', weight: 0.2, evidence: 'mDNS _afpovertcp._tcp (AFP)' });
  if (has('_smb._tcp') && !ctx.apple) out.push({ category: 'nas', weight: 0.15, evidence: 'mDNS _smb._tcp (file sharing)' });
  if (has('_apple-mobdev2._tcp')) out.push({ category: 'phone', os: 'ios', weight: 0.5, evidence: 'mDNS _apple-mobdev2._tcp → iPhone / iPad' });
  if (has('_androidtvremote2._tcp') || has('_androidtvremote._tcp')) {
    out.push({ category: 'tv', os: 'android', weight: 0.55, evidence: 'mDNS _androidtvremote2._tcp → Android TV / Google TV' });
    out.push({ category: 'media_player', os: 'android', weight: 0.45, evidence: 'mDNS _androidtvremote2._tcp → Android TV / Google TV' });
  }
  if (has('_viziocast._tcp')) out.push({ category: 'tv', model: 'Vizio SmartCast TV', weight: 0.75, evidence: 'mDNS _viziocast._tcp → Vizio TV' });
  if (has('_airport._tcp')) out.push({ category: 'access_point', model: 'AirPort base station', weight: 0.8, evidence: 'mDNS _airport._tcp → AirPort base station' });
  if (has('_axis-video._tcp')) out.push({ category: 'camera', weight: 0.8, evidence: 'mDNS _axis-video._tcp → IP camera' });
  if (has('_rtsp._tcp') && !ctx.apple) out.push({ category: 'camera', weight: 0.35, evidence: 'mDNS _rtsp._tcp (video stream)' });
  if (has('_qdiscover._tcp')) out.push({ category: 'nas', os: 'linux', model: 'QNAP NAS', weight: 0.85, evidence: 'mDNS _qdiscover._tcp → QNAP NAS' });
  const asustor = [...services].find((s) => /^_asustor/i.test(s));
  if (asustor) out.push({ category: 'nas', os: 'linux', model: txt.model ? `ASUSTOR ${txt.model}` : 'ASUSTOR NAS', weight: 0.85, evidence: `mDNS ${asustor} → ASUSTOR NAS` });
  if (/synology/i.test(txt.vendor || '')) out.push({ category: 'nas', os: 'linux', model: txt.model ? `Synology ${txt.model}` : 'Synology NAS', weight: 0.85, evidence: 'mDNS vendor=Synology → NAS' });
  if ((has('_airplay._tcp') || has('_raop._tcp')) && !ctx.apple) {
    out.push({ category: 'speaker', weight: 0.2, evidence: 'mDNS _airplay._tcp (AirPlay receiver)' });
    out.push({ category: 'tv', weight: 0.15, evidence: 'mDNS _airplay._tcp (AirPlay receiver)' });
  }
  if (has('_sleep-proxy._udp')) out.push({ category: 'media_player', weight: 0.2, evidence: 'mDNS _sleep-proxy._udp (Bonjour sleep proxy)' });
  if (has('_companion-link._tcp')) out.push({ weight: 0.3, evidence: 'mDNS _companion-link._tcp → Apple device' });
  if (has('_ssh._tcp') && !ctx.apple) out.push({ category: 'server', weight: 0.1, evidence: 'mDNS _ssh._tcp (SSH)' });
  return out;
}

// Services that carry no type information on their own (not listed as generic evidence).
const QUIET_SERVICES = new Set(['_http._tcp', '_https._tcp', '_device-info._tcp', '_sftp-ssh._tcp', '_asquic._udp',
  '_raop._tcp', '_airplay._tcp', '_ssh._tcp', '_smb._tcp', '_companion-link._tcp', '_printer._tcp', '_ipps._tcp',
  '_pdl-datastream._tcp', '_ipp._tcp']);

// ---------------------------------------------------------------------------
// UPnP -> hints
// ---------------------------------------------------------------------------

const GENERIC_UPNP_MODEL = /^(wireless router|router|gateway|access point|wi-?fi protected setup router|wps access point|media renderer|mediarenderer|media server|ipc|ipcamera|network camera|basic|upnp device|linux|default|none|n\/a)$/i;

// Factory-default friendly names that say nothing about the specific device.
const GENERIC_UPNP_NAME = /^(wireless router|router|gateway|wps access point|access point|wi-?fi router|media renderer|media server|upnp device|internet gateway device|igd|basic device|linux|ipc)$/i;

/** Friendly model string from a UPnP description. */
export function upnpModel(upnp) {
  if (!upnp) return null;
  let model = null;
  if (upnp.modelName && !GENERIC_UPNP_MODEL.test(upnp.modelName.trim())) model = upnp.modelName.trim();
  else if (upnp.modelNumber && !GENERIC_UPNP_MODEL.test(upnp.modelNumber.trim())) model = upnp.modelNumber.trim();
  if (!model) return null;
  const maker = shortVendor(upnp.manufacturer);
  // Bare codes ("AX1500", "IPC-HDW2439T") read better with the brand in front.
  if (maker && !/\s/.test(model) && !model.toLowerCase().includes(maker.toLowerCase()) && !/^\[/.test(model)) {
    model = `${maker} ${model}`;
  }
  return model.length > 48 ? `${model.slice(0, 47)}…` : model;
}

function upnpHints(upnp, ctx) {
  if (!upnp) return [];
  const out = [];
  const types = [upnp.deviceType, ...(upnp.deviceTypes || [])].filter(Boolean).join(' ');
  const fname = upnp.friendlyName || '';
  const desc = `${fname} ${upnp.manufacturer || ''} ${upnp.modelName || ''} ${upnp.modelDescription || ''}`;
  const model = upnpModel(upnp);

  if (/InternetGatewayDevice/i.test(types)) {
    if (ctx.gateway) out.push({ category: 'router', weight: 0.8, evidence: 'UPnP InternetGatewayDevice' });
    else out.push({ category: 'access_point', weight: 0.75, evidence: 'UPnP InternetGatewayDevice on non-gateway → mesh node / secondary router' });
  }
  if (/WLANAccessPointDevice/i.test(types)) {
    out.push({ category: ctx.gateway ? 'router' : 'access_point', weight: 0.8, evidence: 'UPnP WLANAccessPointDevice' });
  }
  if (/WFADevice/i.test(types)) {
    out.push({ category: ctx.gateway ? 'router' : 'access_point', weight: 0.6, evidence: 'UPnP Wi-Fi Protected Setup device → Wi-Fi router / AP' });
  }
  if (/ZonePlayer/i.test(types)) {
    out.push({ category: 'speaker', model, weight: 0.85, evidence: `UPnP ZonePlayer${model ? ` model ${model}` : ''}` });
  }
  if (/MediaRenderer/i.test(types) && !/ZonePlayer/i.test(types)) {
    const ev = `UPnP MediaRenderer "${fname || model || 'unnamed'}"`;
    if (/sonos/i.test(desc)) out.push({ category: 'speaker', model, weight: 0.8, evidence: ev });
    else if (/roku/i.test(desc) && !/\btv\b/i.test(desc)) out.push({ category: 'media_player', model, weight: 0.8, evidence: ev });
    else if (TV_BRANDS.test(desc)) out.push({ category: 'tv', model, weight: 0.8, evidence: ev });
    else if (ctx.appleComputer || ctx.windows) out.push({ weight: 0.05, evidence: ev });
    else {
      out.push({ category: 'media_player', model, weight: 0.5, evidence: ev });
      out.push({ category: 'tv', weight: 0.4, evidence: ev });
    }
  }
  if (/dial-multiscreen/i.test(types) && !/MediaRenderer/i.test(types)) {
    out.push({ category: 'media_player', weight: 0.45, evidence: 'UPnP DIAL (cast target)' });
    out.push({ category: 'tv', weight: 0.4, evidence: 'UPnP DIAL (cast target)' });
  }
  if (/MediaServer/i.test(types) && !/MediaRenderer|InternetGatewayDevice/i.test(types)) {
    out.push({ category: 'nas', weight: 0.35, evidence: 'UPnP MediaServer' });
    out.push({ category: 'server', weight: 0.25, evidence: 'UPnP MediaServer' });
  }
  if (/:device:Printer/i.test(types)) out.push({ category: 'printer', model, weight: 0.85, evidence: 'UPnP Printer' });
  if (/hue bridge|philips hue/i.test(desc)) out.push({ category: 'smart_home', model: 'Philips Hue Bridge', weight: 0.85, evidence: 'UPnP Philips Hue bridge' });
  if (/\b(ipc|ip ?camera|network camera|nvr|dvr)\b|^ipc-/i.test(`${upnp.modelName || ''} ${upnp.modelDescription || ''} ${fname}`)) {
    out.push({ category: 'camera', weight: 0.7, evidence: `UPnP camera model ${upnp.modelName || fname}` });
  }

  // Manufacturer acts like a vendor hint (useful when the OUI is unknown or randomized).
  if (upnp.manufacturer && shortVendor(upnp.manufacturer) !== shortVendor(ctx.vendor)) {
    for (const h of vendorHints(upnp.manufacturer)) {
      out.push({ ...h, weight: Math.min(0.7, h.weight + 0.1), evidence: h.evidence.replace(/^Vendor/, 'UPnP manufacturer') });
    }
  }

  // Model string attached to whichever category the device ends up in.
  if (model && !out.some((h) => h.model)) out.push({ model, weight: 0.6, evidence: `UPnP model ${model}` });

  const servers = (upnp.servers && upnp.servers.length ? upnp.servers : [upnp.server]).filter(Boolean).join(' ');
  if (/windows/i.test(servers)) out.push({ os: 'windows', weight: 0.5, evidence: 'UPnP server header Windows' });
  else if (/darwin|mac ?os/i.test(servers)) out.push({ os: 'macos', weight: 0.4, evidence: 'UPnP server header macOS' });
  return out;
}

// ---------------------------------------------------------------------------
// Ports -> hints
// ---------------------------------------------------------------------------

function portHints(ports, ctx) {
  if (!ports || ports.size === 0) return [];
  const out = [];
  const has = (p) => ports.has(p);
  if (has(62078)) {
    out.push({ category: 'phone', os: 'ios', weight: 0.7, evidence: 'Port 62078 open → iOS' });
    out.push({ category: 'tablet', weight: 0.2, evidence: 'Port 62078 open → iOS' });
  }
  if (has(3389)) out.push({ category: 'computer', os: 'windows', weight: 0.5, evidence: 'Port 3389 open (Remote Desktop)' });
  if (has(445)) {
    if (has(139) && !ctx.apple && !ctx.samba) out.push({ category: 'computer', os: 'windows', weight: 0.5, evidence: 'Port 445 open (SMB)' });
    else if (ctx.apple && !has(62078)) out.push({ os: 'macos', weight: 0.35, evidence: 'Port 445 open on Apple device → Mac file sharing' });
    else out.push({ weight: 0.1, evidence: 'Port 445 open (SMB)' });
  }
  if (has(548)) {
    if (ctx.nasVendor) out.push({ category: 'nas', weight: 0.3, evidence: 'Port 548 open (AFP)' });
    else out.push({ os: 'macos', weight: 0.4, evidence: 'Port 548 open (AFP)' });
  }
  if (has(9100)) out.push({ category: 'printer', weight: 0.7, evidence: 'Port 9100 open (raw printing)' });
  if (has(631)) {
    if (ctx.appleComputer) out.push({ weight: 0.05, evidence: 'Port 631 open (IPP)' });
    else out.push({ category: 'printer', weight: has(9100) ? 0.5 : 0.4, evidence: 'Port 631 open (IPP)' });
  }
  if (has(1400)) out.push({ category: 'speaker', model: 'Sonos', weight: 0.7, evidence: 'Port 1400 open (Sonos)' });
  if (has(8060)) out.push({ category: 'media_player', model: 'Roku', weight: 0.7, evidence: 'Port 8060 open (Roku ECP)' });
  if (has(8008) || has(8009)) {
    out.push({ category: 'media_player', weight: 0.6, evidence: `Port ${has(8009) ? 8009 : 8008} open (Google Cast)` });
  }
  if (has(7000)) {
    // The macOS AirPlay receiver (on by default since Monterey) listens on 5000 + 7000; iPhones never
    // listen on 7000 and always have the lockdown port 62078.
    if (ctx.apple && !has(62078) && has(5000)) {
      out.push({ category: 'computer', os: 'macos', weight: 0.5, evidence: 'AirPlay receiver (5000 + 7000) without iOS lockdown port → Mac' });
      if (ctx.randomizedMac) out.push({ category: 'laptop', weight: 0.2, evidence: '' });
    } else if (ctx.apple && !has(62078)) {
      out.push({ os: 'macos', weight: 0.25, evidence: 'AirPlay receiver (7000) without iOS lockdown port → likely Mac' });
    } else {
      out.push({ weight: 0.05, evidence: 'Port 7000 open (AirPlay)' });
    }
  }
  if (has(5001)) out.push({ category: 'nas', weight: 0.45, evidence: 'Port 5001 open (Synology DSM)' });
  else if (has(5000) && !has(7000) && !ctx.apple) out.push({ category: 'nas', weight: 0.2, evidence: 'Port 5000 open (DSM / UPnP)' });
  ctx.webOrDns = has(53) || has(80) || has(443) || has(8080);
  if (has(32400)) {
    out.push({ category: 'server', weight: 0.4, evidence: 'Port 32400 open (Plex)' });
    out.push({ category: 'nas', weight: 0.25, evidence: 'Port 32400 open (Plex)' });
  }
  if (has(22) && !ctx.apple) out.push({ category: 'server', os: 'linux', weight: 0.15, evidence: 'Port 22 open (SSH)' });
  if (!ctx.gateway && has(53)) {
    const web = has(80) || has(443);
    if (web && (ctx.networkVendor || ctx.upnpNetwork)) {
      out.push({ category: 'access_point', weight: 0.75, evidence: 'DNS + web admin on non-gateway → mesh node / secondary router' });
    } else {
      out.push({ category: 'server', weight: 0.2, evidence: 'Port 53 open (DNS server)' });
      out.push({ category: 'access_point', weight: 0.15, evidence: 'Port 53 open (DNS server)' });
    }
  }
  if ((has(80) || has(443) || has(8080)) && out.length === 0 && !ctx.webIdentified) {
    out.push({ weight: 0.05, evidence: `Web interface (port ${has(80) ? 80 : has(443) ? 443 : 8080})` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// classify()
// ---------------------------------------------------------------------------

const JUNK_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-|^[0-9a-f]{12,}$|^[0-9A-F]{12}@/i;

function collectNames({ hostname, mdns, upnp, netbiosName }) {
  // Ordered best first: real host names before descriptive names.
  const list = [];
  const seen = new Set();
  const push = (name, source) => {
    if (list.length >= 16 || typeof name !== 'string' || name.length > 256) return;
    const clean = cleanHostname(name || '');
    if (!clean || clean.length > 64 || JUNK_NAME.test(clean)) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ name: clean, source });
  };
  if (hostname) push(hostname, 'Hostname');
  if (mdns?.hostname) push(mdns.hostname, 'Hostname');
  if (netbiosName) push(netbiosName, 'NetBIOS name');
  if (mdns?.txt?.fn) push(mdns.txt.fn, 'Cast name');
  if (upnp?.friendlyName && !GENERIC_UPNP_NAME.test(upnp.friendlyName.trim())) push(upnp.friendlyName, 'UPnP name');
  for (const n of (mdns?.instanceNames || []).slice(0, 8)) push(n, 'mDNS name');
  return list;
}

/**
 * Pure classifier. See PLAN.md §2.6 for the input/output contract.
 * Optional extra inputs: platform (self OS), selfModel (sysctl hw.model),
 * netbiosSamba (bool), activeProbed (bool), now (ISO string).
 */
export function classify(input = {}) {
  const {
    ip = null, hostname = null, vendor = null, isGateway = false, isSelf = false,
    randomizedMac = false, ttl = null, openPorts = null, mdns = null, upnp = null, netbiosName = null,
    platform = null, selfModel = null, netbiosSamba = false, activeProbed = false, now = null, http = null,
  } = input || {};

  const hints = [];
  const add = (h, source = null) => { if (h && typeof h.weight === 'number') hints.push({ ...h, source }); };
  const services = new Set((mdns?.services || []).map((s) => normalizeService(s) || s));
  const txt = Object.fromEntries(Object.entries(mdns?.txt || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const ports = Array.isArray(openPorts) ? new Set(openPorts) : null;

  // --- Apple model id (strongest single passive signal) -------------------
  const modelCandidates = [mdns?.model, isSelf ? selfModel : null].filter(Boolean);
  let apple = null;
  let appleId = null;
  for (const id of modelCandidates) {
    const info = appleModelInfo(id);
    if (info) { apple = info; appleId = id; break; }
  }
  // Apple-only services, or AirPlay-family services on a device with no known (third-party) vendor.
  const appleServices = services.has('_companion-link._tcp') || services.has('_apple-mobdev2._tcp')
    || (['_airplay._tcp', '_raop._tcp', '_apple-midi._udp', '_asquic._udp'].some((s) => services.has(s)) && (randomizedMac || !vendor));
  const ctx = {
    gateway: !!isGateway,
    vendor,
    apple: !!apple || isAppleVendor(vendor) || appleServices,
    appleComputer: !!apple && (apple.os === 'macos'),
    samba: !!netbiosSamba,
    nasVendor: /synology|qnap|asustor|western digital|terramaster/i.test(vendor || ''),
    networkVendor: isNetworkVendor(vendor) || isNetworkVendor(upnp?.manufacturer),
    upnpNetwork: /InternetGatewayDevice|WLANAccessPointDevice|WFADevice/i.test([upnp?.deviceType, ...(upnp?.deviceTypes || [])].join(' ')),
    windows: false,
    randomizedMac: !!randomizedMac,
  };
  const webHints = httpHints(http, ctx);
  ctx.webIdentified = webHints.length > 0;
  if (webHints.some((h) => h.category === 'access_point' || (isGateway && h.category === 'router'))) ctx.upnpNetwork = true;

  // --- Self / gateway -------------------------------------------------------
  if (isSelf) {
    const selfCategory = apple && (apple.category === 'laptop' || apple.category === 'computer') ? apple.category : 'computer';
    add({ category: selfCategory, os: PLATFORM_OS[platform] || undefined, weight: 0.6, evidence: 'This computer' }, 'self');
  }
  if (isGateway) add({ category: 'router', weight: 0.95, evidence: 'Default gateway → router' }, 'gateway');

  if (apple) {
    const src = mdns?.model === appleId ? 'mDNS model' : 'System model';
    add({ category: apple.category, os: apple.os, model: apple.name, weight: 0.9, evidence: `${src} ${appleId} → ${apple.name}` }, 'mdns');
  } else if (mdns?.model && FAKE_APPLE_ICON.test(mdns.model)) {
    // Samba / NAS servers borrow an Apple icon for Time Machine ("Xserve", "RackMac", "MacSamba").
    add({ category: 'nas', weight: 0.4, evidence: `mDNS device-info model ${mdns.model} → Samba / NAS server` }, 'mdns');
  } else if (mdns?.model && !isAppleModelId(mdns.model)) {
    add({ model: mdns.model, weight: 0.4, evidence: `mDNS model ${mdns.model}` }, 'mdns');
  }
  if (!apple && txt.osxvers) add({ category: 'computer', os: 'macos', weight: 0.6, evidence: 'mDNS device-info osxvers → macOS' }, 'mdns');

  // --- mDNS services ---------------------------------------------------------
  for (const h of mdnsServiceHints(services, txt, ctx)) add(h, 'mdns');
  if (!apple && txt.model && !isAppleModelId(txt.model) && !hints.some((h) => h.model)) {
    add({ model: txt.model, weight: 0.45, evidence: `mDNS model ${txt.model}` }, 'mdns');
  }
  let generic = 0;
  for (const s of [...services].sort()) {
    if (QUIET_SERVICES.has(s) || hints.some((h) => h.evidence.includes(s))) continue;
    if (generic++ >= 2) break;
    add({ weight: 0.02, evidence: `mDNS ${s}` }, 'mdns');
  }

  // --- NetBIOS ---------------------------------------------------------------
  let netbiosOsHint = null;
  if (netbiosName) {
    if (netbiosSamba) add({ os: 'linux', weight: 0.35, evidence: `NetBIOS name ${netbiosName} (Samba → Linux / NAS)` }, 'netbios');
    else if (ctx.apple || /^mac-[0-9a-f]{6}$/i.test(netbiosName)) add({ os: 'macos', weight: 0.2, evidence: `NetBIOS name ${netbiosName} (macOS file sharing)` }, 'netbios');
    else { add({ os: 'windows', weight: 0.45, evidence: `NetBIOS name ${netbiosName}` }, 'netbios'); netbiosOsHint = hints[hints.length - 1]; }
  }

  // --- UPnP ------------------------------------------------------------------
  ctx.windows = hints.some((h) => h.os === 'windows');
  for (const h of upnpHints(upnp, ctx)) add(h, 'upnp');

  // --- Names (DNS, mDNS, NetBIOS, UPnP, Cast) — strongest per category only ----
  const names = collectNames({ hostname, mdns, upnp, netbiosName });
  const bestByKey = new Map();
  names.forEach(({ name, source }, idx) => {
    const factor = source === 'Hostname' ? 1 : source === 'UPnP name' || source === 'mDNS name' ? 0.85 : 0.95;
    for (const h of hostnameHints(name)) {
      const key = h.category || `os:${h.os}`;
      const w = h.weight * factor;
      const prev = bestByKey.get(key);
      if (!prev || w > prev.weight + 1e-9) {
        // NetBIOS: name the actual machine ("NetBIOS name DESKTOP-8UO3KFS → Windows"), once.
        const arrow = h.evidence.indexOf('→');
        const evidence = source === 'NetBIOS name'
          ? `NetBIOS name ${name}${arrow >= 0 ? ` ${h.evidence.slice(arrow)}` : ''}`
          : h.evidence.replace(/^Hostname/, source);
        bestByKey.set(key, { ...h, weight: w, evidence, order: idx, fromNetbios: source === 'NetBIOS name' });
      }
    }
  });
  for (const h of bestByKey.values()) {
    if (h.fromNetbios && netbiosOsHint) netbiosOsHint.evidence = ''; // same fact: keep its OS weight only
    delete h.order; delete h.fromNetbios;
    add(h, 'name');
  }

  // --- Vendor ----------------------------------------------------------------
  const vh = vendorHints(vendor);
  for (const h of vh) add(h, 'vendor');

  // --- Randomized MAC ----------------------------------------------------------
  // On its own a private address is not enough to call a device a phone (Macs, Windows 11 and
  // Android TV randomize too): below the unknown threshold unless other evidence agrees.
  if (randomizedMac && !isSelf) {
    const ev = 'Private Wi-Fi address (phone, tablet or laptop)';
    add({ category: 'phone', weight: 0.22, evidence: ev }, 'mac');
    add({ category: 'tablet', weight: 0.12, evidence: ev }, 'mac');
    add({ category: 'laptop', weight: 0.12, evidence: ev }, 'mac');
  }

  // --- Ports + web banner (active) ---------------------------------------------
  for (const h of portHints(ports, ctx)) add(h, 'ports');
  for (const h of webHints) add(h, 'http');

  // A network-gear OUI with no DNS / web admin port (actively probed) is rarely an AP: TP-Link, D-Link,
  // Tenda ... sell far more smart plugs, bulbs and cameras than access points.
  const apEvidence = ctx.upnpNetwork || webHints.some((h) => h.category === 'access_point' || h.category === 'router');
  if (ports && activeProbed && !isGateway && !ctx.webOrDns && !apEvidence && isNetworkVendor(vendor)) {
    for (const h of hints) {
      if (h.source === 'vendor' && (h.category === 'router' || h.category === 'access_point')) {
        h.weight = Math.min(h.weight, 0.1);
        h.evidence = `Vendor ${shortVendor(vendor)} (no web / DNS admin port → not an access point)`;
      }
    }
    if (NET_VENDOR_WITH_IOT.test(vendor)) {
      add({ category: 'smart_home', weight: 0.3, evidence: `Vendor ${shortVendor(vendor)} without admin ports → smart plug / IoT` }, 'vendor');
    }
  }

  // --- TTL --------------------------------------------------------------------
  if (typeof ttl === 'number' && ttl > 0) {
    // Evidence shows the TTL actually measured (a router one hop away answers 63, not 64).
    if (ttl <= 64) add({ weight: 0.03, evidence: `TTL ${ttl} → Unix-like` }, 'ttl');
    else if (ttl <= 128) add({ category: 'computer', os: 'windows', weight: 0.3, evidence: `TTL ${ttl} → Windows` }, 'ttl');
    else {
      const ev = `TTL ${ttl} → embedded / network device`;
      add({ category: 'smart_home', weight: 0.15, evidence: ev }, 'ttl');
      add({ category: 'access_point', weight: 0.12, evidence: ev }, 'ttl');
      add({ category: 'network_switch', weight: 0.1, evidence: ev }, 'ttl');
      // lwIP-style stacks (ESP32 / Tuya smart plugs, bulbs) answer ping with TTL 255 and expose no TCP services.
      if (ports && ports.size === 0 && !isGateway) add({ category: 'smart_home', weight: 0.3, evidence: `TTL ${ttl} and no open ports → IoT device` }, 'ttl');
    }
  }

  // Non-gateway "router" evidence usually means a mesh node / AP: dampen router.
  if (!isGateway) for (const h of hints) if (h.category === 'router') h.weight *= 0.7;

  // --- OS scoring ---------------------------------------------------------------
  const osScores = scoreBy(hints, 'os');
  let [os, osScore] = best(osScores);
  if (osScore < OS_THRESHOLD) { os = null; osScore = 0; }

  // OS implies a category (internal hints, no evidence line).
  const implied = [];
  if (os && OS_IMPLIES[os] && !isGateway) {
    for (const [category, factor] of OS_IMPLIES[os]) implied.push({ category, weight: osScore * factor, evidence: '', source: 'os' });
  }

  // --- Category scoring -----------------------------------------------------------
  const catScores = scoreBy([...hints, ...implied], 'category');
  let ranked = [...catScores.entries()].sort((a, b) => b[1] - a[1] || CATEGORIES.indexOf(a[0]) - CATEGORIES.indexOf(b[0]));
  if (isGateway) {
    const rest = ranked.filter(([c]) => c !== 'router');
    ranked = [['router', Math.max(0.95, catScores.get('router') || 0)], ...rest];
  }
  let [category, score] = ranked[0] || ['unknown', 0];
  const runnerUp = ranked[1] ? ranked[1][1] : 0;
  let confidence;
  if (score < UNKNOWN_THRESHOLD) {
    category = 'unknown';
    confidence = Math.max(0.05, score);
  } else {
    confidence = score - runnerUp < 0.1 ? Math.max(0.05, score - 0.15) : score;
  }

  // --- OS resolution from category + vendor family --------------------------------
  if (!os && category !== 'unknown') {
    if (ctx.apple) {
      os = { phone: 'ios', tablet: 'ipados', laptop: 'macos', computer: 'macos', media_player: 'tvos' }[category] || null;
    } else if (isAndroidVendor(vendor) && (category === 'phone' || category === 'tablet')) {
      os = 'android';
    }
  }
  // An OS that contradicts the category (e.g. iOS on a printer) is dropped.
  if (os === 'ios' && !['phone', 'tablet', 'media_player', 'wearable'].includes(category)) os = category === 'unknown' ? os : null;
  if (os === 'ios' && category === 'tablet') os = 'ipados';
  if (os === 'ipados' && category === 'phone') os = 'ios';

  // --- Model ------------------------------------------------------------------------
  // Highest weight wins, but a more specific name that extends it ("Sonos" -> "Sonos One",
  // "iPhone" -> "iPhone 15 Pro") is preferred when it is nearly as strong.
  const modelHints = hints.filter((h) => h.model && (!h.category || h.category === category));
  let model = null;
  let modelWeight = -1;
  for (const h of modelHints) if (h.weight > modelWeight) { model = h.model; modelWeight = h.weight; }
  for (const h of modelHints) {
    if (model && h.model.length > model.length && h.weight >= modelWeight - 0.25
      && h.model.toLowerCase().startsWith(model.toLowerCase())) {
      model = h.model;
    }
  }

  // --- Manufacturer -------------------------------------------------------------------
  const manufacturer = upnp?.manufacturer
    || (apple || ctx.apple ? 'Apple' : null)
    || txt.usb_mfg || txt.manufacturer || txt.vendor
    || webHints.find((h) => h.manufacturer)?.manufacturer
    || (/^(ASUSTOR|Synology|QNAP)\b/i.exec(model || '')?.[1] ?? null);

  // --- Evidence (supporting the result first, strongest first) -------------------------
  const supports = (h) => (h.category && h.category === category) || (h.os && h.os === os);
  const evidence = [];
  const ordered = hints
    .filter((h) => h.evidence)
    .map((h, i) => ({ h, i, key: (supports(h) ? 2 : h.category || h.os ? 0 : 1) * 10 + h.weight }))
    .sort((a, b) => b.key - a.key || a.i - b.i);
  for (const { h } of ordered) {
    const text = clip(h.evidence, MAX_EVIDENCE_LEN);
    if (!evidence.includes(text)) evidence.push(text);
  }
  if (category === 'unknown' && !hints.some((h) => h.category && h.weight >= 0.15)) {
    evidence.unshift('No identifying services found');
  }
  if (!vendor && !manufacturer && !randomizedMac && !isSelf && !apple) {
    const at = evidence.findIndex((e) => /^TTL /.test(e));
    if (at >= 0) evidence.splice(at, 0, 'Vendor not recognized');
    else evidence.push('Vendor not recognized');
  }

  return {
    category,
    os: os || null,
    model: clip(model) || null,
    manufacturer: clip(manufacturer) || null,
    typeConfidence: round2(Math.min(1, Math.max(0, confidence))),
    typeEvidence: evidence.slice(0, MAX_EVIDENCE),
    hostnameHints: names.slice(0, MAX_HOSTNAME_HINTS).map((n) => n.name),
    signals: {
      ttl: typeof ttl === 'number' ? ttl : null,
      openPorts: ports ? [...ports].sort((a, b) => a - b) : null,
      mdnsServices: [...services].sort().slice(0, MAX_MDNS_SERVICES).map((x) => clip(x, 64)),
      mdnsModel: clip(mdns?.model || (isSelf && selfModel) || null),
      upnpDeviceType: clip(upnp?.deviceType || null),
      upnpFriendlyName: clip(upnp?.friendlyName || null),
      upnpModel: upnpModel(upnp),
      netbiosName: clip(netbiosName || null, 32),
      httpServer: clip(http?.server || null),
      httpTitle: clip(http?.title || null),
    },
    activeProbed: !!activeProbed,
    fingerprintedAt: now || new Date().toISOString(),
  };
}

function scoreBy(hints, key) {
  const buckets = new Map();
  for (const h of hints) {
    const v = h[key];
    if (!v) continue;
    if (!buckets.has(v)) buckets.set(v, []);
    buckets.get(v).push(h.weight);
  }
  const scores = new Map();
  for (const [v, ws] of buckets) scores.set(v, noisyOr(ws));
  return scores;
}

function best(scores) {
  let bk = null;
  let bv = 0;
  for (const [k, v] of scores) if (v > bv) { bk = k; bv = v; }
  return [bk, bv];
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

async function readSelfModel() {
  try {
    if (process.platform === 'darwin') {
      const out = await new Promise((resolve) => {
        execFile('sysctl', ['-n', 'hw.model'], { timeout: 2000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
      });
      return out.trim() || null;
    }
    if (process.platform === 'linux') {
      const name = (await readFile('/sys/class/dmi/id/product_name', 'utf8').catch(() => '')).trim();
      return name || null;
    }
  } catch { /* ignore */ }
  return null;
}

function resultKey(r) {
  return r ? `${r.category}|${r.os}|${r.model}|${r.manufacturer}|${r.hostnameHints[0] || ''}` : '';
}

export function createFingerprinter({
  getSettings, onResult, concurrency = 2, passiveBrowseMs = 300000, activeProbeMinIntervalMs = 3600000,
  getNetwork = null, isNetworkBusy = null,
} = {}) {
  let started = false;
  let browseTimer = null;
  let initialBrowse = null;
  let selfModel = null;
  let selfModelPromise = null;
  let mdns = null;
  let ssdp = null;
  // Resolves when stop() is called, so queued work does not wait on dead browsers.
  let signalStop = () => {};
  let stopped = Promise.resolve();

  const byIp = new Map(); // ip -> device
  const byMac = new Map(); // mac -> device
  const active = new Map(); // mac -> { at, ip, openPorts, netbios }
  const last = new Map(); // mac -> FingerprintResult
  const queue = [];
  const queued = new Map(); // mac -> task
  let running = 0;
  const passiveTimers = new Map(); // mac -> timer

  const currentNetwork = () => {
    try { return (typeof getNetwork === 'function' && getNetwork()) || null; } catch { return null; }
  };
  const busy = () => {
    try { return typeof isNetworkBusy === 'function' && Boolean(isNetworkBusy()); } catch { return false; }
  };

  function openBrowsers(net) {
    // Pin multicast to the monitored interface (VPNs / a non-en0 Wi-Fi would otherwise take the
    // kernel's multicast route) and only accept answers from that LAN.
    const opts = { onUpdate: onPassive, interfaceIp: net?.ip || null, cidr: net?.cidr || null, selfIp: net?.ip || null };
    mdns = createMdnsBrowser(opts);
    ssdp = createSsdpBrowser(opts);
    try { mdns.start(); } catch (err) { console.warn('[fingerprint] mDNS start failed:', err?.message || err); }
    try { ssdp.start(); } catch (err) { console.warn('[fingerprint] SSDP start failed:', err?.message || err); }
  }

  function closeBrowsers() {
    try { mdns?.stop(); } catch { /* ignore */ }
    try { ssdp?.stop(); } catch { /* ignore */ }
    mdns = null;
    ssdp = null;
  }

  const settings = () => {
    try { return (typeof getSettings === 'function' && getSettings()) || {}; } catch { return {}; }
  };
  const emit = (mac, result) => {
    if (!started) return;
    try { onResult?.(mac, result); } catch (err) { console.warn('[fingerprint] onResult failed:', err?.message || err); }
  };

  function inputFor(device, extra = {}) {
    const mac = device.mac;
    const a = active.get(mac);
    const useActive = settings().activeFingerprinting !== false && a && a.ip === device.ip;
    return {
      mac,
      ip: device.ip || null,
      hostname: device.hostname || null,
      vendor: device.vendor || null,
      isGateway: !!device.isGateway,
      isSelf: !!device.isSelf,
      randomizedMac: typeof device.randomizedMac === 'boolean' ? device.randomizedMac : isRandomized(mac),
      ttl: typeof device.ttl === 'number' ? device.ttl : null,
      openPorts: useActive ? a.openPorts : null,
      mdns: (device.ip && mdns?.get(device.ip)) || null,
      upnp: (device.ip && ssdp?.get(device.ip)) || null,
      netbiosName: useActive ? a.netbios?.name || null : null,
      netbiosSamba: useActive ? !!a.netbios?.samba : false,
      http: useActive ? a.http || null : null,
      platform: device.isSelf ? process.platform : null,
      selfModel: device.isSelf ? selfModel : null,
      activeProbed: !!useActive,
      ...extra,
    };
  }

  function safeClassify(device) {
    try {
      return classify(inputFor(device));
    } catch (err) {
      console.warn('[fingerprint] classify failed:', err?.message || err);
      return classify({ mac: device?.mac, ip: device?.ip });
    }
  }

  // Passive data arrived for an IP: re-classify if we already reported this device.
  function onPassive(ip) {
    const device = byIp.get(ip);
    if (!device || !last.has(device.mac) || queued.has(device.mac)) return;
    const mac = device.mac;
    if (passiveTimers.has(mac)) return;
    passiveTimers.set(mac, setTimeout(() => {
      passiveTimers.delete(mac);
      if (!started) return;
      const d = byMac.get(mac);
      if (!d) return;
      const result = safeClassify(d);
      if (resultKey(result) !== resultKey(last.get(mac))) {
        last.set(mac, result);
        emit(mac, result);
      }
    }, 1000));
  }

  async function browse() {
    if (!started) return;
    await Promise.all([
      mdns?.browseNow().catch(() => {}),
      ssdp?.searchNow().catch(() => {}),
    ]);
  }

  async function runTask(task) {
    const { device, force } = task;
    const mac = device.mac;
    try {
      if (initialBrowse) {
        let t;
        await Promise.race([initialBrowse, stopped, new Promise((r) => { t = setTimeout(r, 6000); })]);
        clearTimeout(t);
      }
      if (device.isSelf && selfModelPromise) await selfModelPromise;
      const s = settings();
      const prev = active.get(mac);
      const sinceLast = prev ? Date.now() - prev.at : Infinity;
      const forced = force && sinceLast > FORCE_MIN_INTERVAL_MS; // repeated "Re-detect" clicks reuse the last probe
      let wantActive = started && s.activeFingerprinting !== false && !device.isSelf && device.ip
        && (forced || !prev || prev.ip !== device.ip || sinceLast > activeProbeMinIntervalMs);
      // A running speed test saturates the link: 400 ms connect probes would time out and the weak
      // result would stick. Classify passively now (flagged degraded) and probe once the test is over.
      if (wantActive && busy()) { wantActive = false; task.degraded = true; }
      const jobs = [];
      if (started && device.ip && mdns && !mdns.get(device.ip)?.hostname) jobs.push(mdns.resolveIp(device.ip).catch(() => null));
      if (wantActive) {
        jobs.push((async () => {
          const [openPorts, netbios] = await Promise.all([
            probePorts(device.ip, { ports: DEFAULT_PORTS }).catch(() => []),
            queryNetbios(device.ip).catch(() => null),
          ]);
          const web = started ? await probeHttp(device.ip, openPorts).catch(() => null) : null;
          active.set(mac, { at: Date.now(), ip: device.ip, openPorts, netbios, http: web });
        })());
      }
      await Promise.all(jobs);
    } catch (err) {
      console.warn('[fingerprint] probe failed for', mac, err?.message || err);
    }
    const current = byMac.get(mac) || device;
    const result = safeClassify({ ...current, ...device, ip: device.ip || current.ip });
    if (task.degraded) result.degraded = true;
    last.set(mac, result);
    emit(mac, result);
    return result;
  }

  function pump() {
    while (running < Math.max(1, concurrency) && queue.length) {
      const task = queue.shift();
      running++;
      runTask(task)
        .catch((err) => {
          console.warn('[fingerprint] task failed:', err?.message || err);
          return safeClassify(task.device);
        })
        .then((result) => {
          queued.delete(task.device.mac);
          task.resolve(result);
        })
        .finally(() => {
          running--;
          pump();
        });
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      stopped = new Promise((r) => { signalStop = r; });
      openBrowsers(currentNetwork());
      selfModelPromise = readSelfModel().then((m) => { selfModel = m; }).catch(() => {});
      initialBrowse = browse().catch(() => {}).finally(() => { initialBrowse = null; });
      browseTimer = setInterval(() => { browse().catch(() => {}); }, Math.max(10000, passiveBrowseMs));
      browseTimer.unref?.();
    },

    stop() {
      if (!started) return;
      started = false;
      signalStop();
      clearInterval(browseTimer);
      browseTimer = null;
      for (const t of passiveTimers.values()) clearTimeout(t);
      passiveTimers.clear();
      closeBrowsers();
      initialBrowse = null;
    },

    /** The host moved to another network: rebind the mDNS/SSDP sockets to the new interface. */
    setNetwork(net) {
      byIp.clear();
      for (const t of passiveTimers.values()) clearTimeout(t);
      passiveTimers.clear();
      if (!started) return;
      closeBrowsers();
      openBrowsers(net || currentNetwork());
      initialBrowse = browse().catch(() => {}).finally(() => { initialBrowse = null; });
    },

    updateDevices(devices) {
      if (!Array.isArray(devices)) return;
      byIp.clear();
      for (const d of devices) {
        if (!d || !d.mac) continue;
        const prev = byMac.get(d.mac) || {};
        const merged = { ...prev, ...d };
        byMac.set(d.mac, merged);
        if (d.ip) byIp.set(d.ip, merged);
      }
    },

    fingerprint(device, { force = false } = {}) {
      if (!device || !device.mac) {
        return Promise.resolve(classify({ ...(device || {}) }));
      }
      const known = byMac.get(device.mac) || {};
      const merged = { ...known, ...device };
      byMac.set(device.mac, merged);
      if (merged.ip) byIp.set(merged.ip, merged);

      const existing = queued.get(device.mac);
      if (existing) {
        existing.device = merged;
        if (force) existing.force = true;
        return existing.promise;
      }
      const task = { device: merged, force: !!force };
      task.promise = new Promise((resolve) => { task.resolve = resolve; });
      queued.set(device.mac, task);
      queue.push(task);
      pump();
      return task.promise;
    },
  };
}

function isRandomized(mac) {
  const first = parseInt(String(mac || '').split(/[:-]/)[0], 16);
  return Number.isFinite(first) && (first & 0x02) !== 0;
}
