import { sql } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { getAgentsDataDir } from '@shared/lib/config/data-dir'
import { listDirectories } from '@shared/lib/utils/file-storage'
import { initEnvManagedPlatformStatus } from '@shared/lib/services/platform-auth-service'
import { getAuth } from './index'
import { getPublicAuthProviders } from './provider-config'

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
  const userTableExists = await hasUserTable()

  if (userTableExists) {
    const userCount = await getUserCount()
    if (userCount > 0) {
      // Case 1: Normal start — user table has entries
      validateAuthProviders()
      getAuth()
      await initEnvManagedPlatformStatus()
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
  validateAuthProviders()
  getAuth()
  await initEnvManagedPlatformStatus()
}

function validateAuthProviders(): void {
  const providers = getPublicAuthProviders()
  for (const provider of providers) {
    if (!provider.readiness.ok) {
      console.warn(
        `[auth] provider ${provider.id} is unavailable: ${provider.readiness.reasons.join(', ')}`
      )
    }
  }
  console.log(
    `[auth] loaded ${providers.length} OIDC provider(s): ${
      providers.map((provider) => provider.id).join(', ') || '(none)'
    }`
  )
}

async function hasUserTable(): Promise<boolean> {
  try {
    const result = await db.get<{ name: string } | undefined>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user'`,
    )
    return !!result
  } catch {
    return false
  }
}

async function getUserCount(): Promise<number> {
  try {
    const result = await db.get<{ count: number }>(sql`SELECT COUNT(*) as count FROM user`)
    return result.count
  } catch {
    return 0
  }
}
