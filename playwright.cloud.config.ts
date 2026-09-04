import { defineConfig, devices, chromium } from '@playwright/test'
import path from 'path'

// Seeds a cloud container runner so the shared-volumes spec exercises the real capability gate. E2E_MOCK still swaps in the mock client.
const defaultE2eDataDir = path.join(__dirname, '.e2e-data', 'cloud')
if (!process.env.SUPERAGENT_DATA_DIR) {
  process.env.SUPERAGENT_DATA_DIR = defaultE2eDataDir
}
const e2eDataDir = path.resolve(process.env.SUPERAGENT_DATA_DIR)
const e2ePort = process.env.E2E_PORT ?? process.env.PORT ?? '3011'
const e2eBaseUrl = process.env.E2E_BASE_URL ?? `http://localhost:${e2ePort}`
const playwrightOutputDir = process.env.PLAYWRIGHT_OUTPUT_DIR ?? 'test-results/cloud'
const playwrightHtmlReportDir = process.env.PLAYWRIGHT_HTML_REPORT ?? 'playwright-report/cloud'

let chromiumPath: string | undefined
try {
  chromiumPath = chromium.executablePath()
} catch {
  // Chromium not installed (e.g., `npx playwright install` hasn't been run yet)
}

const isWindows = process.platform === 'win32'
function buildWebServerCommand() {
  const env: Record<string, string> = {
    SUPERAGENT_DATA_DIR: e2eDataDir,
    E2E_MOCK: 'true',
    PORT: e2ePort,
    VITE_CACHE_DIR: path.join(e2eDataDir, '.vite'),
    CLOUD_RUNNER: 'kubernetes',
  }
  if (chromiumPath) env.E2E_CHROMIUM_PATH = chromiumPath

  if (isWindows) {
    const setVars = Object.entries(env).map(([k, v]) => `set "${k}=${v}"`).join(' && ')
    return `${setVars} && node e2e/setup-e2e-data.js && npm run dev:web`
  }

  const inlineVars = Object.entries(env).map(([k, v]) => `${k}="${v}"`).join(' ')
  return `${inlineVars} node e2e/setup-e2e-data.js && ${inlineVars} npm run dev:web`
}

export default defineConfig({
  testDir: './e2e',
  testMatch: ['**/shared-volumes.spec.ts'],
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
      name: 'wizard',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: buildWebServerCommand(),
    url: `${e2eBaseUrl}/api/settings`,
    reuseExistingServer: false,
    timeout: 120000,
    stdout: 'pipe',
  },
})
