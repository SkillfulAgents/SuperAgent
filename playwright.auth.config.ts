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
  {
    name: 'auth-graph',
    testMatch: '**/graph-roles.spec.ts',
    port: e2ePort + 3,
    dataDir: path.join(e2eDataDir, 'graph'),
    viteCacheDir: path.join(e2eDataDir, '.vite', 'graph'),
  },
  {
    name: 'auth-models',
    testMatch: '**/model-picker-roles.spec.ts',
    port: e2ePort + 4,
    dataDir: path.join(e2eDataDir, 'models'),
    viteCacheDir: path.join(e2eDataDir, '.vite', 'models'),
  },
  {
    name: 'auth-session-scope',
    testMatch: '**/session-scope-roles.spec.ts',
    port: e2ePort + 5,
    dataDir: path.join(e2eDataDir, 'session-scope'),
    viteCacheDir: path.join(e2eDataDir, '.vite', 'session-scope'),
  },
  {
    name: 'auth-mobile-pairing',
    testMatch: '**/mobile-pairing.spec.ts',
    port: e2ePort + 6,
    dataDir: path.join(e2eDataDir, 'mobile-pairing'),
    viteCacheDir: path.join(e2eDataDir, '.vite', 'mobile-pairing'),
  },
  {
    name: 'auth-template-handoff',
    testMatch: '**/template-handoff.spec.ts',
    port: e2ePort + 7,
    dataDir: path.join(e2eDataDir, 'template-handoff'),
    viteCacheDir: path.join(e2eDataDir, '.vite', 'template-handoff'),
  },
  {
    name: 'auth-shared-connections',
    testMatch: '**/shared-connections.spec.ts',
    port: e2ePort + 8,
    dataDir: path.join(e2eDataDir, 'shared-connections'),
    viteCacheDir: path.join(e2eDataDir, '.vite', 'shared-connections'),
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
