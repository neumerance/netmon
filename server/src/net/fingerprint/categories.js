/**
 * Device categories and operating-system identifiers used by the fingerprinting
 * classifier. This is the server-side copy of the table in PLAN.md §4.8 and must
 * stay in sync with web/src/lib/deviceTypes.js.
 */

export const CATEGORIES = [
  'computer', 'laptop', 'phone', 'tablet', 'router', 'access_point', 'network_switch', 'tv',
  'media_player', 'speaker', 'printer', 'camera', 'console', 'nas', 'server', 'smart_home',
  'wearable', 'unknown',
];

export const OS_VALUES = ['windows', 'macos', 'ios', 'ipados', 'android', 'linux', 'chromeos', 'tvos', 'other'];

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

const CATEGORY_SET = new Set(CATEGORIES);
const OS_SET = new Set(OS_VALUES);

export function isCategory(c) {
  return typeof c === 'string' && CATEGORY_SET.has(c);
}

export function isOs(o) {
  return typeof o === 'string' && OS_SET.has(o);
}
