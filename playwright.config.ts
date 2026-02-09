import { defineConfig, devices } from '@playwright/test'
import path from 'path'

// Use a separate data directory for E2E tests to avoid polluting production data
const e2eDataDir = path.join(__dirname, '.e2e-data')

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,  // Run tests serially for more reliable state management
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,  // Use single worker to avoid database conflicts
  reporter: [['html', { open: 'never' }], ['list']],

  // Global setup to reset test data before all tests
  globalSetup: './e2e/global-setup.ts',

  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'web-chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'electron',
      // Custom fixture handles Electron launch
    },
  ],

  webServer: [
    {
      command: `SUPERAGENT_DATA_DIR="${e2eDataDir}" E2E_MOCK=true tsx src/web/server.ts`,
      url: 'http://localhost:47891/api/settings',
      reuseExistingServer: false,  // Always start fresh to ensure E2E_MOCK is set
      timeout: 120000,
      stdout: 'pipe',
    },
    {
      command: `SUPERAGENT_DATA_DIR="${e2eDataDir}" E2E_MOCK=true npm run dev:web`,
      url: 'http://localhost:3000',
      reuseExistingServer: false,  // Always start fresh for E2E tests
      timeout: 120000,
      stdout: 'pipe',
    },
  ],
})
