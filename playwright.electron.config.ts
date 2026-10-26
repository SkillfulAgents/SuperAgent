import { defineConfig } from '@playwright/test'
import path from 'node:path'

const dataDir = path.resolve(process.env.SUPERAGENT_DATA_DIR ?? '.e2e-data/electron')
const debugPort = process.env.E2E_ELECTRON_DEBUG_PORT ?? '47993'
process.env.SUPERAGENT_DATA_DIR = dataDir

export default defineConfig({
  testDir: './e2e/electron',
  workers: 1,
  timeout: 120_000,
  reporter: 'list',
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? 'test-results/electron',
  webServer: {
    // Dev emits the same main/worker module formats as production without
    // running the production build or replacing a running web dev server.
    command: `install-electron && node e2e/setup-e2e-data.js && electron-vite dev --remoteDebuggingPort ${debugPort}${process.env.E2E_ELECTRON_NO_SANDBOX === 'true' ? ' --noSandbox' : ''} -- --user-data-dir="${path.join(dataDir, 'chromium')}"`,
    url: `http://127.0.0.1:${debugPort}/json/version`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      SUPERAGENT_DATA_DIR: dataDir,
      SUPERAGENT_DISABLE_SINGLE_INSTANCE: '1',
      // Keep this runnable after npm ci without rebuilding SQLite for Electron.
      DB_DRIVER: process.env.DB_DRIVER ?? 'libsql',
      E2E_MOCK: 'true',
    },
    stdout: 'pipe',
  },
})
