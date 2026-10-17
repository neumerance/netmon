// Device detail panel E2E (TOPOLOGY.md §5 panel, §8.3 testids, §8.4 a11y).
// Covers: open from a map node and from a list row, the header/facts/evidence/latency content vs the
// mock device, close via Esc / X / empty-canvas click, inline rename (persists + node label), save via
// the edit modal, type override (node icon + data-category), "Connected via" re-parenting, re-detect,
// forget a saved device, focus return to the trigger, and the mobile full-screen sheet with focus trap.
import { test, expect } from '@playwright/test';
import { resetMock, gotoMap, gotoList, deviceRow, mapNodeTestId, macColons, nodeInsideMap } from './helpers.js';

const IPHONE = '5a-1f-3e-8c-44-04';
const PIXEL = '3c-28-6d-a1-b2-05';
const WINDOWS = '3c-7c-3f-5a-9b-03';
const PRINTER = '3c-52-82-7a-0c-08';
const SONOS = '48-a6-b8-c1-d2-09';
const DECO = '50-c7-bf-3d-7e-06';

const SHOTS = 'e2e/screenshots';

const panel = (page) => page.getByTestId('device-detail-panel');
const node = (page, mac) => page.getByTestId(mapNodeTestId(mac));
const nodeFocus = (page, mac) => node(page, mac).locator('[data-node-focus]');

async function apiDevice(request, mac) {
  const res = await request.get('/api/devices');
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  const list = Array.isArray(body) ? body : body.devices;
  const d = list.find((x) => x.mac === macColons(mac));
  expect(d, `device ${mac} in /api/devices`).toBeTruthy();
  return d;
}

async function saveViaApi(request, mac, name) {
  const res = await request.put(`/api/devices/${macColons(mac)}`, { data: { name, type: null, notes: '' } });
  expect(res.ok(), `PUT /api/devices/${mac} -> ${res.status()} ${await res.text()}`).toBeTruthy();
}

async function overrideOf(request, mac) {
  const res = await request.get('/api/topology');
  expect(res.ok()).toBeTruthy();
  return (await res.json()).overrides?.[macColons(mac)] ?? null;
}

/** Click a node on the map and wait for the panel to show it. */
async function openFromMap(page, mac) {
  await expect(node(page, mac)).toBeVisible();
  await node(page, mac).click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toHaveAttribute('data-mac', macColons(mac));
}

/** A point on the map that is empty canvas (the Vue Flow pane itself, not a node/edge/control). */
async function emptyCanvasPoint(page) {
  const pt = await page.getByTestId('topology-map').evaluate((root) => {
    const r = root.getBoundingClientRect();
    for (let y = r.bottom - 20; y > r.top + 80; y -= 15) {
      for (let x = r.left + 20; x < r.left + r.width / 2; x += 15) {
        const el = document.elementFromPoint(x, y);
        if (el && el.classList.contains('vue-flow__pane')) return { x, y };
      }
    }
    return null;
  });
  expect(pt, 'an empty spot on the map canvas').toBeTruthy();
  return pt;
}

test.describe.configure({ mode: 'default' });

test.beforeEach(async ({ request }) => {
  // Reset restores the mock devices AND the topology defaults (iPhone/Pixel/TV under the Deco, no pins).
  await resetMock(request);
});

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('clicking a map node opens the panel with the mock device details', async ({ page, request }) => {
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));

    const dev = await apiDevice(request, IPHONE);
    await gotoMap(page);
    await openFromMap(page, IPHONE);
    const p = panel(page);

    await expect(p).toHaveAttribute('data-mode', 'side');
    await expect(node(page, IPHONE)).toHaveAttribute('data-selected', 'true');
    await expect(p.getByTestId('detail-name')).toHaveText('Jons-iPhone');
    await expect(p.getByTestId('detail-type')).toContainText('iPhone 15 Pro');
    await expect(p.getByTestId('detail-type')).toHaveAttribute('data-category', 'phone');
    await expect(p.getByTestId('detail-type')).toHaveAttribute('data-os', 'ios');
    await expect(p.getByTestId('detail-status')).toHaveAttribute('data-status', 'online');
    await expect(p.getByTestId('detail-status')).toHaveText(/Online/);
    await expect(p.getByTestId('detail-badge-private')).toBeVisible();
    await expect(p.getByTestId('detail-badge-saved')).toHaveCount(0);
    await expect(p.getByTestId('detail-ip')).toHaveText(dev.ip);
    await expect(p.getByTestId('detail-ip')).toHaveText('192.168.1.61');
    await expect(p.getByTestId('detail-mac')).toHaveText('5a:1f:3e:8c:44:04');

    const evidence = p.getByTestId('detail-evidence').locator('li');
    await expect(evidence).toHaveCount(dev.typeEvidence.length);
    await expect(evidence).toHaveText(dev.typeEvidence);

    // Latency chart fills with samples from the mock pinger.
    const chart = p.getByTestId('detail-latency-chart');
    await expect(chart).toBeVisible();
    await expect.poll(async () => Number(await chart.getAttribute('data-samples')), { timeout: 10_000 }).toBeGreaterThan(1);
    await expect(p.getByTestId('detail-latency')).toHaveText(/\d/);

    // Connected via: mock default puts the iPhone under the Deco.
    await expect(p.getByTestId('detail-connected-via')).toHaveValue(macColons(DECO));
    await expect(p.getByTestId('detail-parent')).toHaveText('Deco-M5');

    // Unsaved device: Save, Re-detect; no Forget.
    await expect(p.getByTestId('detail-save-btn')).toHaveText(/Save device/);
    await expect(p.getByTestId('detail-redetect-btn')).toBeEnabled();
    await expect(p.getByTestId('detail-forget-btn')).toHaveCount(0);

    await page.screenshot({ path: `${SHOTS}/detail-panel.png` });
    expect(errors).toEqual([]);
  });

  test('clicking a list row name opens the panel', async ({ page }) => {
    await gotoList(page);
    await deviceRow(page, PIXEL).getByTestId('device-name').click();
    const p = panel(page);
    await expect(p).toBeVisible();
    await expect(p).toHaveAttribute('data-mac', macColons(PIXEL));
    await expect(p.getByTestId('detail-name')).toHaveText('Pixel-8');
    await expect(p.getByTestId('detail-type')).toHaveAttribute('data-category', 'phone');
    await expect(p.getByTestId('detail-ip')).toHaveText('192.168.1.72');
    await expect(p.getByTestId('topology-map')).toHaveCount(0);

    // Another row swaps the content.
    await deviceRow(page, PRINTER).getByTestId('device-name').click();
    await expect(p).toHaveAttribute('data-mac', macColons(PRINTER));
    await expect(p.getByTestId('detail-name')).toHaveText('HP-LaserJet-M404');

    await p.getByTestId('detail-close-btn').click();
    await expect(p).toBeHidden();
  });

  test('Esc, the close button and an empty-canvas click close the panel; focus returns to the node', async ({ page }) => {
    await gotoMap(page);

    // Esc (mouse-opened) -> closes and focuses the node.
    await openFromMap(page, PIXEL);
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    await expect(nodeFocus(page, PIXEL)).toBeFocused();
    await expect(node(page, PIXEL)).toHaveAttribute('data-selected', 'false');

    // Close button -> closes and focuses the node.
    await openFromMap(page, PIXEL);
    await panel(page).getByTestId('detail-close-btn').click();
    await expect(panel(page)).toBeHidden();
    await expect(nodeFocus(page, PIXEL)).toBeFocused();

    // Keyboard: Enter on the focused node opens it, focus moves into the panel (heading), Esc returns it.
    await nodeFocus(page, PRINTER).focus();
    await page.keyboard.press('Enter');
    await expect(panel(page)).toHaveAttribute('data-mac', macColons(PRINTER));
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-testid="device-detail-panel"]'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    await expect(nodeFocus(page, PRINTER)).toBeFocused();

    // Empty canvas click.
    await openFromMap(page, PIXEL);
    const pt = await emptyCanvasPoint(page);
    await page.mouse.click(pt.x, pt.y);
    await expect(panel(page)).toBeHidden();
    await expect(node(page, PIXEL)).toHaveAttribute('data-selected', 'false');
  });

  test('inline rename saves the device, updates the node label and persists after reload', async ({ page, request }) => {
    await gotoMap(page);
    await openFromMap(page, PIXEL);
    const p = panel(page);

    await p.getByTestId('detail-name').click();
    const input = p.getByTestId('detail-name-input');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('Pixel-8');
    await input.fill('Kid tablet phone');
    await input.press('Enter');
    await expect(input).toHaveCount(0);
    await expect(p.getByTestId('detail-name')).toHaveText('Kid tablet phone');
    await expect(p.getByTestId('detail-badge-saved')).toBeVisible();
    await expect(p.getByTestId('detail-save-btn')).toHaveText(/Edit/);
    await expect(p.getByTestId('detail-forget-btn')).toBeVisible();
    await expect(page.getByTestId('toast').filter({ hasText: 'Renamed to' })).toBeVisible();

    // Node label + aria-label follow.
    await expect(nodeFocus(page, PIXEL)).toHaveAttribute('aria-label', /^Kid tablet phone,/);
    await expect(node(page, PIXEL)).toContainText('Kid tablet phone');

    // Server-side.
    const d = await apiDevice(request, PIXEL);
    expect(d.saved).toBe(true);
    expect(d.name).toBe('Kid tablet phone');

    // Esc while renaming cancels the rename, not the panel.
    await p.getByTestId('detail-name-edit-btn').click();
    await p.getByTestId('detail-name-input').fill('Discard me');
    await p.getByTestId('detail-name-input').press('Escape');
    await expect(p).toBeVisible();
    await expect(p.getByTestId('detail-name')).toHaveText('Kid tablet phone');

    // Reload.
    await gotoMap(page);
    await expect(nodeFocus(page, PIXEL)).toHaveAttribute('aria-label', /^Kid tablet phone,/);
    await openFromMap(page, PIXEL);
    await expect(panel(page).getByTestId('detail-name')).toHaveText('Kid tablet phone');
    await expect(panel(page).getByTestId('detail-badge-saved')).toBeVisible();
  });

  test('Save device button opens the edit modal; saving names the device and persists', async ({ page, request }) => {
    await gotoMap(page);
    await openFromMap(page, WINDOWS);
    const p = panel(page);
    await p.getByTestId('detail-save-btn').click();
    const modal = page.getByTestId('device-edit-modal');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('device-name-input')).toBeFocused();
    await page.getByTestId('device-name-input').fill('Office PC');
    await page.getByTestId('save-confirm-btn').click();
    await expect(modal).toBeHidden();
    // Esc in the modal must not have closed the panel (none pressed) and the panel stays open after save.
    await expect(p).toBeVisible();
    await expect(p.getByTestId('detail-name')).toHaveText('Office PC');
    await expect(p.getByTestId('detail-badge-saved')).toBeVisible();
    await expect(nodeFocus(page, WINDOWS)).toHaveAttribute('aria-label', /^Office PC,/);
    expect((await apiDevice(request, WINDOWS)).name).toBe('Office PC');

    await gotoMap(page);
    await openFromMap(page, WINDOWS);
    await expect(panel(page).getByTestId('detail-name')).toHaveText('Office PC');
  });

  test('changing the type override updates the panel and the node icon / category', async ({ page, request }) => {
    await gotoMap(page);
    await expect(node(page, WINDOWS)).toHaveAttribute('data-category', 'computer');
    await expect(node(page, WINDOWS).locator('[data-icon]').first()).toHaveAttribute('data-icon', 'monitor');

    await openFromMap(page, WINDOWS);
    const p = panel(page);
    await p.getByTestId('detail-change-type-btn').click();
    await expect(page.getByTestId('device-edit-modal')).toBeVisible();
    const select = page.getByTestId('device-type-select');
    await expect(select).toBeFocused();
    await select.selectOption('laptop');
    await page.getByTestId('save-confirm-btn').click();
    await expect(page.getByTestId('device-edit-modal')).toBeHidden();

    await expect(p.getByTestId('detail-type')).toHaveAttribute('data-category', 'laptop');
    await expect(p.getByTestId('detail-badge-usertype')).toBeVisible();
    await expect(p.getByTestId('detail-evidence-section')).toHaveAttribute('data-source', 'user');
    await expect(node(page, WINDOWS)).toHaveAttribute('data-category', 'laptop');
    await expect(node(page, WINDOWS).locator('[data-icon]').first()).toHaveAttribute('data-icon', 'laptop');

    const d = await apiDevice(request, WINDOWS);
    expect(d.category).toBe('laptop');
    expect(d.typeSource).toBe('user');
  });

  test('"Connected via" re-parents the device on the map and on the server', async ({ page, request }) => {
    await gotoMap(page);
    await expect(node(page, SONOS)).toHaveAttribute('data-parent', 'gateway');
    await openFromMap(page, SONOS);
    const p = panel(page);
    const via = p.getByTestId('detail-connected-via');
    await expect(via).toHaveValue('');
    await expect(p.getByTestId('detail-parent')).toHaveText('Gateway (default)');

    // Sonos -> Deco.
    await via.selectOption(macColons(DECO));
    await expect(node(page, SONOS)).toHaveAttribute('data-parent', macColons(DECO));
    await expect(page.getByTestId(`map-edge-${SONOS}`)).toHaveAttribute('data-source', /50[-:]c7[-:]bf[-:]3d[-:]7e[-:]06/);
    await expect(p.getByTestId('detail-parent')).toHaveText('Deco-M5');
    await expect.poll(async () => (await overrideOf(request, SONOS))?.parentMac).toBe(macColons(DECO));

    // iPhone (under the Deco by default) -> Gateway. Close first: the side panel may cover its node.
    await p.getByTestId('detail-close-btn').click();
    await expect(p).toBeHidden();
    await openFromMap(page, IPHONE);
    await expect(via).toHaveValue(macColons(DECO));
    await via.selectOption('');
    await expect(node(page, IPHONE)).toHaveAttribute('data-parent', 'gateway');
    await expect(p.getByTestId('detail-parent')).toHaveText(/^Gateway/);
    await expect.poll(async () => (await overrideOf(request, IPHONE))?.parentMac ?? null).toBeNull();

    // Persists across reload.
    await gotoMap(page);
    await expect(node(page, SONOS)).toHaveAttribute('data-parent', macColons(DECO));
    await expect(node(page, IPHONE)).toHaveAttribute('data-parent', 'gateway');
  });

  test('Re-detect runs fingerprinting again and reports the result', async ({ page }) => {
    await gotoMap(page);
    await openFromMap(page, PRINTER);
    const p = panel(page);
    const btn = p.getByTestId('detail-redetect-btn');
    await expect(btn).toBeEnabled();
    const resP = page.waitForResponse(
      (r) => r.request().method() === 'POST' && /\/api\/devices\/[^/]+\/fingerprint$/.test(new URL(r.url()).pathname),
    );
    await btn.click();
    const res = await resP;
    expect(res.status()).toBe(200);
    await expect(page.getByTestId('toast').filter({ hasText: 'Re-detected' })).toBeVisible();
    await expect(page.getByTestId('toast').filter({ hasText: 'Re-detected' })).toContainText(/% confidence/);
    await expect(btn).toBeEnabled();
    await expect(p.getByTestId('detail-type')).toHaveAttribute('data-category', 'printer');
  });

  test('Forget on a saved device reverts it to unsaved', async ({ page, request }) => {
    await saveViaApi(request, PRINTER, 'Office printer');
    await gotoMap(page);
    await openFromMap(page, PRINTER);
    const p = panel(page);
    await expect(p.getByTestId('detail-name')).toHaveText('Office printer');
    await expect(p.getByTestId('detail-badge-saved')).toBeVisible();

    await p.getByTestId('detail-forget-btn').click();
    await expect(page.getByTestId('forget-dialog')).toBeVisible();
    await page.getByTestId('forget-confirm-btn').click();
    await expect(page.getByTestId('forget-dialog')).toBeHidden();

    await expect(p.getByTestId('detail-badge-saved')).toHaveCount(0);
    await expect(p.getByTestId('detail-forget-btn')).toHaveCount(0);
    await expect(p.getByTestId('detail-name')).toHaveText('HP-LaserJet-M404');
    await expect(p.getByTestId('detail-save-btn')).toHaveText(/Save device/);
    await expect(nodeFocus(page, PRINTER)).toHaveAttribute('aria-label', /^HP-LaserJet-M404,/);
    expect((await apiDevice(request, PRINTER)).saved).toBe(false);
  });
});

test.describe('mobile 390x844', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('tapping a node opens a full-screen sheet that traps focus and returns it on close', async ({ page }) => {
    await gotoMap(page);
    // Phone widths open at a readable zoom centred on the gateway (outer nodes may be off-canvas);
    // Fit shows the whole network so the iPhone can be tapped.
    await page.getByTestId('map-fit-btn').click();
    await expect.poll(() => nodeInsideMap(page, IPHONE)).toBe(true);
    await node(page, IPHONE).tap();
    const p = panel(page);
    await expect(p).toBeVisible();
    await expect(p).toHaveAttribute('data-mode', 'sheet');
    await expect(p).toHaveAttribute('role', 'dialog');
    await expect(p).toHaveAttribute('aria-modal', 'true');
    await expect(p.getByTestId('detail-name')).toHaveText('Jons-iPhone');

    // Full-screen: covers the viewport once the slide-up transition has finished.
    await expect
      .poll(async () => {
        const b = await p.boundingBox();
        return b ? [b.x, b.y, b.width, b.height].map(Math.round).join(",") : null;
      })
      .toBe("0,0,390,844");

    // No horizontal scroll (page or panel).
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      panel: (() => {
        const el = document.querySelector('[data-testid="device-detail-panel"]');
        return el ? el.scrollWidth - el.clientWidth : 0;
      })(),
    }));
    expect(overflow.doc).toBeLessThanOrEqual(0);
    expect(overflow.panel).toBeLessThanOrEqual(0);

    await page.screenshot({ path: `${SHOTS}/detail-panel-mobile.png` });

    // Focus trap: tabbing forwards and backwards never leaves the sheet.
    const insidePanel = () => page.evaluate(() => !!document.activeElement?.closest('[data-testid="device-detail-panel"]'));
    await expect.poll(insidePanel).toBe(true);
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      expect(await insidePanel(), `focus inside sheet after Tab #${i + 1}`).toBe(true);
    }
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await insidePanel(), `focus inside sheet after Shift+Tab #${i + 1}`).toBe(true);
    }

    await p.getByTestId('detail-close-btn').click();
    await expect(p).toBeHidden();
    await expect(nodeFocus(page, IPHONE)).toBeFocused();
  });

  test('list view: tapping a card name opens the sheet; Esc closes it and returns focus', async ({ page }) => {
    await gotoList(page);
    const trigger = deviceRow(page, PIXEL).getByTestId('device-name');
    await trigger.tap();
    const p = panel(page);
    await expect(p).toHaveAttribute('data-mode', 'sheet');
    await expect(p.getByTestId('detail-name')).toHaveText('Pixel-8');
    await page.keyboard.press('Escape');
    await expect(p).toBeHidden();
    await expect(trigger).toBeFocused();
    const docOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(docOverflow).toBeLessThanOrEqual(0);
  });
});
