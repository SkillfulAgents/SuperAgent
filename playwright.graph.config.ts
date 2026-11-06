import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'

// Graph gestures need a still board: no unrelated suite may create/delete
// agents while a pointer is between a node and its drop target.
const dataDir = path.resolve(process.env.SUPERAGENT_DATA_DIR ?? path.join(__dirname, '.e2e-data/graph'))
process.env.SUPERAGENT_DATA_DIR = dataDir
const port = process.env.E2E_PORT ?? process.env.PORT ?? '3012'
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${port}`
const env = { SUPERAGENT_DATA_DIR: dataDir, E2E_MOCK: 'true', PORT: port, VITE_CACHE_DIR: path.join(dataDir, '.vite') }
const inline = Object.entries(env).map(([name, value]) => process.platform === 'win32'
  ? `set "${name}=${value}"`
  : `${name}="${value}"`).join(process.platform === 'win32' ? ' && ' : ' ')
const command = process.platform === 'win32'
  ? `${inline} && node e2e/setup-e2e-data.js && npm run dev:web`
  : `${inline} node e2e/setup-e2e-data.js && ${inline} npm run dev:web`
const desktopSpecs = ['**/home-graph.spec.ts', '**/graph-upgrade.spec.ts']

export default defineConfig({
  testDir: './e2e',
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? 'test-results/graph',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: process.env.PLAYWRIGHT_HTML_REPORT ?? 'playwright-report/graph' }]],
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'graph-chromium', testMatch: desktopSpecs, grepInvert: /@touch/, use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } },
    { name: 'graph-webkit', testMatch: desktopSpecs, grepInvert: /@touch/, use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 900 } } },
    { name: 'graph-chromium-touch', testMatch: '**/graph-upgrade.spec.ts', grep: /@touch/, use: { ...devices['Pixel 7'], viewport: { width: 1024, height: 900 } } },
    { name: 'graph-webkit-touch', testMatch: '**/graph-upgrade.spec.ts', grep: /@touch/, use: { ...devices['iPhone 13'], viewport: { width: 1024, height: 900 } } },
  ],
  webServer: { command, url: `${baseURL}/api/settings`, reuseExistingServer: false, timeout: 120_000, stdout: 'pipe' },
})
