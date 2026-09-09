import { defineConfig } from '@playwright/test';
import process from 'node:process';
import path from 'node:path';

if (process.env.E2E_BASE_URL !== 'http://127.0.0.1:20058' || !process.env.E2E_ARTIFACT_DIR) {
  throw new Error('Use npm run test:e2e to start the isolated real backend first');
}

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 15_000 },
  outputDir: path.join(process.env.E2E_ARTIFACT_DIR, 'browser'),
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL,
    browserName: 'chromium',
    viewport: { width: 1440, height: 1100 },
    screenshot: 'only-on-failure',
    // Trace 会包含鉴权头和登录响应，因此仅保留安全的定制证据。
    trace: 'off',
    video: 'off',
    launchOptions: process.env.E2E_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE } : {},
  },
});
