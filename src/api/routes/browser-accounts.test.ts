import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono, type Context, type Next } from 'hono'
import type { AppDatabase } from '@shared/lib/db'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { agents, auditLog, user } from '@shared/lib/db/schema'
import { installTestKeyManager, uninstallKeyManager } from '@shared/lib/keys/testing/memory-key-manager'

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
const { saveAccount, grantAccount, listOwnedAccounts, readAccountFill, readAccountPasskeys, saveAuthenticator, savePasskey } = await import('@shared/lib/browser-vault/vault-service')
const { saveAccountSession, listAccountSessions } = await import('@shared/lib/browser-vault/session-service')

let handle: TestDatabase
let dataDir: string

const app = new Hono()
  .route('/api/browser-accounts', browserAccounts)
  .route('/api/agents', agentBrowserAccountRoutes)

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-accounts-'))
  vi.stubEnv('SUPERAGENT_DATA_DIR', dataDir)
  await installTestKeyManager()
})

afterAll(() => {
  vi.unstubAllEnvs()
  uninstallKeyManager()
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

  it('says where an account has a saved session, never the session, and forgets it for its owner only', async () => {
    auth.mode = true
    const { account } = await saveAccount({ owner: 'alice', site: 'github.com', origin: 'https://github.com', username: 'alice' })
    await saveAccountSession({
      agentSlug: 'agent-a',
      account,
      browserType: 'chrome',
      bundle: { version: 1, site: 'github.com', capturedAt: '2026-10-26T00:00:00.000Z', cookies: [{ name: 'user_session', value: 'the-session', domain: 'github.com', path: '/', httpOnly: true, secure: true }], origins: [] },
    })

    const listed = await (await app.request('/api/browser-accounts')).json()
    expect(listed.accounts[0].sessions).toEqual([{ browserType: 'chrome', capturedAt: expect.any(String) }])
    expect(JSON.stringify(listed)).not.toContain('the-session')

    auth.userId = 'bob'
    expect((await app.request(`/api/browser-accounts/${account.id}/sessions`, { method: 'DELETE' })).status).toBe(404)
    expect(await listAccountSessions([account.id])).toHaveLength(1)
    auth.userId = 'alice'
    expect((await app.request(`/api/browser-accounts/${account.id}/sessions`, { method: 'DELETE' })).status).toBe(200)
    expect(await listAccountSessions([account.id])).toEqual([])
    expect((await listOwnedAccounts('alice'))[0].id).toBe(account.id)
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

describe('an account\'s authenticator app in settings', () => {
  const SEED = { secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', algorithm: 'SHA1' as const, digits: 6, period: 30 }
  const put = (body: unknown) => ({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  async function listed() {
    const body = await (await app.request('/api/browser-accounts')).json()
    return body.accounts[0].signInMethods
  }

  it('asks agents to add one at their next sign-in, and takes it back', async () => {
    const { account } = await saveAccount({ owner: null, site: 'github.com', origin: 'https://github.com', username: 'octocat', values: { password: 'pw' } })
    expect(await listed()).toEqual({ authenticator: null, passkeys: [], requestedAt: null, unavailable: null })

    expect((await app.request(`/api/browser-accounts/${account.id}/sign-in-method-request`, put({ requested: true }))).status).toBe(200)
    expect(await listed()).toEqual({ authenticator: null, passkeys: [], requestedAt: expect.any(String), unavailable: null })
    expect((await app.request(`/api/browser-accounts/${account.id}/sign-in-method-request`, put({ requested: false }))).status).toBe(200)
    expect((await listed()).requestedAt).toBeNull()
    const audit = await testDb.select({ action: auditLog.action, details: auditLog.details }).from(auditLog).all()
    expect(audit.map((row) => JSON.parse(row.details!).signInMethodRequested)).toEqual([true, false])
  })

  it('shows the app an agent added, never its seed, and removes it from the vault', async () => {
    const { account } = await saveAccount({ owner: null, site: 'github.com', origin: 'https://github.com', username: 'octocat', values: { password: 'pw' } })
    await grantAccount({ accountId: account.id, agentSlug: 'agent-a', grantedBy: null })
    await saveAuthenticator({ agentSlug: 'agent-a', accountId: account.id, sessionId: 's-1', setup: { seed: SEED, issuer: 'GitHub', accountName: 'octocat' }, asked: { request: true } })

    const response = await app.request('/api/browser-accounts')
    const text = await response.text()
    expect(text).not.toContain(SEED.secret)
    expect(JSON.parse(text).accounts[0].signInMethods).toEqual({
      authenticator: { addedAt: expect.any(String), issuer: 'GitHub', accountName: 'octocat', name: null, rejectedAt: null },
      passkeys: [],
      requestedAt: null,
      unavailable: null,
    })

    expect((await app.request(`/api/browser-accounts/${account.id}/authenticator`, { method: 'DELETE' })).status).toBe(200)
    expect((await listed()).authenticator).toBeNull()
    // Its password stays.
    expect(await readAccountFill(account.id)).toEqual({ values: { password: 'pw' }, totp: null })
    expect((await app.request(`/api/browser-accounts/${account.id}/authenticator`, { method: 'DELETE' })).status).toBe(404)
  })

  it('changes only the caller\'s own accounts in auth mode', async () => {
    auth.mode = true
    const { account: bobs } = await saveAccount({ owner: 'bob', site: 'github.com', origin: 'https://github.com', username: 'bob' })
    expect((await app.request(`/api/browser-accounts/${bobs.id}/sign-in-method-request`, put({ requested: true }))).status).toBe(404)
    expect((await app.request(`/api/browser-accounts/${bobs.id}/authenticator`, { method: 'DELETE' })).status).toBe(404)
  })
})

describe('an account\'s passkeys in settings', () => {
  const PASSKEY = { credentialId: 'Y3JlZC0x', rpId: 'github.com', privateKey: 'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg' + 'A'.repeat(120), userHandle: 'dXNlci0x', signCount: 1, userName: 'octocat' }
  const remove = (credentialId: string) => ({ method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credentialId }) })

  it('lists the passkeys, never a key, and removes one from the vault', async () => {
    const { account } = await saveAccount({ owner: null, site: 'github.com', origin: 'https://github.com', username: 'octocat', values: { password: 'pw' } })
    await grantAccount({ accountId: account.id, agentSlug: 'agent-a', grantedBy: null })
    await savePasskey({ agentSlug: 'agent-a', accountId: account.id, sessionId: 's-1', passkey: PASSKEY, name: 'Gamut', asked: { request: true } })

    const text = await (await app.request('/api/browser-accounts')).text()
    expect(text).not.toContain(PASSKEY.privateKey)
    expect(JSON.parse(text).accounts[0].signInMethods.passkeys).toEqual([
      { credentialId: 'Y3JlZC0x', rpId: 'github.com', addedAt: expect.any(String), name: 'Gamut', userName: 'octocat' },
    ])

    expect((await app.request(`/api/browser-accounts/${account.id}/passkeys`, remove('Y3JlZC0x'))).status).toBe(200)
    expect(JSON.parse(await (await app.request('/api/browser-accounts')).text()).accounts[0].signInMethods.passkeys).toEqual([])
    expect(await readAccountPasskeys(account.id, 'github.com')).toEqual([])
    // Its password stays.
    expect(await readAccountFill(account.id)).toEqual({ values: { password: 'pw' }, totp: null })
    expect((await app.request(`/api/browser-accounts/${account.id}/passkeys`, remove('Y3JlZC0x'))).status).toBe(404)
  })
})
