import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono, type Context, type Next } from 'hono'
import type { AppDatabase } from '@shared/lib/db'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { agents, auditLog, user } from '@shared/lib/db/schema'
import { resetVaultKeyCache } from '@shared/lib/browser-vault/vault-crypto'

let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

const auth = vi.hoisted(() => ({ mode: false, userId: 'alice', others: 0 }))
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => auth.mode }))
vi.mock('@shared/lib/auth/config', () => ({ getCurrentUserId: () => auth.userId }))
vi.mock('@shared/lib/services/agent-members-service', () => ({ countOtherMembers: async () => auth.others }))
// The agent role checks have their own tests: here every caller may use every agent.
vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (_c: Context, next: Next) => next(),
  AgentUser: () => async (_c: Context, next: Next) => next(),
  getAgentId: (c: Context) => c.req.param('id'),
}))

const { default: browserAccounts, agentBrowserAccountRoutes } = await import('./browser-accounts')
const { saveAccount, grantAccount, listOwnedAccounts } = await import('@shared/lib/browser-vault/vault-service')

let handle: TestDatabase
let dataDir: string

const app = new Hono()
  .route('/api/browser-accounts', browserAccounts)
  .route('/api/agents', agentBrowserAccountRoutes)

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-accounts-'))
  vi.stubEnv('SUPERAGENT_DATA_DIR', dataDir)
  resetVaultKeyCache()
})

afterAll(() => {
  vi.unstubAllEnvs()
  resetVaultKeyCache()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

beforeEach(async () => {
  handle = await createTestDatabase()
  testDb = handle.db
  auth.mode = false
  auth.userId = 'alice'
  auth.others = 0
  const now = new Date()
  await testDb.insert(agents).values([{ slug: 'agent-a', name: 'A', createdAt: now }, { slug: 'agent-b', name: 'B', createdAt: now }]).run()
  for (const id of ['alice', 'bob']) {
    await testDb.insert(user).values({ id, name: id, email: `${id}@example.com`, emailVerified: true, createdAt: now, updatedAt: now }).run()
  }
})

afterEach(async () => {
  await handle.close()
})

const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

describe('browser accounts API', () => {
  it('lists saved accounts with the agents that may use each, never a value', async () => {
    const { account } = await saveAccount({ owner: null, site: 'github.com', origin: 'https://github.com', username: 'octocat', values: { password: 'hunter2' } })
    await grantAccount({ accountId: account.id, agentSlug: 'agent-a', grantedBy: null })

    const res = await app.request('/api/browser-accounts')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const body = await res.json()
    expect(body.accounts).toEqual([expect.objectContaining({
      id: account.id,
      site: 'github.com',
      username: 'octocat',
      parts: ['password'],
      via: null,
      agentSlugs: ['agent-a'],
      lastUsedAt: null,
      rejectedAt: null,
    })])
    expect(JSON.stringify(body)).not.toContain('hunter2')
  })

  it('grants and revokes an agent, renames and deletes, auditing each', async () => {
    const { account } = await saveAccount({ owner: null, site: 'github.com', origin: 'https://github.com', username: 'octocat' })

    expect((await app.request('/api/agents/agent-b/browser-accounts', json({ accountId: account.id }))).status).toBe(200)
    expect((await listOwnedAccounts(null))[0].agentSlugs).toEqual(['agent-b'])
    expect((await app.request(`/api/browser-accounts/${account.id}/agents`)).status).toBe(200)

    expect((await app.request(`/api/browser-accounts/${account.id}/agents/agent-b`, { method: 'DELETE' })).status).toBe(200)
    expect((await app.request(`/api/browser-accounts/${account.id}/agents/agent-b`, { method: 'DELETE' })).status).toBe(404)

    const renamed = await app.request(`/api/browser-accounts/${account.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'Work' }) })
    expect(renamed.status).toBe(200)
    expect((await listOwnedAccounts(null))[0].label).toBe('Work')

    expect((await app.request(`/api/browser-accounts/${account.id}`, { method: 'DELETE' })).status).toBe(200)
    expect(await listOwnedAccounts(null)).toEqual([])
    const actions = (await testDb.select({ action: auditLog.action }).from(auditLog).all()).map((row) => row.action)
    expect(actions).toEqual(['assigned', 'unassigned', 'updated', 'deleted'])
  })

  it('shows and changes only the caller\'s own accounts in auth mode', async () => {
    auth.mode = true
    const { account: bobs } = await saveAccount({ owner: 'bob', site: 'github.com', origin: 'https://github.com', username: 'bob' })
    await saveAccount({ owner: 'alice', site: 'github.com', origin: 'https://github.com', username: 'alice' })

    const listed = await (await app.request('/api/browser-accounts')).json()
    expect(listed.accounts.map((account: { username: string }) => account.username)).toEqual(['alice'])
    expect((await app.request(`/api/browser-accounts/${bobs.id}`, { method: 'DELETE' })).status).toBe(404)
    expect((await app.request(`/api/browser-accounts/${bobs.id}/agents`)).status).toBe(404)
    expect((await app.request('/api/agents/agent-a/browser-accounts', json({ accountId: bobs.id }))).status).toBe(404)
    await grantAccount({ accountId: bobs.id, agentSlug: 'agent-a', grantedBy: 'bob' })
    expect((await app.request(`/api/browser-accounts/${bobs.id}/agents/agent-a`, { method: 'DELETE' })).status).toBe(404)
  })

  it('grants to an agent other members use only once the caller confirms', async () => {
    auth.mode = true
    auth.others = 2
    const { account } = await saveAccount({ owner: 'alice', site: 'github.com', origin: 'https://github.com', username: 'alice' })

    const refused = await app.request('/api/agents/agent-a/browser-accounts', json({ accountId: account.id }))
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ reason: 'shared_agent' })
    expect((await listOwnedAccounts('alice'))[0].agentSlugs).toEqual([])

    const confirmed = await app.request('/api/agents/agent-a/browser-accounts', json({ accountId: account.id, sharedAgentAcknowledged: true }))
    expect(confirmed.status).toBe(200)
    expect((await listOwnedAccounts('alice'))[0].agentSlugs).toEqual(['agent-a'])
  })
})
