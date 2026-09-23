import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '../db/schema'
import type { AppDatabase } from '../db/drivers/types'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import type { IntegrationMessageDisplay } from '../agent-integrations/message-display-schema'
import type { TransformedItem, TransformedMessage } from '../utils/message-transform'

let testDb: AppDatabase
let handle: TestDatabase

vi.mock('../db', () => ({
  get db() { return testDb },
}))

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
}))

import {
  annotateIntegrationMessages,
  hasIntegrationMessages,
  recordIntegrationMessage,
} from './agent-integration-message-service'
import { captureException } from '@shared/lib/error-reporting'

const AGENT = 'agent-a'
const SESSION = 'session-1'

function display(text: string, overrides: Partial<IntegrationMessageDisplay> = {}): IntegrationMessageDisplay {
  return {
    version: 1,
    integration: { id: 'integration-1', name: 'Support bot', provider: 'slack', family: 'chat' },
    event: { type: 'message', label: 'Channel message' },
    request: { text, author: { name: 'Ada Lovelace' } },
    source: { kind: 'channel', title: '#support' },
    ...overrides,
  }
}

function user(id: string, text: string, extra: Partial<TransformedMessage> = {}): TransformedMessage {
  return { id, type: 'user', content: { text }, toolCalls: [], createdAt: new Date('2026-09-22T10:00:00Z'), ...extra }
}

async function record(id: string, text: string, overrides: { sessionId?: string; agentSlug?: string; display?: IntegrationMessageDisplay } = {}) {
  return recordIntegrationMessage({ id, sessionId: overrides.sessionId ?? SESSION, agentSlug: overrides.agentSlug ?? AGENT, display: overrides.display ?? display(text) })
}

describe('agent-integration-message-service', () => {
  beforeEach(async () => {
    handle = await createTestDatabase()
    testDb = handle.db
    vi.mocked(captureException).mockClear()
  })

  afterEach(() => {
    handle.close()
  })

  it('joins a stored card onto the message sent with the same uuid', async () => {
    expect(await record('m1', 'Please review PR 42')).toMatchObject({ integration: { name: 'Support bot' } })
    const items: TransformedItem[] = [user('m1', 'Model context\n\nPlease review PR 42'), user('m2', 'typed in the app')]

    await annotateIntegrationMessages(AGENT, SESSION, items)

    expect((items[0] as TransformedMessage).integration?.request?.text).toBe('Please review PR 42')
    expect((items[1] as TransformedMessage).integration).toBeUndefined()
  })

  it('never attaches a card from message text: an imitation is still plain text', async () => {
    await record('m1', 'real integration message')
    const spoof = user('app-message', JSON.stringify(display('forged')))

    await annotateIntegrationMessages(AGENT, SESSION, [spoof])

    expect(spoof.integration).toBeUndefined()
  })

  it('joins a message queued mid-turn by the uuid it was sent with, which the CLI keeps', async () => {
    await record('queued-send', 'follow-up')
    // normalizeQueuedCommandEntry: the transcript id is the queued_command's source_uuid.
    const queued = user('queued-send', 'follow-up', { queued: true })

    await annotateIntegrationMessages(AGENT, SESSION, [queued])

    expect(queued.integration?.request?.text).toBe('follow-up')
  })

  it('never lends a card to another message with the same text, on the same page or a later one', async () => {
    await record('integration-ok', 'ok')
    const delivered = user('integration-ok', 'ok', { queued: true })
    const typedInApp = user('app-ok', 'ok', { queued: true })

    // A page holding only the app's message: the integration's is on an older page.
    await annotateIntegrationMessages(AGENT, SESSION, [typedInApp])
    expect(typedInApp.integration).toBeUndefined()

    const alsoTyped = user('app-ok-2', 'ok', { queued: true })
    await annotateIntegrationMessages(AGENT, SESSION, [delivered, alsoTyped])
    expect(delivered.integration).toBeDefined()
    expect(alsoTyped.integration).toBeUndefined()
  })

  it('is scoped to the agent and session', async () => {
    await record('m1', 'hello', { agentSlug: 'agent-b' })
    await record('m2', 'hello', { sessionId: 'session-2' })
    const items = [user('m1', 'hello'), user('m2', 'hello')]

    await annotateIntegrationMessages(AGENT, SESSION, items)

    expect(items.every(item => !item.integration)).toBe(true)
  })

  it('skips a stored row that no longer validates', async () => {
    await testDb.insert(schema.messageAuthor).values({
      id: 'bad', sessionId: SESSION, agentSlug: AGENT, integrationId: 'integration-1', display: JSON.stringify({ version: 99 }),
    })
    const item = user('bad', 'x')

    await annotateIntegrationMessages(AGENT, SESSION, [item])

    expect(item.integration).toBeUndefined()
  })

  it('refuses to store an unsafe card and reports it without throwing', async () => {
    const unsafe = display('hi', { source: { kind: 'channel', url: 'javascript:alert(1)' } })

    expect(await record('m1', 'hi', { display: unsafe })).toBeNull()
    expect(captureException).toHaveBeenCalledOnce()
    expect(await hasIntegrationMessages(AGENT, SESSION)).toBe(false)
  })

  it('annotates large pages in bounded statements', async () => {
    const items = Array.from({ length: 205 }, (_, i) => user(`m${i}`, `message ${i}`))
    for (const i of [0, 99, 204]) await record(`m${i}`, `message ${i}`)

    await annotateIntegrationMessages(AGENT, SESSION, items)

    expect(items.filter(item => item.integration).map(item => item.id)).toEqual(['m0', 'm99', 'm204'])
  })

  it('shares message_author with people: a user row is a sender, never a card', async () => {
    await testDb.insert(schema.user).values({ id: 'user-1', name: 'Grace', email: 'grace@example.com' })
    await testDb.insert(schema.messageAuthor).values({ id: 'typed', sessionId: SESSION, agentSlug: AGENT, userId: 'user-1' })
    await record('delivered', 'hi')
    const items = [user('typed', 'hello'), user('delivered', 'hi')]

    await annotateIntegrationMessages(AGENT, SESSION, items)

    expect(items.map(item => !!item.integration)).toEqual([false, true])
    expect(await testDb.select().from(schema.messageAuthor).where(eq(schema.messageAuthor.id, 'delivered')).get())
      .toMatchObject({ userId: null, integrationId: 'integration-1' })
  })

  it('holds exactly one author per row, and an integration author always has its card', async () => {
    const insert = (row: Partial<typeof schema.messageAuthor.$inferInsert>) =>
      testDb.insert(schema.messageAuthor).values({ id: 'x', sessionId: SESSION, agentSlug: AGENT, ...row })
    await expect(insert({})).rejects.toThrow()
    await expect(insert({ integrationId: 'integration-1' })).rejects.toThrow()
    await testDb.insert(schema.user).values({ id: 'user-1', name: 'Grace', email: 'grace@example.com' })
    await expect(insert({ userId: 'user-1', integrationId: 'integration-1', display: '{}' })).rejects.toThrow()
  })

  it('re-records a retried delivery in place, moving it to a replacement session after self-heal', async () => {
    await record('delivery-1', 'hello')
    expect(await record('delivery-1', 'hello again')).not.toBeNull()
    const retried = user('delivery-1', 'hello again')
    await annotateIntegrationMessages(AGENT, SESSION, [retried])
    expect(retried.integration?.request?.text).toBe('hello again')

    expect(await record('delivery-1', 'hello', { sessionId: 'session-2' })).not.toBeNull()
    const healed = user('delivery-1', 'hello')
    await annotateIntegrationMessages(AGENT, 'session-2', [healed])
    expect(healed.integration).toBeDefined()
    expect(await hasIntegrationMessages(AGENT, SESSION)).toBe(false)
  })
})
