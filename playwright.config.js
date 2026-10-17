import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// One throw-away data dir per test run (kept across config re-evaluation in workers).
const dataDir = process.env.NETMON_E2E_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'netmon-e2e-'));
process.env.NETMON_E2E_DATA_DIR = dataDir;

// Port of the mock server under test. Override with NETMON_E2E_PORT to run several suites side by side,
// e.g. `NETMON_E2E_PORT=4180 npx playwright test e2e/alerts.spec.js`.
const port = String(process.env.NETMON_E2E_PORT || 4100);
if (!/^\d{2,5}$/.test(port)) throw new Error(`NETMON_E2E_PORT must be a port number, got "${port}"`);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node server/src/index.js',
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: { NETMON_MOCK: '1', NETMON_DATA_DIR: dataDir, PORT: port, HOST: '127.0.0.1' },
  },
});
