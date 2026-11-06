import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'

// Forms mutate the deployment's password policy. Keep them on one dedicated
// auth-mode server, with independent browser contexts and zero automatic retries.
const dataDir = path.resolve(process.env.SUPERAGENT_DATA_DIR ?? path.join(__dirname, '.e2e-data/forms'))
const port = process.env.E2E_PORT ?? process.env.PORT ?? '3271'
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${port}`
const env = { SUPERAGENT_DATA_DIR: dataDir, AUTH_MODE: 'true', E2E_MOCK: 'true', PORT: port, VITE_CACHE_DIR: path.join(dataDir, '.vite') }
const inline = Object.entries(env).map(([name, value]) => process.platform === 'win32'
  ? `set "${name}=${value}"`
  : `${name}="${value}"`).join(process.platform === 'win32' ? ' && ' : ' ')
const command = process.platform === 'win32'
  ? `${inline} && node e2e/setup-e2e-data.js && npm run dev:web`
  : `${inline} node e2e/setup-e2e-data.js && ${inline} npm run dev:web`

export default defineConfig({
  testDir: './e2e/auth/specs',
  testMatch: '**/forms-upgrade.spec.ts',
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? 'test-results/forms',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: process.env.PLAYWRIGHT_HTML_REPORT ?? 'playwright-report/forms' }]],
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'forms-chromium', grepInvert: /@touch/, use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } },
    { name: 'forms-webkit', grepInvert: /@touch/, use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 900 } } },
    { name: 'forms-chromium-touch', grep: /@touch/, use: { ...devices['Pixel 7'], viewport: { width: 430, height: 932 } } },
    { name: 'forms-webkit-touch', grep: /@touch/, use: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } },
  ],
  webServer: { command, url: `${baseURL}/api/auth-config`, reuseExistingServer: false, timeout: 120_000, stdout: 'pipe' },
})
