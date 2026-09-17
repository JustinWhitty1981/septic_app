import { defineConfig } from '@playwright/test';

// The app is served on host port 5555 (see the e2e service in docker-compose.yml:
// the runner shares the host network, so localhost:5555 is the host's mapping).
// 3000 is taken by the long-running frontend container and is left alone.
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5555',
    headless: true,
    viewport: { width: 1280, height: 720 },
  },
});
