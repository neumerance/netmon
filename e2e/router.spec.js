// Router integration panel (syslog + SNMP) against the mock router (server/src/mock/router.js).
import { test, expect } from '@playwright/test';
import { resetMock } from './helpers.js';

test.beforeEach(async ({ request }) => {
  await resetMock(request);
});

test('router panel starts off and offers setup', async ({ page }) => {
  await page.goto('/?view=list');
  const panel = page.getByTestId('router-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Connect NetMon to your router');
  await expect(page.getByTestId('router-setup-open')).toBeVisible();
});

test('setting up SNMP and syslog shows ports, rates and log lines', async ({ page }) => {
  await page.goto('/?view=list');
  await page.getByTestId('router-setup-open').click();
  await page.getByTestId('router-syslog-toggle').click();
  await page.getByTestId('router-snmp-toggle').click();
  await page.getByTestId('router-snmp-community').fill('e2e-community');
  await page.getByTestId('router-snmp-interval').fill('5');

  await page.getByTestId('router-snmp-test').click();
  await expect(page.getByTestId('router-snmp-test-result')).toContainText('mock-router answered · 5 ports');

  await page.getByTestId('router-save').click();
  await expect(page.getByTestId('router-setup')).toHaveCount(0);
  await expect(page.getByTestId('router-snmp-status')).toHaveText('SNMP ok');

  // Up ports only by default (2 of the 5 mock ports are down).
  const ports = page.getByTestId('router-port');
  await expect(ports).toHaveCount(3);
  await expect(page.locator('[data-testid="router-port"][data-port="eth0"]')).toBeVisible();
  // The second poll (5 s) produces rates.
  await expect(page.locator('[data-testid="router-port"][data-port="eth0"] td').nth(2)).toHaveText(/Mbps/, { timeout: 12_000 });

  // The mock router sends a line every 4 s.
  await expect(page.getByTestId('router-log-line').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('router-syslog-status')).toHaveText('Log live');
});

test('the community is never sent back to the browser', async ({ page, request }) => {
  const put = await request.put('/api/router/config', { data: { snmp: { enabled: true, community: 'top-secret-xyz' } } });
  expect(put.ok()).toBeTruthy();
  const body = await put.text();
  expect(body).not.toContain('top-secret-xyz');
  expect(JSON.parse(body).config.snmp.communitySet).toBe(true);
  expect(await (await request.get('/api/snapshot')).text()).not.toContain('top-secret-xyz');
  expect(await (await request.get('/api/router')).text()).not.toContain('top-secret-xyz');

  await page.goto('/?view=list');
  await page.getByTestId('router-settings').click();
  await expect(page.getByTestId('router-snmp-community')).toHaveValue('');
  await expect(page.getByTestId('router-snmp-community')).toHaveAttribute('placeholder', /saved/);
});

test('invalid router settings show field errors', async ({ page }) => {
  await page.goto('/?view=list');
  await page.getByTestId('router-setup-open').click();
  await page.getByTestId('router-snmp-toggle').click();
  await page.getByTestId('router-snmp-host').fill('not-an-ip');
  await page.getByTestId('router-save').click();
  await expect(page.getByTestId('router-setup')).toContainText('Must be an IPv4 address');
});
