/**
 * Removing a user through Better Auth's admin remove-user endpoint (what
 * Settings → Users → Delete calls) removes everything they own: their provider
 * connections and webhook triggers are torn down first, while the rows still
 * exist, then the FKs cascade their accounts, MCP servers and memberships, and
 * the after hook removes their settings, audits, and refreshes their agents.
 * Runs on both SQLite and libsql.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import type { AppDatabase } from '../db/drivers/types'
import { agentAcl, agentConnectedAccounts, agentRemoteMcps, auditLog, connectedAccounts, remoteMcpServers, userSettings } from '../db/schema'

let handle: TestDatabase
let testDb: AppDatabase

const mocks = vi.hoisted(() => ({
  composioDelete: vi.fn(),
  nangoDelete: vi.fn(),
  cancelTriggers: vi.fn(),
  syncAccountAgents: vi.fn(),
  syncMcpAgents: vi.fn(),
}))

vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
vi.mock('@shared/lib/config/settings', async (importOriginal) => ({
  ...await importOriginal<typeof import('@shared/lib/config/settings')>(),
  getSettings: () => ({ auth: { requireAdminApproval: false } }),
}))
// Two providers that differ only in what they delete, to see each account revoked through its own.
vi.mock('@shared/lib/account-providers', async (importOriginal) => ({
  ...await importOriginal<typeof import('@shared/lib/account-providers')>(),
  getAccountProviderByName: (name: string) => ({ name, deleteConnection: name === 'nango' ? mocks.nangoDelete : mocks.composioDelete }),
}))
vi.mock('@shared/lib/services/webhook-trigger-service', async (importOriginal) => ({
  ...await importOriginal<typeof import('@shared/lib/services/webhook-trigger-service')>(),
  cancelTriggersForConnectedAccount: mocks.cancelTriggers,
}))
// Refreshing a running agent talks to its container.
vi.mock('@shared/lib/services/connection-sync-service', async (importOriginal) => ({
  ...await importOriginal<typeof import('@shared/lib/services/connection-sync-service')>(),
  syncConnectedAccountAgents: mocks.syncAccountAgents,
  syncRemoteMcpAgents: mocks.syncMcpAgents,
}))

import { getAuth, resetAuth } from './index'

const BASE = 'http://localhost:47891'
const signedUpSchema = z.object({ user: z.object({ id: z.string() }) })

function request(endpoint: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return getAuth().handler(new Request(`${BASE}/api/auth/${endpoint}`, {
    method: 'POST',
    headers: { origin: BASE, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }))
}

/** Signs up; the first user becomes the admin. */
async function signUp(email: string): Promise<{ id: string; cookie: string }> {
  const response = await request('sign-up/email', { email, password: 'UserDeletion123!', name: email })
  expect(response.status).toBe(200)
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  return { id: signedUpSchema.parse(await response.json()).user.id, cookie }
}

/** A composio and a nango account, an MCP server (each assigned to an agent), a rule, a membership and settings. */
async function seedOwned(userId: string) {
  const now = new Date()
  await testDb.insert(connectedAccounts).values([
    { id: `${userId}-gmail`, providerConnectionId: `conn-${userId}-gmail`, providerName: 'composio', toolkitSlug: 'gmail', displayName: 'Gmail', userId, createdAt: now, updatedAt: now },
    { id: `${userId}-slack`, providerConnectionId: `conn-${userId}-slack`, providerName: 'nango', toolkitSlug: 'slack', displayName: 'Slack', userId, createdAt: now, updatedAt: now },
  ])
  await testDb.insert(remoteMcpServers).values({
    id: `${userId}-mcp`, name: 'Granola', url: 'https://mcp.example.com', userId, authType: 'bearer', accessToken: 'token', createdAt: now, updatedAt: now,
  })
  await testDb.insert(agentConnectedAccounts).values({ id: `${userId}-gmail-map`, agentSlug: `${userId}-inbox`, connectedAccountId: `${userId}-gmail`, createdAt: now })
  await testDb.insert(agentRemoteMcps).values({ id: `${userId}-mcp-map`, agentSlug: `${userId}-briefing`, remoteMcpId: `${userId}-mcp`, createdAt: now })
  await testDb.run(sql`INSERT INTO proxy_rules (id, kind, account_id, created_by, current_version_id, created_at, updated_at)
    VALUES (${`${userId}-rule`}, 'api', ${`${userId}-gmail`}, 'user', ${`${userId}-rule-v1`}, 1, 1)`)
  await testDb.run(sql`INSERT INTO proxy_rule_versions (id, rule_id, version, name, effect, description, restatement, patterns, code, tests, warnings, created_at)
    VALUES (${`${userId}-rule-v1`}, ${`${userId}-rule`}, 1, 'No sends', 'block', '', '', '[]', '', '[]', '[]', 1)`)
  await testDb.insert(agentAcl).values({ id: `${userId}-acl`, userId, agentSlug: `${userId}-inbox`, role: 'owner', createdAt: now })
  await testDb.insert(userSettings).values({ userId, settings: '{}', updatedAt: now })
}

beforeEach(async () => {
  vi.stubEnv('AUTH_MODE', 'true')
  vi.stubEnv('BETTER_AUTH_SECRET', 'user-deletion-test-secret-0123456789abcdef0123456789abcdef')
  vi.stubEnv('TRUSTED_ORIGINS', BASE)
  vi.stubEnv('AUTH_PROVIDERS_JSON', '[]')
  vi.stubEnv('PLATFORM_TOKEN', '')
  handle = await createTestDatabase()
  testDb = handle.db
  resetAuth()
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.syncAccountAgents.mockResolvedValue(true)
  mocks.syncMcpAgents.mockResolvedValue(true)
})

afterEach(async () => {
  resetAuth()
  await handle.close()
  vi.unstubAllEnvs()
})

describe('removing a user', () => {
  it('revokes their connections before the cascade, then removes, audits and refreshes only what was theirs', async () => {
    const admin = await signUp('admin@example.com')
    const ada = await signUp('ada@example.com')
    const grace = await signUp('grace@example.com')
    await seedOwned(ada.id)
    await seedOwned(grace.id)
    await testDb.insert(userSettings).values({ userId: 'local', settings: '{}', updatedAt: new Date() })
    // What the provider is asked to revoke must still exist locally when it is asked.
    const rowsWhenRevoked: number[] = []
    mocks.composioDelete.mockImplementation(async () => {
      rowsWhenRevoked.push((await testDb.select().from(connectedAccounts).where(eq(connectedAccounts.userId, ada.id))).length)
    })

    const response = await request('admin/remove-user', { userId: ada.id }, { cookie: admin.cookie })

    expect(response.status).toBe(200)
    expect(mocks.composioDelete.mock.calls).toEqual([[`conn-${ada.id}-gmail`, 'gmail']])
    expect(mocks.nangoDelete.mock.calls).toEqual([[`conn-${ada.id}-slack`, 'slack']])
    expect(rowsWhenRevoked).toEqual([2])
    expect(mocks.cancelTriggers.mock.calls.map(([id]) => id).sort()).toEqual([`${ada.id}-gmail`, `${ada.id}-slack`])

    expect((await testDb.select().from(connectedAccounts)).map(row => row.userId)).toEqual([grace.id, grace.id])
    expect((await testDb.select().from(remoteMcpServers)).map(row => row.userId)).toEqual([grace.id])
    expect((await testDb.select().from(agentAcl)).map(row => row.userId)).toEqual([grace.id])
    expect((await testDb.select().from(userSettings)).map(row => row.userId).sort()).toEqual([grace.id, 'local'].sort())

    const [removal] = await testDb.select().from(auditLog).where(and(eq(auditLog.object, 'user'), eq(auditLog.action, 'removed')))
    expect(removal).toMatchObject({ userId: admin.id, objectId: ada.id })
    expect(JSON.parse(removal.details ?? '{}')).toEqual({
      email: 'ada@example.com',
      accounts: [{ id: `${ada.id}-gmail`, toolkitSlug: 'gmail' }, { id: `${ada.id}-slack`, toolkitSlug: 'slack' }],
      mcps: [{ id: `${ada.id}-mcp`, name: 'Granola' }],
    })
    const ruleAudits = await testDb.select().from(auditLog).where(eq(auditLog.object, 'proxy_rule'))
    expect(ruleAudits.map(row => [row.action, row.objectId, row.userId])).toEqual([['deleted', `${ada.id}-gmail`, admin.id]])
    expect(JSON.parse(ruleAudits[0].details ?? '{}')).toMatchObject({ ruleId: `${ada.id}-rule`, by: 'system', reason: 'user_removed' })

    expect(mocks.syncAccountAgents.mock.calls).toEqual([[[`${ada.id}-inbox`]]])
    expect(mocks.syncMcpAgents.mock.calls).toEqual([[[`${ada.id}-briefing`]]])
  })

  it('still removes the user when the provider cannot revoke a connection', async () => {
    const admin = await signUp('admin@example.com')
    const ada = await signUp('ada@example.com')
    await seedOwned(ada.id)
    mocks.composioDelete.mockRejectedValue(new Error('provider unavailable'))
    mocks.cancelTriggers.mockRejectedValue(new Error('trigger service unavailable'))

    const response = await request('admin/remove-user', { userId: ada.id }, { cookie: admin.cookie })

    expect(response.status).toBe(200)
    expect(mocks.nangoDelete).toHaveBeenCalledWith(`conn-${ada.id}-slack`, 'slack')
    expect(await testDb.select().from(connectedAccounts)).toEqual([])
    expect(await testDb.select().from(remoteMcpServers)).toEqual([])
    expect(await testDb.select().from(userSettings)).toEqual([])
  })
})
