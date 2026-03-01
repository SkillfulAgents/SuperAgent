import { sqlite } from '@shared/lib/db'
import { getAgentsDataDir } from '@shared/lib/config/data-dir'
import { listDirectories } from '@shared/lib/utils/file-storage'

/**
 * Validate that the data directory is compatible with AUTH_MODE.
 *
 * Rules:
 * 1. user table exists AND has entries → OK (normal start)
 * 2. user table doesn't exist but agents directory has agents → ERROR
 * 3. user table doesn't exist and no agents → OK (fresh start)
 *
 * Throws an error if validation fails (case 2).
 */
export async function validateAuthModeStartup(): Promise<void> {
  const userTableExists = hasUserTable()

  if (userTableExists) {
    const userCount = getUserCount()
    if (userCount > 0) {
      // Case 1: Normal start — user table has entries
      return
    }
  }

  // Check if agents directory has agents
  const agentsDir = getAgentsDataDir()
  const agents = await listDirectories(agentsDir)

  if (agents.length > 0) {
    // Case 2: ERROR — existing data without auth tables
    throw new Error(
      'Cannot enable AUTH_MODE with existing data. ' +
      'Start with a clean data directory or remove existing agents. ' +
      `Found ${agents.length} agent(s) in ${agentsDir} but no user table.`
    )
  }

  // Case 3: Fresh start — no agents, no users
}

function hasUserTable(): boolean {
  try {
    const result = sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='user'"
    ).get() as { name: string } | undefined
    return !!result
  } catch {
    return false
  }
}

function getUserCount(): number {
  try {
    const result = sqlite.prepare('SELECT COUNT(*) as count FROM user').get() as { count: number }
    return result.count
  } catch {
    return 0
  }
}
