// Browser end-to-end tests. Uses the locally installed Microsoft Edge (no browser download needed);
// set E2E_CHANNEL=chrome or run `npx playwright install chromium` and E2E_CHANNEL= to change.
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

const PORT = 3100;
const dataDir = path.join(os.tmpdir(), `sdlc-e2e-${process.env.E2E_RUN_ID || (process.env.E2E_RUN_ID = String(Date.now()))}`);

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: process.env.E2E_CHANNEL ?? 'msedge',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node src/server.js',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    env: { PORT: String(PORT), DATA_DIR: dataDir, AI_MODE: 'mock', DEMO_PASSWORD: 'E2ePassword123', APP_SECRET: 'e2e-secret-not-for-production', SEED_DEMO_USERS: 'true' },
  },
});
