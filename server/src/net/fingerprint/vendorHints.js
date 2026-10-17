/**
 * Category / OS hints derived from the OUI vendor name (IEEE organisation name
 * as returned by net/oui.js lookupVendor, or a UPnP/mDNS manufacturer string).
 *
 * Generic multi-product vendors (Apple, Samsung, Google) only contribute a small
 * OS hint and an evidence line; single-purpose vendors (Sonos, Roku, printer
 * makers, NAS makers, camera makers) contribute a solid category hint.
 */

/** Short display name for a vendor, used in evidence ("Vendor TP-Link → network gear"). */
export function shortVendor(vendor) {
  if (typeof vendor !== 'string') return null;
  let v = vendor.trim();
  const KNOWN = [
    [/apple/i, 'Apple'], [/samsung/i, 'Samsung'], [/google/i, 'Google'], [/amazon/i, 'Amazon'],
    [/sonos/i, 'Sonos'], [/roku/i, 'Roku'], [/ubiquiti/i, 'Ubiquiti'], [/eero/i, 'eero'],
    [/tp-?link/i, 'TP-Link'], [/netgear/i, 'Netgear'], [/asustek/i, 'ASUSTek'], [/linksys/i, 'Linksys'],
    [/hewlett|^hp\b|hp inc/i, 'HP'], [/seiko epson|epson/i, 'Epson'], [/brother/i, 'Brother'],
    [/canon/i, 'Canon'], [/nintendo/i, 'Nintendo'], [/sony interactive/i, 'Sony Interactive'],
    [/microsoft/i, 'Microsoft'], [/synology/i, 'Synology'], [/qnap/i, 'QNAP'], [/hikvision/i, 'Hikvision'],
    [/dahua/i, 'Dahua'], [/espressif/i, 'Espressif'], [/raspberry/i, 'Raspberry Pi'], [/intel/i, 'Intel'],
    [/realtek/i, 'Realtek'], [/dell/i, 'Dell'], [/lenovo/i, 'Lenovo'], [/lg electronics|lg innotek/i, 'LG'],
    [/signify|philips lighting/i, 'Signify (Philips Hue)'], [/tenda/i, 'Tenda'], [/micro-star|msi/i, 'MSI'],
    [/xiaomi/i, 'Xiaomi'], [/huawei/i, 'Huawei'], [/tuya/i, 'Tuya'], [/asustor/i, 'ASUSTOR'],
  ];
  for (const [re, name] of KNOWN) if (re.test(v)) return name;
  v = v.replace(/[,.]?\s+(inc|ltd|llc|co|corp|corporation|limited|gmbh|ag|s\.?a|technologies|technology|electronics)\b.*$/i, '');
  return v.length > 32 ? `${v.slice(0, 32)}…` : v;
}

const NET_GEAR = ['router', 'access_point'];

/**
 * Rules: [regex, (short) => Hint[]]. Weight guidance (PLAN §2.6): vendor category
 * hints 0.3–0.6; generic vendors only imply OS.
 */
const RULES = [
  // Multi-product vendors: evidence + weak OS only.
  [/apple/i, () => [{ weight: 0.1, evidence: 'Vendor Apple' }]],
  [/samsung/i, () => [{ os: 'android', weight: 0.15, evidence: 'Vendor Samsung' }]],
  [/google/i, () => [{ os: 'android', weight: 0.15, evidence: 'Vendor Google' }]],
  [/amazon/i, () => [
    { category: 'speaker', weight: 0.35, evidence: 'Vendor Amazon → Echo / Fire TV' },
    { category: 'media_player', weight: 0.25, evidence: 'Vendor Amazon → Echo / Fire TV' },
  ]],

  // Single-purpose consumer electronics.
  [/sonos/i, () => [{ category: 'speaker', weight: 0.6, model: 'Sonos speaker', evidence: 'Vendor Sonos → speaker' }]],
  [/bose/i, () => [{ category: 'speaker', weight: 0.55, evidence: 'Vendor Bose → speaker' }]],
  [/roku/i, () => [{ category: 'media_player', weight: 0.6, model: 'Roku', evidence: 'Vendor Roku → streaming device' }]],
  [/nvidia/i, () => [{ category: 'media_player', weight: 0.3, evidence: 'Vendor NVIDIA' }, { category: 'computer', weight: 0.25, evidence: 'Vendor NVIDIA' }]],
  [/vizio|hisense|tcl|funai|sharp|panasonic|tp vision|skyworth|metz/i, (s) => [{ category: 'tv', weight: 0.5, evidence: `Vendor ${s} → TV` }]],
  [/lg electronics/i, () => [{ category: 'tv', weight: 0.35, evidence: 'Vendor LG Electronics' }]],
  [/sony interactive/i, () => [{ category: 'console', weight: 0.7, model: 'PlayStation', evidence: 'Vendor Sony Interactive → PlayStation' }]],
  [/^sony|sony (corporation|mobile|visual)/i, () => [{ category: 'tv', weight: 0.35, evidence: 'Vendor Sony' }]],
  [/nintendo/i, () => [{ category: 'console', weight: 0.7, model: 'Nintendo Switch', evidence: 'Vendor Nintendo → game console' }]],
  [/valve/i, () => [{ category: 'console', os: 'linux', weight: 0.5, model: 'Steam Deck', evidence: 'Vendor Valve → Steam Deck' }]],
  [/garmin|fitbit|whoop/i, (s) => [{ category: 'wearable', weight: 0.5, evidence: `Vendor ${s} → wearable` }]],

  // Network gear.
  [/ubiquiti|eero|tp-?link|netgear|linksys|aruba|meraki|arris|commscope|technicolor|sagemcom|tenda|mikrotik|routerboard|zyxel|d-link|ruckus|cambium|mercusys|actiontec|askey|sercomm|calix|nokia shanghai|zte|fiberhome|edgecore|cradlepoint|draytek|avm gmbh|plume design|amped wireless|buffalo|totolink|cudy|wavlink|gl technologies|peplink|juniper/i,
    (s) => NET_GEAR.map((category) => ({ category, weight: 0.35, evidence: `Vendor ${s} → network gear` }))],
  [/cisco/i, () => [
    { category: 'network_switch', weight: 0.3, evidence: 'Vendor Cisco → network gear' },
    { category: 'router', weight: 0.3, evidence: 'Vendor Cisco → network gear' },
    { category: 'access_point', weight: 0.25, evidence: 'Vendor Cisco → network gear' },
  ]],
  [/huawei/i, () => [
    { category: 'router', weight: 0.25, evidence: 'Vendor Huawei' },
    { category: 'phone', os: 'android', weight: 0.25, evidence: 'Vendor Huawei' },
  ]],
  [/asustek/i, () => [
    { category: 'computer', weight: 0.3, evidence: 'Vendor ASUSTek' },
    { category: 'router', weight: 0.2, evidence: 'Vendor ASUSTek' },
    { category: 'access_point', weight: 0.2, evidence: 'Vendor ASUSTek' },
  ]],

  // Printers.
  [/hewlett|^hp\b|hp inc/i, () => [
    { category: 'printer', weight: 0.45, evidence: 'Vendor HP' },
    { category: 'computer', weight: 0.25, evidence: 'Vendor HP' },
  ]],
  [/epson|brother|canon|xerox|lexmark|kyocera|ricoh|konica|zebra technologies|oki electric|dymo/i,
    (s) => [{ category: 'printer', weight: 0.6, evidence: `Vendor ${s} → printer` }]],

  // NAS.
  [/synology|qnap|asustor|western digital|buffalo nas|drobo|terramaster|ugreen/i,
    (s) => [{ category: 'nas', os: 'linux', weight: 0.6, evidence: `Vendor ${s} → NAS` }]],

  // Cameras.
  [/hikvision|dahua|wyze|ring llc|arlo|reolink|axis communications|amcrest|eufy|anker|uniview|ezviz|lorex|swann|foscam|imou|hanwha|vivotek|tp-link.*tapo/i,
    (s) => [{ category: 'camera', weight: 0.6, evidence: `Vendor ${s} → camera` }]],

  // Smart home / IoT modules.
  [/espressif|tuya|shelly|allterco|signify|philips lighting|lifx|ecobee|irobot|ecovacs|lutron|smartthings|belkin|broadlink|sengled|wiz connected|nest labs|chamberlain|rachio|wemo|meross|govee|aqara|lumi united|switchbot|wonderlabs|leviton|ikea|bosch|ezlo|hunter douglas|resideo|honeywell home|beken|bouffalo|silicon labs|texas instruments|nordic semi|realtek semiconductor.*iot|hui zhou gaoshengda|shenzhen.*iot/i,
    (s) => [{ category: 'smart_home', weight: 0.5, evidence: `Vendor ${s} → smart-home / IoT` }]],
  [/xiaomi/i, () => [
    { category: 'phone', os: 'android', weight: 0.3, evidence: 'Vendor Xiaomi' },
    { category: 'smart_home', weight: 0.25, evidence: 'Vendor Xiaomi' },
  ]],

  // Phones (Android OEMs).
  [/oneplus|oppo|vivo mobile|realme|motorola mobility|hmd global|nothing technology|fairphone|honor device|lenovo mobile|zte mobile|tcl communication|hmd/i,
    (s) => [{ category: 'phone', os: 'android', weight: 0.4, evidence: `Vendor ${s} → Android phone` }]],

  // Computers / NIC makers.
  [/raspberry/i, () => [{ category: 'server', os: 'linux', weight: 0.5, model: 'Raspberry Pi', evidence: 'Vendor Raspberry Pi → Linux board' }]],
  [/microsoft/i, () => [
    { category: 'computer', os: 'windows', weight: 0.3, evidence: 'Vendor Microsoft' },
    { category: 'console', weight: 0.2, evidence: 'Vendor Microsoft' },
  ]],
  [/intel corporate|intel corp|^intel/i, () => [
    { category: 'computer', weight: 0.3, evidence: 'Vendor Intel → PC network adapter' },
    { category: 'laptop', weight: 0.25, evidence: 'Vendor Intel → PC network adapter' },
  ]],
  [/realtek|dell|lenovo|micro-star|msi|gigabyte|giga-byte|asrock|framework|acer|liteon|lite-on|azurewave|rivet networks|killer|qualcomm atheros|mediatek|murata|hon hai|foxconn|wistron|quanta|compal|pegatron|clevo|tongfang|elitegroup|biostar/i,
    (s) => [{ category: 'computer', weight: 0.3, evidence: `Vendor ${s} → PC hardware` }]],
];

/** Hints implied by a vendor string. Returns [] for null / unrecognised vendors. */
export function vendorHints(vendor) {
  if (typeof vendor !== 'string' || !vendor.trim()) return [];
  const s = shortVendor(vendor);
  const out = [];
  for (const [re, make] of RULES) {
    if (!re.test(vendor)) continue;
    for (const h of make(s)) out.push({ ...h });
    break; // first matching rule only: rules are ordered most specific first
  }
  return out;
}

/** Vendors that make network equipment (used by the mesh-node rule). */
export function isNetworkVendor(vendor) {
  if (typeof vendor !== 'string') return false;
  return /ubiquiti|eero|tp-?link|netgear|linksys|aruba|meraki|cisco|arris|commscope|technicolor|sagemcom|tenda|mikrotik|routerboard|zyxel|d-link|ruckus|cambium|mercusys|actiontec|askey|sercomm|calix|zte|fiberhome|plume|asustek|huawei|avm|draytek|buffalo|totolink|cudy|wavlink|gl technologies|peplink|juniper|edgecore|amped/i.test(vendor);
}

/** Apple-family vendor (OS resolution: phone→iOS, laptop→macOS, ...). */
export function isAppleVendor(vendor) {
  return typeof vendor === 'string' && /apple/i.test(vendor);
}

/** Vendors whose phones/tablets run Android. */
export function isAndroidVendor(vendor) {
  return typeof vendor === 'string'
    && /samsung|google|xiaomi|oneplus|oppo|vivo|realme|motorola|hmd|nothing|fairphone|honor|huawei|lenovo|zte|tcl|sony mobile|asus/i.test(vendor);
}
