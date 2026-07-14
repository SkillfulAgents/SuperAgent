import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '../db/schema'

let testDb: ReturnType<typeof drizzle>
let testSqlite: InstanceType<typeof Database>
const mockReadSessionMetadata = vi.fn()

vi.mock('../db', () => ({
  get db() {
    return testDb
  },
}))

vi.mock('./session-service', () => ({
  readSessionMetadata: (...args: unknown[]) => mockReadSessionMetadata(...args),
}))

import { getAgentActivityStats, getConnectionActivityStats } from './activity-stats-service'

const NOW = new Date('2026-07-09T12:00:30.000Z')

async function insertUser(id: string) {
  await testDb.insert(schema.user).values({
    id,
    name: id,
    email: `${id}@example.com`,
    createdAt: NOW,
    updatedAt: NOW,
  })
}

async function insertAccount(id: string, userId: string | null = null) {
  await testDb.insert(schema.connectedAccounts).values({
    id,
    providerConnectionId: `provider-${id}`,
    providerName: 'composio',
    toolkitSlug: 'github',
    displayName: id,
    status: 'active',
    userId,
    createdAt: NOW,
    updatedAt: NOW,
  })
}

async function insertMcp(id: string, userId: string | null = null) {
  await testDb.insert(schema.remoteMcpServers).values({
    id,
    name: id,
    url: `https://${id}.example.com`,
    userId,
    authType: 'none',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  })
}

describe('activity stats data pathways', () => {
  beforeEach(() => {
    testSqlite = new Database(':memory:')
    testSqlite.pragma('foreign_keys = ON')
    testDb = drizzle(testSqlite, { schema })
    migrate(testDb, {
      migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations'),
    })
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    mockReadSessionMetadata.mockResolvedValue({})
  })

  afterEach(() => {
    vi.useRealTimers()
    testSqlite.close()
  })

  it('builds one agent-scoped payload across cron, webhook, API, and MCP sources', async () => {
    await testDb.insert(schema.scheduledTasks).values({
      id: 'cron-a',
      agentSlug: 'agent-a',
      scheduleType: 'cron',
      scheduleExpression: '0 * * * *',
      prompt: 'report',
      name: 'Hourly report',
      status: 'pending',
      nextExecutionAt: new Date('2026-07-09T13:00:00.000Z'),
      isRecurring: true,
      executionCount: 1,
      timezone: 'UTC',
      createdAt: new Date('2026-07-09T08:30:00.000Z'),
    })
    await testDb.insert(schema.webhookTriggers).values({
      id: 'webhook-a',
      agentSlug: 'agent-a',
      kind: 'custom',
      triggerType: 'CUSTOM_WEBHOOK',
      prompt: 'handle',
      status: 'active',
      fireCount: 4,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    })

    await insertAccount('account-a')
    await insertAccount('account-not-mapped')
    await insertMcp('mcp-a')
    await testDb.insert(schema.agentConnectedAccounts).values({
      id: 'map-account-a',
      agentSlug: 'agent-a',
      connectedAccountId: 'account-a',
      createdAt: NOW,
    })
    await testDb.insert(schema.agentRemoteMcps).values({
      id: 'map-mcp-a',
      agentSlug: 'agent-a',
      remoteMcpId: 'mcp-a',
      createdAt: NOW,
    })

    await testDb.insert(schema.proxyAuditLog).values([
      { id: 'proxy-ok', agentSlug: 'agent-a', accountId: 'account-a', toolkit: 'github', targetHost: 'api.github.com', targetPath: 'repos', method: 'GET', statusCode: 200, policyDecision: 'allow', createdAt: new Date('2026-07-08T10:00:00.000Z') },
      { id: 'proxy-fail', agentSlug: 'agent-a', accountId: 'account-a', toolkit: 'github', targetHost: 'api.github.com', targetPath: 'repos', method: 'GET', statusCode: 500, policyDecision: 'allow', createdAt: new Date('2026-07-09T10:00:00.000Z') },
      { id: 'proxy-unmapped', agentSlug: 'agent-a', accountId: 'account-not-mapped', toolkit: 'github', targetHost: 'api.github.com', targetPath: 'repos', method: 'GET', statusCode: 200, policyDecision: 'allow', createdAt: new Date('2026-07-09T10:00:00.000Z') },
      { id: 'proxy-other-agent', agentSlug: 'agent-b', accountId: 'account-a', toolkit: 'github', targetHost: 'api.github.com', targetPath: 'repos', method: 'GET', statusCode: 200, policyDecision: 'allow', createdAt: new Date('2026-07-09T10:00:00.000Z') },
    ])
    await testDb.insert(schema.mcpAuditLog).values({
      id: 'mcp-ok',
      agentSlug: 'agent-a',
      remoteMcpId: 'mcp-a',
      remoteMcpName: 'Docs MCP',
      method: 'POST',
      requestPath: '/tools/call',
      statusCode: 200,
      policyDecision: 'allow',
      createdAt: new Date('2026-07-09T11:00:00.000Z'),
    })

    mockReadSessionMetadata.mockResolvedValue({
      'cron-session': {
        isScheduledExecution: true,
        scheduledTaskId: 'cron-a',
        scheduledExecutionAt: '2026-07-09T10:00:00.000Z',
        automationStatus: 'succeeded',
        createdAt: '2026-07-09T10:00:00.000Z',
      },
      'legacy-webhook-session': {
        isWebhookExecution: true,
        webhookTriggerId: 'webhook-a',
        createdAt: '2026-07-08T12:00:00.000Z',
      },
      'webhook-session': {
        isWebhookExecution: true,
        webhookTriggerId: 'webhook-a',
        webhookInvocationCount: 2,
        automationStatus: 'succeeded',
        createdAt: '2026-07-08T23:00:00.000Z',
      },
      'webhook-failure': {
        isWebhookExecution: true,
        webhookTriggerId: 'webhook-a',
        webhookInvocationCount: 3,
        automationStatus: 'failed',
        createdAt: '2026-07-09T01:00:00.000Z',
      },
      // In-flight — must not be counted in the daily bars until it finalizes.
      'webhook-in-flight': {
        isWebhookExecution: true,
        webhookTriggerId: 'webhook-a',
        webhookInvocationCount: 5,
        automationStatus: 'running',
        createdAt: '2026-07-09T11:30:00.000Z',
      },
    })

    const result = await getAgentActivityStats('agent-a', { days: 2, now: NOW, cronSlots: 2 })

    expect(result.cronByTaskId['cron-a']).toEqual([
      { scheduledAt: '2026-07-09T10:00:00.000Z', status: 'succeeded' },
      { scheduledAt: '2026-07-09T11:00:00.000Z', status: 'skipped' },
    ])
    expect(result.webhookByTriggerId['webhook-a']).toEqual([
      { date: '2026-07-08', succeeded: 3, failed: 0 },
      { date: '2026-07-09', succeeded: 0, failed: 3 },
    ])
    expect(result.connectionById['account-account-a']).toEqual([
      { date: '2026-07-08', succeeded: 1, failed: 0 },
      { date: '2026-07-09', succeeded: 0, failed: 1 },
    ])
    expect(result.connectionById['mcp-mcp-a']).toEqual([
      { date: '2026-07-08', succeeded: 0, failed: 0 },
      { date: '2026-07-09', succeeded: 1, failed: 0 },
    ])
    expect(result.connectionById).not.toHaveProperty('account-account-not-mapped')
  })

  it('owner-scopes global connection activity and still returns zero-filled visible rows', async () => {
    await insertUser('owner-a')
    await insertUser('owner-b')
    await insertAccount('account-a', 'owner-a')
    await insertAccount('account-b', 'owner-b')
    await insertMcp('mcp-a', 'owner-a')
    await insertMcp('mcp-empty', 'owner-a')
    await insertMcp('mcp-b', 'owner-b')

    await testDb.insert(schema.proxyAuditLog).values([
      { id: 'account-a-call', agentSlug: 'agent-a', accountId: 'account-a', toolkit: 'github', targetHost: 'api.github.com', targetPath: 'repos', method: 'GET', statusCode: 200, createdAt: new Date('2026-07-09T10:00:00.000Z') },
      { id: 'account-b-call', agentSlug: 'agent-b', accountId: 'account-b', toolkit: 'github', targetHost: 'api.github.com', targetPath: 'repos', method: 'GET', statusCode: 200, createdAt: new Date('2026-07-09T10:00:00.000Z') },
    ])
    await testDb.insert(schema.mcpAuditLog).values([
      { id: 'mcp-a-call', agentSlug: 'agent-a', remoteMcpId: 'mcp-a', remoteMcpName: 'mcp-a', method: 'POST', requestPath: '/tools/call', statusCode: 500, createdAt: new Date('2026-07-09T10:00:00.000Z') },
      { id: 'mcp-b-call', agentSlug: 'agent-b', remoteMcpId: 'mcp-b', remoteMcpName: 'mcp-b', method: 'POST', requestPath: '/tools/call', statusCode: 200, createdAt: new Date('2026-07-09T10:00:00.000Z') },
    ])

    const result = await getConnectionActivityStats({ days: 2, ownerId: 'owner-a', now: NOW })

    expect(Object.keys(result.connectionById).sort()).toEqual([
      'account-account-a',
      'mcp-mcp-a',
      'mcp-mcp-empty',
    ])
    expect(result.connectionById['account-account-a'][1]).toEqual({ date: '2026-07-09', succeeded: 1, failed: 0 })
    expect(result.connectionById['mcp-mcp-a'][1]).toEqual({ date: '2026-07-09', succeeded: 0, failed: 1 })
    expect(result.connectionById['mcp-mcp-empty']).toEqual([
      { date: '2026-07-08', succeeded: 0, failed: 0 },
      { date: '2026-07-09', succeeded: 0, failed: 0 },
    ])
  })

  it('classifies outcomes in SQL: policy failures, error messages, and status ranges', async () => {
    await insertAccount('account-a')

    const base = { agentSlug: 'agent-a', accountId: 'account-a', toolkit: 'github', targetHost: 'api.github.com', targetPath: 'repos', method: 'GET', createdAt: new Date('2026-07-09T10:00:00.000Z') }
    await testDb.insert(schema.proxyAuditLog).values([
      { ...base, id: 'redirect-ok', statusCode: 302 },
      { ...base, id: 'client-error', statusCode: 400 },
      { ...base, id: 'no-status-with-error', statusCode: null, errorMessage: 'network timeout' },
      { ...base, id: 'ok-status-with-error', statusCode: 200, errorMessage: 'tool returned an error' },
      { ...base, id: 'denied', statusCode: 200, policyDecision: 'denied_by_user' },
      { ...base, id: 'blocked', statusCode: 200, policyDecision: 'block' },
      { ...base, id: 'timed-out-review', statusCode: 200, policyDecision: 'review_timeout' },
      { ...base, id: 'allowed-ok', statusCode: 200, policyDecision: 'allow' },
    ])

    const result = await getConnectionActivityStats({ days: 1, now: NOW })

    expect(result.connectionById['account-account-a']).toEqual([
      { date: '2026-07-09', succeeded: 2, failed: 6 },
    ])
  })

  it('buckets audit rows into the viewer\'s local days via the tz offset', async () => {
    await insertAccount('account-a')
    await testDb.insert(schema.proxyAuditLog).values([
      // 02:00Z on July 9 = 21:00 on July 8 for a UTC-5 viewer (offset +300).
      { id: 'late-evening', agentSlug: 'agent-a', accountId: 'account-a', toolkit: 'github', targetHost: 'api.github.com', targetPath: 'repos', method: 'GET', statusCode: 200, createdAt: new Date('2026-07-09T02:00:00.000Z') },
      { id: 'same-local-day', agentSlug: 'agent-a', accountId: 'account-a', toolkit: 'github', targetHost: 'api.github.com', targetPath: 'repos', method: 'GET', statusCode: 200, createdAt: new Date('2026-07-09T10:00:00.000Z') },
    ])

    const result = await getConnectionActivityStats({ days: 2, tzOffsetMinutes: 300, now: NOW })

    expect(result.connectionById['account-account-a']).toEqual([
      { date: '2026-07-08', succeeded: 1, failed: 0 },
      { date: '2026-07-09', succeeded: 1, failed: 0 },
    ])
  })

  it('downgrades a persisted running status to failed when the session is not live', async () => {
    await testDb.insert(schema.scheduledTasks).values({
      id: 'cron-a',
      agentSlug: 'agent-a',
      scheduleType: 'cron',
      scheduleExpression: '0 * * * *',
      prompt: 'report',
      name: 'Hourly report',
      status: 'pending',
      nextExecutionAt: new Date('2026-07-09T13:00:00.000Z'),
      isRecurring: true,
      executionCount: 1,
      timezone: 'UTC',
      createdAt: new Date('2026-07-09T09:30:00.000Z'),
    })
    await testDb.insert(schema.webhookTriggers).values({
      id: 'webhook-a',
      agentSlug: 'agent-a',
      kind: 'custom',
      triggerType: 'CUSTOM_WEBHOOK',
      prompt: 'handle',
      status: 'active',
      fireCount: 2,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    })
    mockReadSessionMetadata.mockResolvedValue({
      'cron-dead': {
        isScheduledExecution: true,
        scheduledTaskId: 'cron-a',
        scheduledExecutionAt: '2026-07-09T10:00:00.000Z',
        automationStatus: 'running',
        createdAt: '2026-07-09T10:00:00.000Z',
      },
      'cron-live': {
        isScheduledExecution: true,
        scheduledTaskId: 'cron-a',
        scheduledExecutionAt: '2026-07-09T11:00:00.000Z',
        automationStatus: 'running',
        createdAt: '2026-07-09T11:00:00.000Z',
      },
      'webhook-dead': {
        isWebhookExecution: true,
        webhookTriggerId: 'webhook-a',
        webhookInvocationCount: 2,
        automationStatus: 'running',
        createdAt: '2026-07-09T01:00:00.000Z',
      },
    })

    const result = await getAgentActivityStats('agent-a', {
      days: 1,
      now: NOW,
      cronSlots: 2,
      isSessionLive: (sessionId) => sessionId === 'cron-live',
    })

    expect(result.cronByTaskId['cron-a']).toEqual([
      { scheduledAt: '2026-07-09T10:00:00.000Z', status: 'failed' },
      { scheduledAt: '2026-07-09T11:00:00.000Z', status: 'running' },
    ])
    // A dead 'running' webhook batch is a failure, not an invisible in-flight run.
    expect(result.webhookByTriggerId['webhook-a']).toEqual([
      { date: '2026-07-09', succeeded: 0, failed: 2 },
    ])
  })

  it('treats an unknown automation status from a newer build as a legacy success', async () => {
    await testDb.insert(schema.scheduledTasks).values({
      id: 'cron-a',
      agentSlug: 'agent-a',
      scheduleType: 'cron',
      scheduleExpression: '0 * * * *',
      prompt: 'report',
      name: 'Hourly report',
      status: 'pending',
      nextExecutionAt: new Date('2026-07-09T13:00:00.000Z'),
      isRecurring: true,
      executionCount: 1,
      timezone: 'UTC',
      createdAt: new Date('2026-07-09T10:30:00.000Z'),
    })
    mockReadSessionMetadata.mockResolvedValue({
      'future-status': {
        isScheduledExecution: true,
        scheduledTaskId: 'cron-a',
        scheduledExecutionAt: '2026-07-09T11:00:00.000Z',
        automationStatus: 'some-status-from-the-future',
        createdAt: '2026-07-09T11:00:00.000Z',
      },
    })

    const result = await getAgentActivityStats('agent-a', {
      days: 1,
      now: NOW,
      cronSlots: 2,
      isSessionLive: () => false,
    })

    expect(result.cronByTaskId['cron-a']).toEqual([
      { scheduledAt: '2026-07-09T11:00:00.000Z', status: 'succeeded' },
    ])
  })
})
