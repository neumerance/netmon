// Device-type detection UI (PLAN §4.8, §7.2, §11): labels, evidence popover, type chips,
// type filter, user type override (+ persistence and reset to Auto-detect), private MAC badge,
// and the mock `newDevice` arrival.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { resetMock, gotoList, reloadList, deviceRow, deviceRows } from './helpers.js';

// Tests share the one mock server but each resets it in beforeEach; with workers:1 they run in
// order. Default mode (not serial) so one failure does not skip the rest.
test.describe.configure({ mode: 'default' });

// Optional: save screenshots to a fixed folder (otherwise they go to the test output dir).
const SHOT_DIR = process.env.NETMON_QA_SHOT_DIR || '';
async function shot(page, testInfo, name, fullPage = true) {
  const file = SHOT_DIR ? path.join(SHOT_DIR, `device-types-${name}.png`) : testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: file, fullPage });
  await testInfo.attach(name, { path: file, contentType: 'image/png' });
}

// PLAN §7.2 — mock devices with the exact expected category / os / label / evidence.
const DEVICES = [
  { mac: 'a4-83-e7-1c-2d-01', category: 'laptop', os: 'macos', label: 'Mac · MacBook Pro',
    evidence: ['This computer', 'mDNS model MacBookPro18,3 → MacBook Pro', 'Vendor Apple', 'TTL 64 → Unix-like'] },
  { mac: 'f0-9f-c2-10-00-01', category: 'router', os: '', label: 'Router (gateway) · UniFi Dream Machine',
    evidence: ['Default gateway → router', 'UPnP InternetGatewayDevice', 'Vendor Ubiquiti → network gear', 'TTL 64 → Unix-like'] },
  { mac: '3c-7c-3f-5a-9b-03', category: 'computer', os: 'windows', label: 'Windows PC',
    evidence: ['Hostname DESKTOP-* → Windows', 'NetBIOS name DESKTOP-7Q2K9LM', 'TTL 128 → Windows', 'Port 445 open (SMB)', 'Port 3389 open (Remote Desktop)'] },
  { mac: '5a-1f-3e-8c-44-04', category: 'phone', os: 'ios', label: 'iPhone 15 Pro',
    evidence: ['mDNS model iPhone16,1 → iPhone 15 Pro', 'Port 62078 open → iOS', 'Randomized (private) MAC → mobile device', 'Hostname contains iPhone'] },
  { mac: '3c-28-6d-a1-b2-05', category: 'phone', os: 'android', label: 'Android phone · Pixel 8',
    evidence: ['Hostname Pixel-* → Android phone', 'Vendor Google', 'TTL 64 → Unix-like'] },
  { mac: '50-c7-bf-3d-7e-06', category: 'access_point', os: '', label: 'Wi-Fi access point · Deco M5',
    evidence: ['Hostname Deco-* → TP-Link mesh Wi-Fi', 'DNS + web admin on non-gateway → mesh node / secondary router', 'UPnP WLANAccessPointDevice', 'Vendor TP-Link → network gear'] },
  { mac: 'a8-23-fe-44-19-07', category: 'tv', os: 'other', label: 'TV · OLED65C3',
    evidence: ['Hostname LGwebOSTV → LG webOS TV', 'UPnP MediaRenderer "[LG] webOS TV OLED65C3"', 'Vendor LG Electronics'] },
  { mac: '3c-52-82-7a-0c-08', category: 'printer', os: '', label: 'Printer · LaserJet Pro M404dn',
    evidence: ['mDNS _ipp._tcp → printer', 'Port 9100 open (raw printing)', 'Port 631 open (IPP)', 'Vendor HP'] },
  { mac: '48-a6-b8-c1-d2-09', category: 'speaker', os: '', label: 'Smart speaker · Sonos One',
    evidence: ['Vendor Sonos → speaker', 'Port 1400 open (Sonos)', 'mDNS _sonos._tcp', 'UPnP ZonePlayer model Sonos One'] },
  { mac: '00-25-96-12-34-0a', category: 'unknown', os: '', label: 'Unknown device',
    evidence: ['No identifying services found', 'Vendor not recognized', 'TTL 64 → Unix-like'] },
];
const INITIAL_COUNTS = { laptop: 1, router: 1, computer: 1, phone: 2, access_point: 1, tv: 1, printer: 1, speaker: 1, unknown: 1 };
const NEW_DEVICE = '8c-79-f5-3a-21-0b';
const UNKNOWN = '00-25-96-12-34-0a';
const IPHONE = '5a-1f-3e-8c-44-04';

// These tests drive the List view (`/?view=list`); Map is the default view.
const rows = deviceRows;
const row = deviceRow;

/** Load the dashboard and wait until every mock device has its fingerprint (evidence present). */
async function openDashboard(page) {
  await gotoList(page);
  for (const d of DEVICES) {
    await expect(row(page, d.mac).getByTestId('device-type')).toHaveText(d.label);
  }
}

test.beforeEach(async ({ request }) => {
  await resetMock(request);
});

test('each mock device row shows the detected type, category and OS', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

  await openDashboard(page);
  for (const d of DEVICES) {
    const r = row(page, d.mac);
    await expect(r, `row ${d.mac}`).toHaveAttribute('data-category', d.category);
    const type = r.getByTestId('device-type');
    await expect(type, `type ${d.mac}`).toHaveText(d.label);
    await expect(type, `category ${d.mac}`).toHaveAttribute('data-category', d.category);
    await expect(type, `os ${d.mac}`).toHaveAttribute('data-os', d.os);
    await expect(type, `source ${d.mac}`).toHaveAttribute('data-source', 'auto');
  }
  // Self and gateway badges.
  await expect(row(page, DEVICES[0].mac).getByTestId('self-badge')).toBeVisible();
  await expect(row(page, DEVICES[1].mac).getByTestId('gateway-badge')).toBeVisible();
  await shot(page, testInfo, 'all-types');
  expect(errors).toEqual([]);
});

test('"Why?" popover lists the exact evidence strings for every device', async ({ page }, testInfo) => {
  await openDashboard(page);
  const popover = page.getByTestId('device-evidence');
  for (const d of DEVICES) {
    await row(page, d.mac).getByTestId('device-type-why').click();
    await expect(popover, `popover ${d.mac}`).toBeVisible();
    await expect(popover).toHaveCount(1);
    await expect(popover.locator('li'), `evidence ${d.mac}`).toHaveText(d.evidence);
    await expect(popover).toContainText(d.label);
    if (d.mac === IPHONE) {
      await expect(popover).toHaveCSS('opacity', '1'); // let the enter transition finish
      await shot(page, testInfo, 'why-popover-iphone', false); // fullPage scroll would close the popover
    }
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
  }
});

test('type chips show per-category counts and clicking one filters the table', async ({ page }, testInfo) => {
  await openDashboard(page);
  for (const [cat, n] of Object.entries(INITIAL_COUNTS)) {
    const chip = page.getByTestId(`type-chip-${cat}`);
    await expect(chip, `chip ${cat}`).toHaveAttribute('data-count', String(n));
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
  }
  // No chips for categories with zero devices.
  await expect(page.getByTestId('type-chip-tablet')).toHaveCount(0);
  await expect(page.getByTestId('type-chip-camera')).toHaveCount(0);
  await expect(page.locator('[data-testid^="type-chip-"]:not([data-testid="type-chip-clear"])')).toHaveCount(Object.keys(INITIAL_COUNTS).length);

  const phones = page.getByTestId('type-chip-phone');
  await phones.click();
  await expect(phones).toHaveAttribute('aria-pressed', 'true');
  await expect(rows(page)).toHaveCount(2);
  await expect(row(page, IPHONE)).toBeVisible();
  await expect(row(page, '3c-28-6d-a1-b2-05')).toBeVisible();
  await expect(page.getByTestId('type-filter')).toHaveValue('phone');
  await shot(page, testInfo, 'chip-filter-phone');

  // Clicking the active chip toggles the filter off.
  await phones.click();
  await expect(phones).toHaveAttribute('aria-pressed', 'false');
  await expect(rows(page)).toHaveCount(10);
  await expect(page.getByTestId('type-filter')).toHaveValue('all');

  // Switching directly between chips.
  await page.getByTestId('type-chip-router').click();
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, 'f0-9f-c2-10-00-01')).toBeVisible();
  await page.getByTestId('type-chip-speaker').click();
  await expect(page.getByTestId('type-chip-router')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('type-chip-speaker')).toHaveAttribute('aria-pressed', 'true');
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, '48-a6-b8-c1-d2-09')).toBeVisible();
  await page.getByTestId('type-chip-clear').click();
  await expect(rows(page)).toHaveCount(10);
});

test('type-filter select filters rows and syncs the chip state', async ({ page }) => {
  await openDashboard(page);
  const select = page.getByTestId('type-filter');
  await expect(select).toHaveValue('all');

  for (const d of DEVICES.filter((x) => x.category !== 'phone')) {
    await select.selectOption(d.category);
    await expect(rows(page), `filter ${d.category}`).toHaveCount(1);
    await expect(row(page, d.mac)).toBeVisible();
    await expect(page.getByTestId(`type-chip-${d.category}`)).toHaveAttribute('aria-pressed', 'true');
  }
  await select.selectOption('phone');
  await expect(rows(page)).toHaveCount(2);
  await select.selectOption('all');
  await expect(rows(page)).toHaveCount(10);
  await expect(page.locator('[data-testid^="type-chip-"][aria-pressed="true"]')).toHaveCount(0);
});

test('overriding the type sets typeSource=user, survives reload, and Auto-detect restores it', async ({ page, request }, testInfo) => {
  await openDashboard(page);
  const r = row(page, UNKNOWN);
  const type = r.getByTestId('device-type');
  const icon = r.getByTestId('device-type-icon').locator('[data-icon]').first();
  const iconBefore = await icon.getAttribute('data-icon');

  // Save the unknown device as a camera.
  await r.getByTestId('save-device-btn').click();
  await expect(page.getByTestId('device-name-input')).toBeVisible();
  await page.getByTestId('device-name-input').fill('Garage camera');
  await page.getByTestId('device-type-select').selectOption('camera');
  await page.getByTestId('save-confirm-btn').click();
  await expect(page.getByTestId('device-name-input')).toHaveCount(0);

  await expect(r).toHaveAttribute('data-saved', 'true');
  await expect(r.getByTestId('device-name')).toHaveText('Garage camera');
  await expect(r).toHaveAttribute('data-category', 'camera');
  await expect(type).toHaveText('Camera');
  await expect(type).toHaveAttribute('data-category', 'camera');
  await expect(type).toHaveAttribute('data-source', 'user');
  await expect(icon).not.toHaveAttribute('data-icon', iconBefore ?? '');
  await expect(page.getByTestId('type-chip-camera')).toHaveAttribute('data-count', '1');
  await expect(page.getByTestId('type-chip-unknown')).toHaveCount(0);

  // Server agrees.
  const api = await (await request.get('/api/devices')).json();
  const list = Array.isArray(api) ? api : api.devices;
  const dev = list.find((d) => d.mac === UNKNOWN.replace(/-/g, ':'));
  expect(dev).toBeTruthy();
  expect(dev.category).toBe('camera');
  expect(dev.typeSource).toBe('user');

  // "Why?" popover shows it was set by the user.
  await r.getByTestId('device-type-why').click();
  await expect(page.getByTestId('device-evidence')).toContainText('Set by you');
  await page.keyboard.press('Escape');
  await shot(page, testInfo, 'override-camera');

  // Persists across reload.
  await reloadList(page);
  await expect(type).toHaveText('Camera');
  await expect(type).toHaveAttribute('data-source', 'user');
  await expect(r).toHaveAttribute('data-category', 'camera');

  // Reset to Auto-detect.
  await r.getByTestId('save-device-btn').click();
  const select = page.getByTestId('device-type-select');
  await expect(select).toHaveValue('camera');
  await select.selectOption('');
  await page.getByTestId('save-confirm-btn').click();
  await expect(page.getByTestId('device-name-input')).toHaveCount(0);
  await expect(type).toHaveText('Unknown device');
  await expect(type).toHaveAttribute('data-category', 'unknown');
  await expect(type).toHaveAttribute('data-source', 'auto');
  await expect(r).toHaveAttribute('data-category', 'unknown');
  await expect(icon).toHaveAttribute('data-icon', iconBefore ?? '');
  await expect(r).toHaveAttribute('data-saved', 'true'); // still saved, only the type was reset
  await expect(page.getByTestId('type-chip-unknown')).toHaveAttribute('data-count', '1');
  await expect(page.getByTestId('type-chip-camera')).toHaveCount(0);
});

test('overriding a known type (Windows PC -> server) updates label and icon', async ({ page }) => {
  await openDashboard(page);
  const r = row(page, '3c-7c-3f-5a-9b-03');
  const type = r.getByTestId('device-type');
  await r.getByTestId('save-device-btn').click();
  await page.getByTestId('device-name-input').fill('Plex box');
  await page.getByTestId('device-type-select').selectOption('server');
  await page.getByTestId('save-confirm-btn').click();
  // server + windows => base 'Windows PC' (PLAN §4.8 algorithm: computer|laptop|server & windows)
  await expect(type).toHaveText('Windows PC');
  await expect(type).toHaveAttribute('data-category', 'server');
  await expect(type).toHaveAttribute('data-source', 'user');
  await expect(r.getByTestId('device-type-icon').locator('[data-icon]').first()).toHaveAttribute('data-icon', /server/);
});

test('randomized MAC device shows the Private address badge; others do not', async ({ page }, testInfo) => {
  await openDashboard(page);
  const privateBadge = (mac) => row(page, mac).getByText('Private', { exact: true }).locator('visible=true');
  await expect(privateBadge(IPHONE)).toHaveCount(1);
  await expect(privateBadge(IPHONE)).toHaveAttribute('title', /Private \(randomized\)/);
  for (const d of DEVICES.filter((x) => x.mac !== IPHONE)) {
    await expect(privateBadge(d.mac), `no badge on ${d.mac}`).toHaveCount(0);
  }
  await row(page, IPHONE).scrollIntoViewIfNeeded();
  await shot(page, testInfo, 'private-mac');
});

test('private MAC badge testid is present on a visible element (PLAN-style testid)', async ({ page }) => {
  // In the table layout the Address column is hidden below a 1024px panel, so the badge the user
  // sees is the inline copy on the Device cell's third line; it must carry the testid too.
  test.setTimeout(15_000);
  await openDashboard(page);
  // DeviceCard and the table Address column carry data-testid="private-mac-badge"; the table's
  // inline (third line) copy shown on narrower panels must be reachable too.
  await expect(row(page, IPHONE).getByTestId('private-mac-badge').locator('visible=true')).toHaveCount(1);
});

test('mock newDevice adds a detected tablet row, a chip, a toast and an event', async ({ page, request }, testInfo) => {
  await openDashboard(page);
  await expect(page.getByTestId('type-chip-tablet')).toHaveCount(0);

  const res = await request.post('/api/mock/state', { data: { newDevice: true } });
  expect(res.ok()).toBeTruthy();

  const r = row(page, NEW_DEVICE);
  await expect(r).toBeVisible();
  await expect(rows(page)).toHaveCount(11);
  await expect(r).toHaveAttribute('data-online', 'true');
  const type = r.getByTestId('device-type');
  await expect(type).toHaveText('Android tablet · Galaxy Tab S9');
  await expect(type).toHaveAttribute('data-category', 'tablet');
  await expect(type).toHaveAttribute('data-os', 'android');
  await expect(page.getByTestId('type-chip-tablet')).toHaveAttribute('data-count', '1');

  await r.getByTestId('device-type-why').click();
  await expect(page.getByTestId('device-evidence').locator('li')).toHaveText([
    'Hostname Galaxy-Tab-* → Samsung tablet', 'Vendor Samsung', 'TTL 64 → Unix-like',
  ]);
  await page.keyboard.press('Escape');

  await expect(page.getByTestId('toast').filter({ hasText: /New device|new devices/ }).filter({ hasText: /Galaxy/ })).toHaveCount(1);
  await expect(page.locator('[data-testid="event-item"][data-type="device_new"]').filter({ hasText: /Galaxy/ }).first()).toBeVisible();
  await shot(page, testInfo, 'new-device');

  // Removing it again: the unsaved device goes offline (it is dropped later, after dropUnsavedAfterMs).
  await request.post('/api/mock/state', { data: { newDevice: false } });
  await expect
    .poll(async () => (await r.count()) === 0 || (await r.getAttribute('data-online')) === 'false', { timeout: 10_000 })
    .toBe(true);
});
