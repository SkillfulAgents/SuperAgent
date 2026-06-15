import { defineConfig, devices, chromium } from '@playwright/test'
import path from 'path'

// Use a separate data directory for E2E tests to avoid polluting production data.
// CI can override these so multiple Playwright invocations run in parallel in
// one job without port or database collisions.
const e2eDataDir = path.resolve(process.env.SUPERAGENT_DATA_DIR ?? path.join(__dirname, '.e2e-data'))
const e2ePort = process.env.PORT ?? process.env.E2E_PORT ?? '3000'
const e2eBaseUrl = process.env.E2E_BASE_URL ?? `http://localhost:${e2ePort}`
const configuredWorkers = process.env.PLAYWRIGHT_WORKERS
  ? Number(process.env.PLAYWRIGHT_WORKERS)
  : undefined
const configuredRetries = process.env.PLAYWRIGHT_RETRIES
  ? Number(process.env.PLAYWRIGHT_RETRIES)
  : undefined
const webTestIgnore = [
  '**/auth/**',
  '**/getting-started-wizard.spec.ts',
  '**/settings.spec.ts',
  '**/policy-settings.spec.ts',
]

if (process.env.E2E_SKIP_BROWSER_STREAM === 'true') {
  webTestIgnore.push('**/browser-stream.spec.ts')
}
if (process.env.E2E_INCLUDE_A11Y !== 'true') {
  webTestIgnore.push('**/a11y-audit.spec.ts')
}
if (process.env.E2E_INCLUDE_PERSISTENCE !== 'true') {
  webTestIgnore.push('**/persistence.spec.ts')
}

// Resolve Playwright's bundled Chromium path for the browser streaming E2E test.
// This allows the mock container to launch a real headless browser without requiring
// Chrome to be installed on the system (works in GHA).
let chromiumPath: string | undefined
try {
  chromiumPath = chromium.executablePath()
} catch {
  // Chromium not installed (e.g., `npx playwright install` hasn't been run yet)
}

// Build a cross-platform webServer command.
// Unix uses inline `VAR=val cmd`, Windows needs `set VAR=val && cmd`.
const isWindows = process.platform === 'win32'
function buildWebServerCommand() {
  const env: Record<string, string> = {
    SUPERAGENT_DATA_DIR: e2eDataDir,
    E2E_MOCK: 'true',
    PORT: e2ePort,
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
  testIgnore: ['**/auth/**'],  // Auth tests use separate config (playwright.auth.config.ts)
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: configuredRetries !== undefined && Number.isFinite(configuredRetries) ? configuredRetries : (process.env.CI ? 2 : 0),
  workers: configuredWorkers && Number.isFinite(configuredWorkers) ? configuredWorkers : (process.env.CI ? 4 : 2),
  reporter: process.env.CI ? [['list']] : [['html', { open: 'never' }], ['list']],

  use: {
    baseURL: e2eBaseUrl,
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
      testIgnore: webTestIgnore,
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['global-state'],
    },
  ],

  webServer: {
    command: buildWebServerCommand(),
    url: `${e2eBaseUrl}/api/settings`,  // Wait for API to be ready, not just Vite
    reuseExistingServer: false,  // Always start fresh for E2E tests
    timeout: 120000,
    stdout: 'pipe',
  },
})
