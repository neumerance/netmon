// Alerts & live-status E2E (PLAN §6 alerts, §7.4 mock control, §11 testids).
// Runs against the mock backend. All tests share one server, so they run serially and
// reset the mock world first.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetMock, mock } from './helpers.js';

const SHOTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'screenshots');
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `alerts-${name}.png`), fullPage: false });

// Each test resets the mock world, so they are independent; workers:1 keeps them in order.
test.describe.configure({ mode: 'default' });

test.beforeEach(async ({ request }) => {
  // Also waits (once) for the mock startup speed test window to pass; see helpers.js.
  await resetMock(request);
});

/** Open the dashboard (default view: Map; these tests don't touch the devices section) and wait for the live stream. */
async function openDashboard(page) {
  await page.goto('/');
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-status', 'open');
  await expect(page.getByTestId('internet-status')).toHaveAttribute('data-status', 'up');
}

const banner = (page, kind) => page.locator(`[data-testid="alert-banner"][data-kind="${kind}"]`);

test('internet down raises a critical banner, Down status and title warning; recovery clears it with a restored toast', async ({ page, request }) => {
  await openDashboard(page);
  await expect(page).toHaveTitle('NetMon');
  await expect(page.getByTestId('alert-banner')).toHaveCount(0);

  await mock(request, { internetDown: true });

  const down = banner(page, 'internet_down');
  await expect(down).toBeVisible();
  await expect(down).toHaveAttribute('data-level', 'critical');
  await expect(down).toHaveAttribute('role', 'alert');
  await expect(down).toContainText(/internet/i);
  // Critical banners are not dismissible.
  await expect(down.getByTestId('alert-dismiss')).toHaveCount(0);

  const status = page.getByTestId('internet-status');
  await expect(status).toHaveAttribute('data-status', 'down');
  await expect(status).toHaveText(/Offline/);

  // Title blinks between "⚠ Internet down — NetMon" and "Internet down — NetMon".
  await expect(page).toHaveTitle(/^⚠ Internet down/);
  await expect(page).toHaveTitle(/Internet down — NetMon$/);

  // The user is never blocked from running a speed test, even while the internet is down.
  await expect(page.getByTestId('run-speedtest-btn')).toBeEnabled();
  await shot(page, 'internet-down');

  await mock(request, { internetDown: false });

  await expect(down).toHaveCount(0);
  await expect(status).toHaveAttribute('data-status', 'up');
  await expect(status).toHaveText(/Online/);
  // Toasts carry the event kind in data-kind (ToastHost: `t.kind || level`).
  const restored = page.locator('[data-testid="toast"][data-kind="internet_restored"]');
  await expect(restored).toHaveCount(1);
  await expect(restored).toContainText('Internet restored');
  await expect(restored).toBeVisible();
  await expect(restored).toHaveAttribute('data-level', 'success');
  await expect(page).toHaveTitle('NetMon');
  await expect(page.getByTestId('run-speedtest-btn')).toBeEnabled();
  await shot(page, 'internet-restored');
});

test('slow speed raises a warning banner mentioning 200 Mbps; lowering the threshold to 100 clears it', async ({ page, request }) => {
  await openDashboard(page);
  await expect(banner(page, 'slow_speed')).toHaveCount(0);

  // Setting downloadMbps starts a manual mock speed test (PLAN §7.4).
  await mock(request, { downloadMbps: 150 });
  await expect(page.getByTestId('speedtest-progress')).toBeVisible();

  const slow = banner(page, 'slow_speed');
  await expect(slow).toBeVisible({ timeout: 10_000 });
  await expect(slow).toHaveAttribute('data-level', 'warning');
  await expect(slow).toContainText('200 Mbps');
  await expect(slow).toContainText('150');
  await expect(page.getByTestId('speed-download')).toHaveText('150');
  await expect(page.getByTestId('speed-download')).toHaveAttribute('data-value', '150');
  await expect(page).toHaveTitle('Slow internet — NetMon');
  await shot(page, 'slow-speed');

  // Lower the threshold in the settings drawer.
  await page.getByTestId('settings-btn').click();
  const drawer = page.getByTestId('settings-drawer');
  await expect(drawer).toBeVisible();
  const input = page.getByTestId('threshold-input');
  await expect(input).toHaveValue('200');
  await input.fill('100');
  // A "Speed test complete" toast is showing at this point. It must not cover the drawer's
  // Save button: a real pointer click has to land right away, not after the toast auto-dismisses.
  await shot(page, 'toast-over-settings-save');
  const save = page.getByTestId('settings-save-btn');
  await save.click({ timeout: 3_000 });
  await expect(page.getByTestId('settings-error')).toHaveCount(0);

  await expect(slow).toHaveCount(0);
  await expect(page).toHaveTitle('NetMon');
  const settings = await (await request.get('/api/settings')).json();
  expect(settings.speedThresholdMbps ?? settings.settings?.speedThresholdMbps).toBe(100);
  await shot(page, 'threshold-lowered');
});

test('run-speedtest-btn shows progress, stays pressable while running, then shows the new download value', async ({ page }) => {
  await openDashboard(page);
  const btn = page.getByTestId('run-speedtest-btn');
  const dl = page.getByTestId('speed-download');
  // After reset the newest seeded result is 431 Mbps; the mock test measures 450.
  await expect(dl).toHaveText('431');
  await expect(btn).toBeEnabled();
  await expect(page.getByTestId('speedtest-progress')).toHaveCount(0);

  await btn.click();

  const progress = page.getByTestId('speedtest-progress');
  await expect(progress).toBeVisible();
  // Never blocked: pressing again during a test just says one is already running.
  await expect(btn).toBeEnabled();
  await btn.click();
  await expect(page.getByTestId('toast').filter({ hasText: 'already running' })).toBeVisible();
  await expect(progress).toHaveAttribute('data-phase', /latency|download|upload/);
  await expect(progress).toHaveAttribute('data-percent', /\d+/);
  await shot(page, 'speedtest-running');

  await expect(progress).toHaveCount(0, { timeout: 10_000 });
  await expect(dl).toHaveText('450');
  await expect(dl).toHaveAttribute('data-value', '450');
  await expect(page.getByTestId('speed-upload')).toHaveText('40');
  await expect(btn).toBeEnabled();
  await expect(banner(page, 'slow_speed')).toHaveCount(0);
  await shot(page, 'speedtest-done');
});

test('connection-status shows disconnected while /api/stream is aborted and recovers', async ({ page }) => {
  await openDashboard(page);
  const conn = page.getByTestId('connection-status');

  // Block the SSE endpoint, then reload so the page has to (re)connect through the block.
  await page.route('**/api/stream*', (route) => route.abort());
  await page.reload();

  await expect(conn).toHaveAttribute('data-status', 'reconnecting');
  await expect(page).toHaveTitle(/Reconnecting/);
  await shot(page, 'stream-disconnected');

  await page.unroute('**/api/stream*');
  // Backoff is 1 s → 10 s; allow for a couple of retries.
  await expect(conn).toHaveAttribute('data-status', 'open', { timeout: 15_000 });
  await expect(page).toHaveTitle('NetMon');
  await expect(page.getByTestId('internet-status')).toHaveAttribute('data-status', 'up');
  await shot(page, 'stream-recovered');
});
