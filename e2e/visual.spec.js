// Visual / responsive / accessibility checks against the mock backend (PLAN §7, §8, §11; DESIGN.md).
// Saves reference full-page screenshots to e2e/screenshots/.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetMock, gotoList, gotoMap, reloadList, deviceRows, deviceRow } from './helpers.js';

const SHOTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'screenshots');
const SELF = 'a4-83-e7-1c-2d-01';
const WINDOWS = '3c-7c-3f-5a-9b-03';

// Each test resets the mock world, so they are independent; workers:1 keeps them in order.
test.describe.configure({ mode: 'default' });

test.beforeEach(async ({ request }) => {
  await resetMock(request);
});

/** Wait until live header data has rendered (internet up, speed tween settled). */
async function liveSettled(page) {
  await expect(page.getByTestId('internet-status')).toHaveAttribute('data-status', 'up');
  await expect(page.getByTestId('speed-download')).toHaveText('431');
}

/**
 * Load the dashboard in the List view (Map is the default; `?view=list` selects the list) and wait
 * until live data has rendered (SSE open, 10 devices, tween settled).
 */
async function openDashboard(page) {
  await gotoList(page);
  await liveSettled(page);
}

async function noHorizontalScroll(page) {
  const m = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    bw: document.body.scrollWidth,
    iw: window.innerWidth,
  }));
  expect(m.sw, `documentElement.scrollWidth ${m.sw} > innerWidth ${m.iw}`).toBeLessThanOrEqual(m.iw);
  expect(m.bw, `body.scrollWidth ${m.bw} > innerWidth ${m.iw}`).toBeLessThanOrEqual(m.iw);
}

async function htmlTheme(page) {
  return page.evaluate(() => ({
    dataTheme: document.documentElement.dataset.theme,
    dark: document.documentElement.classList.contains('dark'),
    bg: getComputedStyle(document.body).backgroundColor,
  }));
}

/** Press Tab until `testid` is focused (max `limit` presses). Returns presses used or -1. */
async function tabTo(page, testid, limit = 80) {
  for (let i = 1; i <= limit; i++) {
    await page.keyboard.press('Tab');
    const hit = await page.evaluate((id) => document.activeElement?.getAttribute('data-testid') === id, testid);
    if (hit) return i;
  }
  return -1;
}

test.describe('theme', () => {
  test('dark by OS preference, toggle switches to light and persists across reload', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openDashboard(page);
    const dark = await htmlTheme(page);
    expect(dark.dark).toBe(true);
    expect(dark.dataTheme).toBe('dark');
    await page.screenshot({ path: path.join(SHOTS, 'dashboard-dark.png'), fullPage: true });

    await page.getByTestId('theme-toggle').click();
    await expect(page.locator('html')).not.toHaveClass(/(^|\s)dark(\s|$)/);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const light = await htmlTheme(page);
    expect(light.bg).not.toBe(dark.bg); // visibly different page background

    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('netmon.ui') || '{}').theme);
    expect(stored).toBe('light');

    await reloadList(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('html')).not.toHaveClass(/(^|\s)dark(\s|$)/);
    await expect(page.getByTestId('speed-download')).toHaveText('431');
    await page.screenshot({ path: path.join(SHOTS, 'dashboard-light.png'), fullPage: true });

    // And back to dark.
    await page.getByTestId('theme-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/);
  });

  test('toggle from light OS preference switches to dark', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openDashboard(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.getByTestId('theme-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/);
  });
});

test.describe('responsive', () => {
  test('mobile 390x844 renders device cards without horizontal page scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await openDashboard(page);
    await expect(page.getByTestId('devices-list')).toBeVisible();
    await expect(page.getByTestId('devices-table')).toHaveCount(0);
    await expect(deviceRow(page, SELF).getByTestId('device-type')).toHaveText('Mac · MacBook Pro');
    await expect(page.getByTestId('run-speedtest-btn')).toBeVisible();
    await expect(page.getByTestId('settings-btn')).toBeVisible();
    await noHorizontalScroll(page);

    // No visible card extends past the viewport.
    const overflow = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid^="device-row-"]'))
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.right > window.innerWidth + 0.5 || r.left < -0.5).length,
    );
    expect(overflow).toBe(0);
    await page.screenshot({ path: path.join(SHOTS, 'dashboard-mobile.png'), fullPage: true });
  });

  test('tablet 768x1024 layout has no horizontal scroll and shows all devices', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await openDashboard(page);
    const table = page.getByTestId('devices-table');
    const list = page.getByTestId('devices-list');
    expect((await table.count()) + (await list.count())).toBe(1);
    await expect(page.getByTestId('kpi-download')).toBeVisible();
    await expect(page.getByTestId('isp-name')).toHaveText(/Comcast Cable Communications/);
    await noHorizontalScroll(page);
    await page.screenshot({ path: path.join(SHOTS, 'dashboard-tablet.png'), fullPage: true });
  });

  test('desktop 1440 uses the table layout', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDashboard(page);
    await expect(page.getByTestId('devices-table')).toBeVisible();
    await noHorizontalScroll(page);
  });
});

// The default devices view is the topology map (TOPOLOGY §8.1, §10.8): the page must still fit the viewport.
test.describe('responsive (default map view)', () => {
  for (const vp of [{ width: 390, height: 844, name: 'mobile' }, { width: 768, height: 1024, name: 'tablet' }, { width: 1440, height: 900, name: 'desktop' }]) {
    test(`${vp.name} ${vp.width}x${vp.height} shows the map without horizontal page scroll`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.goto('/');
      await expect(page.getByTestId('connection-status')).toHaveAttribute('data-status', 'open');
      await expect(page.getByTestId('topology-map')).toBeVisible();
      await liveSettled(page);
      await expect(deviceRows(page)).toHaveCount(0);
      await noHorizontalScroll(page);
      await page.screenshot({ path: path.join(SHOTS, `dashboard-map-${vp.name}.png`), fullPage: true });
    });
  }
});

test.describe('alerts', () => {
  test('internet down banner is role=alert with assertive live region', async ({ page, request }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openDashboard(page);
    await request.post('/api/mock/state', { data: { internetDown: true } });
    const banner = page.locator('[data-testid="alert-banner"][data-kind="internet_down"]');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute('data-level', 'critical');
    await expect(banner).toHaveAttribute('role', 'alert');
    await expect(banner).toHaveAttribute('aria-live', 'assertive');
    await expect(banner).toHaveCount(1);
    await expect(page.getByRole('alert').filter({ hasText: /internet/i }).first()).toBeVisible();
    await expect(page.getByTestId('internet-status')).toHaveAttribute('data-status', 'down');
    // Critical banners are never dismissible.
    await expect(banner.getByTestId('alert-dismiss')).toHaveCount(0);
    // The banner sits inside the viewport near the top so it is seen without scrolling.
    const box = await banner.boundingBox();
    expect(box.y).toBeLessThan(300);
    await page.screenshot({ path: path.join(SHOTS, 'alert-internet-down.png'), fullPage: true });
  });

  test('slow speed banner is a polite live region warning', async ({ page, request }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openDashboard(page);
    await request.post('/api/mock/state', { data: { downloadMbps: 150 } });
    const banner = page.locator('[data-testid="alert-banner"][data-kind="slow_speed"]');
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toHaveAttribute('data-level', 'warning');
    await expect(banner).toHaveAttribute('aria-live', /polite|assertive/);
    expect(['alert', 'status']).toContain(await banner.getAttribute('role'));
    await expect(page.getByTestId('speed-download')).toHaveText('150');
    await expect(page.getByTestId('speedtest-progress')).toHaveCount(0);
    await page.screenshot({ path: path.join(SHOTS, 'alert-slow.png'), fullPage: true });
  });
});

test.describe('dialogs and popovers', () => {
  test('save modal traps focus, closes on Escape and returns focus', async ({ page }) => {
    await openDashboard(page);
    const row = deviceRow(page, WINDOWS);
    const saveBtn = row.getByTestId('save-device-btn');
    await saveBtn.click();
    const modal = page.getByTestId('device-edit-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toHaveAttribute('aria-modal', 'true');
    await expect(modal).toHaveAttribute('role', /dialog/);
    await expect(page.getByTestId('device-name-input')).toBeFocused();

    // Tab forwards and backwards many times: focus never leaves the modal.
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('Tab');
      expect(await modal.evaluate((m) => m.contains(document.activeElement))).toBe(true);
    }
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await modal.evaluate((m) => m.contains(document.activeElement))).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await expect(saveBtn).toBeFocused();
    await expect(row).not.toHaveAttribute('data-saved', 'true');
  });

  test('settings drawer is keyboard reachable, traps focus and closes on Escape', async ({ page }) => {
    await openDashboard(page);
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    const presses = await tabTo(page, 'settings-btn');
    expect(presses, 'settings-btn not reachable with Tab').toBeGreaterThan(0);
    await page.keyboard.press('Enter');
    const drawer = page.getByTestId('settings-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute('aria-modal', 'true');
    await expect.poll(() => drawer.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      expect(await drawer.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(page.getByTestId('settings-btn')).toBeFocused();
  });

  test('run-speedtest-btn is keyboard reachable and starts a test with Enter', async ({ page }) => {
    await openDashboard(page);
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    const presses = await tabTo(page, 'run-speedtest-btn');
    expect(presses, 'run-speedtest-btn not reachable with Tab').toBeGreaterThan(0);
    // Focus is visible (outline or box-shadow ring).
    const ring = await page.getByTestId('run-speedtest-btn').evaluate((el) => {
      const s = getComputedStyle(el);
      return (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none';
    });
    expect(ring, 'focused run-speedtest-btn has no visible focus indicator').toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('speedtest-progress')).toBeVisible();
    await expect(page.getByTestId('speedtest-progress')).toHaveCount(0, { timeout: 15_000 });
  });

  test('"Why?" popover shows evidence and closes on Escape', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openDashboard(page);
    const row = deviceRow(page, SELF);
    // After a mock reset rows first appear as "identifying"; wait for the final label.
    await expect(row.getByTestId('device-type')).toHaveText('Mac · MacBook Pro');
    const why = row.getByTestId('device-type-why');
    // Scroll first and let the scroll event flush: the popover closes on any page scroll.
    await why.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await why.click();
    const pop = page.getByTestId('device-evidence');
    await expect(pop).toHaveCount(1);
    await expect(pop).toHaveCSS('opacity', '1');
    await expect(pop).toContainText('mDNS model MacBookPro18,3');
    // Viewport shot: a full-page capture resizes the viewport, and the popover closes on resize by design.
    await page.screenshot({ path: path.join(SHOTS, 'device-why-popover.png') });
    await page.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);
    await expect(why).toBeFocused();
  });

});

test.describe('a11y basics', () => {
  for (const view of ['list', 'map']) test(`icon-only buttons have accessible names (${view} view)`, async ({ page }) => {
    if (view === 'list') await openDashboard(page);
    else await gotoMap(page);
    for (const id of ['theme-toggle', 'mute-btn', 'settings-btn']) {
      const name = await page.getByTestId(id).getAttribute('aria-label');
      expect(name, `${id} has no aria-label`).toBeTruthy();
    }
    // Every button has a non-empty accessible name (text, aria-label or title).
    const unnamed = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button'))
        .filter((b) => b.offsetParent !== null)
        .filter((b) => !(b.getAttribute('aria-label') || b.textContent.trim() || b.getAttribute('title') || b.getAttribute('aria-labelledby')))
        .map((b) => b.outerHTML.slice(0, 120)),
    );
    expect(unnamed).toEqual([]);
    await expect(page.locator('html')).toHaveAttribute('lang', /.+/);
  });
});

// Regression: the popover must survive the scroll that brings its trigger into view.
test.describe('popover robustness', () => {
  test('"Why?" popover stays open when the click had to scroll the trigger into view', async ({ page }) => {
    await openDashboard(page);
    // The last row sits below the fold at 1280x720, so the click scrolls first (scroll, then click).
    const row = deviceRow(page, '00-25-96-12-34-0a');
    await expect(row.getByTestId('device-type')).toHaveText('Unknown device');
    await expect(row.getByTestId('device-type-why')).not.toBeInViewport();
    await row.getByTestId('device-type-why').click();
    const pop = page.getByTestId('device-evidence');
    await expect(pop).toHaveCSS('opacity', '1');
    await expect(pop).toContainText('No identifying services found');
  });
});
