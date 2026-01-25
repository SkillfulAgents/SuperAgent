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
    return
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

  console.log('[E2E Setup] E2E test data cleaned successfully')
}

export default globalSetup
