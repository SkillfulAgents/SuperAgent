import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { AppDatabase } from '@shared/lib/db'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { agentBrowserAccounts, agents, auditLog, browserAccounts, browserAccountSessions, user } from '@shared/lib/db/schema'
import { resetVaultKeyCache, sealJson } from './vault-crypto'

let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

const {
  clearAccountRejected,
  deleteAccount,
  findGrantedAccount,
  findOwnedProviderAccount,
  getOwnedAccount,
  grantAccount,
  isAccountGranted,
  listAccountAgentSlugs,
  listGrantedAccounts,
  listOwnedAccounts,
  listOwnedAccountsElsewhere,
  markAccountRejected,
  readAccountValues,
  recentPasswordFills,
  recordAccountUse,
  renameAccount,
  revokeAccount,
  saveAccount,
  switchAccountToVia,
  VaultConflictError,
} = await import('./vault-service')

let handle: TestDatabase
let dataDir: string

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-service-'))
  vi.stubEnv('SUPERAGENT_DATA_DIR', dataDir)
  vi.stubEnv('BETTER_AUTH_SECRET', '')
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
  const now = new Date()
  await testDb.insert(agents).values([
    { slug: 'agent-a', name: 'Agent A', createdAt: now },
    { slug: 'agent-b', name: 'Agent B', createdAt: now },
  ]).run()
})

afterEach(async () => {
  await handle.close()
})

async function addUser(id: string) {
  const now = new Date()
  await testDb.insert(user).values({ id, name: id, email: `${id}@example.com`, emailVerified: true, createdAt: now, updatedAt: now }).run()
}

const github = { owner: null, site: 'github.com', origin: 'https://github.com' }

describe('saveAccount', () => {
  it('creates an account on the first save and merges each later step into it', async () => {
    const first = await saveAccount({ ...github, username: 'Octocat@Example.com ' })
    expect(first.created).toBe(true)
    expect(first.account).toMatchObject({ site: 'github.com', username: 'Octocat@Example.com', parts: [], via: null })

    const second = await saveAccount({ ...github, username: 'octocat@example.com', values: { password: 'hunter2' } })
    expect(second.created).toBe(false)
    expect(second.account.id).toBe(first.account.id)
    expect(second.account.parts).toEqual(['password'])

    const third = await saveAccount({ ...github, origin: 'https://other.github.com', username: 'OCTOCAT@example.com', values: { 'text:workspace': 'acme' } })
    expect(third.account.parts).toEqual(['password', 'text:workspace'])
    // The first save's username and origin stay.
    expect(third.account).toMatchObject({ username: 'Octocat@Example.com', origin: 'https://github.com' })
    expect(await readAccountValues(first.account.id)).toEqual({ password: 'hunter2', 'text:workspace': 'acme' })
  })

  it('keeps where the password was last typed as the account\'s origin', async () => {
    const wiki = { owner: null, site: 'corp.example', username: 'me' }
    const { account } = await saveAccount({ ...wiki, origin: 'http://wiki.corp.example', values: { password: 'one' } })
    // Another part from an encrypted page leaves it.
    await saveAccount({ ...wiki, origin: 'https://sso.corp.example', values: { 'text:workspace': 'acme' } })
    expect((await getOwnedAccount(null, account.id))?.origin).toBe('http://wiki.corp.example')
    // The password typed on https: it is an https account's now.
    await saveAccount({ ...wiki, origin: 'https://sso.corp.example', values: { password: 'two' } })
    expect((await getOwnedAccount(null, account.id))?.origin).toBe('https://sso.corp.example')
    // Typed again on the plain-HTTP page: the user put it there.
    await saveAccount({ ...wiki, origin: 'http://wiki.corp.example', values: { password: 'three' } })
    expect((await getOwnedAccount(null, account.id))?.origin).toBe('http://wiki.corp.example')
  })

  it('refuses a username longer than the vault keeps', async () => {
    await expect(saveAccount({ ...github, username: 'x'.repeat(321) })).rejects.toBeInstanceOf(VaultConflictError)
  })

  it('replaces a part the user entered again', async () => {
    const { account } = await saveAccount({ ...github, username: 'octocat', values: { password: 'old' } })
    await saveAccount({ ...github, username: 'octocat', values: { password: 'new' } })
    expect(await readAccountValues(account.id)).toEqual({ password: 'new' })
  })

  it('keeps the values sealed in the database, bound to their row', async () => {
    const { account } = await saveAccount({ ...github, username: 'octocat', values: { password: 'hunter2-plaintext' } })
    const row = await testDb.select().from(browserAccounts).where(eq(browserAccounts.id, account.id)).get()
    expect(row?.secrets).toMatch(/^v1:/)
    expect(JSON.stringify(row)).not.toContain('hunter2-plaintext')

    // A sealed value copied onto another row does not open there.
    const other = await saveAccount({ ...github, username: 'hubot' })
    await testDb.update(browserAccounts).set({ secrets: row!.secrets, parts: '["password"]' }).where(eq(browserAccounts.id, other.account.id)).run()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await readAccountValues(other.account.id)).toEqual({})
    expect(errors.mock.calls.flat().join(' ')).not.toContain('hunter2')
    errors.mockRestore()
  })

  it('lands both of two saves made at once', async () => {
    await Promise.all([
      saveAccount({ ...github, username: 'octocat', values: { password: 'pw' } }),
      saveAccount({ ...github, username: 'octocat', values: { 'text:workspace': 'acme' } }),
    ])
    const accounts = await listOwnedAccounts(null)
    expect(accounts).toHaveLength(1)
    expect(await readAccountValues(accounts[0].id)).toEqual({ password: 'pw', 'text:workspace': 'acme' })
  })

  it('points a site account at the provider account it signs in with, the same owner\'s only', async () => {
    await addUser('alice')
    await addUser('bob')
    const google = await saveAccount({ owner: 'alice', site: 'google.com', origin: 'https://accounts.google.com', username: 'alice@gmail.com' })
    const medium = await saveAccount({ owner: 'alice', site: 'medium.com', origin: 'https://medium.com', username: 'alice@gmail.com', viaAccountId: google.account.id })
    expect(medium.account.via).toEqual({ id: google.account.id, site: 'google.com', username: 'alice@gmail.com', label: null })

    await expect(saveAccount({ owner: 'bob', site: 'medium.com', origin: 'https://medium.com', username: 'bob', viaAccountId: google.account.id }))
      .rejects.toBeInstanceOf(VaultConflictError)
    // Deleting the provider account leaves the site account, pointing nowhere.
    await deleteAccount('alice', google.account.id)
    expect((await getOwnedAccount('alice', medium.account.id))?.via).toBeNull()
  })

  it('refuses an account without a username', async () => {
    await expect(saveAccount({ ...github, username: '   ' })).rejects.toBeInstanceOf(VaultConflictError)
  })

  it('keeps one username on two tenants of a shared host as two accounts', async () => {
    const acme = await saveAccount({ owner: null, site: 'acme.okta.com', origin: 'https://acme.okta.com', username: 'me@acme.com', values: { password: 'acme-pw' } })
    const other = await saveAccount({ owner: null, site: 'other.okta.com', origin: 'https://other.okta.com', username: 'me@acme.com', values: { password: 'other-pw' } })
    expect(other.account.id).not.toBe(acme.account.id)
    expect(await readAccountValues(acme.account.id)).toEqual({ password: 'acme-pw' })
    await grantAccount({ accountId: acme.account.id, agentSlug: 'agent-a', grantedBy: null })
    expect(await findGrantedAccount('agent-a', 'evil.okta.com', 'me@acme.com')).toBeNull()
  })

  it('completes a provider account saved by name on the site its sign-in form is on', async () => {
    const named = await saveAccount({ owner: null, site: 'google.com', origin: 'https://google.com', username: 'me@gmail.com' })
    const medium = await saveAccount({ owner: null, site: 'medium.com', origin: 'https://medium.com', username: 'me@gmail.com', viaAccountId: named.account.id })
    const typed = await saveAccount({ owner: null, site: 'accounts.google.com', origin: 'https://accounts.google.com', username: 'me@gmail.com', values: { password: 'pw' } })
    expect(typed).toMatchObject({ created: false, account: { id: named.account.id, site: 'accounts.google.com', parts: ['password'] } })
    expect((await getOwnedAccount(null, medium.account.id))?.via?.site).toBe('accounts.google.com')
    expect((await findOwnedProviderAccount(null, 'google.com', 'ME@gmail.com'))?.id).toBe(named.account.id)
    // Only a provider's: another site's account by name stays where it was saved.
    const shop = await saveAccount({ owner: null, site: 'shop.example', origin: 'https://shop.example', username: 'me' })
    const login = await saveAccount({ owner: null, site: 'login.shop.example', origin: 'https://login.shop.example', username: 'me', values: { password: 'pw' } })
    expect(login.account.id).not.toBe(shop.account.id)
  })

  it('does not save over an account it cannot unlock, unless every part it holds is entered again', async () => {
    const { account } = await saveAccount({ ...github, username: 'octocat', values: { password: 'pw', 'text:workspace': 'acme' } })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Another deployment's secret: the seal no longer opens.
    vi.stubEnv('BETTER_AUTH_SECRET', 'a-different-auth-secret-of-enough-length')
    try {
      expect(await readAccountValues(account.id)).toEqual({})
      await expect(saveAccount({ ...github, username: 'octocat', values: { password: 'new' } })).rejects.toBeInstanceOf(VaultConflictError)
      await saveAccount({ ...github, username: 'octocat', values: { password: 'new', 'text:workspace': 'acme' } })
      expect(await readAccountValues(account.id)).toEqual({ password: 'new', 'text:workspace': 'acme' })
    } finally {
      vi.stubEnv('BETTER_AUTH_SECRET', '')
      errors.mockRestore()
    }
  })

  it('marks an account the agent says the site turned down, until the user enters its password again', async () => {
    const { account } = await saveAccount({ ...github, username: 'octocat', values: { password: 'old', 'text:workspace': 'acme' } })
    // Only an account the agent may use.
    await markAccountRejected({ agentSlug: 'agent-a', accountId: account.id, sessionId: 's-1' })
    expect((await getOwnedAccount(null, account.id))?.rejectedAt).toBeNull()

    await grantAccount({ accountId: account.id, agentSlug: 'agent-a', grantedBy: null })
    await markAccountRejected({ agentSlug: 'agent-a', accountId: account.id, sessionId: 's-1' })
    expect((await getOwnedAccount(null, account.id))?.rejectedAt).toBeInstanceOf(Date)
    expect(await testDb.select().from(auditLog).all()).toMatchObject([{ objectId: account.id, action: 'rejected' }])
    // Another part is not the correction; the password is.
    await saveAccount({ ...github, username: 'octocat', values: { 'text:workspace': 'acme2' } })
    expect((await getOwnedAccount(null, account.id))?.rejectedAt).toBeInstanceOf(Date)
    await saveAccount({ ...github, username: 'octocat', values: { password: 'new' } })
    expect((await getOwnedAccount(null, account.id))?.rejectedAt).toBeNull()

    await markAccountRejected({ agentSlug: 'agent-a', accountId: account.id, sessionId: 's-2' })
    await clearAccountRejected(account.id)
    expect((await getOwnedAccount(null, account.id))?.rejectedAt).toBeNull()
  })

  it('signs in with its password again once the user saves one, no longer through the provider', async () => {
    const google = await saveAccount({ owner: null, site: 'accounts.google.com', origin: 'https://accounts.google.com', username: 'me@gmail.com' })
    const { account } = await saveAccount({ owner: null, site: 'medium.com', origin: 'https://medium.com', username: 'me@gmail.com', viaAccountId: google.account.id })
    // Another part keeps the provider sign-in; a password ends it.
    expect((await saveAccount({ owner: null, site: 'medium.com', origin: 'https://medium.com', username: 'me@gmail.com', values: { 'text:workspace': 'acme' } })).account.via?.id).toBe(google.account.id)
    const saved = await saveAccount({ owner: null, site: 'medium.com', origin: 'https://medium.com', username: 'me@gmail.com', values: { password: 'pw' } })
    expect(saved.account).toMatchObject({ id: account.id, via: null, parts: ['password', 'text:workspace'] })
  })

  it('keeps a provider account named in the card one account through an email-first sign-in', async () => {
    const named = await saveAccount({ owner: null, site: 'google.com', origin: 'https://google.com', username: 'me@gmail.com' })
    const medium = await saveAccount({ owner: null, site: 'medium.com', origin: 'https://medium.com', username: 'me@gmail.com', viaAccountId: named.account.id })
    await grantAccount({ accountId: named.account.id, agentSlug: 'agent-a', grantedBy: null })
    // The email step saves the username alone; the password step comes after.
    const email = await saveAccount({ owner: null, site: 'accounts.google.com', origin: 'https://accounts.google.com', username: 'me@gmail.com' })
    expect(email).toMatchObject({ created: false, account: { id: named.account.id, site: 'accounts.google.com', parts: [] } })
    const password = await saveAccount({ owner: null, site: 'accounts.google.com', origin: 'https://accounts.google.com', username: 'me@gmail.com', values: { password: 'pw' } })
    expect(password.account).toMatchObject({ id: named.account.id, parts: ['password'] })
    expect(await listOwnedAccounts(null)).toHaveLength(2)
    expect((await getOwnedAccount(null, medium.account.id))?.via?.id).toBe(named.account.id)
    expect(await listAccountAgentSlugs(named.account.id)).toEqual(['agent-a'])
  })

  it('switches an account to sign in through a provider: its password goes, other parts stay', async () => {
    const google = await saveAccount({ owner: null, site: 'accounts.google.com', origin: 'https://accounts.google.com', username: 'me@gmail.com' })
    const { account } = await saveAccount({ owner: null, site: 'app.slack.com', origin: 'https://app.slack.com', username: 'me@gmail.com', values: { password: 'pw', 'text:workspace': 'acme' } })
    const switched = await switchAccountToVia({ owner: null, accountId: account.id, viaAccountId: google.account.id })
    expect(switched).toMatchObject({ id: account.id, parts: ['text:workspace'], via: { id: google.account.id } })
    expect(await readAccountValues(account.id)).toEqual({ 'text:workspace': 'acme' })
  })
})

describe('owners', () => {
  it('keeps each user\'s vault apart, even for one username on one site', async () => {
    await addUser('alice')
    await addUser('bob')
    const alice = await saveAccount({ owner: 'alice', site: 'github.com', origin: 'https://github.com', username: 'shared', values: { password: 'a' } })
    const bob = await saveAccount({ owner: 'bob', site: 'github.com', origin: 'https://github.com', username: 'shared', values: { password: 'b' } })
    expect(alice.account.id).not.toBe(bob.account.id)
    expect((await listOwnedAccounts('alice')).map((account) => account.id)).toEqual([alice.account.id])
    expect(await getOwnedAccount('bob', alice.account.id)).toBeNull()
    expect(await renameAccount('bob', alice.account.id, 'mine')).toBe(false)
    expect(await deleteAccount('bob', alice.account.id)).toBeNull()
    expect(await readAccountValues(alice.account.id)).toEqual({ password: 'a' })
  })
})

describe('grants', () => {
  it('lists an agent\'s accounts on a site only, and finds one by username in any case', async () => {
    const octocat = await saveAccount({ ...github, username: 'Octocat', values: { password: 'pw' } })
    const hubot = await saveAccount({ ...github, username: 'hubot' })
    const gitlab = await saveAccount({ owner: null, site: 'gitlab.com', origin: 'https://gitlab.com', username: 'octocat' })
    expect(await grantAccount({ accountId: octocat.account.id, agentSlug: 'agent-a', grantedBy: null })).toBe(true)
    expect(await grantAccount({ accountId: octocat.account.id, agentSlug: 'agent-a', grantedBy: null })).toBe(false)
    await grantAccount({ accountId: gitlab.account.id, agentSlug: 'agent-a', grantedBy: null })
    await grantAccount({ accountId: hubot.account.id, agentSlug: 'agent-b', grantedBy: null })

    expect((await listGrantedAccounts('agent-a', 'github.com')).map((account) => account.username)).toEqual(['Octocat'])
    expect((await findGrantedAccount('agent-a', 'github.com', 'OCTOCAT'))?.id).toBe(octocat.account.id)
    expect(await findGrantedAccount('agent-a', 'github.com', 'hubot')).toBeNull()
    expect(await isAccountGranted('agent-b', octocat.account.id)).toBe(false)
  })

  it('does not grant the provider account a site account points at', async () => {
    const google = await saveAccount({ owner: null, site: 'google.com', origin: 'https://accounts.google.com', username: 'me@gmail.com' })
    const medium = await saveAccount({ owner: null, site: 'medium.com', origin: 'https://medium.com', username: 'me@gmail.com', viaAccountId: google.account.id })
    await grantAccount({ accountId: medium.account.id, agentSlug: 'agent-a', grantedBy: null })
    expect(await listGrantedAccounts('agent-a', 'google.com')).toEqual([])
    // Offered as the account it signs in with: not the site's own, nor one that itself signs in elsewhere.
    const sso = await saveAccount({ owner: null, site: 'acme-sso.com', origin: 'https://acme-sso.com', username: 'me' })
    expect((await listOwnedAccountsElsewhere(null, 'medium.com')).map((account) => account.id)).toEqual([google.account.id, sso.account.id])
    // Google's own sign-in site is on its domain: no Google account offered there.
    expect(await listOwnedAccountsElsewhere(null, 'accounts.google.com')).toEqual([expect.objectContaining({ id: sso.account.id })])
  })

  it('revokes only the owner\'s accounts, and goes with the agent and the account', async () => {
    await addUser('alice')
    await addUser('bob')
    const { account } = await saveAccount({ owner: 'alice', site: 'github.com', origin: 'https://github.com', username: 'alice' })
    await grantAccount({ accountId: account.id, agentSlug: 'agent-a', grantedBy: 'alice' })
    await grantAccount({ accountId: account.id, agentSlug: 'agent-b', grantedBy: 'alice' })
    expect(await listAccountAgentSlugs(account.id)).toEqual(['agent-a', 'agent-b'])

    expect(await revokeAccount({ owner: 'bob', accountId: account.id, agentSlug: 'agent-a' })).toBe(false)
    expect(await revokeAccount({ owner: 'alice', accountId: account.id, agentSlug: 'agent-a' })).toBe(true)
    expect(await revokeAccount({ owner: 'alice', accountId: account.id, agentSlug: 'agent-a' })).toBe(false)

    await testDb.delete(agents).where(eq(agents.slug, 'agent-b')).run()
    expect(await listAccountAgentSlugs(account.id)).toEqual([])

    await grantAccount({ accountId: account.id, agentSlug: 'agent-a', grantedBy: 'alice' })
    await testDb.insert(browserAccountSessions).values({
      id: 'session-1',
      accountId: account.id,
      browserType: 'container',
      bundle: sealJson<unknown>({ version: 1 }, { purpose: 'account-session', id: 'session-1', site: 'github.com' }, z.unknown()),
      capturedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    }).run()
    expect(await deleteAccount('alice', account.id)).toEqual({ agentSlugs: ['agent-a'] })
    expect(await testDb.select().from(agentBrowserAccounts).all()).toEqual([])
    expect(await testDb.select().from(browserAccountSessions).all()).toEqual([])
  })

  it('records a use on the account and the grant, and in the audit log without values', async () => {
    const { account } = await saveAccount({ ...github, username: 'octocat', values: { password: 'hunter2' } })
    await grantAccount({ accountId: account.id, agentSlug: 'agent-a', grantedBy: null })
    await recordAccountUse({ agentSlug: 'agent-a', accountId: account.id, sessionId: 's-1', password: true, by: 'vault' })

    expect((await getOwnedAccount(null, account.id))?.lastUsedAt).toBeInstanceOf(Date)
    const grant = await testDb.select().from(agentBrowserAccounts).get()
    expect(grant?.lastUsedAt).toBeInstanceOf(Date)
    const audit = await testDb.select().from(auditLog).all()
    expect(audit).toMatchObject([{ object: 'browser_account', objectId: account.id, action: 'used' }])
    expect(JSON.stringify(audit)).not.toContain('hunter2')
    expect(JSON.parse(audit[0].details!)).toEqual({ agentSlug: 'agent-a', sessionId: 's-1', password: true, by: 'vault' })
  })

  it('reads back when the password went in, newest first, from any session, within the window', async () => {
    const { account } = await saveAccount({ ...github, username: 'octocat', values: { password: 'hunter2' } })
    const { account: other } = await saveAccount({ ...github, username: 'hubot', values: { password: 'pw' } })
    const used = (objectId: string, at: number, details: Record<string, unknown> | string) => ({
      id: `audit-${objectId}-${at}`,
      createdAt: new Date(at),
      userId: null,
      object: 'browser_account',
      objectId,
      action: 'used',
      details: typeof details === 'string' ? details : JSON.stringify(details),
    })
    const now = Date.now()
    await testDb.insert(auditLog).values([
      used(account.id, now - 5 * 60_000, { sessionId: 's-2', password: true, by: 'vault' }),
      used(account.id, now - 10 * 60_000, { sessionId: 's-1', password: true, by: 'user' }),
      // No password went in, a row from before the details said so, one past the window, another account's, unreadable.
      used(account.id, now - 15 * 60_000, { sessionId: 's-1', password: false, by: 'vault' }),
      used(account.id, now - 20 * 60_000, { agentSlug: 'agent-a', sessionId: 's-0' }),
      used(account.id, now - 2 * 60 * 60_000, { sessionId: 's-0', password: true, by: 'vault' }),
      used(other.id, now - 60_000, { sessionId: 's-3', password: true, by: 'vault' }),
      used(account.id, now - 25 * 60_000, 'not json'),
    ]).run()

    expect(await recentPasswordFills(account.id, 60 * 60_000, now)).toEqual([
      { at: new Date(now - 5 * 60_000), unattended: true },
      { at: new Date(now - 10 * 60_000), unattended: false },
    ])
  })
})

describe('renameAccount', () => {
  it('sets a label, and clears it with an empty one', async () => {
    const { account } = await saveAccount({ ...github, username: 'octocat' })
    expect(await renameAccount(null, account.id, ' Work ')).toBe(true)
    expect((await getOwnedAccount(null, account.id))?.label).toBe('Work')
    await renameAccount(null, account.id, '')
    expect((await getOwnedAccount(null, account.id))?.label).toBeNull()
  })
})
