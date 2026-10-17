// Shared E2E helpers for driving the mock backend (PLAN §7.4) and opening the dashboard in a
// given devices view (TOPOLOGY §8.1: Map is the default, `?view=list|map` overrides it).
import { expect } from '@playwright/test';

export const MOCK_DEVICE_COUNT = 10;

// ---------------------------------------------------------------------------------------------
// MAC / testid helpers (PLAN conventions: JSON uses lowercase colons, testids/URLs use dashes)
// ---------------------------------------------------------------------------------------------

/** 'A4:83:E7:1C:2D:01' | 'a4-83-e7-1c-2d-01' -> 'a4-83-e7-1c-2d-01' */
export const macDashes = (mac) => String(mac).trim().toLowerCase().replace(/[:-]/g, '-');
/** 'a4-83-e7-1c-2d-01' -> 'a4:83:e7:1c:2d:01' */
export const macColons = (mac) => String(mac).trim().toLowerCase().replace(/[:-]/g, ':');

/** List-view row / card testid for a device. */
export const deviceTestId = (mac) => `device-row-${macDashes(mac)}`;
/** Map-view node testid for a hub/device (TOPOLOGY §3 `testidForMac`). */
export const mapNodeTestId = (mac) => `map-node-${macDashes(mac)}`;
/** Map-view edge testid for the link into a hub/device. */
export const mapEdgeTestId = (mac) => `map-edge-${macDashes(mac)}`;

/** All list rows/cards (never rendered by the map view). */
export const deviceRows = (page) => page.locator('[data-testid^="device-row-"]');
/** One list row/card by MAC (either form). */
export const deviceRow = (page, mac) => page.getByTestId(deviceTestId(mac));

// ---------------------------------------------------------------------------------------------
// Mock control
// ---------------------------------------------------------------------------------------------

/** POST /api/mock/state and assert it succeeded. */
export async function mock(request, data) {
  const res = await request.post('/api/mock/state', { data });
  expect(res.ok(), `mock/state ${JSON.stringify(data)} -> ${res.status()}`).toBeTruthy();
  return res.json();
}

const listOf = (body) => (Array.isArray(body) ? body : body?.devices) || [];

let startupSettled = false;

/**
 * Wait (once per worker) until the mock server's startup speed test has had its chance to run
 * and has finished. A reset is meant to cancel it (PLAN §7.4); this guard keeps specs that are
 * run on their own deterministic either way.
 */
export async function waitForStartup(request) {
  if (startupSettled) return;
  await expect
    .poll(async () => (await (await request.get('/api/health')).json()).uptimeSec, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(4);
  await expect
    .poll(async () => (await (await request.get('/api/snapshot')).json()).speed?.running, { timeout: 15_000 })
    .toBe(false);
  startupSettled = true;
}

/**
 * Reset the mock world and wait until it is deterministic again: the next mock scan has
 * repopulated all devices online, every device is fingerprinted (has evidence, not
 * "Identifying…"), and no speed test is running. Without this, PUT /api/devices/:mac can
 * 404 and rows can briefly render as "Unknown device".
 *
 * The reset also restores the topology mock defaults (TOPOLOGY §10.1: `topology.reset({scope:'all'})`)
 * and clears the speed controller's manual-test cooldown (the mock is exempt from it anyway).
 */
export async function resetMock(request, { devices = MOCK_DEVICE_COUNT } = {}) {
  await waitForStartup(request);
  await mock(request, { reset: true });
  await expect
    .poll(async () => {
      const res = await request.get('/api/devices');
      if (!res.ok()) return `HTTP ${res.status()}`;
      const list = listOf(await res.json());
      const ready = list.filter((d) => d.online && !d.fingerprinting && (d.typeEvidence || []).length > 0);
      return `${ready.length}/${list.length}`;
    }, { timeout: 10_000, message: 'mock devices online and fingerprinted after reset' })
    .toBe(`${devices}/${devices}`);
  await expect
    .poll(async () => (await (await request.get('/api/snapshot')).json()).speed?.running, { timeout: 10_000 })
    .toBe(false);
}

// ---------------------------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------------------------

/** Wait for the live stream (SSE) to be open. */
export async function waitForLive(page) {
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-status', 'open');
}

/**
 * Open the dashboard in the List view (`/?view=list`) and wait for the live stream and, unless
 * `devices` is null, for that many device rows.
 */
export async function gotoList(page, { devices = MOCK_DEVICE_COUNT } = {}) {
  await page.goto('/?view=list');
  await waitForLive(page);
  if (devices != null) await expect(deviceRows(page)).toHaveCount(devices);
}

/**
 * Re-open the List view with a full page load (use instead of `page.reload()` for
 * "persists after reload" checks so the list view does not depend on the URL being kept).
 */
export const reloadList = (page, opts) => gotoList(page, opts);

/** Open the dashboard in the Map view (`/?view=map`) and wait for the live stream and the map. */
export async function gotoMap(page) {
  await page.goto('/?view=map');
  await waitForLive(page);
  await expect(page.getByTestId('topology-map')).toBeVisible();
}

/**
 * True when a map node's tile lies fully inside the visible map canvas (the flow is clipped by the
 * map container, so a node can be "visible" to Playwright yet off-canvas and untappable).
 */
export async function nodeInsideMap(page, mac) {
  const mapBox = await page.getByTestId('topology-map').boundingBox();
  const b = await page.getByTestId(mapNodeTestId(mac)).boundingBox();
  if (!mapBox || !b) return false;
  return (
    b.x >= mapBox.x - 1 &&
    b.y >= mapBox.y - 1 &&
    b.x + b.width <= mapBox.x + mapBox.width + 1 &&
    b.y + b.height <= mapBox.y + mapBox.height + 1
  );
}
