/**
 * Hostname / device-name heuristics. Works on DNS names, mDNS host and instance
 * names, NetBIOS names and UPnP friendly names. Each rule yields a Hint:
 *   { category?, os?, model?, weight (0..1), evidence }
 * Evidence strings start with "Hostname"; the orchestrator rewrites that prefix
 * when the name came from another source ("mDNS name", "NetBIOS name", ...).
 *
 * Rules are ordered most specific first; once a rule with `final: true` matches,
 * weaker generic rules for the same category are skipped.
 */

/** Strip DNS suffixes and normalise separators so patterns can stay simple. */
export function cleanHostname(name) {
  if (typeof name !== 'string') return '';
  return name
    .trim()
    .replace(/\.$/, '')
    .replace(/\.(local|lan|home|localdomain|home\.arpa|internal)$/i, '')
    .replace(/[’']/g, '');
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * Each rule: { re, hints: (match, name) => Hint[] }.
 * `re` is tested against the cleaned name. Keep regexes anchored or bounded by
 * separators where a bare substring would cause false positives.
 */
const RULES = [
  // --- Apple ---------------------------------------------------------------
  { re: /iphone/i, hints: () => [{ category: 'phone', os: 'ios', model: 'iPhone', weight: 0.75, evidence: 'Hostname contains iPhone' }] },
  { re: /ipad/i, hints: () => [{ category: 'tablet', os: 'ipados', model: 'iPad', weight: 0.75, evidence: 'Hostname contains iPad' }] },
  { re: /macbook[-_ ]?pro/i, hints: () => [{ category: 'laptop', os: 'macos', model: 'MacBook Pro', weight: 0.75, evidence: 'Hostname contains MacBook Pro' }] },
  { re: /macbook[-_ ]?air/i, hints: () => [{ category: 'laptop', os: 'macos', model: 'MacBook Air', weight: 0.75, evidence: 'Hostname contains MacBook Air' }] },
  { re: /macbook/i, hints: () => [{ category: 'laptop', os: 'macos', model: 'MacBook', weight: 0.7, evidence: 'Hostname contains MacBook' }] },
  { re: /(^|[^a-z])imac/i, hints: () => [{ category: 'computer', os: 'macos', model: 'iMac', weight: 0.7, evidence: 'Hostname contains iMac' }] },
  { re: /mac[-_ ]?mini/i, hints: () => [{ category: 'computer', os: 'macos', model: 'Mac mini', weight: 0.7, evidence: 'Hostname contains Mac mini' }] },
  { re: /mac[-_ ]?studio/i, hints: () => [{ category: 'computer', os: 'macos', model: 'Mac Studio', weight: 0.7, evidence: 'Hostname contains Mac Studio' }] },
  { re: /^mac-[0-9a-f]{6}$/i, hints: () => [{ category: 'computer', os: 'macos', weight: 0.55, evidence: 'Hostname MAC-xxxxxx → macOS file sharing name' }] },
  { re: /apple[-_ ]?tv/i, hints: () => [{ category: 'media_player', os: 'tvos', model: 'Apple TV', weight: 0.75, evidence: 'Hostname contains Apple TV' }] },
  { re: /homepod/i, hints: () => [{ category: 'speaker', os: 'other', model: 'HomePod', weight: 0.75, evidence: 'Hostname contains HomePod' }] },
  { re: /apple[-_ ]?watch/i, hints: () => [{ category: 'wearable', os: 'other', model: 'Apple Watch', weight: 0.7, evidence: 'Hostname contains Apple Watch' }] },
  { re: /airport/i, hints: () => [{ category: 'access_point', weight: 0.6, model: 'AirPort', evidence: 'Hostname contains AirPort' }] },

  // --- Windows -------------------------------------------------------------
  { re: /^desktop-[a-z0-9]{5,8}$/i, hints: () => [{ category: 'computer', os: 'windows', weight: 0.75, evidence: 'Hostname DESKTOP-* → Windows' }] },
  { re: /^laptop-[a-z0-9]{5,8}$/i, hints: () => [{ category: 'laptop', os: 'windows', weight: 0.75, evidence: 'Hostname LAPTOP-* → Windows laptop' }] },
  { re: /^(win|win10|win11|windows)[-_]/i, hints: () => [{ category: 'computer', os: 'windows', weight: 0.55, evidence: 'Hostname WIN-* → Windows' }] },
  { re: /surface/i, hints: () => [{ category: 'laptop', os: 'windows', model: 'Surface', weight: 0.6, evidence: 'Hostname contains Surface' }] },

  // --- Android / other phones ----------------------------------------------
  { re: /galaxy[-_ ]?tab([-_ ]?([a-z]\d+\w*))?/i, hints: (m) => [{ category: 'tablet', os: 'android', model: m[2] ? `Galaxy Tab ${m[2].toUpperCase()}` : 'Galaxy Tab', weight: 0.75, evidence: 'Hostname Galaxy-Tab-* → Samsung tablet' }] },
  { re: /galaxy[-_ ]?watch/i, hints: () => [{ category: 'wearable', os: 'other', model: 'Galaxy Watch', weight: 0.7, evidence: 'Hostname Galaxy-Watch-* → smartwatch' }] },
  { re: /galaxy(?![-_ ]?(?:tab|watch|buds|book))([-_ ]?([a-z]\d+\w*))?/i, hints: (m) => [{ category: 'phone', os: 'android', model: m[2] ? `Galaxy ${m[2].toUpperCase()}` : 'Galaxy', weight: 0.7, evidence: 'Hostname Galaxy-* → Samsung phone' }] },
  { re: /^pixel[-_ ]?(tablet)/i, hints: () => [{ category: 'tablet', os: 'android', model: 'Pixel Tablet', weight: 0.75, evidence: 'Hostname Pixel-Tablet → Android tablet' }] },
  { re: /^pixel(?![-_ ]?tablet)[-_ ]?(\d+[a-z]?(?:[-_ ]?(?:pro|xl|fold|a))?)?(?=$|[-_ ])/i, hints: (m) => [{ category: 'phone', os: 'android', model: m[1] ? `Pixel ${m[1].replace(/[-_]/g, ' ').replace(/\b(pro|xl|fold)\b/gi, (w) => cap(w.toLowerCase()))}` : 'Pixel', weight: 0.75, evidence: 'Hostname Pixel-* → Android phone' }] },
  { re: /^sm-([tpx])\d+/i, hints: () => [{ category: 'tablet', os: 'android', weight: 0.6, evidence: 'Hostname SM-T/X* → Samsung tablet model' }] },
  { re: /^sm-[a-z]\d+/i, hints: () => [{ category: 'phone', os: 'android', weight: 0.6, evidence: 'Hostname SM-* → Samsung phone model' }] },
  { re: /^android[-_]?[0-9a-f]*/i, hints: () => [{ category: 'phone', os: 'android', weight: 0.6, evidence: 'Hostname android-* → Android device' }] },
  { re: /(^|[-_ ])(oneplus|redmi|xiaomi|poco|oppo|realme|huawei|honor|motorola|moto[-_ ]?g|nokia|nothing[-_ ]?phone|fairphone)([-_ ]|\d|$)/i, hints: (m) => [{ category: 'phone', os: 'android', weight: 0.6, evidence: `Hostname contains ${m[2]} → Android phone` }] },
  { re: /kindle/i, hints: () => [{ category: 'tablet', os: 'android', model: 'Kindle', weight: 0.65, evidence: 'Hostname contains Kindle' }] },
  { re: /chromebook|(^|[-_])penguin$/i, hints: () => [{ category: 'laptop', os: 'chromeos', model: 'Chromebook', weight: 0.65, evidence: 'Hostname contains Chromebook' }] },

  // --- TV / streaming / speakers --------------------------------------------
  { re: /lgwebostv|webos[-_ ]?tv/i, hints: () => [{ category: 'tv', os: 'other', model: 'LG webOS TV', weight: 0.8, evidence: 'Hostname LGwebOSTV → LG webOS TV' }] },
  { re: /chromecast/i, hints: () => [{ category: 'media_player', model: 'Chromecast', weight: 0.75, evidence: 'Hostname contains Chromecast' }] },
  { re: /google[-_ ]?tv/i, hints: () => [{ category: 'media_player', os: 'android', model: 'Google TV', weight: 0.7, evidence: 'Hostname contains Google TV' }] },
  { re: /nest[-_ ]?hub/i, hints: () => [{ category: 'smart_home', model: 'Nest Hub', weight: 0.7, evidence: 'Hostname contains Nest Hub' }] },
  { re: /google[-_ ]?home|nest[-_ ]?(mini|audio)/i, hints: () => [{ category: 'speaker', model: 'Google Nest speaker', weight: 0.7, evidence: 'Hostname contains Google Home / Nest' }] },
  { re: /roku/i, hints: () => [{ category: 'media_player', model: 'Roku', weight: 0.75, evidence: 'Hostname contains Roku' }] },
  { re: /fire[-_ ]?tv|^aft[a-z]{1,6}$/i, hints: () => [{ category: 'media_player', os: 'android', model: 'Fire TV', weight: 0.7, evidence: 'Hostname Fire TV' }] },
  { re: /(^|[-_ ])(echo|alexa)([-_ ]|$)|amazon[-_ ]?echo/i, hints: () => [{ category: 'speaker', model: 'Amazon Echo', weight: 0.65, evidence: 'Hostname contains Echo' }] },
  { re: /shield/i, hints: () => [{ category: 'media_player', os: 'android', model: 'NVIDIA Shield', weight: 0.6, evidence: 'Hostname contains Shield' }] },
  { re: /sonos/i, hints: () => [{ category: 'speaker', model: 'Sonos', weight: 0.75, evidence: 'Hostname contains Sonos' }] },
  { re: /bravia|vizio|hisense|tcl[-_ ]?tv|samsung[-_ ]?tv|(^|[-_ ])tizen|smart[-_ ]?tv|^tv[-_]|[-_]tv$|^\[tv\]/i, hints: () => [{ category: 'tv', weight: 0.6, evidence: 'Hostname looks like a smart TV' }] },

  // --- Consoles --------------------------------------------------------------
  { re: /^ps([345])([-_ ]|$)|playstation[-_ ]?([345])?/i, hints: (m) => [{ category: 'console', model: `PlayStation${m[1] || m[3] ? ` ${m[1] || m[3]}` : ''}`, weight: 0.75, evidence: 'Hostname PS* → PlayStation' }] },
  { re: /xbox/i, hints: () => [{ category: 'console', os: 'windows', model: 'Xbox', weight: 0.75, evidence: 'Hostname contains Xbox' }] },
  { re: /nintendo|^switch[-_]?[0-9a-f]{4,}/i, hints: () => [{ category: 'console', model: 'Nintendo Switch', weight: 0.7, evidence: 'Hostname Nintendo → console' }] },
  { re: /steamdeck|steam[-_]deck/i, hints: () => [{ category: 'console', os: 'linux', model: 'Steam Deck', weight: 0.7, evidence: 'Hostname contains Steam Deck' }] },

  // --- Printers ----------------------------------------------------------------
  { re: /^(hp|npi)[0-9a-f]{6}\b|laserjet|officejet|deskjet|envy[-_ ]?\d|designjet|pagewide/i, hints: () => [{ category: 'printer', model: null, weight: 0.7, evidence: 'Hostname looks like an HP printer' }] },
  { re: /^epson|^et-\d{4}|^xp-\d{3}/i, hints: () => [{ category: 'printer', weight: 0.7, evidence: 'Hostname looks like an Epson printer' }] },
  { re: /^br[nw][0-9a-f]{6,12}$|brother/i, hints: () => [{ category: 'printer', weight: 0.7, evidence: 'Hostname BRN*/BRW* → Brother printer' }] },
  { re: /canon|^mf\d{3}|pixma|imageclass|xerox|lexmark|kyocera|ricoh|^km[0-9a-f]{6}/i, hints: () => [{ category: 'printer', weight: 0.65, evidence: 'Hostname looks like a printer' }] },
  { re: /printer/i, hints: () => [{ category: 'printer', weight: 0.55, evidence: 'Hostname contains printer' }] },

  // --- Network gear -------------------------------------------------------------
  { re: /^eero|[-_ ]eero/i, hints: () => [{ category: 'access_point', model: 'eero', weight: 0.75, evidence: 'Hostname eero → mesh Wi-Fi' }] },
  { re: /(^|[-_ ])deco(?:[-_ ]?([a-z]{1,2}\d{1,3}[a-z]?))?(?=$|[-_ ])/i, hints: (m) => [{ category: 'access_point', model: m[2] ? `Deco ${m[2].toUpperCase()}` : 'Deco', weight: 0.75, evidence: 'Hostname Deco-* → TP-Link mesh Wi-Fi' }] },
  { re: /(^|[-_ ])orbi([-_ \d]|$)/i, hints: () => [{ category: 'access_point', model: 'Orbi', weight: 0.75, evidence: 'Hostname Orbi → Netgear mesh Wi-Fi' }] },
  { re: /velop/i, hints: () => [{ category: 'access_point', model: 'Velop', weight: 0.75, evidence: 'Hostname Velop → Linksys mesh Wi-Fi' }] },
  { re: /unifi|ubnt|^u6[-_]|^uap|^usw|^udm/i, hints: (m, name) => [/^usw/i.test(name)
    ? { category: 'network_switch', weight: 0.7, evidence: 'Hostname UniFi switch' }
    : { category: 'access_point', weight: 0.65, evidence: 'Hostname UniFi → Ubiquiti network gear' }] },
  { re: /extender|repeater|^re\d{3}|mesh|^ap[-_]|[-_]ap$|access[-_ ]?point/i, hints: () => [{ category: 'access_point', weight: 0.6, evidence: 'Hostname looks like a Wi-Fi extender / AP' }] },
  { re: /(?<!nintendo[-_ ]?)switch/i, hints: () => [{ category: 'network_switch', weight: 0.45, evidence: 'Hostname contains switch' }] },
  { re: /router|gateway|^rt-[a-z0-9]+|archer|nighthawk|fritz/i, hints: () => [{ category: 'router', weight: 0.5, evidence: 'Hostname looks like a router' }] },

  // --- NAS / servers -------------------------------------------------------------
  { re: /synology|diskstation|^ds\d{3,4}/i, hints: () => [{ category: 'nas', os: 'linux', model: 'Synology DiskStation', weight: 0.75, evidence: 'Hostname Synology → NAS' }] },
  { re: /qnap|^ts-\d{3}/i, hints: () => [{ category: 'nas', os: 'linux', model: 'QNAP', weight: 0.75, evidence: 'Hostname QNAP → NAS' }] },
  { re: /asustor|truenas|freenas|unraid|readynas|(^|[-_ ])nas([-_ ]|\d|$)/i, hints: () => [{ category: 'nas', weight: 0.65, evidence: 'Hostname looks like a NAS' }] },
  { re: /^pi\.?hole$|pihole/i, hints: () => [{ category: 'server', os: 'linux', model: 'Pi-hole', weight: 0.7, evidence: 'Hostname pi.hole → Pi-hole DNS server' }] },
  { re: /raspberrypi|^rpi\d*([-_]|$)|^pi\d*$|^pi[-_]/i, hints: () => [{ category: 'server', os: 'linux', model: 'Raspberry Pi', weight: 0.65, evidence: 'Hostname raspberrypi → Raspberry Pi' }] },
  { re: /homeassistant|home[-_]assistant|^hassio/i, hints: () => [{ category: 'server', os: 'linux', model: 'Home Assistant', weight: 0.7, evidence: 'Hostname Home Assistant' }] },
  { re: /proxmox|^pve\d*([-_]|$)|^srv|server|^nuc/i, hints: () => [{ category: 'server', weight: 0.45, evidence: 'Hostname looks like a server' }] },
  { re: /ubuntu|debian|fedora|archlinux|centos|manjaro|linux|^kali/i, hints: () => [{ category: 'computer', os: 'linux', weight: 0.5, evidence: 'Hostname contains a Linux distro name' }] },

  // --- Cameras / smart home -------------------------------------------------------
  { re: /hikvision|dahua|reolink|amcrest|wyze|arlo|(^|[-_ ])ring([-_ ]|$)|eufy|^ipc[-_]|^ipcam|camera|(^|[-_ ])cam([-_ \d]|$)|doorbell|blink/i, hints: () => [{ category: 'camera', weight: 0.6, evidence: 'Hostname looks like a camera' }] },
  { re: /^esp[-_]?[0-9a-f]{4,}|esp32|esp8266|tasmota|shelly|tuya|sonoff|wled|^wiz[-_]|philips[-_]?hue|^hue[-_]|smartthings|ecobee|nest[-_]?(thermostat|protect)|roomba|^wemo|^kasa|^hs\d{3}|^lifx|^myq/i, hints: () => [{ category: 'smart_home', weight: 0.65, evidence: 'Hostname looks like a smart-home device' }] },

  // --- Generic words (weak) ----------------------------------------------------------
  { re: /laptop|notebook|thinkpad|zenbook|vivobook|ideapad|latitude|xps|elitebook|probook|spectre|pavilion|inspiron|aspire|swift|predator|rog[-_ ]/i, hints: () => [{ category: 'laptop', weight: 0.5, evidence: 'Hostname suggests a laptop' }] },
  { re: /desktop|(^|[-_])pc([-_\d]|$)|workstation|optiplex|thinkcentre/i, hints: () => [{ category: 'computer', weight: 0.4, evidence: 'Hostname suggests a desktop PC' }] },
  { re: /tablet|(^|[-_])tab([-_]|$)/i, hints: () => [{ category: 'tablet', weight: 0.45, evidence: 'Hostname suggests a tablet' }] },
  { re: /phone/i, hints: () => [{ category: 'phone', weight: 0.4, evidence: 'Hostname contains phone' }] },
];

/**
 * Return hints for a single name. Generic rules are skipped for a category that
 * a more specific rule already matched, so the same name never double counts.
 */
export function hostnameHints(hostname) {
  const name = cleanHostname(hostname);
  if (!name) return [];
  const out = [];
  const seenCategories = new Set();
  for (const rule of RULES) {
    const m = rule.re.exec(name);
    if (!m) continue;
    let hints;
    try {
      hints = rule.hints(m, name) || [];
    } catch {
      continue;
    }
    for (const h of hints) {
      if (h.category && seenCategories.has(h.category)) continue;
      if (h.category) seenCategories.add(h.category);
      const hint = { weight: h.weight, evidence: h.evidence };
      if (h.category) hint.category = h.category;
      if (h.os) hint.os = h.os;
      if (h.model) hint.model = h.model;
      out.push(hint);
    }
  }
  return out;
}
