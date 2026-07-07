import { defineConfig, devices } from '@playwright/test'
import path from 'path'

// Use a separate data directory for auth E2E tests.
const e2eDataDir = path.resolve(process.env.SUPERAGENT_DATA_DIR ?? path.join(__dirname, '.e2e-data-auth'))
const configuredPort = Number(process.env.E2E_PORT ?? process.env.PORT ?? '3001')
const e2ePort = Number.isFinite(configuredPort) ? configuredPort : 3001
const playwrightOutputDir = process.env.PLAYWRIGHT_OUTPUT_DIR ?? 'test-results'
const playwrightHtmlReportDir = process.env.PLAYWRIGHT_HTML_REPORT ?? 'playwright-report'
const configuredWorkers = process.env.PLAYWRIGHT_WORKERS
  ? Number(process.env.PLAYWRIGHT_WORKERS)
  : undefined

const authProjects = [
  {
    name: 'auth-flow',
    testMatch: '**/auth-flow.spec.ts',
    port: e2ePort,
    dataDir: path.join(e2eDataDir, 'flow'),
    viteCacheDir: path.join(e2eDataDir, '.vite', 'flow'),
  },
  {
    name: 'auth-settings',
    testMatch: '**/auth-settings.spec.ts',
    port: e2ePort + 1,
    dataDir: path.join(e2eDataDir, 'settings'),
    viteCacheDir: path.join(e2eDataDir, '.vite', 'settings'),
  },
  {
    name: 'auth-users',
    testMatch: '**/user-onboarding.spec.ts',
    port: e2ePort + 2,
    dataDir: path.join(e2eDataDir, 'users'),
    viteCacheDir: path.join(e2eDataDir, '.vite', 'users'),
  },
].map((project, index) => ({
  ...project,
  baseURL: index === 0 && process.env.E2E_BASE_URL
    ? process.env.E2E_BASE_URL
    : `http://localhost:${project.port}`,
}))

function buildAuthServerCommand(dataDir: string, port: number, viteCacheDir: string) {
  return `SUPERAGENT_DATA_DIR="${dataDir}" AUTH_MODE=true node e2e/setup-e2e-data.js && SUPERAGENT_DATA_DIR="${dataDir}" VITE_CACHE_DIR="${viteCacheDir}" E2E_MOCK=true AUTH_MODE=true ANTHROPIC_API_KEY=sk-ant-e2e-mock PORT=${port} npm run dev:web`
}

export default defineConfig({
  testDir: './e2e/auth/specs',
  outputDir: playwrightOutputDir,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: configuredWorkers && Number.isFinite(configuredWorkers) ? configuredWorkers : 2,
  reporter: [['list'], ['html', { open: 'never', outputFolder: playwrightHtmlReportDir }]],

  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: authProjects.map((project) => ({
    name: project.name,
    testMatch: project.testMatch,
    use: { ...devices['Desktop Chrome'], baseURL: project.baseURL },
  })),

  webServer: authProjects.map((project) => ({
    command: buildAuthServerCommand(project.dataDir, project.port, project.viteCacheDir),
    url: `${project.baseURL}/api/settings`,
    reuseExistingServer: false,
    timeout: 120000,
    stdout: 'pipe',
  })),
})
