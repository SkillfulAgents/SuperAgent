import { defineConfig, devices, chromium } from '@playwright/test'
import path from 'path'

// PWA / service-worker suite. Unlike every other config this one runs against a
// PRODUCTION build served by the real web server (src/web/server.ts): the
// service worker only exists in `vite build` output and only registers in prod
// (see main.tsx), so a dev-server run would be testing nothing. Single worker —
// the build + serve cycle owns one dist/ and one origin's SW registration.
const defaultE2eDataDir = path.join(__dirname, '.e2e-data', 'pwa')
if (!process.env.SUPERAGENT_DATA_DIR) {
  process.env.SUPERAGENT_DATA_DIR = defaultE2eDataDir
}
const e2eDataDir = path.resolve(process.env.SUPERAGENT_DATA_DIR)
const e2ePort = process.env.E2E_PORT ?? process.env.PORT ?? '3004'
const e2eBaseUrl = process.env.E2E_BASE_URL ?? `http://localhost:${e2ePort}`
const playwrightOutputDir = process.env.PLAYWRIGHT_OUTPUT_DIR ?? 'test-results/pwa'
const playwrightHtmlReportDir = process.env.PLAYWRIGHT_HTML_REPORT ?? 'playwright-report/pwa'

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
    // E2E_MOCK must be present at BUILD time too — vite.config.ts bakes it into
    // the bundle as the __E2E_MOCK__ define.
    E2E_MOCK: 'true',
    PORT: e2ePort,
  }
  if (chromiumPath) env.E2E_CHROMIUM_PATH = chromiumPath

  // Full production pipeline: renderer build (emits the SW), API bundle via
  // tsup (handles the ?raw prompt imports plain tsx cannot), then the real
  // server entry — identical to `npm run preview` / the shipped deployment.
  if (isWindows) {
    const setVars = Object.entries(env).map(([k, v]) => `set "${k}=${v}"`).join(' && ')
    return `${setVars} && node e2e/setup-e2e-data.js && npx vite build && npx tsup && node dist/web/server.mjs`
  }
  const inlineVars = Object.entries(env).map(([k, v]) => `${k}="${v}"`).join(' ')
  return `${inlineVars} node e2e/setup-e2e-data.js && ${inlineVars} npx vite build && ${inlineVars} npx tsup && ${inlineVars} node dist/web/server.mjs`
}

export default defineConfig({
  testDir: './e2e',
  testMatch: ['**/pwa-precache.spec.ts'],
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
      name: 'pwa',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: buildWebServerCommand(),
    url: `${e2eBaseUrl}/api/settings`,
    reuseExistingServer: false,
    // Includes a full production `vite build`, not just server boot.
    timeout: 300000,
    stdout: 'pipe',
  },
})
