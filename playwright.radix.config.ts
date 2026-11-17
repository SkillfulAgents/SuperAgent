import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'

// Interaction checks have one isolated settings/database instance. In
// particular, touch tests create enough real agents to scroll the sidebar.
const dataDir = path.resolve(process.env.SUPERAGENT_DATA_DIR ?? path.join(__dirname, '.e2e-data/radix'))
process.env.SUPERAGENT_DATA_DIR = dataDir
const port = process.env.E2E_PORT ?? process.env.PORT ?? '3011'
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${port}`
const env = { SUPERAGENT_DATA_DIR: dataDir, E2E_MOCK: 'true', PORT: port, VITE_CACHE_DIR: path.join(dataDir, '.vite') }
const inline = Object.entries(env).map(([name, value]) => process.platform === 'win32'
  ? `set "${name}=${value}"`
  : `${name}="${value}"`).join(process.platform === 'win32' ? ' && ' : ' ')
const command = process.platform === 'win32'
  ? `${inline} && node e2e/setup-e2e-data.js && npm run dev:web`
  : `${inline} node e2e/setup-e2e-data.js && ${inline} npm run dev:web`

export default defineConfig({
  testDir: './e2e',
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? 'test-results/radix',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: process.env.PLAYWRIGHT_HTML_REPORT ?? 'playwright-report/radix' }]],
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'radix-chromium', testMatch: '**/radix-interactions.spec.ts', use: { ...devices['Desktop Chrome'] } },
    { name: 'radix-webkit', testMatch: '**/radix-interactions.spec.ts', use: { ...devices['Desktop Safari'] } },
    { name: 'radix-chromium-touch', testMatch: '**/radix-touch.spec.ts', use: { ...devices['Pixel 7'] } },
    { name: 'radix-webkit-touch', testMatch: '**/radix-touch.spec.ts', use: { ...devices['iPhone 13'] } },
  ],
  webServer: {
    command,
    url: `${baseURL}/api/settings`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
  },
})
