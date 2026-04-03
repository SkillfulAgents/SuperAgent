import { defineConfig, devices, chromium } from '@playwright/test'
import path from 'path'

// Use a separate data directory for E2E tests to avoid polluting production data
const e2eDataDir = path.join(__dirname, '.e2e-data')

// Resolve Playwright's bundled Chromium path for the browser streaming E2E test.
// This allows the mock container to launch a real headless browser without requiring
// Chrome to be installed on the system (works in GHA).
let chromiumPath: string | undefined
try {
  chromiumPath = chromium.executablePath()
} catch {
  // Chromium not installed (e.g., `npx playwright install` hasn't been run yet)
}

export default defineConfig({
  testDir: './e2e',
  testIgnore: ['**/auth/**'],  // Auth tests use separate config (playwright.auth.config.ts)
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : 2,
  reporter: process.env.CI ? [['list']] : [['html', { open: 'never' }], ['list']],

  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      // Wizard tests toggle setupCompleted (global shared state).
      // Must run alone before anything else to avoid poisoning other tests.
      name: 'wizard',
      testMatch: '**/getting-started-wizard.spec.ts',
      use: { ...devices['Desktop Chrome'] },
      fullyParallel: false,
    },
    {
      // Settings/policy tests modify global settings but don't toggle setupCompleted.
      // Safe to run after wizard tests complete.
      name: 'global-state',
      testMatch: [
        '**/settings.spec.ts',
        '**/policy-settings.spec.ts',
      ],
      use: { ...devices['Desktop Chrome'] },
      fullyParallel: false,
      dependencies: ['wizard'],
    },
    {
      name: 'web-chromium',
      testIgnore: [
        '**/auth/**',
        '**/getting-started-wizard.spec.ts',
        '**/settings.spec.ts',
        '**/policy-settings.spec.ts',
      ],
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['global-state'],
    },
  ],

  webServer: {
    command: `SUPERAGENT_DATA_DIR="${e2eDataDir}" node e2e/setup-e2e-data.js && SUPERAGENT_DATA_DIR="${e2eDataDir}" E2E_MOCK=true PORT=3000${chromiumPath ? ` E2E_CHROMIUM_PATH='${chromiumPath}'` : ''} npm run dev:web`,
    url: 'http://localhost:3000/api/settings',  // Wait for API to be ready, not just Vite
    reuseExistingServer: false,  // Always start fresh for E2E tests
    timeout: 120000,
    stdout: 'pipe',
  },
})
