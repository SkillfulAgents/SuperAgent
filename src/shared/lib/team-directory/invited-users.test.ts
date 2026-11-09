import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { backgroundSettled } from '@shared/lib/background'
import { agentAcl, user } from '@shared/lib/db/schema'

const state = vi.hoisted(() => ({ db: null as TestDatabase['db'] | null }))
vi.mock('@shared/lib/db', () => ({ get db() { return state.db } }))
vi.mock('@shared/lib/auth/secret', () => ({ getOrCreateAuthSecret: async () => 'team-directory-test-secret' }))
vi.mock('@shared/lib/agent-integrations/app-link', () => ({ resolvePublicAppBaseUrl: async () => 'https://gamut.test' }))

import { DirectoryInviteError, inviteDirectoryPerson, notifyInvitedUser } from './invited-users'
import { registerDirectoryProvider } from './registry'
import { saveDirectoryConnection, deleteDirectoryConnection } from './store'
import { searchInviteCandidates } from './invite-candidates'
import { createFakeDirectoryProvider, type FakeDirectory } from './testing/fake-directory-provider'
import { readInviteToken } from '@shared/lib/auth/invite-tokens'
import { addAgentUsers, countOtherMembers } from '@shared/lib/services/agent-members-service'
import { getPushableAgentSlugs } from '@shared/lib/services/notification-service'

let handle: TestDatabase
let fake: FakeDirectory
let unregister: () => void
let directoryId: string

async function addUser(id: string, email: string, extra: Partial<typeof user.$inferInsert> = {}) {
  const now = new Date()
  await handle.db.insert(user).values({ id, name: id, email, createdAt: now, updatedAt: now, ...extra }).run()
}
async function grant(userId: string, agentSlug: string, role: 'owner' | 'user' | 'viewer' = 'user') {
  await handle.db.insert(agentAcl).values({ id: `${userId}-${agentSlug}`, userId, agentSlug, role, createdAt: new Date() }).run()
}

beforeEach(async () => {
  vi.stubEnv('AUTH_MODE', 'true')
  handle = await createTestDatabase()
  state.db = handle.db
  fake = createFakeDirectoryProvider('fake', 'Fake Directory')
  unregister = registerDirectoryProvider(fake.provider)
  fake.setPeople('acme', [
    fake.person('acme', 'u-dana', 'Dana Whitfield', 'Dana@Acme.test', { avatarUrl: 'https://avatars.test/dana.png' }),
    fake.person('acme', 'u-vic', 'Unverified Vic', 'vic@acme.test', { emailVerified: false }),
  ])
  directoryId = (await saveDirectoryConnection({ provider: 'fake', tenant: { tenantId: 'acme', tenantName: 'Acme' }, credentials: { token: 'acme-token' }, createdByUserId: null })).id
  await addUser('ada', 'ada@acme.test', { role: 'admin' })
})

afterEach(async () => {
  await backgroundSettled()
  unregister()
  vi.unstubAllEnvs()
  await handle.close()
})

describe('inviteDirectoryPerson', () => {
  it('makes an invited user for someone with no account, with no way to sign in', async () => {
    const { userId, invited } = await inviteDirectoryPerson({ directoryId, remoteId: 'u-dana' }, 'ada')
    expect(invited).toBe(true)
    const row = await handle.db.select().from(user).where(eq(user.id, userId)).get()
    expect(row).toMatchObject({
      name: 'Dana Whitfield', email: 'dana@acme.test', status: 'invited', emailVerified: false,
      image: 'https://avatars.test/dana.png', invitedByUserId: 'ada',
      directoryProvider: 'fake', directoryTenantId: 'acme', directoryRemoteId: 'u-dana',
    })
  })

  it('reuses the invited user, and an account that already has the email', async () => {
    const first = await inviteDirectoryPerson({ directoryId, remoteId: 'u-dana' }, 'ada')
    expect(await inviteDirectoryPerson({ directoryId, remoteId: 'u-dana' }, 'ada')).toEqual(first)

    await addUser('sara', 'Sara@Acme.test')
    fake.setPeople('acme', [fake.person('acme', 'u-sara', 'Sara Kim', 'sara@acme.test')])
    await handle.db.delete(user).where(eq(user.id, first.userId)).run()
    // The cached listing still has Dana; Sara is new to it, so list again.
    const { listDirectoryNow } = await import('./cache')
    const { getDirectoryConnection } = await import('./store')
    await listDirectoryNow((await getDirectoryConnection(directoryId))!)
    expect(await inviteDirectoryPerson({ directoryId, remoteId: 'u-sara' }, 'ada')).toEqual({ userId: 'sara', invited: false })
  })

  it('makes one row when two people invite the same person at once', async () => {
    const [a, b] = await Promise.all([
      inviteDirectoryPerson({ directoryId, remoteId: 'u-dana' }, 'ada'),
      inviteDirectoryPerson({ directoryId, remoteId: 'u-dana' }, 'ada'),
    ])
    expect(a.userId).toBe(b.userId)
    expect(await handle.db.select().from(user).where(eq(user.email, 'dana@acme.test')).all()).toHaveLength(1)
  })

  it('refuses someone whose email the directory has not verified, or who left it', async () => {
    await expect(inviteDirectoryPerson({ directoryId, remoteId: 'u-vic' }, 'ada')).rejects.toMatchObject({ status: 400 })
    await expect(inviteDirectoryPerson({ directoryId, remoteId: 'u-gone' }, 'ada')).rejects.toBeInstanceOf(DirectoryInviteError)
    await expect(inviteDirectoryPerson({ directoryId: 'nope', remoteId: 'u-dana' }, 'ada')).rejects.toMatchObject({ status: 404 })
  })
})

describe('notifyInvitedUser', () => {
  it('DMs them through their directory with a link that claims their account', async () => {
    const { userId } = await inviteDirectoryPerson({ directoryId, remoteId: 'u-dana' }, 'ada')
    expect(await notifyInvitedUser(userId, { kind: 'mentioned', agentName: 'Support', byName: 'Ada', text: 'can you look at this?' })).toBe('sent')
    expect(fake.sent).toHaveLength(1)
    const [{ user: to, message }] = fake.sent
    expect(to).toMatchObject({ provider: 'fake', tenantId: 'acme', remoteId: 'u-dana' })
    expect(message).toMatchObject({ headline: 'Ada mentioned you in Support on Gamut:', quote: 'can you look at this?', link: { label: 'Join Gamut to reply' } })
    const link = new URL(message.link.url)
    expect(link.origin).toBe('https://gamut.test')
    expect(await readInviteToken(link.searchParams.get('invite')!)).toBe(userId)
  })

  it('tells nobody who has joined, or whose directory is gone', async () => {
    expect(await notifyInvitedUser('ada', { kind: 'shared', agentName: 'Support', byName: 'Sara' })).toBe('not-invited')
    const { userId } = await inviteDirectoryPerson({ directoryId, remoteId: 'u-dana' }, 'ada')
    await deleteDirectoryConnection(directoryId)
    expect(await notifyInvitedUser(userId, { kind: 'shared', agentName: 'Support', byName: 'Ada' })).toBe('no-channel')
    expect(fake.sent).toEqual([])
  })
})

describe('invited users are not members yet', () => {
  it('are offered as accounts not on Gamut, once', async () => {
    await inviteDirectoryPerson({ directoryId, remoteId: 'u-dana' }, 'ada')
    expect(await searchInviteCandidates('dana', [])).toEqual([
      { kind: 'user', id: expect.any(String), name: 'Dana Whitfield', email: 'dana@acme.test', image: 'https://avatars.test/dana.png', notOnGamut: true },
    ])
  })

  it('are left out of everyone-in-the-workspace, of who an agent acts for, and of pushes', async () => {
    const { userId } = await inviteDirectoryPerson({ directoryId, remoteId: 'u-dana' }, 'ada')
    await grant(userId, 'support')
    await grant('ada', 'support', 'owner')
    await addAgentUsers('team-brain')
    expect((await handle.db.select().from(agentAcl).where(eq(agentAcl.agentSlug, 'team-brain')).all()).map((row) => row.userId)).toEqual(['ada'])
    expect(await countOtherMembers('support', 'ada')).toBe(0)
    expect(await getPushableAgentSlugs(userId)).toEqual([])
    expect((await getPushableAgentSlugs('ada')).sort()).toEqual(['support', 'team-brain'])
  })
})
