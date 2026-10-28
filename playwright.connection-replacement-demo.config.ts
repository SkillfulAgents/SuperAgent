import { defineConfig, devices } from '@playwright/test'
import path from 'path'

// Dedicated Auth Mode server and database; never uses a developer's data.
const dataDir = path.resolve(process.env.SUPERAGENT_DATA_DIR ?? '.e2e-data/connection-replacement-demo')
const port = process.env.E2E_PORT ?? '4317'
const baseURL = `http://localhost:${port}`
process.env.SUPERAGENT_DATA_DIR = dataDir
process.env.E2E_CONNECTION_REPLACEMENT_DEMO = 'true'
process.env.E2E_DEMO_SLACK_URL ??= 'http://127.0.0.1:4318'

export default defineConfig({
  testDir: './e2e/auth/specs',
  testMatch: 'connection-replacement.demo.spec.ts',
  outputDir: 'test-results/connection-replacement-demo',
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'], baseURL },
  webServer: {
    command: 'node e2e/setup-e2e-data.js && npm run dev:web',
    env: {
      SUPERAGENT_DATA_DIR: dataDir,
      VITE_CACHE_DIR: path.join(dataDir, '.vite'),
      PORT: port,
      AUTH_MODE: 'true',
      E2E_MOCK: 'true',
      E2E_CONNECTION_REPLACEMENT_DEMO: 'true',
      E2E_DEMO_SLACK_URL: process.env.E2E_DEMO_SLACK_URL,
      ANTHROPIC_API_KEY: 'sk-ant-e2e-mock',
    },
    url: `${baseURL}/api/settings`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
