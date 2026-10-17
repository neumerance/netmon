/**
 * Apple hardware model identifiers (as advertised in mDNS `_device-info._tcp`
 * TXT `model=`, `_airplay._tcp` `model=`, `_raop._tcp` `am=` or `sysctl hw.model`)
 * mapped to friendly names, categories and operating systems.
 *
 * Macs keep the family name ("MacBook Pro") on purpose: it is what users recognise
 * and what the UI label pattern "Mac · MacBook Pro" expects. iPhones get the exact
 * marketing name because that is how people tell their phones apart.
 */

// Apple-silicon era Macs use opaque "MacNN,N" identifiers, so they need a table.
const MAC_IDS = {
  'Mac13,1': ['Mac Studio', 'computer'], 'Mac13,2': ['Mac Studio', 'computer'],
  'Mac14,2': ['MacBook Air', 'laptop'], 'Mac14,3': ['Mac mini', 'computer'],
  'Mac14,5': ['MacBook Pro', 'laptop'], 'Mac14,6': ['MacBook Pro', 'laptop'],
  'Mac14,7': ['MacBook Pro', 'laptop'], 'Mac14,8': ['Mac Pro', 'computer'],
  'Mac14,9': ['MacBook Pro', 'laptop'], 'Mac14,10': ['MacBook Pro', 'laptop'],
  'Mac14,12': ['Mac mini', 'computer'], 'Mac14,13': ['Mac Studio', 'computer'],
  'Mac14,14': ['Mac Studio', 'computer'], 'Mac14,15': ['MacBook Air', 'laptop'],
  'Mac15,3': ['MacBook Pro', 'laptop'], 'Mac15,4': ['iMac', 'computer'], 'Mac15,5': ['iMac', 'computer'],
  'Mac15,6': ['MacBook Pro', 'laptop'], 'Mac15,7': ['MacBook Pro', 'laptop'],
  'Mac15,8': ['MacBook Pro', 'laptop'], 'Mac15,9': ['MacBook Pro', 'laptop'],
  'Mac15,10': ['MacBook Pro', 'laptop'], 'Mac15,11': ['MacBook Pro', 'laptop'],
  'Mac15,12': ['MacBook Air', 'laptop'], 'Mac15,13': ['MacBook Air', 'laptop'],
  'Mac15,14': ['Mac Studio', 'computer'],
  'Mac16,1': ['MacBook Pro', 'laptop'], 'Mac16,2': ['iMac', 'computer'], 'Mac16,3': ['iMac', 'computer'],
  'Mac16,5': ['MacBook Pro', 'laptop'], 'Mac16,6': ['MacBook Pro', 'laptop'],
  'Mac16,7': ['MacBook Pro', 'laptop'], 'Mac16,8': ['MacBook Pro', 'laptop'],
  'Mac16,9': ['Mac Studio', 'computer'], 'Mac16,10': ['Mac mini', 'computer'],
  'Mac16,11': ['Mac mini', 'computer'], 'Mac16,12': ['MacBook Air', 'laptop'],
  'Mac16,13': ['MacBook Air', 'laptop'],
  'Mac17,2': ['MacBook Pro', 'laptop'],
};

const IPHONE_IDS = {
  'iPhone8,1': 'iPhone 6s', 'iPhone8,2': 'iPhone 6s Plus', 'iPhone8,4': 'iPhone SE',
  'iPhone9,1': 'iPhone 7', 'iPhone9,3': 'iPhone 7', 'iPhone9,2': 'iPhone 7 Plus', 'iPhone9,4': 'iPhone 7 Plus',
  'iPhone10,1': 'iPhone 8', 'iPhone10,4': 'iPhone 8', 'iPhone10,2': 'iPhone 8 Plus', 'iPhone10,5': 'iPhone 8 Plus',
  'iPhone10,3': 'iPhone X', 'iPhone10,6': 'iPhone X',
  'iPhone11,2': 'iPhone XS', 'iPhone11,4': 'iPhone XS Max', 'iPhone11,6': 'iPhone XS Max', 'iPhone11,8': 'iPhone XR',
  'iPhone12,1': 'iPhone 11', 'iPhone12,3': 'iPhone 11 Pro', 'iPhone12,5': 'iPhone 11 Pro Max',
  'iPhone12,8': 'iPhone SE (2nd generation)',
  'iPhone13,1': 'iPhone 12 mini', 'iPhone13,2': 'iPhone 12', 'iPhone13,3': 'iPhone 12 Pro', 'iPhone13,4': 'iPhone 12 Pro Max',
  'iPhone14,4': 'iPhone 13 mini', 'iPhone14,5': 'iPhone 13', 'iPhone14,2': 'iPhone 13 Pro', 'iPhone14,3': 'iPhone 13 Pro Max',
  'iPhone14,6': 'iPhone SE (3rd generation)', 'iPhone14,7': 'iPhone 14', 'iPhone14,8': 'iPhone 14 Plus',
  'iPhone15,2': 'iPhone 14 Pro', 'iPhone15,3': 'iPhone 14 Pro Max', 'iPhone15,4': 'iPhone 15', 'iPhone15,5': 'iPhone 15 Plus',
  'iPhone16,1': 'iPhone 15 Pro', 'iPhone16,2': 'iPhone 15 Pro Max',
  'iPhone17,1': 'iPhone 16 Pro', 'iPhone17,2': 'iPhone 16 Pro Max', 'iPhone17,3': 'iPhone 16', 'iPhone17,4': 'iPhone 16 Plus',
  'iPhone17,5': 'iPhone 16e',
  'iPhone18,1': 'iPhone 17 Pro', 'iPhone18,2': 'iPhone 17 Pro Max', 'iPhone18,3': 'iPhone 17', 'iPhone18,4': 'iPhone Air',
};

const APPLE_TV_IDS = {
  'AppleTV3,1': 'Apple TV (3rd generation)', 'AppleTV3,2': 'Apple TV (3rd generation)',
  'AppleTV5,3': 'Apple TV HD', 'AppleTV6,2': 'Apple TV 4K', 'AppleTV11,1': 'Apple TV 4K (2nd generation)',
  'AppleTV14,1': 'Apple TV 4K (3rd generation)',
};

const AUDIO_ACCESSORY_IDS = {
  'AudioAccessory1,1': 'HomePod', 'AudioAccessory1,2': 'HomePod',
  'AudioAccessory5,1': 'HomePod mini', 'AudioAccessory6,1': 'HomePod (2nd generation)',
};

// Legacy (Intel-era) identifiers carry the family in the prefix. Order matters:
// longer prefixes first so "MacBookPro" wins over "MacBook" and "iMacPro" over "iMac".
const PREFIX_RULES = [
  ['MacBookPro', 'MacBook Pro', 'laptop', 'macos'],
  ['MacBookAir', 'MacBook Air', 'laptop', 'macos'],
  ['MacBook', 'MacBook', 'laptop', 'macos'],
  ['iMacPro', 'iMac Pro', 'computer', 'macos'],
  ['iMac', 'iMac', 'computer', 'macos'],
  ['Macmini', 'Mac mini', 'computer', 'macos'],
  ['MacPro', 'Mac Pro', 'computer', 'macos'],
  ['Xserve', 'Xserve', 'server', 'macos'],
  ['iPhone', 'iPhone', 'phone', 'ios'],
  ['iPad', 'iPad', 'tablet', 'ipados'],
  ['iPod', 'iPod touch', 'media_player', 'ios'],
  ['AppleTV', 'Apple TV', 'media_player', 'tvos'],
  ['AudioAccessory', 'HomePod', 'speaker', 'other'],
  ['Watch', 'Apple Watch', 'wearable', 'other'],
  ['RealityDevice', 'Apple Vision Pro', 'wearable', 'other'],
  ['AirPort', 'AirPort base station', 'access_point', 'other'],
];

const MODEL_ID_RE = /^[A-Za-z]+\d+,\d+$/;

/** True when `s` looks like an Apple model identifier ("Mac15,6", "iPhone16,1", "AirPort10,115"). */
export function isAppleModelId(s) {
  return typeof s === 'string' && MODEL_ID_RE.test(s.trim());
}

/**
 * Map an Apple model identifier to { name, category, os }, or null when the string
 * is not a recognisable Apple identifier.
 */
export function appleModelInfo(modelId) {
  if (typeof modelId !== 'string') return null;
  const id = modelId.trim();
  if (!id) return null;

  if (MAC_IDS[id]) {
    const [name, category] = MAC_IDS[id];
    return { name, category, os: 'macos' };
  }
  if (/^Mac\d+,\d+$/.test(id)) {
    // Newer Mac not in the table yet: still certainly a Mac.
    return { name: 'Mac', category: 'computer', os: 'macos' };
  }
  if (IPHONE_IDS[id]) return { name: IPHONE_IDS[id], category: 'phone', os: 'ios' };
  if (APPLE_TV_IDS[id]) return { name: APPLE_TV_IDS[id], category: 'media_player', os: 'tvos' };
  if (AUDIO_ACCESSORY_IDS[id]) return { name: AUDIO_ACCESSORY_IDS[id], category: 'speaker', os: 'other' };

  for (const [prefix, name, category, os] of PREFIX_RULES) {
    if (id.startsWith(prefix) && /\d/.test(id.slice(prefix.length, prefix.length + 1))) {
      return { name, category, os };
    }
  }
  return null;
}
