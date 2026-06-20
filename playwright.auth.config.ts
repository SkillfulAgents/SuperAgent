import { defineConfig, devices } from '@playwright/test'
import path from 'path'

// Use a separate data directory for auth E2E tests.
const e2eDataDir = path.resolve(process.env.SUPERAGENT_DATA_DIR ?? path.join(__dirname, '.e2e-data-auth'))
const e2ePort = process.env.E2E_PORT ?? process.env.PORT ?? '3001'
const e2eBaseUrl = process.env.E2E_BASE_URL ?? `http://localhost:${e2ePort}`
const playwrightOutputDir = process.env.PLAYWRIGHT_OUTPUT_DIR ?? 'test-results'
const playwrightHtmlReportDir = process.env.PLAYWRIGHT_HTML_REPORT ?? 'playwright-report'

export default defineConfig({
  testDir: './e2e/auth/specs',
  outputDir: playwrightOutputDir,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: playwrightHtmlReportDir }]],

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
    command: `SUPERAGENT_DATA_DIR="${e2eDataDir}" AUTH_MODE=true node e2e/setup-e2e-data.js && SUPERAGENT_DATA_DIR="${e2eDataDir}" E2E_MOCK=true AUTH_MODE=true ANTHROPIC_API_KEY=sk-ant-e2e-mock PORT=${e2ePort} npm run dev:web`,
    url: `${e2eBaseUrl}/api/settings`,
    reuseExistingServer: false,
    timeout: 120000,
    stdout: 'pipe',
  },
})
