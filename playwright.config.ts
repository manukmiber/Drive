// E2E (SPEC §15 Fase 12): main user journeys against `npm run dev` (all adapters mock).
// Browser: PW_CHROMIUM (default /usr/bin/chromium) so no Playwright browser download is needed.
import { defineConfig, devices } from '@playwright/test';

const executablePath = process.env.PW_CHROMIUM ?? '/usr/bin/chromium';
const launchOptions = { executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] };

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    locale: 'id-ID',
    timezoneId: 'Asia/Jakarta',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/, use: { launchOptions } },
    {
      name: 'desktop',
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], channel: undefined, launchOptions },
    },
    { name: 'mobile', dependencies: ['setup'], use: { ...devices['Pixel 7'], launchOptions } },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:8790/api/health',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
