// Topology map + device detail panel E2E (TOPOLOGY.md §8.3 testids, §10.8 scenarios).
// Runs against the mock backend (10 devices; mock "Connected via" defaults put the iPhone, Pixel 8 and
// LG TV under the Deco M5). Every test resets the mock world, which also restores the topology defaults
// and unpins every node (TOPOLOGY §7.4).
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resetMock, mock, gotoMap, gotoList, waitForLive, deviceRows, macColons,
  mapNodeTestId, mapEdgeTestId, MOCK_DEVICE_COUNT, nodeInsideMap,
} from './helpers.js';

const SHOTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'screenshots');
const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(SHOTS, name), ...opts });

// Mock devices (server/src/mock/devices.js), dashed form.
const SELF = 'a4-83-e7-1c-2d-01';
const GATEWAY = 'f0-9f-c2-10-00-01';
const WINDOWS = '3c-7c-3f-5a-9b-03';
const IPHONE = '5a-1f-3e-8c-44-04';
const PIXEL = '3c-28-6d-a1-b2-05';
const DECO = '50-c7-bf-3d-7e-06';
const TV = 'a8-23-fe-44-19-07';
const PRINTER = '3c-52-82-7a-0c-08';
const SONOS = '48-a6-b8-c1-d2-09';
const UNKNOWN = '00-25-96-12-34-0a';

const NON_GATEWAY = [SELF, WINDOWS, IPHONE, PIXEL, DECO, TV, PRINTER, SONOS, UNKNOWN];
const DECO_CHILDREN = [IPHONE, PIXEL, TV];

test.describe.configure({ mode: 'default' });

test.beforeEach(async ({ request }) => {
  await resetMock(request);
  // resetMock already restores the topology mock defaults; assert it so a failure points here.
  const t = await (await request.get('/api/topology')).json();
  expect(Object.keys(t.overrides).sort()).toEqual(DECO_CHILDREN.map(macColons).sort());
});

const node = (page, mac) => page.getByTestId(mapNodeTestId(mac));
const edge = (page, mac) => page.getByTestId(mapEdgeTestId(mac));
const mapNodes = (page) => page.locator('[data-testid^="map-node-"]');
const mapEdges = (page) => page.locator('[data-testid^="map-edge-"]');
const panel = (page) => page.getByTestId('device-detail-panel');

async function overrides(request) {
  const res = await request.get('/api/topology');
  expect(res.ok()).toBeTruthy();
  return (await res.json()).overrides;
}

async function saveViaApi(request, mac, name) {
  const res = await request.put(`/api/devices/${mac}`, { data: { name, type: null, notes: '' } });
  expect(res.ok(), `PUT /api/devices/${mac} -> ${res.status()} ${await res.text()}`).toBeTruthy();
}

/** Vue Flow wrapper translate() of a node, i.e. its flow position. */
async function flowPosition(page, mac) {
  const wrapper = page.locator(`.vue-flow__node[data-id="${macColons(mac)}"]`);
  const transform = await wrapper.evaluate((el) => el.style.transform);
  const m = transform.match(/translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px\)/);
  expect(m, `transform of ${mac}: ${transform}`).not.toBeNull();
  return { x: Number(m[1]), y: Number(m[2]) };
}

/** Centre of the icon tile (= edge anchor) of a node, in page coordinates. */
async function tileCenter(page, mac) {
  const tile = node(page, mac).locator('[data-node-focus] > div').first();
  const box = await tile.boundingBox();
  expect(box, `tile box of ${mac}`).not.toBeNull();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Scroll the map fully into the viewport so page.mouse coordinates hit it. */
async function mapIntoView(page) {
  await page.getByTestId('map-container').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const box = await page.getByTestId('map-container').boundingBox();
  const vp = page.viewportSize();
  expect(box.y, 'map top inside viewport').toBeGreaterThanOrEqual(0);
  expect(box.y + box.height, 'map bottom inside viewport').toBeLessThanOrEqual(vp.height + 1);
}

/** Real mouse drag (Vue Flow uses d3-drag; needs intermediate moves past the 4 px threshold). */
async function drag(page, from, to, { beforeUp } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 6, from.y + 6, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 15 });
  if (beforeUp) await beforeUp();
  await page.mouse.up();
}

const zoomReadout = (page) => page.getByTestId('map-zoom-readout');

// ---------------------------------------------------------------------------------------------

test('(1) map is the default view: internet, gateway and every mock device node with category/online', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await waitForLive(page);
  const map = page.getByTestId('topology-map');
  await expect(map).toBeVisible();
  await expect(page.getByTestId('view-toggle-map')).toHaveAttribute('aria-checked', 'true');
  await expect(deviceRows(page)).toHaveCount(0);

  await expect(page.getByTestId('map-node-internet')).toHaveCount(1);
  await expect(page.getByTestId('map-node-internet')).toHaveAttribute('data-status', 'up');
  const gw = page.getByTestId('map-node-gateway');
  await expect(gw).toHaveCount(1);
  await expect(gw).toHaveAttribute('data-mac', macColons(GATEWAY));
  await expect(gw).toHaveAttribute('data-online', 'true');

  // internet + gateway + 9 others; WAN edge + one edge into each of the 9 others.
  await expect(mapNodes(page)).toHaveCount(MOCK_DEVICE_COUNT + 1);
  await expect(map).toHaveAttribute('data-node-count', String(MOCK_DEVICE_COUNT + 1));
  await expect(mapEdges(page)).toHaveCount(MOCK_DEVICE_COUNT);
  await expect(page.getByTestId('map-edge-internet')).toHaveAttribute('data-kind', 'wan');

  const expectCat = {
    [SELF]: 'laptop', [IPHONE]: 'phone', [PIXEL]: 'phone', [DECO]: 'access_point', [TV]: 'tv',
    [PRINTER]: 'printer', [SONOS]: 'speaker',
  };
  for (const mac of NON_GATEWAY) {
    const n = node(page, mac);
    await expect(n, mac).toBeVisible();
    await expect(n).toHaveAttribute('data-online', 'true');
    await expect(n).toHaveAttribute('data-mac', macColons(mac));
    await expect(n).toHaveAttribute('data-category', /.+/);
    if (expectCat[mac]) await expect(n).toHaveAttribute('data-category', expectCat[mac]);
    await expect(edge(page, mac)).toHaveAttribute('data-target', macColons(mac));
  }
  await expect(node(page, SELF)).toHaveAttribute('data-self', 'true');
  await expect(node(page, DECO)).toHaveAttribute('data-kind', 'hub');
  await expect(node(page, PIXEL)).toHaveAttribute('data-kind', 'device');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('(2) mock Deco AP is a hub with the iPhone, Pixel and LG TV connected through it', async ({ page }) => {
  await gotoMap(page);
  const deco = node(page, DECO);
  await expect(deco).toHaveAttribute('data-kind', 'hub');
  await expect(deco).toHaveAttribute('data-parent', 'gateway');
  // The "<n> devices" pill is level-of-detail (hidden below 55 % zoom); the aria-label always has it.
  await expect(deco.locator('[data-node-focus]')).toHaveAttribute('aria-label', /3 devices/);
  await expect(edge(page, DECO)).toHaveAttribute('data-kind', 'uplink');
  await expect(edge(page, DECO)).toHaveAttribute('data-source', macColons(GATEWAY));

  for (const mac of DECO_CHILDREN) {
    await expect(node(page, mac)).toHaveAttribute('data-parent', macColons(DECO));
    await expect(edge(page, mac)).toHaveAttribute('data-source', macColons(DECO));
    await expect(edge(page, mac)).toHaveAttribute('data-kind', 'lan');
  }
  for (const mac of [SELF, WINDOWS, PRINTER, SONOS, UNKNOWN]) {
    await expect(node(page, mac)).toHaveAttribute('data-parent', 'gateway');
    await expect(edge(page, mac)).toHaveAttribute('data-source', macColons(GATEWAY));
  }
});

test('(3) clicking a node opens the detail panel; Esc closes it; self shows throughput', async ({ page }) => {
  await gotoMap(page);
  await node(page, IPHONE).locator('[data-node-focus]').click();

  const p = panel(page);
  await expect(p).toBeVisible();
  await expect(p).toHaveAttribute('data-mac', macColons(IPHONE));
  await expect(node(page, IPHONE)).toHaveAttribute('data-selected', 'true');
  await expect(p.getByTestId('detail-name')).toHaveText(/Jons-iPhone/);
  await expect(p.getByTestId('detail-type')).toContainText('iPhone 15 Pro');
  await expect(p.getByTestId('detail-ip')).toContainText('192.168.1.61');
  await expect(p.getByTestId('detail-mac')).toContainText(/5a[:-]1f[:-]3e[:-]8c[:-]44[:-]04/i);
  expect(await p.getByTestId('detail-evidence').locator('li').count()).toBeGreaterThanOrEqual(1);
  await expect(p.getByTestId('detail-throughput')).toContainText('Requires router integration');
  await expect(p.getByTestId('detail-connected-via')).toHaveValue(macColons(DECO));

  await page.keyboard.press('Escape');
  await expect(p).toHaveCount(0);
  await expect(node(page, IPHONE)).toHaveAttribute('data-selected', 'false');

  // This computer: throughput measured locally.
  await node(page, SELF).locator('[data-node-focus]').click();
  await expect(p).toHaveAttribute('data-mac', macColons(SELF));
  await expect(p.getByTestId('detail-badge-self')).toBeVisible();
  const tp = p.getByTestId('detail-throughput');
  await expect(tp).toHaveAttribute('data-rx', /\d/);
  await expect(tp).not.toContainText('Requires router integration');

  // X closes too.
  await p.getByTestId('detail-close-btn').click();
  await expect(p).toHaveCount(0);
});

test('(4) search highlights the match and dims every other node', async ({ page }) => {
  await gotoMap(page);
  await page.getByTestId('search-input').fill('pixel');

  await expect(node(page, PIXEL)).toHaveAttribute('data-dimmed', 'false');
  await expect(node(page, PIXEL)).toHaveAttribute('data-highlighted', 'true');
  for (const mac of NON_GATEWAY.filter((m) => m !== PIXEL)) {
    await expect(node(page, mac), mac).toHaveAttribute('data-dimmed', 'true');
  }
  // Gateway is never dimmed.
  await expect(page.getByTestId('map-node-gateway')).toHaveAttribute('data-dimmed', 'false');
  await expect(edge(page, PIXEL)).toHaveAttribute('data-dimmed', 'false');
  await expect(edge(page, SONOS)).toHaveAttribute('data-dimmed', 'true');
  await expect(page.getByTestId('map-filter-bar')).toContainText(/Highlighting 1 of 10/);

  await page.getByTestId('clear-filters-btn').click();
  await expect(page.getByTestId('search-input')).toHaveValue('');
  await expect(page.getByTestId('map-filter-bar')).toHaveCount(0);
  for (const mac of NON_GATEWAY) await expect(node(page, mac)).toHaveAttribute('data-dimmed', 'false');
});

test('(5) an offline saved device is a dimmed node with a dashed offline edge', async ({ page, request }) => {
  await saveViaApi(request, TV, 'Bedroom TV');
  await gotoMap(page);
  await expect(node(page, TV)).toHaveAttribute('data-online', 'true');

  await mock(request, { devicesOffline: [macColons(TV)] });

  const n = node(page, TV);
  await expect(n).toHaveAttribute('data-online', 'false', { timeout: 15_000 });
  await expect(n).toHaveAttribute('data-quality', 'offline');
  await expect(n).toHaveClass(/opacity-60/);
  const e = edge(page, TV);
  await expect(e).toHaveAttribute('data-quality', 'offline');
  await expect(e).toHaveAttribute('data-online', 'false');
  await expect(e).toHaveAttribute('data-animated', 'false');
  const dash = await e.locator('path.nm-link-line').evaluate((p) => getComputedStyle(p).strokeDasharray);
  expect(dash).not.toBe('none');
  // Still connected via the Deco (override kept while offline).
  await expect(n).toHaveAttribute('data-parent', macColons(DECO));

  await mock(request, { devicesOffline: [] });
  await expect(n).toHaveAttribute('data-online', 'true', { timeout: 15_000 });
});

test('(6) dragging a node to empty canvas pins it; position persists after reload; Reset layout clears it', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await gotoMap(page);
  await mapIntoView(page);
  const relayout = page.getByTestId('map-relayout-btn');
  await expect(relayout).toBeDisabled();
  await expect(node(page, PRINTER)).toHaveAttribute('data-pinned', 'false');
  const before = await flowPosition(page, PRINTER);

  const from = await tileCenter(page, PRINTER);
  const put = page.waitForResponse((r) => r.url().includes(`/api/topology/`) && r.request().method() === 'PUT');
  await drag(page, from, { x: from.x + 50, y: from.y + 60 });
  const res = await put;
  expect(res.status()).toBe(200);
  expect(res.request().postDataJSON()).toHaveProperty('position');

  await expect(node(page, PRINTER)).toHaveAttribute('data-pinned', 'true');
  await expect(node(page, PRINTER)).toHaveAttribute('data-parent', 'gateway'); // a move is not a re-parent
  await expect(relayout).toBeEnabled();
  await expect(relayout).toHaveAttribute('data-pinned-count', '1');

  const stored = (await overrides(request))[macColons(PRINTER)];
  expect(stored?.position, JSON.stringify(stored)).toBeTruthy();
  expect(stored.parentMac).toBeNull();
  const after = await flowPosition(page, PRINTER);
  expect(Math.abs(after.x - before.x) + Math.abs(after.y - before.y)).toBeGreaterThan(20);
  expect(Math.abs(stored.position.x - after.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(stored.position.y - after.y)).toBeLessThanOrEqual(1);

  await gotoMap(page);
  await expect(node(page, PRINTER)).toHaveAttribute('data-pinned', 'true');
  const reloaded = await flowPosition(page, PRINTER);
  expect(Math.abs(reloaded.x - stored.position.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(reloaded.y - stored.position.y)).toBeLessThanOrEqual(1);

  await relayout.click();
  await expect(node(page, PRINTER)).toHaveAttribute('data-pinned', 'false');
  await expect(relayout).toBeDisabled();
  await expect.poll(async () => (await overrides(request))[macColons(PRINTER)] ?? null).toBeNull();
  // "Connected via" defaults survive a layout reset.
  await expect(node(page, IPHONE)).toHaveAttribute('data-parent', macColons(DECO));
  await expect.poll(async () => flowPosition(page, PRINTER)).toEqual(before);
});

test('(7) dragging a device onto the AP re-parents it; edge source changes and persists', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await gotoMap(page);
  await mapIntoView(page);
  await expect(node(page, SONOS)).toHaveAttribute('data-parent', 'gateway');
  const from = await tileCenter(page, SONOS);
  const to = await tileCenter(page, DECO);

  await drag(page, from, to, {
    beforeUp: async () => {
      await expect(node(page, DECO).getByTestId('map-drop-hint')).toBeVisible();
      await expect(node(page, DECO).getByTestId('map-drop-hint')).toContainText(/Drop to connect via Deco/);
    },
  });

  await expect(node(page, SONOS)).toHaveAttribute('data-parent', macColons(DECO));
  await expect(edge(page, SONOS)).toHaveAttribute('data-source', macColons(DECO));
  await expect(node(page, SONOS)).toHaveAttribute('data-pinned', 'false');
  await expect(node(page, DECO).locator('[data-node-focus]')).toHaveAttribute('aria-label', /4 devices/);
  await expect(page.getByTestId('map-drop-hint')).toHaveCount(0);
  await expect.poll(async () => (await overrides(request))[macColons(SONOS)]?.parentMac ?? null).toBe(macColons(DECO));

  await gotoMap(page);
  await expect(node(page, SONOS)).toHaveAttribute('data-parent', macColons(DECO));
  await expect(edge(page, SONOS)).toHaveAttribute('data-source', macColons(DECO));
});

test('(8) "Connected via" select re-parents a device to the gateway and back; persists after reload', async ({ page, request }) => {
  await gotoMap(page);
  await node(page, IPHONE).locator('[data-node-focus]').click();
  const select = panel(page).getByTestId('detail-connected-via');
  await expect(select).toHaveValue(macColons(DECO));

  await select.selectOption('');
  await expect(node(page, IPHONE)).toHaveAttribute('data-parent', 'gateway');
  await expect(edge(page, IPHONE)).toHaveAttribute('data-source', macColons(GATEWAY));
  // parentMac null + position null = default -> the server drops the entry (TOPOLOGY §7.1).
  await expect.poll(async () => macColons(IPHONE) in (await overrides(request))).toBe(false);

  await gotoMap(page);
  await expect(node(page, IPHONE)).toHaveAttribute('data-parent', 'gateway');
  await expect(edge(page, IPHONE)).toHaveAttribute('data-source', macColons(GATEWAY));

  // And re-parent the printer onto the Deco from the panel.
  await node(page, PRINTER).locator('[data-node-focus]').click();
  await expect(panel(page)).toHaveAttribute('data-mac', macColons(PRINTER));
  await panel(page).getByTestId('detail-connected-via').selectOption(macColons(DECO));
  await expect(node(page, PRINTER)).toHaveAttribute('data-parent', macColons(DECO));
  await expect(edge(page, PRINTER)).toHaveAttribute('data-source', macColons(DECO));
  await expect.poll(async () => (await overrides(request))[macColons(PRINTER)]?.parentMac ?? null).toBe(macColons(DECO));
});

test('(9) zoom buttons change the zoom and Fit to screen restores the fitted view', async ({ page }) => {
  await gotoMap(page);
  const readout = zoomReadout(page);
  await expect(readout).toHaveText(/^\d+%$/);
  const fitted = (await readout.textContent()).trim();

  await page.getByTestId('map-zoom-in-btn').click();
  await expect(readout).not.toHaveText(fitted);
  await page.getByTestId('map-zoom-in-btn').click();
  const zoomed = parseInt(await readout.textContent(), 10);
  expect(zoomed).toBeGreaterThan(parseInt(fitted, 10));

  await page.getByTestId('map-fit-btn').click();
  await expect(readout).toHaveText(fitted);
  // Every node is inside the map after fitting.
  const mapBox = await page.getByTestId('topology-map').boundingBox();
  for (const mac of NON_GATEWAY) {
    const b = await node(page, mac).boundingBox();
    expect(b.x, mac).toBeGreaterThanOrEqual(mapBox.x - 1);
    expect(b.y, mac).toBeGreaterThanOrEqual(mapBox.y - 1);
    expect(b.x + b.width, mac).toBeLessThanOrEqual(mapBox.x + mapBox.width + 1);
    expect(b.y + b.height, mac).toBeLessThanOrEqual(mapBox.y + mapBox.height + 1);
  }

  await page.getByTestId('map-zoom-out-btn').click();
  await expect(readout).not.toHaveText(fitted);
});

test('(10) view toggle switches map <-> list, is remembered, and ?view= overrides it', async ({ page }) => {
  await gotoMap(page);
  await page.getByTestId('view-toggle-list').click();
  await expect(page.getByTestId('topology-map')).toHaveCount(0);
  await expect(deviceRows(page)).toHaveCount(MOCK_DEVICE_COUNT);
  await expect(page.getByTestId('view-toggle-list')).toHaveAttribute('aria-checked', 'true');

  // Remembered across a plain reload.
  await page.goto('/');
  await waitForLive(page);
  await expect(deviceRows(page)).toHaveCount(MOCK_DEVICE_COUNT);
  await expect(page.getByTestId('topology-map')).toHaveCount(0);

  // ?view=map wins over the remembered list.
  await gotoMap(page);
  await expect(deviceRows(page)).toHaveCount(0);

  await page.getByTestId('view-toggle-map').click(); // already map: no-op
  await gotoList(page);
  await expect(page.getByTestId('topology-map')).toHaveCount(0);
  await page.getByTestId('view-toggle-map').click();
  await expect(page.getByTestId('topology-map')).toBeVisible();
  await expect(deviceRows(page)).toHaveCount(0);
});

test('(11) internet down: the internet node and WAN edge show the down state', async ({ page, request }) => {
  await gotoMap(page);
  const inet = page.getByTestId('map-node-internet');
  await expect(inet).toHaveAttribute('data-status', 'up');

  await mock(request, { internetDown: true });
  await expect(inet).toHaveAttribute('data-status', 'down');
  await expect(page.getByTestId('map-edge-internet')).toHaveAttribute('data-quality', 'down');
  await expect(page.getByTestId('map-edge-internet')).toHaveAttribute('data-animated', 'false');
  await expect(inet).toContainText(/Down/);

  await mock(request, { internetDown: false });
  await expect(inet).toHaveAttribute('data-status', 'up');
  await expect(page.getByTestId('map-edge-internet')).not.toHaveAttribute('data-quality', 'down');
});

test('(12) reduced motion: no flow-dot animations', async ({ page }) => {
  await gotoMap(page);
  await expect(page.locator('[data-testid="topology-map"] animateMotion').first()).toBeAttached();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('[data-testid="topology-map"] animateMotion')).toHaveCount(0);
  await expect(page.locator('[data-testid^="map-edge-"][data-animated="true"]')).toHaveCount(0);
});

test('(13) topology API validation and DELETE scope=all', async ({ request }) => {
  const put = (mac, data) => request.put(`/api/topology/${mac}`, { data });
  expect((await put(SONOS, { parentMac: macColons(PRINTER) })).status()).toBe(400); // not a hub
  expect((await put(SONOS, { parentMac: macColons(SONOS) })).status()).toBe(400); // self parent
  expect((await put(SONOS, { position: { x: 10001, y: 0 } })).status()).toBe(400);
  expect((await put(SONOS, {})).status()).toBe(400);
  expect((await put(GATEWAY, { parentMac: macColons(DECO) })).status()).toBe(400);
  expect((await put('de-ad-be-ef-00-01', { position: { x: 1, y: 1 } })).status()).toBe(404);

  // Loop: make the Sonos a second hub (type access_point), hang it off the Deco, then try to hang the
  // Deco off the Sonos. resetMock in beforeEach clears the saved type and the overrides afterwards.
  const asAp = await request.put(`/api/devices/${SONOS}`, { data: { name: 'SonosAP', type: 'access_point', notes: '' } });
  expect(asAp.ok(), `PUT /api/devices/${SONOS} -> ${asAp.status()} ${await asAp.text()}`).toBeTruthy();
  const sonosUnderDeco = await put(SONOS, { parentMac: macColons(DECO) });
  expect(sonosUnderDeco.status(), await sonosUnderDeco.text()).toBe(200);
  const loop = await put(DECO, { parentMac: macColons(SONOS) });
  expect(loop.status()).toBe(400);
  const loopBody = await loop.json();
  expect(loopBody.details?.parentMac).toBe('That would create a loop');
  // The rejected PUT left the Deco under the gateway.
  expect((await overrides(request))[macColons(DECO)]?.parentMac ?? null).toBeNull();

  const ok = await put(SONOS, { parentMac: macColons(DECO), position: { x: 12.345, y: -5 } });
  expect(ok.status()).toBe(200);
  const body = await ok.json();
  expect(body.override.position).toEqual({ x: 12.3, y: -5 });

  const del = await request.delete('/api/topology?scope=all');
  expect(del.status()).toBe(200);
  const after = (await del.json()).overrides;
  expect(Object.keys(after).sort()).toEqual(DECO_CHILDREN.map(macColons).sort());
  expect((await request.delete('/api/topology?scope=bogus')).status()).toBe(400);
});

test('(14) mobile 390x844: tapping a node opens the full-screen sheet; no horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'light' });
  await gotoMap(page);
  await page.getByTestId('topology-map').scrollIntoViewIfNeeded();
  const noHScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(await noHScroll()).toBe(true);
  await shot(page, 'topology-mobile.png');

  // Phone widths open at a readable zoom centred on the gateway, so outer nodes can be off-canvas
  // (pan to reach them). The Fit button always shows the whole network.
  await page.getByTestId('map-fit-btn').click();
  await expect.poll(() => nodeInsideMap(page, IPHONE)).toBe(true);
  await node(page, IPHONE).locator('[data-node-focus]').click();
  const p = panel(page);
  await expect(p).toBeVisible();
  await expect(p).toHaveAttribute('data-mode', 'sheet');
  await expect(p.getByTestId('detail-name')).toHaveText(/Jons-iPhone/);
  expect(await noHScroll()).toBe(true);
  await p.getByTestId('detail-close-btn').click();
  await expect(p).toHaveCount(0);
});

test('(15) screenshots: dark and light map', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const scheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: scheme });
    await gotoMap(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    await expect(mapNodes(page)).toHaveCount(MOCK_DEVICE_COUNT + 1);
    await page.getByTestId('devices-panel').scrollIntoViewIfNeeded();
    await shot(page, `topology-${scheme}.png`);
  }
});
