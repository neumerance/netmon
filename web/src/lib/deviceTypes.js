// Device categories, OS labels, icons and display helpers (PLAN.md §4.8).
// Pure module — no Vue imports. Mirrors server/src/net/fingerprint/categories.js.

export const CATEGORIES = [
  'computer',
  'laptop',
  'phone',
  'tablet',
  'router',
  'access_point',
  'network_switch',
  'tv',
  'media_player',
  'speaker',
  'printer',
  'camera',
  'console',
  'nas',
  'server',
  'smart_home',
  'wearable',
  'unknown',
];

export const CATEGORY_LABELS = {
  computer: 'Computer',
  laptop: 'Laptop',
  phone: 'Phone',
  tablet: 'Tablet',
  router: 'Router',
  access_point: 'Wi-Fi access point',
  network_switch: 'Network switch',
  tv: 'TV',
  media_player: 'Streaming device',
  speaker: 'Smart speaker',
  printer: 'Printer',
  camera: 'Camera',
  console: 'Game console',
  nas: 'NAS',
  server: 'Server',
  smart_home: 'Smart home',
  wearable: 'Wearable',
  unknown: 'Unknown device',
};

export const CATEGORY_PLURALS = {
  computer: 'computers',
  laptop: 'laptops',
  phone: 'phones',
  tablet: 'tablets',
  router: 'routers',
  access_point: 'access points',
  network_switch: 'switches',
  tv: 'TVs',
  media_player: 'streaming devices',
  speaker: 'speakers',
  printer: 'printers',
  camera: 'cameras',
  console: 'consoles',
  nas: 'NAS',
  server: 'servers',
  smart_home: 'smart home',
  wearable: 'wearables',
  unknown: 'unknown',
};

// Icon names understood by components/ui/Icon.vue (PLAN §4.8 names; Icon.vue also accepts
// the DESIGN.md lucide aliases such as 'monitor', 'smartphone', 'hard-drive', 'help-circle').
export const CATEGORY_ICONS = {
  computer: 'desktop',
  laptop: 'laptop',
  phone: 'phone',
  tablet: 'tablet',
  router: 'router',
  access_point: 'wifi',
  network_switch: 'switch',
  tv: 'tv',
  media_player: 'cast',
  speaker: 'speaker',
  printer: 'printer',
  camera: 'camera',
  console: 'gamepad',
  nas: 'database',
  server: 'server',
  smart_home: 'home',
  wearable: 'watch',
  unknown: 'question',
};

export const OS_LABELS = {
  windows: 'Windows',
  macos: 'macOS',
  ios: 'iOS',
  ipados: 'iPadOS',
  android: 'Android',
  linux: 'Linux',
  chromeos: 'ChromeOS',
  tvos: 'tvOS',
  other: 'Other',
};

export const OS_ICONS = {
  windows: 'windows',
  macos: 'apple',
  ios: 'apple',
  ipados: 'apple',
  tvos: 'apple',
  android: 'android',
  linux: 'linux',
};

export const TYPE_GROUPS = {
  computers: ['computer', 'laptop', 'server'],
  mobile: ['phone', 'tablet', 'wearable'],
  network: ['router', 'access_point', 'network_switch'],
  media: ['tv', 'media_player', 'speaker', 'console'],
  home: ['smart_home', 'camera'],
  office: ['printer', 'nas'],
  other: ['unknown'],
};

export const TYPE_GROUP_LABELS = {
  computers: 'Computers',
  mobile: 'Phones & tablets',
  network: 'Network',
  media: 'Media',
  home: 'Smart home',
  office: 'Office',
  other: 'Other',
};

// Category -> tint key for icon tiles (DESIGN §1.4). Tints are only for icon tiles and chip dots.
// Usage: `bg-cat-${tint}/12 text-cat-${tint}` — prefer CATEGORY_TINT_CLASSES (static strings so
// Tailwind can see them).
export const CATEGORY_TINTS = {
  computer: 'computer',
  laptop: 'computer',
  server: 'computer',
  nas: 'computer',
  phone: 'mobile',
  tablet: 'mobile',
  wearable: 'mobile',
  router: 'network',
  access_point: 'network',
  network_switch: 'network',
  tv: 'media',
  media_player: 'media',
  speaker: 'media',
  console: 'media',
  printer: 'iot',
  camera: 'iot',
  smart_home: 'iot',
  unknown: 'unknown',
};

// Static class strings per tint (Tailwind scans source for complete class names).
export const TINT_CLASSES = {
  computer: { tile: 'bg-cat-computer/12 text-cat-computer', text: 'text-cat-computer', dot: 'bg-cat-computer', active: 'bg-cat-computer/12 border-cat-computer/40' },
  mobile: { tile: 'bg-cat-mobile/12 text-cat-mobile', text: 'text-cat-mobile', dot: 'bg-cat-mobile', active: 'bg-cat-mobile/12 border-cat-mobile/40' },
  network: { tile: 'bg-cat-network/12 text-cat-network', text: 'text-cat-network', dot: 'bg-cat-network', active: 'bg-cat-network/12 border-cat-network/40' },
  media: { tile: 'bg-cat-media/12 text-cat-media', text: 'text-cat-media', dot: 'bg-cat-media', active: 'bg-cat-media/12 border-cat-media/40' },
  iot: { tile: 'bg-cat-iot/12 text-cat-iot', text: 'text-cat-iot', dot: 'bg-cat-iot', active: 'bg-cat-iot/12 border-cat-iot/40' },
  unknown: { tile: 'bg-cat-unknown/12 text-cat-unknown', text: 'text-cat-unknown', dot: 'bg-cat-unknown', active: 'bg-cat-unknown/12 border-cat-unknown/40' },
};

/** Tint classes for a category (falls back to 'unknown'). */
export function categoryTint(category) {
  return TINT_CLASSES[CATEGORY_TINTS[category] || 'unknown'];
}

/** TYPE_GROUPS key for a category ('other' if not found). */
export function categoryGroup(category) {
  for (const [key, cats] of Object.entries(TYPE_GROUPS)) {
    if (cats.includes(category)) return key;
  }
  return 'other';
}

export function categoryLabel(category) {
  return CATEGORY_LABELS[category] || CATEGORY_LABELS.unknown;
}

export function osLabel(os) {
  return (os && OS_LABELS[os]) || '—';
}

/**
 * Human label combining category, OS and model (PLAN §4.8, exact algorithm).
 * 'Mac · MacBook Pro', 'Windows PC', 'iPhone 15 Pro', 'Router (gateway) · UniFi Dream Machine'.
 */
export function deviceTypeLabel(device) {
  if (!device) return CATEGORY_LABELS.unknown;
  const category = CATEGORY_LABELS[device.category] ? device.category : 'unknown';
  const os = device.os || null;
  let base;
  if (category === 'computer' || category === 'laptop' || category === 'server') {
    if (os === 'macos') base = 'Mac';
    else if (os === 'windows') base = 'Windows PC';
    else if (os === 'linux') base = 'Linux PC';
    else if (os === 'chromeos') base = 'Chromebook';
  } else if (category === 'phone') {
    if (os === 'ios') base = 'iPhone';
    else if (os === 'android') base = 'Android phone';
  } else if (category === 'tablet') {
    if (os === 'ipados') base = 'iPad';
    else if (os === 'android') base = 'Android tablet';
  } else if (category === 'router') {
    if (device.isGateway) base = 'Router (gateway)';
  } else if (category === 'tv' || category === 'media_player') {
    if (os === 'tvos') base = 'Apple TV';
  }
  if (!base) base = CATEGORY_LABELS[category];

  const model = typeof device.model === 'string' ? device.model.trim() : '';
  if (!model) return base;
  // 'startsWith' is applied on a word boundary so that 'iPhone 15 Pro' (base 'iPhone') collapses to the
  // model while 'MacBook Pro' (base 'Mac') still renders 'Mac · MacBook Pro' as PLAN §7.2 expects.
  const ml = model.toLowerCase();
  const bl = base.toLowerCase();
  if (ml === bl || (ml.startsWith(bl) && !/[a-z0-9]/i.test(model.charAt(base.length)))) return model;
  return `${base} · ${model}`;
}

/** Icon name for a device's category. */
export function deviceIcon(device) {
  return CATEGORY_ICONS[device?.category] ?? 'question';
}

/** Icon name for an OS, or null. */
export function osIcon(os) {
  return (os && OS_ICONS[os]) || null;
}

/** 'high' (>= 0.75), 'medium' (>= 0.45), else 'low'. */
export function confidenceLevel(c) {
  const v = typeof c === 'number' && Number.isFinite(c) ? c : 0;
  if (v >= 0.75) return 'high';
  if (v >= 0.45) return 'medium';
  return 'low';
}

/** 'High confidence (92%)' etc. */
export function confidenceText(c) {
  const v = typeof c === 'number' && Number.isFinite(c) ? c : 0;
  const pct = Math.round(v * 100);
  const level = confidenceLevel(v);
  if (level === 'high') return `High confidence (${pct}%)`;
  if (level === 'medium') return `Medium confidence (${pct}%)`;
  return `Low confidence — best guess (${pct}%)`;
}

/** Row primary text: name || hostname || model || vendor || ip || mac. */
export function deviceDisplayName(device) {
  if (!device) return '';
  return device.name || device.hostname || device.model || device.vendor || device.ip || device.mac || '';
}

const GROUP_NOUNS = {
  computers: ['computer', 'computers'],
  mobile: ['phone or tablet', 'phones & tablets'],
  network: ['network device', 'network devices'],
  media: ['media device', 'media devices'],
  home: ['smart-home device', 'smart-home devices'],
  office: ['office device', 'office devices'],
  other: ['unknown', 'unknown'],
};

/**
 * Summary text for type counts: '4 computers · 3 phones · 2 routers'. Input { [category]: n }.
 * When there are more categories than `max`, it summarizes by TYPE_GROUPS instead
 * ('2 computers · 2 phones & tablets · 2 network devices · 3 media devices · …') so no device
 * type is silently dropped; anything still beyond `max` is reported as '+N more'.
 */
export function typeSummaryText(typeCounts, { max = 6 } = {}) {
  const entries = Object.entries(typeCounts || {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || CATEGORIES.indexOf(a[0]) - CATEGORIES.indexOf(b[0]));
  let parts;
  if (entries.length <= max) {
    parts = entries.map(([cat, n]) => `${n} ${n === 1 ? singular(cat) : CATEGORY_PLURALS[cat] || cat}`);
  } else {
    const groups = new Map();
    for (const [cat, n] of entries) {
      const g = categoryGroup(cat);
      groups.set(g, (groups.get(g) || 0) + n);
    }
    const order = Object.keys(TYPE_GROUPS);
    parts = [...groups.entries()]
      .sort((a, b) => (a[0] === 'other') - (b[0] === 'other') || b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]))
      .map(([g, n]) => `${n} ${(GROUP_NOUNS[g] || GROUP_NOUNS.other)[n === 1 ? 0 : 1]}`);
  }
  if (parts.length > max) {
    const rest = parts.length - (max - 1);
    parts = [...parts.slice(0, max - 1), `+${rest} more`];
  }
  return parts.join(' · ');
}

function singular(cat) {
  const label = CATEGORY_LABELS[cat] || cat;
  // Keep acronyms ('TV', 'NAS') and proper nouns ('Wi-Fi') readable.
  if (label === label.toUpperCase()) return label;
  return label.replace(/^(\w)/, (m) => m.toLowerCase()).replace(/^wi-fi/i, 'Wi-Fi');
}
