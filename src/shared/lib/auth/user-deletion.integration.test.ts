/**
 * Deleting a user through Better Auth (what Settings → Users does) removes
 * everything they own: the FKs cascade their accounts, MCP servers and agent
 * memberships, and the delete hook removes their settings, which has no FK.
 * Runs on both SQLite and libsql.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import type { AppDatabase } from '../db/drivers/types'
import { agentAcl, connectedAccounts, remoteMcpServers, userSettings } from '../db/schema'

let handle: TestDatabase
let testDb: AppDatabase

vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
vi.mock('@shared/lib/config/settings', async (importOriginal) => ({
  ...await importOriginal<typeof import('@shared/lib/config/settings')>(),
  getSettings: () => ({ auth: { requireAdminApproval: false } }),
}))

import { getAuth, resetAuth } from './index'

beforeEach(async () => {
  vi.stubEnv('AUTH_MODE', 'true')
  vi.stubEnv('BETTER_AUTH_SECRET', 'user-deletion-test-secret-0123456789abcdef0123456789abcdef')
  vi.stubEnv('AUTH_PROVIDERS_JSON', '[]')
  vi.stubEnv('PLATFORM_TOKEN', '')
  handle = await createTestDatabase()
  testDb = handle.db
  resetAuth()
})

afterEach(async () => {
  resetAuth()
  await handle.close()
  vi.unstubAllEnvs()
})

async function signUp(email: string): Promise<string> {
  const { user } = await getAuth().api.signUpEmail({ body: { name: email, email, password: 'UserDeletion123!' } })
  return user.id
}

async function seedOwned(userId: string) {
  const now = new Date()
  await testDb.insert(connectedAccounts).values({
    id: `acct-${userId}`, providerConnectionId: `conn-${userId}`, toolkitSlug: 'gmail', displayName: 'Gmail', userId, createdAt: now, updatedAt: now,
  })
  await testDb.insert(remoteMcpServers).values({
    id: `mcp-${userId}`, name: 'MCP', url: 'https://mcp.example.com', userId, authType: 'bearer', accessToken: 'token', createdAt: now, updatedAt: now,
  })
  await testDb.insert(agentAcl).values({ id: `acl-${userId}`, userId, agentSlug: 'agent', role: 'owner', createdAt: now })
  await testDb.insert(userSettings).values({ userId, settings: '{}', updatedAt: now })
}

it('removes what the deleted user owned and nothing of anyone else', async () => {
  const ada = await signUp('ada@example.com')
  const grace = await signUp('grace@example.com')
  await seedOwned(ada)
  await seedOwned(grace)
  await testDb.insert(userSettings).values({ userId: 'local', settings: '{}', updatedAt: new Date() })

  await (await getAuth().$context).internalAdapter.deleteUser(ada)

  expect((await testDb.select().from(connectedAccounts)).map(row => row.userId)).toEqual([grace])
  expect((await testDb.select().from(remoteMcpServers)).map(row => row.userId)).toEqual([grace])
  expect((await testDb.select().from(agentAcl)).map(row => row.userId)).toEqual([grace])
  expect((await testDb.select().from(userSettings)).map(row => row.userId).sort()).toEqual([grace, 'local'].sort())
})
