import { defineConfig, devices } from '@playwright/test'
import path from 'path'

// Use a separate data directory for auth E2E tests. CI can override the path
// and port when running auth alongside the other E2E suites in one job.
const e2eDataDir = path.resolve(process.env.SUPERAGENT_DATA_DIR ?? path.join(__dirname, '.e2e-data-auth'))
const e2ePort = process.env.PORT ?? process.env.E2E_PORT ?? '3001'
const e2eBaseUrl = process.env.E2E_BASE_URL ?? `http://localhost:${e2ePort}`
process.env.SUPERAGENT_DATA_DIR = e2eDataDir
process.env.AUTH_MODE = 'true'
process.env.E2E_MOCK = 'true'
process.env.AUTH_RATE_LIMIT_MAX = '10000'
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-e2e-mock'

export default defineConfig({
  testDir: './e2e/auth/specs',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['html', { open: 'never' }], ['list']],

  use: {
    baseURL: e2eBaseUrl,
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
    command: `SUPERAGENT_DATA_DIR="${e2eDataDir}" AUTH_MODE=true node e2e/setup-e2e-data.js && SUPERAGENT_DATA_DIR="${e2eDataDir}" E2E_MOCK=true AUTH_MODE=true AUTH_RATE_LIMIT_MAX=10000 ANTHROPIC_API_KEY=sk-ant-e2e-mock PORT=${e2ePort} npm run dev:web`,
    url: `${e2eBaseUrl}/api/settings`,
    reuseExistingServer: false,
    timeout: 120000,
    stdout: 'pipe',
  },
})
