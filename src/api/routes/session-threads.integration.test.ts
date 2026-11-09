import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { persistedSettingsSchema } from '@shared/lib/config/settings-schema'
import { backgroundSettled } from '@shared/lib/background'

/**
 * Replying in a thread: who may, which message it hangs off, and who each
 * reply tells. The agent's sessions are stubbed: a thread never touches the
 * transcript, only whether the session exists and its live stream.
 */

const broadcastEvent = vi.fn(async () => {})
const knownSessions = new Set<string>()
vi.mock('@shared/lib/agent-actor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/lib/agent-actor')>()
  return {
    ...actual,
    agentRegistry: {
      get: () => ({
        sessions: { isKnown: async (sessionId: string) => knownSessions.has(sessionId) },
        messages: { broadcastEvent },
      }),
    },
  }
})

const triggerThreadReply = vi.fn(async () => {})
vi.mock('@shared/lib/notifications/notification-manager', () => ({
  notificationManager: { triggerThreadReply },
}))

let directory: string
let db: typeof import('@shared/lib/db')
let authModule: typeof import('@shared/lib/auth')
let app: Hono

const agentSlug = '0123456789'
const sessionId = 'session-1'
const parentUuid = 'parent-message'
const people: Record<string, { id: string; token: string }> = {}

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'session-threads-'))
  fs.mkdirSync(path.join(directory, 'agents', agentSlug), { recursive: true })
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify(persistedSettingsSchema.parse({ auth: { signupMode: 'open', requireAdminApproval: false } })))
  vi.stubEnv('SUPERAGENT_DATA_DIR', directory)
  vi.stubEnv('AUTH_MODE', 'true')
  vi.stubEnv('AUTH_PROVIDERS_JSON', '[]')
  vi.stubEnv('BETTER_AUTH_SECRET', 'thread-test-secret-0123456789abcdef0123456789abcdef')
  db = await import('@shared/lib/db')
  await db.openDatabase()
  authModule = await import('@shared/lib/auth')
  const { Authenticated, ResolveAgent } = await import('../middleware/auth')
  const { default: threads } = await import('./session-threads')
  app = new Hono()
  app.use('/api/agents/*', Authenticated())
  app.use('/api/agents/:id/*', ResolveAgent())
  app.route('/api/agents/:id/sessions/:sessionId/threads', threads)
  // `admin` signs up first and so becomes the instance admin; the rest are plain users.
  for (const name of ['admin', 'west', 'graham', 'iddo', 'viewer', 'outsider', 'leaver']) {
    const result = await (await authModule.getAuth()).api.signUpEmail({ body: { name, email: `${name}@example.test`, password: 'ThreadTesting123!' } })
    people[name] = { id: result.user.id, token: result.token! }
  }
  const { agentAcl, agents, messageAuthor } = await import('@shared/lib/db/schema')
  await db.db.insert(agents).values({ slug: agentSlug, name: agentSlug, createdAt: new Date(0), runtime: 'local' })
  await db.db.insert(agentAcl).values((['west', 'graham', 'iddo', 'viewer'] as const).map((name, index) => ({
    id: randomUUID(), userId: people[name].id, agentSlug, role: name === 'viewer' ? 'viewer' as const : name === 'west' ? 'owner' as const : 'user' as const, createdAt: new Date(index * 1000),
  })))
  // West's message tagged Graham; it is the one the thread hangs off.
  await db.db.insert(messageAuthor).values({ id: parentUuid, sessionId, agentSlug, userId: people.west.id })
  knownSessions.add(sessionId)
})

afterAll(async () => {
  authModule.resetAuth()
  await db.closeDatabase()
  vi.unstubAllEnvs()
  fs.rmSync(directory, { recursive: true, force: true })
})

beforeEach(() => {
  triggerThreadReply.mockClear()
  broadcastEvent.mockClear()
})

function reply(name: string, body: { text: string; taggedUserIds?: string[] }, parent = parentUuid, session = sessionId) {
  return app.request(`/api/agents/${agentSlug}/sessions/${session}/threads/${parent}/replies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${people[name].token}` },
    body: JSON.stringify(body),
  })
}

function get(name: string, resource = '') {
  return app.request(`/api/agents/${agentSlug}/sessions/${sessionId}/threads${resource}`, {
    headers: { authorization: `Bearer ${people[name].token}` },
  })
}

function recipients(): string[] {
  return triggerThreadReply.mock.calls.map((call) => (call as unknown as [{ recipientUserId: string }])[0].recipientUserId).sort()
}

describe('replying in a thread', () => {
  it('tells the parent author and who it tagged, never the person replying, and only people who can open the agent', async () => {
    const response = await reply('graham', { text: 'On it', taggedUserIds: [people.graham.id, people.outsider.id] })
    expect(response.status).toBe(201)
    expect(recipients()).toEqual([people.west.id])
    await backgroundSettled()
    expect(broadcastEvent).toHaveBeenCalledWith(sessionId, { type: 'thread_replies_updated', parentMessageUuid: parentUuid })
  })

  it('follows the thread for everyone who replies, without tagging anyone again', async () => {
    await reply('iddo', { text: 'Joining in' })
    expect(recipients()).toEqual([people.west.id, people.graham.id].sort())

    triggerThreadReply.mockClear()
    await reply('west', { text: 'Thanks both' })
    expect(recipients()).toEqual([people.graham.id, people.iddo.id].sort())
  })

  it('lists the replies and the session threads for anyone who can open the agent', async () => {
    const thread = await get('viewer', `/${parentUuid}`)
    expect(thread.status).toBe(200)
    const { replies } = await thread.json() as { replies: Array<{ text: string; sender: { name: string } }> }
    expect(replies.map((r) => [r.sender.name, r.text])).toEqual([['graham', 'On it'], ['iddo', 'Joining in'], ['west', 'Thanks both']])

    const summaries = await get('viewer')
    const { threads } = await summaries.json() as { threads: Array<{ parentMessageUuid: string; replyCount: number }> }
    expect(threads).toEqual([expect.objectContaining({ parentMessageUuid: parentUuid, replyCount: 3 })])
  })

  it('refuses viewers, outsiders, unknown messages and empty replies', async () => {
    expect((await reply('viewer', { text: 'hi' })).status).toBe(403)
    expect((await reply('outsider', { text: 'hi' })).status).toBe(403)
    expect((await get('outsider')).status).toBe(403)
    // A thread hangs off a message a person wrote in this session.
    expect((await reply('graham', { text: 'hi' }, 'no-such-message')).status).toBe(404)
    expect((await reply('graham', { text: 'hi' }, parentUuid, 'other-session')).status).toBe(404)
    expect((await reply('graham', { text: '   ' })).status).toBe(400)
    expect(triggerThreadReply).not.toHaveBeenCalled()
  })

  it('stops telling someone who can no longer open the agent', async () => {
    const { agentAcl } = await import('@shared/lib/db/schema')
    const { eq, and } = await import('drizzle-orm')
    await db.db.delete(agentAcl).where(and(eq(agentAcl.agentSlug, agentSlug), eq(agentAcl.userId, people.iddo.id)))
    await reply('graham', { text: 'Iddo left' })
    expect(recipients()).toEqual([people.west.id])
  })
})
