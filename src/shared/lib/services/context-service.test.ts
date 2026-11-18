/**
 * The context reads over a real, migrated database. The agent's actor is a
 * stand-in: what its sessions store and keep live is what each test sets.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '@shared/lib/db/schema'
import type { SessionLiveState, TurnMessage } from '@shared/lib/agent-actor/types'
import type { SessionMetadata } from '@shared/lib/types/agent'

let testDb: ReturnType<typeof drizzle>
vi.mock('@shared/lib/db', () => ({
  get db() {
    return testDb
  },
}))
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => true }))

const metadata = new Map<string, SessionMetadata>()
let live: Pick<SessionLiveState, 'isActive' | 'turnMessage'> = { isActive: false, turnMessage: null }
const sessions = {
  metadata: vi.fn(async (sessionId: string) => metadata.get(sessionId) ?? null),
  isKnown: vi.fn(async (sessionId: string) => metadata.has(sessionId)),
  get: vi.fn(async (sessionId: string) => (metadata.has(sessionId) ? { id: sessionId, lastActivityAt: new Date(5_000) } : null)),
  live: vi.fn(async () => live),
}
vi.mock('@shared/lib/agent-actor', () => ({
  agentRegistry: { get: () => ({ sessions }) },
  agentCatalog: { get: async (slug: string) => (slug === AGENT ? { slug } : null) },
}))

import { getAgentContext, getMessageContext, getSessionContext } from './context-service'

const AGENT = 'support-agent'
const DANA = 'user-dana'
const BEN = 'user-ben'

beforeEach(async () => {
  vi.clearAllMocks()
  metadata.clear()
  live = { isActive: false, turnMessage: null }
  testDb = drizzle(new Database(':memory:'), { schema })
  migrate(testDb, { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })
  await testDb.insert(schema.agents).values({ slug: AGENT, name: 'Support', createdAt: new Date(), runtime: 'local' })
  await testDb.insert(schema.user).values([
    { id: DANA, name: 'Dana', email: 'dana@example.com', emailVerified: false },
    { id: BEN, name: 'Ben', email: 'ben@example.com', emailVerified: false },
  ])
})

const slackThread = async (sessionId: string) => {
  await testDb.insert(schema.chatIntegrations).values({
    id: 'slack-1', agentSlug: AGENT, provider: 'slack', config: '{}', createdAt: new Date(), updatedAt: new Date(),
  })
  await testDb.insert(schema.chatIntegrationSessions).values({
    id: 'mapping-1', integrationId: 'slack-1', externalChatId: 'C123|1731.22', sessionId, createdAt: new Date(), updatedAt: new Date(),
  })
  await testDb.insert(schema.chatIntegrationAccess).values({
    id: 'access-1', integrationId: 'slack-1', externalChatId: 'C123|1731.22', status: 'allowed',
    requestedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
  })
}

describe('getAgentContext', () => {
  it('lists the members oldest first, and the first owner', async () => {
    await testDb.insert(schema.agentAcl).values([
      { id: 'acl-ben', userId: BEN, agentSlug: AGENT, role: 'user', createdAt: new Date(1_000) },
      { id: 'acl-dana', userId: DANA, agentSlug: AGENT, role: 'owner', createdAt: new Date(2_000) },
    ])
    expect(await getAgentContext(AGENT)).toEqual({
      ownerId: DANA,
      members: [{ userId: BEN, role: 'user' }, { userId: DANA, role: 'owner' }],
    })
  })

  it('throws for an agent that does not exist', async () => {
    await expect(getAgentContext('missing-agent')).rejects.toThrow('Agent not found')
  })
})

describe('getSessionContext', () => {
  it('reads a Slack thread session from its chat mapping, integration and approval', async () => {
    // A level from a newer build: stored, but not one this build knows.
    const effort = 'turbo' as SessionMetadata['effort']
    metadata.set('slack-session', { isChatIntegrationSession: true, chatIntegrationId: 'slack-1', effort, speed: 'fast', starred: true })
    await slackThread('slack-session')

    expect(await getSessionContext(AGENT, 'slack-session', ['origin', 'conversation', 'hidden', 'runtime', 'permissions', 'lifecycle'])).toEqual({
      origin: { kind: 'integration', integrationId: 'slack-1', provider: 'slack', family: 'chat' },
      conversation: { integrationId: 'slack-1', provider: 'slack', family: 'chat', externalId: 'C123|1731.22', chatType: 'thread' },
      hidden: true,
      // An effort level this build does not know is dropped.
      runtime: { speed: 'fast' },
      permissions: { chatApproval: 'allowed' },
      lifecycle: { starred: true, lastActivityAt: 5_000 },
    })
  })

  it('names who made the cron as the creator of its session, and its pending wake', async () => {
    await testDb.insert(schema.scheduledTasks).values([
      { id: 'daily-report', agentSlug: AGENT, scheduleType: 'cron', scheduleExpression: '0 9 * * *', prompt: 'Send the report', nextExecutionAt: new Date(), createdAt: new Date(), createdByUserId: DANA },
      { id: 'wake-1', agentSlug: AGENT, scheduleType: 'at', scheduleExpression: 'once', prompt: 'Check again', nextExecutionAt: new Date(9_000), createdAt: new Date(), resumeSessionId: 'cron-session' },
    ])
    metadata.set('cron-session', { isScheduledExecution: true, scheduledTaskId: 'daily-report', createdByUserId: BEN, automationStatus: 'running' })

    expect(await getSessionContext(AGENT, 'cron-session', ['origin', 'createdBy', 'lifecycle'])).toEqual({
      origin: { kind: 'scheduled', taskId: 'daily-report' },
      createdBy: { kind: 'user', userId: DANA },
      lifecycle: { automationStatus: 'running', starred: false, lastActivityAt: 5_000, wake: { at: 9_000, taskId: 'wake-1' } },
    })
  })

  it('reads only what the asked fields need', async () => {
    metadata.set('app-session', { createdByUserId: DANA })
    expect(await getSessionContext(AGENT, 'app-session', ['createdBy'])).toEqual({ createdBy: { kind: 'user', userId: DANA } })
    expect(sessions.get).not.toHaveBeenCalled()
  })

  it('throws for a session that does not exist', async () => {
    await expect(getSessionContext(AGENT, 'missing-session', ['hidden'])).rejects.toThrow('Session not found')
  })
})

describe('getMessageContext', () => {
  const author = (id: string, fields: Partial<typeof schema.messageAuthor.$inferInsert>, at: number) =>
    testDb.insert(schema.messageAuthor).values({ id, sessionId: 'shared-session', agentSlug: AGENT, createdAt: new Date(at), ...fields })

  it('reads the running turn\'s message before any saved one', async () => {
    await author('newer-silent-tag', { userId: BEN }, 2_000)
    const turnMessage: TurnMessage = { uuid: 'dana-message', sentAt: 1_000, from: { sender: { kind: 'user', userId: DANA }, source: { kind: 'app' }, deviceId: null } }
    live = { isActive: true, turnMessage }
    expect(await getMessageContext(AGENT, 'shared-session')).toEqual({
      sender: { kind: 'user', userId: DANA }, source: { kind: 'app' }, deviceId: null, sentAt: 1_000,
    })
  })

  it('names no sender for a running turn no person started', async () => {
    await author('older-message', { userId: BEN }, 1_000)
    live = { isActive: true, turnMessage: { uuid: 'notice', sentAt: 2_000 } }
    expect(await getMessageContext(AGENT, 'shared-session')).toBeUndefined()
  })

  it('reads the newest saved sender while no turn runs', async () => {
    await slackThread('shared-session')
    metadata.set('shared-session', { createdByDeviceId: 'phone-1' })
    await author('dana-message', { userId: DANA }, 1_000)
    await author('slack-message', {
      integrationId: 'slack-1',
      display: JSON.stringify({
        version: 1,
        event: { type: 'message', label: 'Sent a message' },
        request: { text: 'Is the invoice ready?', author: { name: 'Priya' } },
        source: { kind: 'thread' },
        integration: { id: 'slack-1', name: 'Support Slack', provider: 'slack', family: 'chat' },
      }),
    }, 2_000)
    expect(await getMessageContext(AGENT, 'shared-session')).toEqual({
      sender: { kind: 'external', integrationId: 'slack-1', name: 'Priya' },
      source: { kind: 'integration', integrationId: 'slack-1', externalId: 'C123|1731.22' },
      sentAt: 2_000,
    })
  })

  it('names the automation for a webhook run with no saved message', async () => {
    metadata.set('webhook-session', { isWebhookExecution: true, webhookTriggerId: 'new-order', createdAt: new Date(3_000).toISOString() })
    expect(await getMessageContext(AGENT, 'webhook-session')).toEqual({
      sender: { kind: 'automation', trigger: 'webhook', id: 'new-order' }, source: { kind: 'automation' }, sentAt: 3_000,
    })
  })
})
