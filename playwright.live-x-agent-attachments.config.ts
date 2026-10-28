import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.E2E_BASE_URL
if (!baseURL) {
  throw new Error('E2E_BASE_URL is required; run through e2e/live/x-agent-attachments/run.ts')
}

const viewport = { width: 1440, height: 900 }

export default defineConfig({
  testDir: './e2e/live/x-agent-attachments',
  testMatch: ['**/*.spec.ts'],
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? 'test-results/live-x-agent-attachments',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 12 * 60_000,
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
