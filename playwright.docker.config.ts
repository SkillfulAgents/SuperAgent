import { defineConfig, devices } from '@playwright/test'
import path from 'path'

// Runs the web E2E suite against an ALREADY-RUNNING server — typically the
// production Docker image — instead of spawning the dev server.
//
// Usage:
//   SUPERAGENT_DATA_DIR=<seed-dir> node e2e/setup-e2e-data.js
//   docker run -d -p 3199:47891 -e E2E_MOCK=true -e SUPERAGENT_DATA_DIR=/root/.superagent \
//     -v <seed-dir>:/root/.superagent <image>
//   E2E_MOCK=true E2E_PORT=3199 SUPERAGENT_DATA_DIR=<seed-dir> \
//     npx playwright test --config=playwright.docker.config.ts --project=web-chromium
//
// Both the container AND this test process need SUPERAGENT_DATA_DIR pointed at
// the same (mounted) directory: the server's mock recorder writes JSONL there,
// and specs read .env/JSONL/wire captures from it.
const defaultE2eDataDir = path.join(__dirname, '.e2e-data', 'docker')
if (!process.env.SUPERAGENT_DATA_DIR) {
  process.env.SUPERAGENT_DATA_DIR = defaultE2eDataDir
}
const e2ePort = process.env.E2E_PORT ?? '3199'
const e2eBaseUrl = process.env.E2E_BASE_URL ?? `http://localhost:${e2ePort}`
const playwrightOutputDir = process.env.PLAYWRIGHT_OUTPUT_DIR ?? 'test-results'
const playwrightHtmlReportDir = process.env.PLAYWRIGHT_HTML_REPORT ?? 'playwright-report'
const configuredWorkers = process.env.PLAYWRIGHT_WORKERS
  ? Number(process.env.PLAYWRIGHT_WORKERS)
  : undefined

const webTestIgnore = [
  '**/auth/**',
  '**/getting-started-wizard.spec.ts',
  // Mutates the global provider API key — quarantined to the wizard config.
  '**/provider-api-key.spec.ts',
  '**/replicate-api-key.spec.ts',
  // These specs register a mock MCP server on host loopback
  // (http://127.0.0.1:<port>/mcp) which is unreachable from inside the
  // container, so they structurally cannot pass against a containerized server.
  '**/mcp-policy-enforcement.spec.ts',
  '**/connections-management.spec.ts',
  '**/connected-accounts.spec.ts',
  '**/connection-delete.spec.ts',
  '**/global-connections.spec.ts',
  // Launches a host Chromium for the screencast; same host-only topology.
  '**/browser-stream.spec.ts',
]

if (process.env.E2E_INCLUDE_A11Y !== 'true') {
  webTestIgnore.push('**/a11y-audit.spec.ts')
}

export default defineConfig({
  testDir: './e2e',
  testIgnore: ['**/auth/**'],
  outputDir: playwrightOutputDir,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: configuredWorkers && Number.isFinite(configuredWorkers) ? configuredWorkers : 4,
  reporter: [['list'], ['html', { open: 'never', outputFolder: playwrightHtmlReportDir }]],

  use: {
    baseURL: e2eBaseUrl,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'web-chromium',
      testIgnore: webTestIgnore,
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // No webServer: the target is an externally-managed container.
})
