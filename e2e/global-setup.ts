import fs from 'fs'
import path from 'path'

const e2eDataDir = path.join(__dirname, '..', '.e2e-data')

/**
 * Global setup runs once before all tests.
 * Resets the E2E test database to ensure clean state.
 */
async function globalSetup() {
  console.log('[E2E Setup] Cleaning E2E test data directory...')

  // Ensure the directory exists
  if (!fs.existsSync(e2eDataDir)) {
    fs.mkdirSync(e2eDataDir, { recursive: true })
    console.log('[E2E Setup] Created E2E data directory:', e2eDataDir)
  }

  // Remove the database file to start fresh
  const dbPath = path.join(e2eDataDir, 'superagent.db')
  const walPath = path.join(e2eDataDir, 'superagent.db-wal')
  const shmPath = path.join(e2eDataDir, 'superagent.db-shm')

  for (const file of [dbPath, walPath, shmPath]) {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file)
      console.log('[E2E Setup] Removed:', file)
    }
  }

  // Remove agents directory to clean up workspace data
  const agentsDir = path.join(e2eDataDir, 'agents')
  if (fs.existsSync(agentsDir)) {
    fs.rmSync(agentsDir, { recursive: true })
    console.log('[E2E Setup] Removed agents directory')
  }

  // Write settings.json with setupCompleted: true so the getting started wizard
  // does not auto-open during existing tests
  const settingsPath = path.join(e2eDataDir, 'settings.json')
  const settings = {
    container: {
      containerRunner: 'docker',
      agentImage: 'ghcr.io/skilfulagents/superagent-agent-container-base:main',
      resourceLimits: { cpu: 1, memory: '512m' },
    },
    app: {
      setupCompleted: true,
    },
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
  console.log('[E2E Setup] Wrote settings.json with setupCompleted: true')

  console.log('[E2E Setup] E2E test data cleaned successfully')
}

export default globalSetup
