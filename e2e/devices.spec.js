// Devices dashboard E2E (PLAN §7.2 mock devices, §11 data-testid contract).
// Covers: device list + badges, KPIs + ISP, save/name/persist, saved-device offline/online,
// forget, status filters + counts + search, per-device throughput.
import { test, expect } from '@playwright/test';
import { resetMock, gotoList, reloadList, deviceRow, deviceRows } from './helpers.js';

const SELF = 'a4-83-e7-1c-2d-01';
const GATEWAY = 'f0-9f-c2-10-00-01';
const WINDOWS = '3c-7c-3f-5a-9b-03';
const PIXEL = '3c-28-6d-a1-b2-05';
const PRINTER = '3c-52-82-7a-0c-08';
const SONOS = '48-a6-b8-c1-d2-09';
const TV = 'a8-23-fe-44-19-07';

const SHOTS = process.env.NETMON_SHOTS_DIR || 'test-results/devices-shots';

// Each test resets the mock world, so they are independent; workers:1 keeps them in order.
test.describe.configure({ mode: 'default' });

/** Rows are keyed by MAC (dashes). These tests drive the List view (`/?view=list`); Map is the default. */
const row = deviceRow;
const rows = deviceRows;

async function mock(request, patch) {
  const res = await request.post('/api/mock/state', { data: patch });
  expect(res.ok(), `mock/state ${JSON.stringify(patch)} -> ${res.status()}`).toBeTruthy();
}

async function saveViaApi(request, mac, name) {
  const res = await request.put(`/api/devices/${mac}`, { data: { name, type: null, notes: '' } });
  expect(res.ok(), `PUT /api/devices/${mac} -> ${res.status()} ${await res.text()}`).toBeTruthy();
}

async function openDashboard(page) {
  await gotoList(page);
}

/** Count shown in a status tab button, e.g. "Online 10" -> 10. */
async function tabCount(page, id) {
  const txt = (await page.getByTestId(`filter-${id}`).innerText()).replace(/\s+/g, ' ').trim();
  const m = txt.match(/(\d+)\s*$/);
  return m ? Number(m[1]) : NaN;
}

async function expectTabCount(page, id, n) {
  await expect(page.getByTestId(`filter-${id}`)).toHaveText(new RegExp(`\\b${n}\\s*$`));
}

test.beforeEach(async ({ request }) => {
  // Reset clears the live device table; resetMock waits for the next mock scan to repopulate all
  // 10 online (and fingerprinted) before tests PUT to /api/devices/:mac (404 otherwise).
  await resetMock(request);
});

test('dashboard lists mock devices with This device / Gateway badges, KPIs and ISP', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await openDashboard(page);

  // Exactly one self and one gateway badge, each on the right row.
  await expect(page.getByTestId('self-badge')).toHaveCount(1);
  await expect(page.getByTestId('gateway-badge')).toHaveCount(1);
  await expect(row(page, SELF).getByTestId('self-badge')).toHaveText('This device');
  await expect(row(page, GATEWAY).getByTestId('gateway-badge')).toHaveText('Gateway');

  // All rows online and unsaved after reset.
  await expect(page.locator('[data-testid^="device-row-"][data-online="true"]')).toHaveCount(10);
  await expect(page.locator('[data-testid^="device-row-"][data-saved="true"]')).toHaveCount(0);

  // Device names fall back to hostname.
  await expect(row(page, PIXEL).getByTestId('device-name')).toHaveText('Pixel-8');
  await expect(row(page, PIXEL).getByTestId('device-type')).toHaveText('Android phone · Pixel 8');
  await expect(row(page, SONOS).getByTestId('device-type')).toHaveText('Smart speaker · Sonos One');

  // KPIs: newest seeded speed result (PLAN §7.3) is 431 down.
  await expect(page.getByTestId('speed-download')).toHaveText('431');
  await expect(page.getByTestId('speed-upload')).toHaveText(/^\d+(\.\d+)?$/);
  await expect(page.getByTestId('speed-ping')).toHaveText(/^\d+(\.\d+)?$/);
  await expect(page.getByTestId('internet-status')).toHaveAttribute('data-status', 'up');

  // ISP name + public IP.
  await expect(page.getByTestId('isp-name')).toHaveText(/Comcast Cable Communications/);
  await expect(page.getByTestId('isp-ip')).toHaveText(/73\.162\.88\.14/);

  // Type summary chips (PLAN §7.2 initial typeCounts: phone 2).
  await expect(page.getByTestId('type-chip-phone')).toHaveAttribute('data-count', '2');

  await page.screenshot({ path: `${SHOTS}/01-dashboard.png`, fullPage: true });
  expect(errors).toEqual([]);
});

test('save & name a device: name shows, persists after reload, appears in Saved filter', async ({ page }) => {
  await openDashboard(page);
  const r = row(page, WINDOWS);
  await expect(r).toHaveAttribute('data-saved', 'false');
  await expect(r.getByTestId('forget-device-btn')).toHaveCount(0);
  await expect(r.getByTestId('save-device-btn')).toHaveText(/Save/);

  await r.getByTestId('save-device-btn').click();
  const modal = page.getByTestId('device-edit-modal');
  await expect(modal).toBeVisible();
  const input = page.getByTestId('device-name-input');
  await expect(input).toBeFocused();
  await input.fill('  Office PC  ');
  await page.getByTestId('save-confirm-btn').click();
  await expect(modal).toBeHidden();

  await expect(r).toHaveAttribute('data-saved', 'true');
  await expect(r.getByTestId('device-name')).toHaveText('Office PC');
  await expect(r.getByTestId('save-device-btn')).toHaveText(/Edit/);
  await expect(r.getByTestId('forget-device-btn')).toBeVisible();
  await expectTabCount(page, 'saved', 1);

  // Persisted server-side: survives a full reload.
  await reloadList(page);
  await expect(row(page, WINDOWS)).toHaveAttribute('data-saved', 'true');
  await expect(row(page, WINDOWS).getByTestId('device-name')).toHaveText('Office PC');

  // Saved filter shows only the saved device.
  await page.getByTestId('filter-saved').click();
  await expect(page.getByTestId('filter-saved')).toHaveAttribute('aria-pressed', 'true');
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, WINDOWS)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/02-saved-filter.png`, fullPage: true });

  // device_saved event logged.
  await expect(
    page.getByTestId('events-panel').locator('[data-testid="event-item"][data-type="device_saved"]').filter({ hasText: 'Office PC' })
  ).not.toHaveCount(0);

  // Editing again: modal pre-fills the saved name.
  await page.getByTestId('filter-all').click();
  await row(page, WINDOWS).getByTestId('save-device-btn').click();
  await expect(page.getByTestId('device-name-input')).toHaveValue('Office PC');
  await page.getByTestId('save-cancel-btn').click();
  await expect(page.getByTestId('device-edit-modal')).toBeHidden();
});

test('saved device going offline shows Offline · last seen, an event and an alert; back online when cleared', async ({ page, request }) => {
  await saveViaApi(request, SONOS, 'Living room speaker');
  await openDashboard(page);
  const r = row(page, SONOS);
  await expect(r.getByTestId('device-name')).toHaveText('Living room speaker');
  await expect(r.getByTestId('device-status')).toHaveAttribute('data-status', 'online');

  await mock(request, { devicesOffline: [SONOS.replace(/-/g, ':')] });

  // Offline after mock offlineAfterMs (2.5 s) + broadcast — within the 7 s expect timeout, give 15 s headroom.
  await expect(r).toHaveAttribute('data-online', 'false', { timeout: 15_000 });
  const status = r.getByTestId('device-status');
  await expect(status).toHaveAttribute('data-status', 'offline');
  await expect(status).toHaveText(/^Offline\s*·\s*last seen (just now|\d+ s ago)/);
  await expect(r).toHaveAttribute('data-saved', 'true');

  // Offline saved devices sort last.
  await expect(rows(page).last()).toHaveAttribute('data-testid', `device-row-${SONOS}`);

  // Info banner for the saved device going offline.
  await expect(page.locator('[data-testid="alert-banner"][data-kind="device_offline"]')).toHaveAttribute('data-level', 'info');

  // Event log entry naming the device.
  const events = page.getByTestId('events-panel');
  await expect(events.locator('[data-testid="event-item"][data-type="device_offline"]').filter({ hasText: 'Living room speaker' })).toHaveCount(1);

  // Status filter counts reflect the offline device.
  await expectTabCount(page, 'offline', 1);
  await expectTabCount(page, 'online', 9);
  await page.getByTestId('filter-offline').click();
  await expect(rows(page)).toHaveCount(1);
  await expect(r).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/03-saved-offline.png`, fullPage: true });
  await page.getByTestId('filter-all').click();

  // Bring it back.
  await mock(request, { devicesOffline: [] });
  await expect(r).toHaveAttribute('data-online', 'true', { timeout: 15_000 });
  await expect(r.getByTestId('device-status')).toHaveText(/^Online/);
  await expect(page.locator('[data-testid="alert-banner"][data-kind="device_offline"]')).toHaveCount(0);
  await expect(events.locator('[data-testid="event-item"][data-type="device_online"]').filter({ hasText: 'Living room speaker' })).toHaveCount(1);
  await expectTabCount(page, 'offline', 0);
});

test('forget a saved device: row reverts to unsaved and hostname', async ({ page, request }) => {
  await saveViaApi(request, PRINTER, 'Office printer');
  await openDashboard(page);
  const r = row(page, PRINTER);
  await expect(r).toHaveAttribute('data-saved', 'true');
  await expect(r.getByTestId('device-name')).toHaveText('Office printer');
  await expectTabCount(page, 'saved', 1);

  await r.getByTestId('forget-device-btn').click();
  await expect(page.getByTestId('forget-dialog')).toBeVisible();
  await page.getByTestId('forget-confirm-btn').click();

  await expect(r).toHaveAttribute('data-saved', 'false');
  await expect(r.getByTestId('device-name')).toHaveText('HP-LaserJet-M404');
  await expect(r.getByTestId('forget-device-btn')).toHaveCount(0);
  await expect(r.getByTestId('save-device-btn')).toHaveText(/Save/);
  await expectTabCount(page, 'saved', 0);
  await expect(page.getByTestId('events-panel').locator('[data-testid="event-item"][data-type="device_forgotten"]')).not.toHaveCount(0);

  // Server agrees after reload.
  await reloadList(page);
  await expect(row(page, PRINTER)).toHaveAttribute('data-saved', 'false');
});

test('forgetting an offline saved device removes it from the list', async ({ page, request }) => {
  await saveViaApi(request, TV, 'Bedroom TV');
  await openDashboard(page);
  await mock(request, { devicesOffline: [TV.replace(/-/g, ':')] });
  const r = row(page, TV);
  await expect(r).toHaveAttribute('data-online', 'false', { timeout: 15_000 });
  await r.getByTestId('forget-device-btn').click();
  await page.getByTestId('forget-confirm-btn').click();
  await expect(r).toHaveCount(0);
  await expect(rows(page)).toHaveCount(9);
});

test('status filters show counts; search filters by name, IP, MAC and vendor', async ({ page, request }) => {
  await saveViaApi(request, WINDOWS, 'Office PC');
  await openDashboard(page);

  expect(await tabCount(page, 'all')).toBe(10);
  expect(await tabCount(page, 'online')).toBe(10);
  expect(await tabCount(page, 'offline')).toBe(0);
  expect(await tabCount(page, 'saved')).toBe(1);
  await expect(page.getByTestId('filter-all')).toHaveAttribute('aria-pressed', 'true');

  await page.getByTestId('filter-online').click();
  await expect(page.getByTestId('filter-online')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('filter-all')).toHaveAttribute('aria-pressed', 'false');
  await expect(rows(page)).toHaveCount(10);

  await page.getByTestId('filter-offline').click();
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByTestId('devices-empty')).toBeVisible();

  await page.getByTestId('filter-saved').click();
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, WINDOWS)).toBeVisible();

  await page.getByTestId('filter-all').click();
  await expect(rows(page)).toHaveCount(10);

  const search = page.getByTestId('search-input');
  // By saved name (case-insensitive).
  await search.fill('office pc');
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, WINDOWS)).toBeVisible();
  // By hostname.
  await search.fill('pixel');
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, PIXEL)).toBeVisible();
  // By IP.
  await search.fill('192.168.1.120');
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, PRINTER)).toBeVisible();
  // By MAC (colon form).
  await search.fill('48:a6:b8');
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, SONOS)).toBeVisible();
  // By vendor.
  await search.fill('Ubiquiti');
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, GATEWAY)).toBeVisible();
  // Tab counts follow the search (DESIGN §3.4).
  await expectTabCount(page, 'all', 1);
  await page.screenshot({ path: `${SHOTS}/04-search.png`, fullPage: true });
  // No match -> empty state.
  await search.fill('zzz-no-such-device');
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByTestId('devices-empty')).toBeVisible();
  // Esc clears.
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(rows(page)).toHaveCount(10);

  // Search combined with status filter.
  await page.getByTestId('filter-saved').click();
  await search.fill('pixel');
  await expect(rows(page)).toHaveCount(0);
  await search.fill('');
  await expect(rows(page)).toHaveCount(1);
});

test('type chip filters the list to that category', async ({ page }) => {
  await openDashboard(page);
  const chip = page.getByTestId('type-chip-phone');
  await expect(chip).toHaveAttribute('aria-pressed', 'false');
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect(rows(page)).toHaveCount(2);
  await expect(page.locator('[data-testid^="device-row-"][data-category="phone"]')).toHaveCount(2);
  await chip.click();
  await expect(rows(page)).toHaveCount(10);
  // Same via the type <select>.
  await page.getByTestId('type-filter').selectOption('printer');
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, PRINTER)).toBeVisible();
  await page.getByTestId('type-filter').selectOption('all');
  await expect(rows(page)).toHaveCount(10);
});

test('self row shows live throughput; other rows show "—" requiring router integration', async ({ page }) => {
  await openDashboard(page);
  const selfTp = row(page, SELF).getByTestId('device-throughput');
  await expect(selfTp).toHaveText(/↓\s*[\d.]+\s*↑\s*[\d.]+\s*Mbps/);
  await expect(selfTp).toHaveAttribute('data-rx', /^\d+(\.\d+)?$/);
  await expect(selfTp).toHaveAttribute('data-tx', /^\d+(\.\d+)?$/);
  // Self is not pinged.
  await expect(row(page, SELF).getByTestId('device-latency')).toHaveText(/—/);

  for (const mac of [GATEWAY, WINDOWS, PIXEL, PRINTER, SONOS]) {
    const tp = row(page, mac).getByTestId('device-throughput');
    await expect(tp).toHaveText('—');
    await expect(tp).toHaveAttribute('title', 'Requires router integration');
    await expect(tp).toHaveAttribute('data-rx', '');
  }
  // Exactly one row with live throughput.
  await expect(page.locator('[data-testid="device-throughput"]:not([data-rx=""])')).toHaveCount(1);

  // Others get a latency value from pings (gateway base 1.2 ms).
  await expect(row(page, GATEWAY).getByTestId('device-latency')).toHaveText(/\d/);
});

test.describe('mobile card layout (390px)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('cards keep the same testids: badges, save, throughput, no horizontal scroll', async ({ page }) => {
    await openDashboard(page);
    await expect(page.getByTestId('devices-list')).toBeVisible();
    await expect(page.getByTestId('devices-table')).toHaveCount(0);
    await expect(row(page, SELF).getByTestId('self-badge')).toBeVisible();
    await expect(row(page, GATEWAY).getByTestId('gateway-badge')).toBeVisible();
    await expect(row(page, SELF).getByTestId('device-throughput')).toHaveText(/↓\s*[\d.]+\s*↑\s*[\d.]+\s*Mbps/);

    const c = row(page, PIXEL);
    await c.getByTestId('save-device-btn').click();
    await page.getByTestId('device-name-input').fill('Jon phone');
    await page.getByTestId('save-confirm-btn').click();
    await expect(c).toHaveAttribute('data-saved', 'true');
    await expect(c.getByTestId('device-name')).toHaveText('Jon phone');

    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(sw).toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${SHOTS}/05-mobile.png`, fullPage: true });
  });
});
