import { defineConfig, devices, chromium } from '@playwright/test'
import path from 'path'

// Quarantine config for specs that mutate GLOBAL server state (onboarding
// flags, the provider API key): single worker, own server/data directory,
// separate from the fully-parallel main web suite.
const defaultE2eDataDir = path.join(__dirname, '.e2e-data', 'wizard')
if (!process.env.SUPERAGENT_DATA_DIR) {
  process.env.SUPERAGENT_DATA_DIR = defaultE2eDataDir
}
const e2eDataDir = path.resolve(process.env.SUPERAGENT_DATA_DIR)
const e2ePort = process.env.E2E_PORT ?? process.env.PORT ?? '3003'
const e2eBaseUrl = process.env.E2E_BASE_URL ?? `http://localhost:${e2ePort}`
const playwrightOutputDir = process.env.PLAYWRIGHT_OUTPUT_DIR ?? 'test-results/wizard'
const playwrightHtmlReportDir = process.env.PLAYWRIGHT_HTML_REPORT ?? 'playwright-report/wizard'

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
    // A machine-level key would flip apiKeyStatus.source to 'env' and break
    // the keyless baseline these specs assert. Empty string reads as unset.
    ANTHROPIC_API_KEY: '',
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
  testMatch: [
    '**/getting-started-wizard.spec.ts',
    '**/provider-api-key.spec.ts',
  ],
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
