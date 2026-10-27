import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { AppDatabase } from '@shared/lib/db'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { agentBrowserAccounts, agents, browserAccountSessions } from '@shared/lib/db/schema'
import { resetVaultKeyCache } from './vault-crypto'
import type { SessionBundle } from './vault-schemas'

let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

const { saveAccount, grantAccount } = await import('./vault-service')
const {
  forgetAccountSessions,
  heldAccountOnSite,
  heldSessionVersion,
  listAccountSessions,
  markSessionHeld,
  readAccountSession,
  saveAccountSession,
} = await import('./session-service')

let handle: TestDatabase
let dataDir: string

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-service-'))
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
  const now = new Date()
  await testDb.insert(agents).values([
    { slug: 'agent-a', name: 'Agent A', createdAt: now },
    { slug: 'agent-b', name: 'Agent B', createdAt: now },
  ]).run()
})

afterEach(async () => {
  await handle.close()
})

const bundle = (who: string, site = 'github.com'): SessionBundle => ({
  version: 1,
  site,
  capturedAt: '2026-10-26T00:00:00.000Z',
  cookies: [{ name: 'user_session', value: `${who}-session`, domain: site, path: '/', httpOnly: true, secure: true }],
  origins: [{ origin: `https://${site}`, localStorage: [['token', `${who}-token`]], indexedDB: [] }],
})

async function account(username: string, site = 'github.com') {
  const saved = (await saveAccount({ owner: null, site, origin: `https://${site}`, username, values: { password: `${username}-pw` } })).account
  for (const agentSlug of ['agent-a', 'agent-b']) await grantAccount({ accountId: saved.id, agentSlug, grantedBy: null })
  return saved
}

describe('saved sessions', () => {
  it('seal a capture per account and browser type, the newest over the one before', async () => {
    const alice = await account('alice')
    await saveAccountSession({ agentSlug: 'agent-a', account: alice, browserType: 'container', bundle: bundle('alice-1') })
    await saveAccountSession({ agentSlug: 'agent-a', account: alice, browserType: 'container', bundle: bundle('alice-2') })
    await saveAccountSession({ agentSlug: 'agent-a', account: alice, browserType: 'chrome', bundle: bundle('alice-chrome') })

    expect((await readAccountSession(alice, 'container'))?.bundle.cookies[0].value).toBe('alice-2-session')
    expect((await readAccountSession(alice, 'chrome'))?.bundle.cookies[0].value).toBe('alice-chrome-session')
    expect(await readAccountSession(alice, 'browserbase')).toBeNull()
    // Sealed: the row never holds the session in the clear.
    const rows = await testDb.select().from(browserAccountSessions).all()
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row.bundle).not.toContain('session')
  })

  it('number captures in one sequence across accounts, so a version names one capture', async () => {
    const alice = await account('alice')
    const bob = await account('bob', 'gitlab.com')
    await saveAccountSession({ agentSlug: 'agent-a', account: alice, browserType: 'container', bundle: bundle('alice') })
    await saveAccountSession({ agentSlug: 'agent-a', account: bob, browserType: 'container', bundle: bundle('bob', 'gitlab.com') })
    await saveAccountSession({ agentSlug: 'agent-a', account: alice, browserType: 'container', bundle: bundle('alice-again') })

    expect((await readAccountSession(bob, 'container'))?.version).toBe(2)
    expect((await readAccountSession(alice, 'container'))?.version).toBe(3)
  })

  it('give two captures at once two versions, and keep the last', async () => {
    const alice = await account('alice')
    await Promise.all(['one', 'two', 'three'].map((who) =>
      saveAccountSession({ agentSlug: who === 'two' ? 'agent-b' : 'agent-a', account: alice, browserType: 'container', bundle: bundle(who) })))
    const saved = await readAccountSession(alice, 'container')
    expect(saved?.version).toBe(3)
    // Each agent holds the version its own capture got.
    expect(new Set([await heldSessionVersion('agent-a', alice.id), await heldSessionVersion('agent-b', alice.id)]).size).toBe(2)
  })

  it('mark what the agent\'s browser holds: the capture it saved or was given, one account per site', async () => {
    const alice = await account('alice')
    const bob = await account('bob')
    await saveAccountSession({ agentSlug: 'agent-a', account: alice, browserType: 'container', bundle: bundle('alice') })
    expect(await heldSessionVersion('agent-a', alice.id)).toBe(1)
    expect(await heldSessionVersion('agent-b', alice.id)).toBeNull()

    // Bob's session restored into agent A's browser: Alice's is no longer there.
    await saveAccountSession({ agentSlug: 'agent-b', account: bob, browserType: 'container', bundle: bundle('bob') })
    await markSessionHeld({ agentSlug: 'agent-a', account: bob, version: 2 })
    expect(await heldSessionVersion('agent-a', bob.id)).toBe(2)
    expect(await heldSessionVersion('agent-a', alice.id)).toBeNull()
  })

  it('name the one account on a site whose session an agent\'s browser holds', async () => {
    const alice = await account('alice')
    const bob = await account('bob')
    expect(await heldAccountOnSite('agent-a', 'github.com')).toBeNull()
    await saveAccountSession({ agentSlug: 'agent-a', account: alice, browserType: 'container', bundle: bundle('alice') })
    expect(await heldAccountOnSite('agent-a', 'github.com')).toEqual({ accountId: alice.id, version: 1 })
    await saveAccountSession({ agentSlug: 'agent-a', account: bob, browserType: 'container', bundle: bundle('bob') })
    expect(await heldAccountOnSite('agent-a', 'github.com')).toEqual({ accountId: bob.id, version: 2 })
    expect(await heldAccountOnSite('agent-b', 'github.com')).toBeNull()
    expect(await heldAccountOnSite('agent-a', 'gitlab.com')).toBeNull()
  })

  it('does not open a session copied into another account\'s row', async () => {
    const alice = await account('alice')
    const bob = await account('bob')
    await saveAccountSession({ agentSlug: 'agent-a', account: alice, browserType: 'container', bundle: bundle('alice') })
    const sealed = (await testDb.select().from(browserAccountSessions).get())!.bundle
    await testDb.insert(browserAccountSessions).values({
      id: `${bob.id}:container`, accountId: bob.id, browserType: 'container', bundle: sealed, version: 9, capturedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    }).run()
    expect(await readAccountSession(bob, 'container')).toBeNull()
  })

  it('list where an account has sessions, never their contents, and forget them for its owner only', async () => {
    const alice = await account('alice')
    await saveAccountSession({ agentSlug: 'agent-a', account: alice, browserType: 'chrome', bundle: bundle('alice') })
    const listed = await listAccountSessions([alice.id])
    expect(listed).toEqual([{ accountId: alice.id, browserType: 'chrome', capturedAt: expect.any(Date) }])

    expect(await forgetAccountSessions('someone-else', alice.id)).toBe(false)
    expect(await listAccountSessions([alice.id])).toHaveLength(1)
    expect(await forgetAccountSessions(null, alice.id)).toBe(true)
    expect(await listAccountSessions([alice.id])).toEqual([])
  })

  it('forget what each browser held, so a later capture with the same number restores', async () => {
    const alice = await account('alice')
    await saveAccountSession({ agentSlug: 'agent-a', account: alice, browserType: 'container', bundle: bundle('alice') })
    expect(await heldSessionVersion('agent-a', alice.id)).toBe(1)
    await forgetAccountSessions(null, alice.id)
    expect(await heldSessionVersion('agent-a', alice.id)).toBeNull()
    // The sequence starts over with nothing left: agent A's browser does not hold this one.
    await saveAccountSession({ agentSlug: 'agent-b', account: alice, browserType: 'container', bundle: bundle('alice-again') })
    expect((await readAccountSession(alice, 'container'))?.version).toBe(1)
    expect(await heldSessionVersion('agent-a', alice.id)).toBeNull()
  })

  it('go with the account', async () => {
    const alice = await account('alice')
    await saveAccountSession({ agentSlug: 'agent-a', account: alice, browserType: 'container', bundle: bundle('alice') })
    const { deleteAccount } = await import('./vault-service')
    await deleteAccount(null, alice.id)
    expect(await testDb.select().from(browserAccountSessions).all()).toEqual([])
    expect(await testDb.select().from(agentBrowserAccounts).where(eq(agentBrowserAccounts.accountId, alice.id)).all()).toEqual([])
  })
})
