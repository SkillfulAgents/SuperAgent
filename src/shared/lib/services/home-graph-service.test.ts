import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '../db/schema'

let testDb: ReturnType<typeof drizzle>
let testSqlite: InstanceType<typeof Database>

vi.mock('../db', () => ({
  get db() { return testDb },
  get sqlite() { return testSqlite },
}))

// Invocation counting reads per-agent session metadata from disk; the service
// contract is "count invokedByAgentSlug across visible agents' sessions".
const metadataByAgent: Record<string, Record<string, { invokedByAgentSlug?: string }>> = {}
vi.mock('./session-service', () => ({
  readSessionMetadata: (agentSlug: string) => Promise.resolve(metadataByAgent[agentSlug] ?? {}),
}))

import { buildHomeGraph } from './home-graph-service'
import {
  agentConnectedAccounts,
  agentRemoteMcps,
  chatIntegrations,
  chatIntegrationSessions,
  connectedAccounts,
  mcpAuditLog,
  proxyAuditLog,
  remoteMcpServers,
  user,
  xAgentPolicies,
} from '../db/schema'

const NOW = new Date('2026-07-01T00:00:00Z')

function seed() {
  testDb.insert(user).values([
    { id: 'u1', name: 'One', email: 'one@example.com', emailVerified: false, createdAt: NOW, updatedAt: NOW },
    { id: 'u2', name: 'Two', email: 'two@example.com', emailVerified: false, createdAt: NOW, updatedAt: NOW },
  ]).run()

  testDb.insert(connectedAccounts).values([
    { id: 'accA', providerConnectionId: 'pc-a', toolkitSlug: 'gmail', displayName: 'Gmail', userId: 'u1', createdAt: NOW, updatedAt: NOW },
    { id: 'accB', providerConnectionId: 'pc-b', toolkitSlug: 'slack', displayName: 'Slack', userId: 'u2', createdAt: NOW, updatedAt: NOW },
  ]).run()
  testDb.insert(agentConnectedAccounts).values([
    { id: 'l1', agentSlug: 'agent1', connectedAccountId: 'accA', createdAt: NOW },
    { id: 'l2', agentSlug: 'agent1', connectedAccountId: 'accB', createdAt: NOW },
    { id: 'l3', agentSlug: 'hidden', connectedAccountId: 'accA', createdAt: NOW },
  ]).run()

  testDb.insert(remoteMcpServers).values([
    { id: 'mcpX', name: 'Docs', url: 'https://mcp.example.com', userId: 'u1', createdAt: NOW, updatedAt: NOW },
  ]).run()
  testDb.insert(agentRemoteMcps).values([
    { id: 'm1', agentSlug: 'agent2', remoteMcpId: 'mcpX', createdAt: NOW },
  ]).run()

  testDb.insert(chatIntegrations).values([
    { id: 'chat1', agentSlug: 'agent1', provider: 'telegram', config: '{}', status: 'error', createdAt: NOW, updatedAt: NOW },
    { id: 'chat2', agentSlug: 'agent2', provider: 'slack', config: '{}', status: 'active', createdAt: NOW, updatedAt: NOW },
    { id: 'chat3', agentSlug: 'hidden', provider: 'telegram', config: '{}', status: 'active', createdAt: NOW, updatedAt: NOW },
  ]).run()
  testDb.insert(chatIntegrationSessions).values([
    { id: 's1', integrationId: 'chat2', externalChatId: 'x1', sessionId: 'sess1', createdAt: NOW, updatedAt: NOW },
    // Archived sessions still count as "was used"
    { id: 's2', integrationId: 'chat2', externalChatId: 'x2', sessionId: 'sess2', archivedAt: NOW, createdAt: NOW, updatedAt: NOW },
  ]).run()

  const webhookRows: (typeof schema.webhookTriggers.$inferInsert)[] = [
    { id: 'wh1', agentSlug: 'agent1', triggerType: 'GMAIL_NEW_EMAIL', prompt: 'p', status: 'active', fireCount: 5, createdAt: NOW },
    { id: 'wh2', agentSlug: 'agent1', triggerType: 'GMAIL_NEW_EMAIL', prompt: 'p', status: 'cancelled', fireCount: 0, createdAt: NOW },
  ]
  testDb.insert(schema.webhookTriggers).values(webhookRows).run()

  const cronRows: (typeof schema.scheduledTasks.$inferInsert)[] = [
    { id: 'cr1', agentSlug: 'agent2', scheduleType: 'cron', scheduleExpression: '0 9 * * *', prompt: 'p', status: 'pending', nextExecutionAt: NOW, isRecurring: true, executionCount: 3, createdAt: NOW },
    { id: 'cr2', agentSlug: 'agent2', scheduleType: 'at', scheduleExpression: '2026-01-01', prompt: 'p', status: 'executed', nextExecutionAt: NOW, isRecurring: false, executionCount: 0, createdAt: NOW },
    // A pending session wake: session-scoped, must never surface as a cron node.
    { id: 'wake1', agentSlug: 'agent2', scheduleType: 'at', scheduleExpression: '2026-08-01', prompt: 'p', status: 'pending', nextExecutionAt: NOW, isRecurring: false, executionCount: 0, resumeSessionId: 'sess-sleeping', createdAt: NOW },
  ]
  testDb.insert(schema.scheduledTasks).values(cronRows).run()

  testDb.insert(xAgentPolicies).values([
    { id: 'p1', callerAgentSlug: 'agent1', targetAgentSlug: 'agent2', operation: 'invoke', decision: 'allow', createdAt: NOW, updatedAt: NOW },
    { id: 'p2', callerAgentSlug: 'agent1', targetAgentSlug: 'agent2', operation: 'read', decision: 'allow', createdAt: NOW, updatedAt: NOW },
    { id: 'p3', callerAgentSlug: 'agent2', targetAgentSlug: 'agent1', operation: 'invoke', decision: 'block', createdAt: NOW, updatedAt: NOW },
    { id: 'p4', callerAgentSlug: 'agent2', targetAgentSlug: null, operation: 'invoke', decision: 'allow', createdAt: NOW, updatedAt: NOW },
    { id: 'p5', callerAgentSlug: 'hidden', targetAgentSlug: 'agent1', operation: 'invoke', decision: 'allow', createdAt: NOW, updatedAt: NOW },
    { id: 'p6', callerAgentSlug: 'agent1', targetAgentSlug: 'hidden', operation: 'invoke', decision: 'allow', createdAt: NOW, updatedAt: NOW },
  ]).run()

  const audit = (agentSlug: string, accountId: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `pa-${agentSlug}-${accountId}-${i}`,
      agentSlug,
      accountId,
      toolkit: 'gmail',
      targetHost: 'api.example.com',
      targetPath: '/v1',
      method: 'GET',
      createdAt: NOW,
    }))
  testDb.insert(proxyAuditLog).values([
    ...audit('agent1', 'accA', 3),
    ...audit('agent1', 'accB', 1),
    // Non-visible agent using a linked account: its slug must never reach the
    // usage payload (topology leak).
    ...audit('hidden', 'accA', 7),
    // Visible agent, but the agent↔account link no longer exists: dead usage.
    ...audit('agent2', 'accA', 2),
  ]).run()

  testDb.insert(mcpAuditLog).values(
    Array.from({ length: 2 }, (_, i) => ({
      id: `ma-${i}`,
      agentSlug: 'agent2',
      remoteMcpId: 'mcpX',
      remoteMcpName: 'Docs',
      method: 'tools/call',
      requestPath: '/',
      createdAt: NOW,
    })),
  ).run()
}

describe('home-graph-service', () => {
  beforeEach(() => {
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    migrate(testDb, { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })
    for (const key of Object.keys(metadataByAgent)) delete metadataByAgent[key]
    seed()
  })

  afterEach(() => {
    testSqlite?.close()
  })

  const scope = (overrides?: Partial<Parameters<typeof buildHomeGraph>[0]>) => ({
    agentSlugs: ['agent1', 'agent2'],
    userId: null,
    isIntegrationConnected: (id: string) => id === 'chat2',
    ...overrides,
  })

  it('returns links, triggers, and permissions scoped to the visible agents', async () => {
    const graph = await buildHomeGraph(scope())

    expect(graph.accountLinks).toEqual(
      expect.arrayContaining([
        { agentSlug: 'agent1', accountId: 'accA' },
        { agentSlug: 'agent1', accountId: 'accB' },
      ]),
    )
    expect(graph.accountLinks).toHaveLength(2) // hidden agent's link excluded
    expect(graph.mcpLinks).toEqual([{ agentSlug: 'agent2', mcpId: 'mcpX' }])

    // Non-active chat statuses render (error node), hidden agent's chat doesn't.
    expect(graph.chats.map((c) => c.id).sort()).toEqual(['chat1', 'chat2'])
    const chat1 = graph.chats.find((c) => c.id === 'chat1')
    expect(chat1).toMatchObject({ status: 'error', connected: false, sessionCount: 0 })
    // Archived sessions still count toward "was used".
    expect(graph.chats.find((c) => c.id === 'chat2')).toMatchObject({ connected: true, sessionCount: 2 })

    // Only still-subscribed webhooks / still-scheduled crons.
    expect(graph.webhooks).toEqual([
      expect.objectContaining({ id: 'wh1', agentSlug: 'agent1', fireCount: 5, status: 'active' }),
    ])
    expect(graph.crons).toEqual([
      expect.objectContaining({ id: 'cr1', agentSlug: 'agent2', executionCount: 3, isRecurring: true }),
    ])

    // invoke + non-block + concrete target + visible caller AND target only
    // (a non-visible target slug must never reach the response).
    expect(graph.permissions).toEqual([{ caller: 'agent1', target: 'agent2' }])
  })

  it('counts invocations from session metadata, ignoring self and non-visible callers', async () => {
    metadataByAgent['agent2'] = {
      a: { invokedByAgentSlug: 'agent1' },
      b: { invokedByAgentSlug: 'agent1' },
      c: { invokedByAgentSlug: 'hidden' },
      d: { invokedByAgentSlug: 'agent2' },
      e: {},
    }
    const graph = await buildHomeGraph(scope())
    expect(graph.invocations).toEqual([{ caller: 'agent1', target: 'agent2', count: 2 }])
  })

  it('scopes usage counts to visible agents and current links', async () => {
    const graph = await buildHomeGraph(scope())
    // 'hidden:accA' (non-visible agent) and 'agent2:accA' (no current link)
    // are both excluded despite having audit rows.
    expect(graph.accountUsage).toEqual({ 'agent1:accA': 3, 'agent1:accB': 1 })
    expect(graph.mcpUsage).toEqual({ 'agent2:mcpX': 2 })
  })

  it("scopes usage counts to the caller's own accounts and servers in auth mode", async () => {
    const graph = await buildHomeGraph(scope({ userId: 'u1' }))
    expect(graph.accountUsage).toEqual({ 'agent1:accA': 3 }) // accB belongs to u2
    expect(graph.mcpUsage).toEqual({ 'agent2:mcpX': 2 })
  })

  it("scopes account/MCP links to the caller's own resources in auth mode", async () => {
    // agent1 is a SHARED agent linked to accA (u1's) and accB (u2's). As u2,
    // the payload must not leak u1's accA id — even though the agent is
    // visible to both users. mcpX belongs to u1, so u2 sees no mcp link.
    const graph = await buildHomeGraph(scope({ userId: 'u2' }))
    expect(graph.accountLinks).toEqual([{ agentSlug: 'agent1', accountId: 'accB' }])
    expect(graph.mcpLinks).toEqual([])

    // As u1: accA is visible, accB (u2's) is not.
    const asU1 = await buildHomeGraph(scope({ userId: 'u1' }))
    expect(asU1.accountLinks).toEqual([{ agentSlug: 'agent1', accountId: 'accA' }])
    expect(asU1.mcpLinks).toEqual([{ agentSlug: 'agent2', mcpId: 'mcpX' }])
  })

  it('returns an empty graph for an empty agent scope without touching other data', async () => {
    const graph = await buildHomeGraph(scope({ agentSlugs: [] }))
    expect(graph).toEqual({
      accountLinks: [],
      mcpLinks: [],
      chats: [],
      webhooks: [],
      crons: [],
      permissions: [],
      invocations: [],
      accountUsage: {},
      mcpUsage: {},
    })
  })
})
