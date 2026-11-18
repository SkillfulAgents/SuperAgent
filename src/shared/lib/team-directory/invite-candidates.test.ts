import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { backgroundSettled } from '@shared/lib/background'
import { user } from '@shared/lib/db/schema'

const state = vi.hoisted(() => ({ db: null as TestDatabase['db'] | null }))
vi.mock('@shared/lib/db', () => ({ get db() { return state.db } }))
vi.mock('@shared/lib/auth/secret', () => ({ getOrCreateAuthSecret: async () => 'team-directory-test-secret' }))

import { searchInviteCandidates } from './invite-candidates'
import { registerDirectoryProvider } from './registry'
import { saveDirectoryConnection } from './store'
import { createFakeDirectoryProvider, type FakeDirectory } from './testing/fake-directory-provider'

let handle: TestDatabase
let fake: FakeDirectory
let unregister: () => void

async function addAccount(id: string, name: string, email: string) {
  const now = new Date()
  await handle.db.insert(user).values({ id, name, email, createdAt: now, updatedAt: now }).run()
}

/** Slack's users.list answering with these members, as the real provider reads them. */
function slackWorkspace(members: Array<{ id: string; name: string; email: string }>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (!url.endsWith('/users.list')) return new Response(JSON.stringify({ ok: false, error: 'unknown_method' }))
    return new Response(JSON.stringify({
      ok: true,
      members: members.map((m) => ({ id: m.id, is_email_confirmed: true, profile: { real_name: m.name, email: m.email } })),
    }))
  }))
}

beforeEach(async () => {
  vi.stubEnv('AUTH_MODE', 'true')
  handle = await createTestDatabase()
  state.db = handle.db
  fake = createFakeDirectoryProvider('fake', 'Fake Directory')
  unregister = registerDirectoryProvider(fake.provider)
})

afterEach(async () => {
  await backgroundSettled()
  unregister()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await handle.close()
})

describe('searchInviteCandidates', () => {
  it('lists accounts first, then directory people who have no account', async () => {
    await addAccount('u-dana', 'Dana Whitfield', 'dana@acme.test')
    await saveDirectoryConnection({ provider: 'fake', tenant: { tenantId: 'acme', tenantName: 'Acme' }, credentials: { token: 'acme-token' }, createdByUserId: null })
    fake.setPeople('acme', [
      fake.person('acme', 'f1', 'Dana (directory)', 'DANA@acme.test'),
      fake.person('acme', 'f2', 'Dan Ortiz', 'dan@acme.test', { avatarUrl: 'https://avatars.test/dan.png' }),
      fake.person('acme', 'f3', 'Sara Kim', 'sara@acme.test'),
    ])

    expect(await searchInviteCandidates('dan', [])).toEqual([
      { kind: 'user', id: 'u-dana', name: 'Dana Whitfield', email: 'dana@acme.test', image: null, notOnGamut: false },
      { kind: 'directory', directoryRef: { directoryId: expect.any(String), remoteId: 'f2' }, name: 'Dan Ortiz', email: 'dan@acme.test', image: 'https://avatars.test/dan.png', notOnGamut: true, source: 'Fake Directory · Acme' },
    ])
  })

  it('leaves out directory people who are already members, as their accounts are', async () => {
    await addAccount('u-dana', 'Dana Whitfield', 'dana@acme.test')
    await saveDirectoryConnection({ provider: 'fake', tenant: { tenantId: 'acme', tenantName: 'Acme' }, credentials: { token: 'acme-token' }, createdByUserId: null })
    fake.setPeople('acme', [fake.person('acme', 'f1', 'Dana Whitfield', 'dana@acme.test')])
    expect(await searchInviteCandidates('dana', ['u-dana'])).toEqual([])
  })

  it('merges a person Slack and another directory both list, through the same code', async () => {
    await saveDirectoryConnection({ provider: 'slack', tenant: { tenantId: 'T1', tenantName: 'Acme' }, credentials: { botToken: 'xoxb-test' }, createdByUserId: null })
    await saveDirectoryConnection({ provider: 'fake', tenant: { tenantId: 'acme', tenantName: 'Acme HR' }, credentials: { token: 'acme-token' }, createdByUserId: null })
    slackWorkspace([{ id: 'U1', name: 'Sara Kim', email: 'sara@acme.test' }, { id: 'U2', name: 'Lee Park', email: 'lee@acme.test' }])
    fake.setPeople('acme', [fake.person('acme', 'f1', 'Sara K.', 'Sara@Acme.test'), fake.person('acme', 'f2', 'Sam Field', 'sam@acme.test')])

    // The picker opening (no query) only starts the listings; the next search has them.
    expect(await searchInviteCandidates('', [])).toEqual([])
    await backgroundSettled()
    const found = await searchInviteCandidates('', [])
    expect(found.map((c) => [c.name, c.kind === 'directory' ? c.source : null])).toEqual([
      ['Lee Park', 'Slack · Acme'],
      ['Sam Field', 'Fake Directory · Acme HR'],
      ['Sara Kim', 'Slack · Acme'],
    ])
  })

  it('shows no directory people outside auth mode, where there is no one to share with', async () => {
    vi.stubEnv('AUTH_MODE', 'false')
    await saveDirectoryConnection({ provider: 'fake', tenant: { tenantId: 'acme', tenantName: 'Acme' }, credentials: { token: 'acme-token' }, createdByUserId: null })
    fake.setPeople('acme', [fake.person('acme', 'f1', 'Dan Ortiz', 'dan@acme.test')])
    expect(await searchInviteCandidates('dan', [])).toEqual([])
    expect(fake.listCalls).toEqual([])
  })

  it('skips a directory whose provider this build no longer has', async () => {
    await saveDirectoryConnection({ provider: 'fake', tenant: { tenantId: 'acme', tenantName: 'Acme' }, credentials: { token: 'acme-token' }, createdByUserId: null })
    unregister()
    expect(await searchInviteCandidates('dan', [])).toEqual([])
  })

  it('checks many people against accounts in bounded chunks', async () => {
    await saveDirectoryConnection({ provider: 'fake', tenant: { tenantId: 'acme', tenantName: 'Acme' }, credentials: { token: 'acme-token' }, createdByUserId: null })
    const people = Array.from({ length: 200 }, (_, i) => fake.person('acme', `f${i}`, `Person ${String(i).padStart(3, '0')}`, `p${i}@acme.test`))
    fake.setPeople('acme', people)
    // The first 120 by name already have accounts.
    for (const p of people.slice(0, 120)) await addAccount(`u-${p.remoteId}`, p.name, p.email!)
    const found = (await searchInviteCandidates('person', [])).filter((c) => c.kind === 'directory')
    expect(found).toHaveLength(50)
    expect(found[0].name).toBe('Person 120')
  })
})
