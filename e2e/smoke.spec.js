// Smoke test: the dashboard loads against the mock backend and shows the mock devices (PLAN §7, §11).
import { test, expect } from '@playwright/test';
import { resetMock, gotoList, deviceRows } from './helpers.js';

const SELF = 'a4-83-e7-1c-2d-01';
const GATEWAY = 'f0-9f-c2-10-00-01';

test.beforeEach(async ({ request }) => {
  await resetMock(request);
});

test('dashboard loads with live connection, internet status and ISP', async ({ page }) => {
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(String(err)));

  // Default view (no ?view=): the devices section is the topology map, and the page loads cleanly.
  await page.goto('/');
  await expect(page).toHaveTitle(/NetMon/);
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-status', 'open');
  await expect(page.getByTestId('internet-status')).toHaveAttribute('data-status', 'up');
  await expect(page.getByTestId('internet-status')).toHaveText(/Online/);
  await expect(page.getByTestId('isp-name')).toHaveText(/Comcast Cable Communications/);
  await expect(page.getByTestId('isp-ip')).toHaveText(/73\.162\.88\.14/);
  // After reset the newest seeded result is 431 Mbps (PLAN §7.3).
  await expect(page.getByTestId('speed-download')).toHaveText('431');
  await expect(page.getByTestId('alert-banner')).toHaveCount(0);
  await expect(page.getByTestId('topology-map')).toBeVisible();
  await expect(deviceRows(page)).toHaveCount(0); // the map never renders device-row-*
  expect(errors).toEqual([]);
});

test('devices are listed with detected types (list view)', async ({ page }) => {
  await gotoList(page);

  const self = page.getByTestId(`device-row-${SELF}`);
  await expect(self).toHaveAttribute('data-online', 'true');
  await expect(self.getByTestId('device-type')).toHaveText('Mac · MacBook Pro');
  await expect(self.getByTestId('device-throughput')).toHaveText(/↓\s*[\d.]+\s*↑\s*[\d.]+\s*Mbps/);

  const gw = page.getByTestId(`device-row-${GATEWAY}`);
  await expect(gw.getByTestId('device-type')).toHaveText('Router (gateway) · UniFi Dream Machine');
  await expect(gw.getByTestId('device-status')).toHaveText(/^Online/);

  await expect(page.getByTestId('device-row-5a-1f-3e-8c-44-04').getByTestId('device-type')).toHaveText('iPhone 15 Pro');
  await expect(page.getByTestId('device-row-3c-7c-3f-5a-9b-03').getByTestId('device-type')).toHaveText('Windows PC');
  await expect(page.getByTestId('device-row-00-25-96-12-34-0a').getByTestId('device-type')).toHaveText('Unknown device');
});

test('internet down raises a critical banner that clears on restore', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-status', 'open');
  await request.post('/api/mock/state', { data: { internetDown: true } });
  const banner = page.locator('[data-testid="alert-banner"][data-kind="internet_down"]');
  await expect(banner).toHaveAttribute('data-level', 'critical');
  await expect(page.getByTestId('internet-status')).toHaveAttribute('data-status', 'down');
  await request.post('/api/mock/state', { data: { internetDown: false } });
  await expect(banner).toHaveCount(0);
  await expect(page.getByTestId('internet-status')).toHaveAttribute('data-status', 'up');
});
