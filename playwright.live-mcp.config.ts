import { defineConfig, devices } from '@playwright/test'

/**
 * Live remote-MCP hot-add probe: the REAL container against a mock OAuth MCP.
 *
 * No webServer here — `e2e/live/mcp-hot-add/run.mjs` seeds a data dir with
 * real credentials, boots the host, and points this config at it through
 * E2E_BASE_URL. Video is always on: the run doubles as the demo recording of
 * the whole flow (agent asks → user signs in → agent uses the new tools).
 */
const baseURL = process.env.E2E_BASE_URL
if (!baseURL) {
  throw new Error('E2E_BASE_URL is required — run this through e2e/live/mcp-hot-add/run.mjs')
}

const viewport = { width: 1440, height: 900 }

export default defineConfig({
  testDir: './e2e/live/mcp-hot-add',
  testMatch: ['**/*.spec.ts'],
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? 'test-results/live-mcp-hot-add',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // One real agent turn with a human-paced OAuth handoff in the middle.
  timeout: 10 * 60_000,
  reporter: [['list']],
  use: {
    baseURL,
    viewport,
    video: { mode: 'on', size: viewport },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'live-chromium',
      use: { ...devices['Desktop Chrome'], viewport },
    },
  ],
})
