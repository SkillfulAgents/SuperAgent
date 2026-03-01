import { defineConfig, devices } from '@playwright/test'
import path from 'path'

// Use a separate data directory for auth E2E tests
const e2eDataDir = path.join(__dirname, '.e2e-data-auth')

export default defineConfig({
  testDir: './e2e/auth/specs',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['html', { open: 'never' }], ['list']],

  globalSetup: './e2e/auth/global-setup.ts',

  use: {
    baseURL: 'http://localhost:3001',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'auth-chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: `SUPERAGENT_DATA_DIR="${e2eDataDir}" E2E_MOCK=true AUTH_MODE=true ANTHROPIC_API_KEY=sk-ant-e2e-mock PORT=3001 npm run dev:web`,
    url: 'http://localhost:3001/api/settings',
    reuseExistingServer: false,
    timeout: 120000,
    stdout: 'pipe',
  },
})
