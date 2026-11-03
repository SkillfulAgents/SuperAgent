import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '../db/schema'

let testDb: ReturnType<typeof drizzle>
let testSqlite: InstanceType<typeof Database>
const mockReadSessionMetadata = vi.fn()
const mockActiveIds = vi.fn((_slug: string): string[] => [])

vi.mock('../db', () => ({
  get db() {
    return testDb
  },
}))

vi.mock('./session-service', () => ({
  readSessionMetadata: (...args: unknown[]) => mockReadSessionMetadata(...args),
}))

vi.mock('@shared/lib/agent-actor/live/live-sessions', async () => ({
  LiveSessions: (await import('@shared/lib/agent-actor/testing/live-sessions-double')).liveSessionsDouble({
    activeIds: (slug) => mockActiveIds(slug),
  }),
}))

import { buildHomeCardHealth } from './home-card-health-service'
import { storeAgentSummary, useStoredAgentSummaries, type AgentSummary } from './agent-summaries'

const NOW = new Date('2026-07-30T12:00:00.000Z')

describe('home-card-health-service', () => {
  beforeEach(() => {
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    migrate(testDb, {
      migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations'),
    })
    mockReadSessionMetadata.mockReset()
    mockActiveIds.mockReset()
    mockActiveIds.mockReturnValue([])
    mockReadSessionMetadata.mockImplementation(async (store: { slug: string }) => (
      store.slug === 'agent-a'
        ? {
            'cron-success': {
              scheduledTaskId: 'cron-a',
              scheduledExecutionAt: '2026-07-29T09:00:00.000Z',
              automationStatus: 'succeeded',
              createdAt: '2026-07-29T09:00:00.000Z',
            },
            'webhook-success': {
              isWebhookExecution: true,
              webhookTriggerId: 'webhook-a',
              webhookInvocationCount: 3,
              automationStatus: 'succeeded',
              createdAt: '2026-07-30T10:00:00.000Z',
            },
          }
        : {}
    ))
  })

  afterEach(() => {
    useStoredAgentSummaries(false)
    testSqlite.close()
  })

  it('returns card automation descriptors and chart series without unrelated scheduled rows', async () => {
    await testDb.insert(schema.scheduledTasks).values([
      {
        id: 'cron-a',
        agentSlug: 'agent-a',
        scheduleType: 'cron',
        scheduleExpression: '0 9 * * *',
        prompt: 'report',
        name: 'Daily report',
        status: 'pending',
        nextExecutionAt: new Date('2099-01-01T09:00:00.000Z'),
        isRecurring: true,
        executionCount: 1,
        timezone: 'UTC',
        createdAt: new Date('2026-07-28T00:00:00.000Z'),
      },
      {
        id: 'one-time-a',
        agentSlug: 'agent-a',
        scheduleType: 'at',
        scheduleExpression: '2099-01-01T09:00:00.000Z',
        prompt: 'one time',
        name: 'One-time reminder',
        status: 'pending',
        nextExecutionAt: new Date('2099-01-01T09:00:00.000Z'),
        isRecurring: false,
        executionCount: 0,
        createdAt: NOW,
      },
      {
        id: 'cron-hidden',
        agentSlug: 'hidden-agent',
        scheduleType: 'cron',
        scheduleExpression: '0 9 * * *',
        prompt: 'hidden',
        status: 'pending',
        nextExecutionAt: new Date('2099-01-01T09:00:00.000Z'),
        isRecurring: true,
        executionCount: 0,
        createdAt: NOW,
      },
    ])
    await testDb.insert(schema.webhookTriggers).values([
      {
        id: 'webhook-a',
        agentSlug: 'agent-a',
        kind: 'custom',
        triggerType: 'CUSTOM_WEBHOOK',
        prompt: 'handle',
        name: 'Feedback',
        status: 'active',
        fireCount: 3,
        createdAt: NOW,
      },
      {
        id: 'webhook-cancelled',
        agentSlug: 'agent-a',
        kind: 'custom',
        triggerType: 'CUSTOM_WEBHOOK',
        prompt: 'old',
        status: 'cancelled',
        fireCount: 1,
        createdAt: NOW,
      },
    ])

    const result = await buildHomeCardHealth({
      agentSlugs: ['agent-a', 'agent-without-charts'],
      days: 7,
      now: NOW,
      tzOffsetMinutes: 0,
    })

    expect(result.crons).toEqual([
      expect.objectContaining({
        id: 'cron-a',
        agentSlug: 'agent-a',
        name: 'Daily report',
      }),
    ])
    expect(result.webhooks).toEqual([
      expect.objectContaining({
        id: 'webhook-a',
        agentSlug: 'agent-a',
        name: 'Feedback',
      }),
    ])
    expect(result.cronByTaskId['cron-a']).toEqual([
      { scheduledAt: '2026-07-28T09:00:00.000Z', status: 'skipped' },
      { scheduledAt: '2026-07-29T09:00:00.000Z', status: 'succeeded' },
      { scheduledAt: '2026-07-30T09:00:00.000Z', status: 'skipped' },
    ])
    expect(result.webhookByTriggerId['webhook-a'][6]).toEqual({
      date: '2026-07-30',
      succeeded: 3,
      failed: 0,
    })
    expect(mockReadSessionMetadata).toHaveBeenCalledTimes(1)
    expect(mockReadSessionMetadata).toHaveBeenCalledWith(expect.objectContaining({ slug: 'agent-a' }))
    expect(result).not.toHaveProperty('accountLinks')
    expect(result).not.toHaveProperty('connectionById')
  })

  it('asks only agents with a chart, and a running run with no live session counts as failed', async () => {
    await testDb.insert(schema.webhookTriggers).values({
      id: 'webhook-a', agentSlug: 'agent-a', kind: 'custom', triggerType: 'CUSTOM_WEBHOOK', prompt: 'handle',
      name: 'Feedback', status: 'active', fireCount: 2, createdAt: NOW,
    })
    mockReadSessionMetadata.mockImplementation(async (store: { slug: string }) => (store.slug === 'agent-a'
      ? {
          'still-running': { isWebhookExecution: true, webhookTriggerId: 'webhook-a', automationStatus: 'running', createdAt: '2026-07-30T10:00:00.000Z' },
          'died-running': { isWebhookExecution: true, webhookTriggerId: 'webhook-a', automationStatus: 'running', createdAt: '2026-07-30T11:00:00.000Z' },
        }
      : {}))
    mockActiveIds.mockImplementation((slug) => (slug === 'agent-a' ? ['still-running'] : []))

    const result = await buildHomeCardHealth({ agentSlugs: ['agent-a', 'agent-without-charts'], days: 7, now: NOW, tzOffsetMinutes: 0 })

    expect(mockActiveIds.mock.calls.map(([slug]) => slug)).toEqual(['agent-a'])
    expect(result.webhookByTriggerId['webhook-a'][6]).toEqual({ date: '2026-07-30', succeeded: 0, failed: 1 })
  })

  it('draws the charts from stored summaries and asks no agent', async () => {
    await testDb.insert(schema.webhookTriggers).values({
      id: 'webhook-a', agentSlug: 'agent-a', kind: 'custom', triggerType: 'CUSTOM_WEBHOOK', prompt: 'handle',
      name: 'Feedback', status: 'active', fireCount: 3, createdAt: NOW,
    })
    useStoredAgentSummaries(true)
    const summary: AgentSummary = {
      container: { status: 'stopped', port: null, healthWarnings: [], stale: false },
      hasActiveSessions: false, hasSessionsAwaitingInput: false, awaitingSessionIds: [], sessionCount: 2,
      lastActivityAt: '2026-07-30T11:00:00.000Z', visibleSessionIds: [], dashboards: [], widgets: [],
      automationRuns: [
        { sessionId: 'webhook-done', createdAt: '2026-07-30T10:00:00.000Z', status: 'succeeded', webhookTriggerId: 'webhook-a', webhookInvocationCount: 3 },
        { sessionId: 'webhook-died', createdAt: '2026-07-30T11:00:00.000Z', status: 'failed', webhookTriggerId: 'webhook-a' },
      ],
    }
    await storeAgentSummary('agent-a', summary)

    const result = await buildHomeCardHealth({ agentSlugs: ['agent-a'], days: 7, now: NOW, tzOffsetMinutes: 0 })

    expect(result.webhookByTriggerId['webhook-a'][6]).toEqual({ date: '2026-07-30', succeeded: 3, failed: 1 })
    expect(mockReadSessionMetadata).not.toHaveBeenCalled()
    expect(mockActiveIds).not.toHaveBeenCalled()
  })

  it('short-circuits an empty visible-agent scope', async () => {
    const result = await buildHomeCardHealth({
      agentSlugs: [],
      days: 14,
      now: NOW,
    })

    expect(result).toEqual({
      days: 14,
      generatedAt: NOW.toISOString(),
      crons: [],
      webhooks: [],
      cronByTaskId: {},
      webhookByTriggerId: {},
    })
    expect(mockReadSessionMetadata).not.toHaveBeenCalled()
  })
})
