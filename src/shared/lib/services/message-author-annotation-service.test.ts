/**
 * The messages API's author read against a real database: one statement per
 * response whatever its size, a fixed number of bound parameters, and the same
 * JSON as the statements it replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import * as schema from '@shared/lib/db/schema'
import type { AppDatabase } from '@shared/lib/db/drivers/types'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { integrationMessageDisplaySchema, type IntegrationMessageDisplay } from '@shared/lib/agent-integrations/message-display-schema'
import type { TransformedItem, TransformedMessage } from '@shared/lib/utils/message-transform'

let testDb: AppDatabase
let handle: TestDatabase

vi.mock('@shared/lib/db', () => ({
  get db() { return testDb },
}))

import { annotateMessageAuthors, messageAuthorsQuery } from './message-author-annotation-service'
import { getUserSummaries } from './user-profile-service'

const AGENT = 'agent-a'
const SESSION = 'session-1'
const AVATAR = '/api/profile/images/0f8fad5b-d9cb-469f-a165-70867728950e.png'

function display(text: string): IntegrationMessageDisplay {
  return {
    version: 1,
    integration: { id: 'integration-1', name: 'Support bot', provider: 'slack', family: 'chat' },
    event: { type: 'message', label: 'Channel message' },
    request: { text, author: { name: 'Ada Lovelace' } },
    source: { kind: 'channel', title: '#support' },
  }
}

function userItem(id: string): TransformedMessage {
  return { id, type: 'user', content: { text: `text of ${id}` }, toolCalls: [], createdAt: new Date('2026-09-22T10:00:00Z') }
}

function assistantItem(id: string): TransformedMessage {
  return { id, type: 'assistant', content: { text: 'ok' }, toolCalls: [], createdAt: new Date('2026-09-22T10:00:01Z') }
}

function byUser(id: string, userId: string, sessionId = SESSION) {
  return { id, sessionId, agentSlug: AGENT, userId }
}

function byIntegration(id: string, overrides: { sessionId?: string; agentSlug?: string; display?: string } = {}) {
  return {
    id,
    sessionId: overrides.sessionId ?? SESSION,
    agentSlug: overrides.agentSlug ?? AGENT,
    integrationId: 'integration-1',
    display: overrides.display ?? JSON.stringify(display(`card of ${id}`)),
  }
}

/**
 * What the messages route did before the single read, statement for
 * statement: cards in IN lists of 80, then (auth mode) the user authors, then
 * their profiles.
 */
async function annotateAsBefore(
  items: TransformedItem[],
  options: { senders: boolean; scope?: 'items' | 'session' },
): Promise<void> {
  const users = items.filter((item): item is TransformedMessage => item.type === 'user')
  if (users.length === 0) return
  const ids = users.map(item => item.id)

  const displays = new Map<string, string | null>()
  for (let i = 0; i < ids.length; i += 80) {
    const rows = await testDb.select({ id: schema.messageAuthor.id, display: schema.messageAuthor.display })
      .from(schema.messageAuthor)
      .where(and(
        eq(schema.messageAuthor.agentSlug, AGENT),
        eq(schema.messageAuthor.sessionId, SESSION),
        isNotNull(schema.messageAuthor.integrationId),
        inArray(schema.messageAuthor.id, ids.slice(i, i + 80)),
      ))
      .all()
    for (const row of rows) displays.set(row.id, row.display)
  }
  for (const item of users) {
    const json = displays.get(item.id)
    if (!json) continue
    let parsed: unknown
    try { parsed = JSON.parse(json) } catch { continue }
    const card = integrationMessageDisplaySchema.safeParse(parsed)
    if (card.success) item.integration = card.data
  }

  if (!options.senders) return
  const authors = await testDb
    .select({ messageId: schema.messageAuthor.id, userId: schema.messageAuthor.userId })
    .from(schema.messageAuthor)
    .where(and(
      eq(schema.messageAuthor.sessionId, SESSION),
      options.scope === 'session' ? undefined : inArray(schema.messageAuthor.id, ids),
      isNotNull(schema.messageAuthor.userId),
    ))
    .all()
  const profiles = await getUserSummaries(authors.flatMap(author => author.userId ? [author.userId] : []))
  const byMessage = new Map(authors.map(author => [author.messageId, author.userId ? profiles.get(author.userId) : undefined]))
  for (const item of users) {
    const sender = byMessage.get(item.id)
    if (sender) item.sender = sender
  }
}

/** A transcript covering every kind of author the table can hold, and none. */
async function seedMixedSession(): Promise<TransformedItem[]> {
  await testDb.insert(schema.user).values([
    { id: 'ada', name: 'Ada', email: 'ada@example.test', image: 'https://example.test/ada.png' },
    { id: 'maya', name: 'Maya', email: 'maya@example.test', status: 'invited' },
    { id: 'grace', name: 'Grace', email: 'grace@example.test', image: 'https://example.test/grace.png', avatarOverride: AVATAR },
    { id: 'gone', name: 'Gone', email: 'gone@example.test' },
  ]).run()
  await testDb.insert(schema.messageAuthor).values([
    byUser('by-ada', 'ada'),
    byUser('by-ada-again', 'ada'),
    byUser('by-maya', 'maya'),
    byUser('by-grace', 'grace'),
    byUser('by-gone', 'gone'),
    byUser('not-in-response', 'ada'),
    byUser('other-session-user', 'ada', 'session-2'),
    byIntegration('by-slack'),
    byIntegration('by-slack-again'),
    byIntegration('other-session-card', { sessionId: 'session-2' }),
    byIntegration('other-agent-card', { agentSlug: 'agent-b' }),
    byIntegration('stale-card', { display: JSON.stringify({ version: 99 }) }),
    byIntegration('broken-card', { display: '{not json' }),
  ]).run()
  // The account is deleted: its author rows go with it.
  await testDb.delete(schema.user).where(eq(schema.user.id, 'gone')).run()
  // An author row whose user row is missing, as a database without the cascade would leave it.
  await testDb.run(sql`PRAGMA foreign_keys = OFF`)
  await testDb.insert(schema.messageAuthor).values(byUser('by-ghost', 'ghost')).run()
  await testDb.run(sql`PRAGMA foreign_keys = ON`)

  return [
    userItem('by-ada'),
    assistantItem('assistant-1'),
    userItem('by-slack'),
    userItem('unknown-author'),
    userItem('by-maya'),
    userItem('by-gone'),
    userItem('by-ghost'),
    assistantItem('by-ada-again'),
    userItem('by-ada-again'),
    userItem('by-grace'),
    userItem('by-slack-again'),
    userItem('other-session-user'),
    userItem('other-session-card'),
    userItem('other-agent-card'),
    userItem('stale-card'),
    userItem('broken-card'),
  ]
}

const json = (items: unknown) => JSON.parse(JSON.stringify(items))

beforeEach(async () => {
  handle = await createTestDatabase()
  testDb = handle.db
})

afterEach(async () => {
  vi.restoreAllMocks()
  await handle.close()
})

describe('annotateMessageAuthors', () => {
  it.each([
    { senders: true, scope: 'items' as const },
    { senders: true, scope: 'session' as const },
    { senders: false, scope: 'items' as const },
    { senders: false, scope: 'session' as const },
  ])('answers the same JSON as the statements it replaced ($scope, senders $senders)', async (options) => {
    const before = await seedMixedSession()
    const after = structuredClone(before)
    await annotateAsBefore(before, options)

    await annotateMessageAuthors(AGENT, SESSION, after, options)

    expect(json(after)).toEqual(json(before))
  })

  it('names each kind of author, and leaves the rest alone', async () => {
    const items = await seedMixedSession() as TransformedMessage[]

    await annotateMessageAuthors(AGENT, SESSION, items, { senders: true })

    const annotated = Object.fromEntries(items.filter(item => item.type === 'user').map(item => [item.id, item]))
    expect(annotated['by-ada'].sender).toEqual({ id: 'ada', name: 'Ada', email: 'ada@example.test', image: 'https://example.test/ada.png' })
    expect(annotated['by-ada-again'].sender).toEqual(annotated['by-ada'].sender)
    expect(annotated['by-maya'].sender).toEqual({ id: 'maya', name: 'Maya', email: 'maya@example.test', image: null, invited: true })
    expect(annotated['by-grace'].sender).toEqual({ id: 'grace', name: 'Grace', email: 'grace@example.test', image: AVATAR })
    expect(annotated['by-slack'].integration).toEqual(display('card of by-slack'))
    expect(annotated['by-slack'].sender).toBeUndefined()
    expect(annotated['by-ada'].integration).toBeUndefined()
    for (const id of ['unknown-author', 'by-gone', 'by-ghost', 'other-session-user', 'other-session-card', 'other-agent-card', 'stale-card', 'broken-card']) {
      expect(annotated[id].sender, id).toBeUndefined()
      expect(annotated[id].integration, id).toBeUndefined()
    }
    // The assistant line sharing a user message's id is not an authored message.
    expect(items.find(item => item.type === 'assistant' && item.id === 'by-ada-again')?.sender).toBeUndefined()
  })

  it('attaches no sender when senders are not asked for', async () => {
    const items = await seedMixedSession() as TransformedMessage[]

    await annotateMessageAuthors(AGENT, SESSION, items, { senders: false })

    expect(items.some(item => item.sender)).toBe(false)
    expect(items.find(item => item.id === 'by-slack')?.integration).toEqual(display('card of by-slack'))
  })

  it.each([
    ['a delta of three messages', 3],
    ['a page of 300 messages', 300],
    ['a page at the 500 maximum', 500],
  ])('reads %s in one statement', async (_name, size) => {
    await testDb.insert(schema.user).values({ id: 'ada', name: 'Ada', email: 'ada@example.test' }).run()
    const ids = Array.from({ length: size }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    // Every third message came from an integration, the rest from a person.
    const rows = ids.map((id, i) => i % 3 === 2 ? byIntegration(id) : byUser(id, 'ada'))
    for (let i = 0; i < rows.length; i += 100) await testDb.insert(schema.messageAuthor).values(rows.slice(i, i + 100)).run()
    const items = ids.map(userItem)
    const select = vi.spyOn(testDb, 'select')

    await annotateMessageAuthors(AGENT, SESSION, items, { senders: true })

    expect(select).toHaveBeenCalledTimes(1)
    expect(items.filter(item => item.sender?.id === 'ada')).toHaveLength(size - Math.floor(size / 3))
    expect(items.filter(item => item.integration)).toHaveLength(Math.floor(size / 3))
    expect(items.every(item => !!item.sender !== !!item.integration)).toBe(true)
  })

  it('reads the whole transcript in one statement', async () => {
    const items = await seedMixedSession()
    const select = vi.spyOn(testDb, 'select')

    await annotateMessageAuthors(AGENT, SESSION, items, { senders: true, scope: 'session' })

    expect(select).toHaveBeenCalledTimes(1)
  })

  it('reads nothing for a response with no user messages', async () => {
    await seedMixedSession()
    const select = vi.spyOn(testDb, 'select')

    await annotateMessageAuthors(AGENT, SESSION, [assistantItem('assistant-1'), null, undefined], { senders: true })

    expect(select).not.toHaveBeenCalled()
  })

  it.each(['items', 'session'] as const)('keeps agent senders scoped to the recipient and independent of the payer (%s)', async (scope) => {
    await testDb.insert(schema.user).values({ id: 'payer', name: 'Payer', email: 'payer@example.test' }).run()
    await testDb.insert(schema.agents).values({ slug: 'writer', name: 'Writer', avatarColor: 'tonal-pink', avatarShape: 'circle', createdAt: new Date() }).run()
    await testDb.insert(schema.messageAuthor).values({
      id: 'same-message', sessionId: SESSION, agentSlug: AGENT, authorAgentSlug: 'writer', billedUserId: 'payer',
    }).run()
    const read = async (recipient: string, senders = true) => {
      const item = userItem('same-message')
      await annotateMessageAuthors(recipient, SESSION, [item], { senders, scope })
      return item
    }
    const expected = { slug: 'writer', name: 'Writer', avatar: { color: 'tonal-pink', shape: 'circle' } }
    const original = await read(AGENT)
    expect(original.agentSender).toEqual(expected)
    expect(original.sender).toBeUndefined()
    expect((await read('imported-agent')).agentSender).toBeUndefined()
    expect((await read(AGENT, false)).agentSender).toBeUndefined()

    await testDb.delete(schema.user).where(eq(schema.user.id, 'payer')).run()
    expect((await read(AGENT)).agentSender).toEqual(expected)
    await testDb.delete(schema.agents).where(eq(schema.agents.slug, 'writer')).run()
    expect((await read(AGENT)).agentSender).toEqual({ slug: 'writer', name: 'writer', avatar: null })
  })

  // Cloudflare D1 allows 100 bound parameters per statement.
  it.each([1, 300, 500, 5000])('binds three parameters for %i message ids', (count) => {
    const ids = Array.from({ length: count }, (_, i) => `message-${i}`)

    const { params } = messageAuthorsQuery(AGENT, SESSION, ids).toSQL()

    expect(params).toEqual([AGENT, SESSION, JSON.stringify(ids)])
  })

  it('binds only the recipient and session for the whole transcript', () => {
    expect(messageAuthorsQuery(AGENT, SESSION, null).toSQL().params).toEqual([AGENT, SESSION])
  })
})
