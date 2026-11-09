/**
 * Threads on session messages: replies kept beside the transcript, and the
 * people each reply tells (the parent's author, who it tagged, who replied).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { AppDatabase } from '../db/drivers/types'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'

let testDb: AppDatabase
let handle: TestDatabase

vi.mock('@shared/lib/db', () => ({
  get db() {
    return testDb
  },
}))

import {
  addThreadReply,
  deleteAgentThreadsStatements,
  deleteSessionThreads,
  getMessageAuthorUserId,
  listThreadParticipants,
  listThreadReplies,
  listThreadSummaries,
} from './thread-service'
import { batch } from '../db/batch'
import { messageAuthor, sessionThreads, user } from '../db/schema'

const WEST = 'user-west'
const GRAHAM = 'user-graham'
const IDDO = 'user-iddo'
const AGENT = 'shared-agent'
const SESSION = 'session-1'
const PARENT = 'msg-parent'
const key = { agentSlug: AGENT, sessionId: SESSION, parentMessageUuid: PARENT }

describe('session threads', () => {
  beforeEach(async () => {
    handle = await createTestDatabase()
    testDb = handle.db
    await testDb.insert(user).values([WEST, GRAHAM, IDDO].map((id) => ({ id, name: id.replace('user-', ''), email: `${id}@example.com` })))
    // West wrote the message the thread is on.
    await testDb.insert(messageAuthor).values({ id: PARENT, sessionId: SESSION, agentSlug: AGENT, userId: WEST })
  })

  afterEach(async () => {
    await handle.close()
  })

  it('finds who wrote the parent message, in that session only', async () => {
    expect(await getMessageAuthorUserId(AGENT, SESSION, PARENT)).toBe(WEST)
    expect(await getMessageAuthorUserId(AGENT, 'other-session', PARENT)).toBeNull()
    expect(await getMessageAuthorUserId('other-agent', SESSION, PARENT)).toBeNull()
  })

  it('lists replies oldest first, with who wrote each', async () => {
    await addThreadReply({ ...key, userId: GRAHAM, text: 'first', taggedUserIds: [GRAHAM] })
    await addThreadReply({ ...key, userId: WEST, text: 'second', taggedUserIds: [] })

    const replies = await listThreadReplies(key)
    expect(replies.map((reply) => [reply.text, reply.sender?.name])).toEqual([['first', 'graham'], ['second', 'west']])
    expect(replies.every((reply) => reply.parentMessageUuid === PARENT)).toBe(true)
  })

  it('keeps who the parent tagged from the first reply only', async () => {
    await addThreadReply({ ...key, userId: GRAHAM, text: 'first', taggedUserIds: [GRAHAM, GRAHAM] })
    // A later reply cannot widen the thread: tagging people is the parent's to do.
    await addThreadReply({ ...key, userId: GRAHAM, text: 'again', taggedUserIds: [IDDO] })

    const [thread] = await testDb.select().from(sessionThreads).all()
    expect(JSON.parse(thread.taggedUserIds)).toEqual([GRAHAM])
    expect(await listThreadParticipants(key)).toEqual([WEST, GRAHAM])
  })

  it('counts the parent author, the tagged and every replier once each', async () => {
    await addThreadReply({ ...key, userId: GRAHAM, text: 'hi', taggedUserIds: [GRAHAM] })
    await addThreadReply({ ...key, userId: IDDO, text: 'joining', taggedUserIds: [] })
    await addThreadReply({ ...key, userId: GRAHAM, text: 'welcome', taggedUserIds: [] })

    expect((await listThreadParticipants(key)).sort()).toEqual([GRAHAM, IDDO, WEST].sort())
  })

  it('reads a tagged list that no longer parses as empty', async () => {
    await testDb.insert(sessionThreads).values({ ...key, taggedUserIds: 'not json', createdAt: new Date() })
    expect(await listThreadParticipants(key)).toEqual([WEST])
  })

  it('summarizes each thread with its count, last reply and latest repliers', async () => {
    await addThreadReply({ ...key, userId: GRAHAM, text: 'a', taggedUserIds: [GRAHAM] })
    await addThreadReply({ ...key, userId: IDDO, text: 'b', taggedUserIds: [] })
    await addThreadReply({ ...key, userId: GRAHAM, text: 'c', taggedUserIds: [] })
    await addThreadReply({ ...key, parentMessageUuid: 'msg-other', userId: WEST, text: 'd', taggedUserIds: [] })

    const summaries = new Map((await listThreadSummaries(AGENT, SESSION)).map((summary) => [summary.parentMessageUuid, summary]))
    expect(summaries.get(PARENT)?.replyCount).toBe(3)
    expect(summaries.get(PARENT)?.repliers.map((person) => person.id)).toEqual([GRAHAM, IDDO])
    expect(summaries.get('msg-other')?.replyCount).toBe(1)
    expect(await listThreadSummaries(AGENT, 'other-session')).toEqual([])
  })

  it('goes with its session, and with its agent', async () => {
    await addThreadReply({ ...key, userId: GRAHAM, text: 'a', taggedUserIds: [GRAHAM] })
    await addThreadReply({ ...key, sessionId: 'session-2', userId: GRAHAM, text: 'b', taggedUserIds: [] })

    await deleteSessionThreads(AGENT, [SESSION])
    expect(await listThreadReplies(key)).toEqual([])
    expect(await testDb.select().from(sessionThreads).all()).toHaveLength(1)

    await batch([...deleteAgentThreadsStatements(AGENT)])
    expect(await listThreadReplies({ ...key, sessionId: 'session-2' })).toEqual([])
    expect(await testDb.select().from(sessionThreads).all()).toEqual([])
  })
})
