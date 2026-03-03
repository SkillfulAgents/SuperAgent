import fs from 'fs'
import path from 'path'

const e2eDataDir = path.join(__dirname, '..', '..', '.e2e-data-auth')

/**
 * Global setup for auth E2E tests.
 * Resets the test database to ensure clean state.
 */
async function globalSetup() {
  console.log('[E2E Auth Setup] Cleaning auth E2E test data directory...')

  if (!fs.existsSync(e2eDataDir)) {
    fs.mkdirSync(e2eDataDir, { recursive: true })
    console.log('[E2E Auth Setup] Created data directory:', e2eDataDir)
  }

  // DB files are cleaned in the webServer command (before the server starts)
  // to avoid a race condition where the server opens the DB before globalSetup deletes it.

  // Remove agents directory
  const agentsDir = path.join(e2eDataDir, 'agents')
  if (fs.existsSync(agentsDir)) {
    fs.rmSync(agentsDir, { recursive: true })
    console.log('[E2E Auth Setup] Removed agents directory')
  }

  // Write settings.json with setupCompleted: true (skip wizard)
  // Auth settings use permissive defaults so existing auth-flow tests work
  // (open signup, no complexity requirement, no admin approval).
  const settingsPath = path.join(e2eDataDir, 'settings.json')
  const settings = {
    container: {
      containerRunner: 'docker',
      agentImage: 'ghcr.io/skillfulagents/superagent-agent-container-base:latest',
      resourceLimits: { cpu: 1, memory: '512m' },
    },
    apiKeys: {
      anthropicApiKey: 'sk-ant-e2e-mock-key',
    },
    app: {
      setupCompleted: true,
    },
    auth: {
      signupMode: 'open',
      passwordRequireComplexity: false,
      requireAdminApproval: false,
      passwordMinLength: 8,
    },
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
  console.log('[E2E Auth Setup] Wrote settings.json with setupCompleted: true')

  console.log('[E2E Auth Setup] Auth E2E test data cleaned successfully')
}

export default globalSetup
