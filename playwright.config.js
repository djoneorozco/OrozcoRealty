import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests', testMatch: '**/*.spec.js', timeout: 30000, workers: 2,
  use: { baseURL: 'http://127.0.0.1:4178', headless: true, screenshot: 'only-on-failure' },
  webServer: { command: 'npm run build && node tests/server.mjs', url: 'http://127.0.0.1:4178', reuseExistingServer: false },
  reporter: [['list']] });
