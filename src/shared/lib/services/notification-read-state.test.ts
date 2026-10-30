import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono, type Context } from 'hono'
import type { AppDatabase } from '../db/drivers/types'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import type { SessionMetadataMap } from '../types/agent'
import { user, agentAcl } from '../db/schema'

let handle: TestDatabase
let database: AppDatabase
const live = { awaitingSessionIds: [] as string[], pendingReviews: [] }
const metadata: SessionMetadataMap = { hidden: { isScheduledExecution: true } }
const failures = { summary: false }
vi.mock('../db', () => ({ get db() { return database } }))
vi.mock('../agent-actor', () => ({ agentRegistry: { get: () => ({
  live: async () => live,
  sessions: {
    summary: async () => {
      if (failures.summary) throw new Error('Agent disappeared')
      return { sessionIds: ['s1', 's2', 'manual', 'hidden'], sessionCount: 4, lastActivityAt: null }
    },
    readMetadata: async () => metadata,
  },
}) } }))
vi.mock('../auth/mode', () => ({ isAuthMode: () => true }))
vi.mock('../../../api/middleware/auth', () => ({
  Authenticated: () => async (c: Context, next: () => Promise<void>) => { c.set('user', { id: 'viewer' }); await next() },
  HasNotificationAccess: () => async (_c: Context, next: () => Promise<void>) => next(),
}))

import { createNotification, getNotification } from './notification-service'
import { markSessionUnread } from './session-unread-service'
import { notificationReadAgentSlugs, notificationReadState } from './notification-read-state'
import notificationsRouter from '../../../api/routes/notifications'
import { notificationReadResponseSchema } from '../notifications/read-state-schema'

const app = new Hono().route('/api/notifications', notificationsRouter)
async function create(body: string, options: { agentSlug?: string; sessionId?: string; type?: 'session_complete' | 'session_waiting' | 'session_mention'; recipientUserId?: string } = {}) {
  return createNotification({ title: body, body, type: 'session_complete', sessionId: 's1', agentSlug: 'shared', ...options })
}
async function post(path: string) {
  const response = await app.request('/api/notifications/' + path, { method: 'POST' })
  expect(response.status).toBe(200)
  return notificationReadResponseSchema.parse(await response.json())
}

describe('notification read confirmations', () => {
  beforeEach(async () => {
    handle = await createTestDatabase()
    database = handle.db
    live.awaitingSessionIds = []
    failures.summary = false
    await database.insert(user).values(['viewer', 'peer'].map(id => ({ id, name: id, email: `${id}@example.test` })))
    await database.insert(agentAcl).values([
      { id: 'viewer-shared', userId: 'viewer', agentSlug: 'shared', role: 'user', createdAt: new Date() },
      { id: 'peer-shared', userId: 'peer', agentSlug: 'shared', role: 'user', createdAt: new Date() },
      { id: 'peer-private', userId: 'peer', agentSlug: 'private', role: 'user', createdAt: new Date() },
    ])
  })
  afterEach(async () => { await handle.close() })

  it('returns the remaining preview and counts with a single-notification write', async () => {
    const first = await create('First', { type: 'session_mention', recipientUserId: 'viewer' })
    const next = await create('Next\n  notification', { sessionId: 's2' })
    const result = await post(`${first}/read`)
    expect((await getNotification(first))?.isRead).toBe(true)
    expect(result.readState).toMatchObject({ count: 1, mentions: 0, agents: [{
      slug: 'shared', hasUnreadNotifications: true, hasUnreadMention: false,
      notificationPreview: 'Next notification', notificationPreviewSource: { id: next, sessionId: 's2' },
      unreadSessionIds: ['s2'],
    }] })
  })

  it('clears notification previews while retaining personal reminders and a live needs-input state', async () => {
    await create('Please choose', { type: 'session_waiting' })
    await markSessionUnread('shared', 'manual', 'viewer')
    live.awaitingSessionIds = ['s1']
    const result = await post('read-all')
    expect(result.readState).toMatchObject({ count: 0, mentions: 0, agents: [{
      hasUnreadNotifications: true, hasUnreadMention: false,
      markedUnreadSessionIds: ['manual'], unreadSessionIds: ['manual'],
    }] })
    expect(result.readState?.agents[0].notificationPreview).toBeUndefined()
    expect(live.awaitingSessionIds).toEqual(['s1'])
  })

  it('uses the same needs-input/mention/unread priority and hidden-session filtering as the agents list', async () => {
    await create('Hidden', { sessionId: 'hidden' })
    const waiting = await create('Question', { type: 'session_waiting' })
    const mention = await create('Mention', { type: 'session_mention', sessionId: 's2', recipientUserId: 'viewer' })
    live.awaitingSessionIds = ['s1']
    expect((await notificationReadState(['shared'], 'viewer')).agents[0].notificationPreviewSource?.id).toBe(waiting)
    live.awaitingSessionIds = []
    expect((await notificationReadState(['shared'], 'viewer')).agents[0].notificationPreviewSource?.id).toBe(mention)
    await post(`read-by-session/s1`)
    const after = await post(`read-by-session/s2`)
    expect(after.readState?.agents[0]).toMatchObject({ hasUnreadNotifications: false, hasUnreadMention: false })
    expect(after.readState?.agents[0].notificationPreview).toBeUndefined()
  })

  it('scopes affected agents, counts and reads to accessible agents and the viewer\'s own mentions', async () => {
    const shared = await create('Shared')
    const theirs = await create('Private mention', { type: 'session_mention', recipientUserId: 'peer' })
    const inaccessible = await create('Private agent', { agentSlug: 'private' })
    expect(await notificationReadAgentSlugs({ kind: 'notification', id: inaccessible }, 'viewer')).toEqual([])
    expect(await notificationReadAgentSlugs({ kind: 'notification', id: theirs }, 'viewer')).toEqual([])
    expect(await notificationReadAgentSlugs({ kind: 'session', sessionId: 's1' }, 'viewer')).toEqual(['shared'])
    const result = await post('read-all')
    expect(result.readState?.agents.map(a => a.slug)).toEqual(['shared'])
    expect(result.readState?.count).toBe(0)
    expect((await getNotification(shared))?.isRead).toBe(true)
    expect((await getNotification(theirs))?.isRead).toBe(false)
    expect((await getNotification(inaccessible))?.isRead).toBe(false)
  })

  it('keeps a missing notification a 404 and handles empty bulk reads', async () => {
    expect((await app.request('/api/notifications/missing/read', { method: 'POST' })).status).toBe(404)
    expect((await post('read-all')).readState).toEqual({ count: 0, mentions: 0, agents: [] })
  })

  it('still acknowledges a committed write if reading the confirmation fails', async () => {
    const id = await create('Done')
    failures.summary = true
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await post(`${id}/read`)).toEqual({ success: true })
      expect((await getNotification(id))?.isRead).toBe(true)
      expect(log).toHaveBeenCalledWith('Failed to confirm notification read state:', expect.any(Error))
    } finally {
      log.mockRestore()
    }
  })
})
