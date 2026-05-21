import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import * as schema from '../db/schema'

let testDir: string
let testDb: ReturnType<typeof drizzle>
let testSqlite: InstanceType<typeof Database>

vi.mock('../db', async () => {
  return {
    get db() {
      return testDb
    },
    get sqlite() {
      return testSqlite
    },
  }
})

const mockDeleteComposioTrigger = vi.fn()
const mockIsPlatformComposioActive = vi.fn(() => true)

vi.mock('../composio/triggers', () => ({
  deleteComposioTrigger: (...args: unknown[]) => mockDeleteComposioTrigger(...args),
}))

vi.mock('../composio/client', () => ({
  isPlatformComposioActive: () => mockIsPlatformComposioActive(),
}))

vi.mock('../analytics/server-analytics', () => ({
  trackServerEvent: vi.fn(),
}))

import { cleanupAgentData } from './agent-cleanup-service'

const AGENT_SLUG = 'test-agent'
const OTHER_AGENT_SLUG = 'other-agent'

describe('agent-cleanup-service', () => {
  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-cleanup-test-'))
    testSqlite = new Database(':memory:')
    testSqlite.pragma('foreign_keys = ON')
    testDb = drizzle(testSqlite, { schema })
    const migrationsFolder = path.join(process.cwd(), 'src/shared/lib/db/migrations')
    migrate(testDb, { migrationsFolder })

    vi.clearAllMocks()
    mockIsPlatformComposioActive.mockReturnValue(true)
  })

  afterEach(async () => {
    testSqlite?.close()
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  // ── Helpers ──────────────────────────────────────────────────────────────

  function insertConnectedAccount(id: string): void {
    testDb.insert(schema.connectedAccounts).values({
      id,
      composioConnectionId: `composio-${id}`,
      toolkitSlug: 'gmail',
      displayName: `Account ${id}`,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    }).run()
  }

  function insertAgentConnectedAccount(agentSlug: string, connectedAccountId: string): void {
    testDb.insert(schema.agentConnectedAccounts).values({
      id: `aca-${agentSlug}-${connectedAccountId}`,
      agentSlug,
      connectedAccountId,
      createdAt: new Date(),
    }).run()
  }

  function insertWebhookTrigger(
    id: string,
    agentSlug: string,
    opts: { composioTriggerId?: string; status?: string } = {},
  ): void {
    testDb.insert(schema.webhookTriggers).values({
      id,
      agentSlug,
      connectedAccountId: 'acct-1',
      triggerType: 'GMAIL_NEW_EMAIL',
      prompt: 'Process this email',
      status: (opts.status as 'active') ?? 'active',
      composioTriggerId: opts.composioTriggerId ?? null,
      createdAt: new Date(),
    }).run()
  }

  function insertChatIntegration(id: string, agentSlug: string): string {
    testDb.insert(schema.chatIntegrations).values({
      id,
      agentSlug,
      provider: 'telegram',
      config: JSON.stringify({ botToken: `tok-${id}`, chatId: '123' }),
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    }).run()
    return id
  }

  let sessionSeq = 0
  function insertChatIntegrationSession(integrationId: string): void {
    sessionSeq++
    testDb.insert(schema.chatIntegrationSessions).values({
      id: `cis-${integrationId}-${sessionSeq}`,
      integrationId,
      externalChatId: 'chat-123',
      sessionId: 'session-abc',
      createdAt: new Date(),
      updatedAt: new Date(),
    }).run()
  }

  function insertScheduledTask(id: string, agentSlug: string): void {
    testDb.insert(schema.scheduledTasks).values({
      id,
      agentSlug,
      scheduleType: 'at',
      scheduleExpression: '2026-01-01T00:00:00Z',
      prompt: 'Do something',
      status: 'pending',
      nextExecutionAt: new Date(),
      createdAt: new Date(),
    }).run()
  }

  function insertNotification(id: string, agentSlug: string): void {
    testDb.insert(schema.notifications).values({
      id,
      type: 'session_complete',
      sessionId: 'session-1',
      agentSlug,
      title: 'Done',
      body: 'Task completed',
      createdAt: new Date(),
    }).run()
  }

  function insertRemoteMcpServer(id: string): void {
    testDb.insert(schema.remoteMcpServers).values({
      id,
      name: `MCP ${id}`,
      url: 'https://example.com/mcp',
      authType: 'none',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    }).run()
  }

  function insertAgentRemoteMcp(agentSlug: string, remoteMcpId: string): void {
    testDb.insert(schema.agentRemoteMcps).values({
      id: `arm-${agentSlug}-${remoteMcpId}`,
      agentSlug,
      remoteMcpId,
      createdAt: new Date(),
    }).run()
  }

  function insertProxyAuditLog(agentSlug: string): void {
    testDb.insert(schema.proxyAuditLog).values({
      id: `pal-${agentSlug}-${Date.now()}`,
      agentSlug,
      accountId: 'acct-1',
      toolkit: 'gmail',
      targetHost: 'gmail.googleapis.com',
      targetPath: '/v1/messages',
      method: 'GET',
      createdAt: new Date(),
    }).run()
  }

  let mcpAuditSeq = 0
  function insertMcpAuditLog(agentSlug: string, remoteMcpId: string): void {
    mcpAuditSeq++
    testDb.insert(schema.mcpAuditLog).values({
      id: `mal-${agentSlug}-${mcpAuditSeq}`,
      agentSlug,
      remoteMcpId,
      remoteMcpName: 'Test MCP',
      method: 'POST',
      requestPath: '/test',
      createdAt: new Date(),
    }).run()
  }

  function insertUser(id: string): void {
    testDb.insert(schema.user).values({
      id,
      name: `User ${id}`,
      email: `${id}@test.com`,
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).run()
  }

  function insertAgentAcl(agentSlug: string, userId: string, role: 'owner' | 'user' | 'viewer' = 'user'): void {
    testDb.insert(schema.agentAcl).values({
      id: `acl-${agentSlug}-${userId}`,
      userId,
      agentSlug,
      role,
      createdAt: new Date(),
    }).run()
  }

  let messageAuthorSeq = 0
  function insertMessageAuthor(agentSlug: string, userId: string): void {
    messageAuthorSeq++
    testDb.insert(schema.messageAuthor).values({
      id: `ma-${agentSlug}-${messageAuthorSeq}`,
      sessionId: `session-${messageAuthorSeq}`,
      agentSlug,
      userId,
      createdAt: new Date(),
    }).run()
  }

  function countRows(table: any, agentSlug: string): number {
    return testDb
      .select()
      .from(table)
      .where(eq(table.agentSlug, agentSlug))
      .all().length
  }

  // ── Tests ────────────────────────────────────────────────────────────────

  describe('cleanupAgentData', () => {
    it('deletes agent connected account mappings', async () => {
      insertConnectedAccount('acct-1')
      insertAgentConnectedAccount(AGENT_SLUG, 'acct-1')
      insertAgentConnectedAccount(OTHER_AGENT_SLUG, 'acct-1')

      await cleanupAgentData(AGENT_SLUG)

      expect(countRows(schema.agentConnectedAccounts, AGENT_SLUG)).toBe(0)
      expect(countRows(schema.agentConnectedAccounts, OTHER_AGENT_SLUG)).toBe(1)
    })

    it('does not delete the connected account itself (shared resource)', async () => {
      insertConnectedAccount('acct-1')
      insertAgentConnectedAccount(AGENT_SLUG, 'acct-1')

      await cleanupAgentData(AGENT_SLUG)

      const accounts = testDb.select().from(schema.connectedAccounts).all()
      expect(accounts).toHaveLength(1)
    })

    it('cancels webhook triggers and cleans up Composio', async () => {
      insertConnectedAccount('acct-1')
      insertWebhookTrigger('wt-1', AGENT_SLUG, { composioTriggerId: 'ti_abc', status: 'active' })
      insertWebhookTrigger('wt-2', AGENT_SLUG, { composioTriggerId: 'ti_def', status: 'active' })
      insertWebhookTrigger('wt-other', OTHER_AGENT_SLUG, { composioTriggerId: 'ti_ghi', status: 'active' })

      await cleanupAgentData(AGENT_SLUG)

      // Both triggers for the deleted agent should be cancelled
      const remaining = testDb.select().from(schema.webhookTriggers)
        .where(eq(schema.webhookTriggers.agentSlug, AGENT_SLUG))
        .all()
      const active = remaining.filter(t => t.status === 'active')
      expect(active).toHaveLength(0)

      // Other agent's trigger untouched
      const otherTriggers = testDb.select().from(schema.webhookTriggers)
        .where(eq(schema.webhookTriggers.agentSlug, OTHER_AGENT_SLUG))
        .all()
      expect(otherTriggers).toHaveLength(1)
      expect(otherTriggers[0].status).toBe('active')

      // Composio cleanup called for each unique composioTriggerId
      expect(mockDeleteComposioTrigger).toHaveBeenCalledWith('ti_abc')
      expect(mockDeleteComposioTrigger).toHaveBeenCalledWith('ti_def')
      expect(mockDeleteComposioTrigger).not.toHaveBeenCalledWith('ti_ghi')
    })

    it('does not call Composio delete when other agents still use the same composioTriggerId', async () => {
      insertConnectedAccount('acct-1')
      insertWebhookTrigger('wt-1', AGENT_SLUG, { composioTriggerId: 'ti_shared', status: 'active' })
      insertWebhookTrigger('wt-other', OTHER_AGENT_SLUG, { composioTriggerId: 'ti_shared', status: 'active' })

      await cleanupAgentData(AGENT_SLUG)

      // Should NOT call deleteComposioTrigger because other-agent still uses ti_shared
      expect(mockDeleteComposioTrigger).not.toHaveBeenCalled()
    })

    it('skips Composio cleanup when platform Composio is inactive', async () => {
      mockIsPlatformComposioActive.mockReturnValue(false)
      insertConnectedAccount('acct-1')
      insertWebhookTrigger('wt-1', AGENT_SLUG, { composioTriggerId: 'ti_abc', status: 'active' })

      await cleanupAgentData(AGENT_SLUG)

      expect(mockDeleteComposioTrigger).not.toHaveBeenCalled()
      // Trigger should still be cancelled in DB
      const triggers = testDb.select().from(schema.webhookTriggers)
        .where(eq(schema.webhookTriggers.agentSlug, AGENT_SLUG))
        .all()
      expect(triggers.every(t => t.status === 'cancelled')).toBe(true)
    })

    it('handles already-cancelled triggers gracefully', async () => {
      insertConnectedAccount('acct-1')
      insertWebhookTrigger('wt-1', AGENT_SLUG, { composioTriggerId: 'ti_abc', status: 'cancelled' })

      await cleanupAgentData(AGENT_SLUG)

      expect(mockDeleteComposioTrigger).not.toHaveBeenCalled()
    })

    it('deletes chat integrations and cascades to sessions', async () => {
      const intId = insertChatIntegration('ci-1', AGENT_SLUG)
      insertChatIntegrationSession(intId)
      insertChatIntegrationSession(intId)
      const otherIntId = insertChatIntegration('ci-other', OTHER_AGENT_SLUG)
      insertChatIntegrationSession(otherIntId)

      await cleanupAgentData(AGENT_SLUG)

      // Agent's integrations gone
      expect(countRows(schema.chatIntegrations, AGENT_SLUG)).toBe(0)

      // Sessions cascaded (no orphans)
      const sessions = testDb.select().from(schema.chatIntegrationSessions)
        .where(eq(schema.chatIntegrationSessions.integrationId, intId))
        .all()
      expect(sessions).toHaveLength(0)

      // Other agent's integration + sessions untouched
      expect(countRows(schema.chatIntegrations, OTHER_AGENT_SLUG)).toBe(1)
      const otherSessions = testDb.select().from(schema.chatIntegrationSessions)
        .where(eq(schema.chatIntegrationSessions.integrationId, otherIntId))
        .all()
      expect(otherSessions).toHaveLength(1)
    })

    it('deletes scheduled tasks', async () => {
      insertScheduledTask('st-1', AGENT_SLUG)
      insertScheduledTask('st-2', AGENT_SLUG)
      insertScheduledTask('st-other', OTHER_AGENT_SLUG)

      await cleanupAgentData(AGENT_SLUG)

      expect(countRows(schema.scheduledTasks, AGENT_SLUG)).toBe(0)
      expect(countRows(schema.scheduledTasks, OTHER_AGENT_SLUG)).toBe(1)
    })

    it('deletes notifications', async () => {
      insertNotification('n-1', AGENT_SLUG)
      insertNotification('n-other', OTHER_AGENT_SLUG)

      await cleanupAgentData(AGENT_SLUG)

      expect(countRows(schema.notifications, AGENT_SLUG)).toBe(0)
      expect(countRows(schema.notifications, OTHER_AGENT_SLUG)).toBe(1)
    })

    it('deletes agent remote MCP mappings but not the MCP server', async () => {
      insertRemoteMcpServer('mcp-1')
      insertAgentRemoteMcp(AGENT_SLUG, 'mcp-1')
      insertAgentRemoteMcp(OTHER_AGENT_SLUG, 'mcp-1')

      await cleanupAgentData(AGENT_SLUG)

      expect(countRows(schema.agentRemoteMcps, AGENT_SLUG)).toBe(0)
      expect(countRows(schema.agentRemoteMcps, OTHER_AGENT_SLUG)).toBe(1)
      // MCP server itself still exists
      const servers = testDb.select().from(schema.remoteMcpServers).all()
      expect(servers).toHaveLength(1)
    })

    it('deletes proxy audit log entries', async () => {
      insertProxyAuditLog(AGENT_SLUG)
      insertProxyAuditLog(OTHER_AGENT_SLUG)

      await cleanupAgentData(AGENT_SLUG)

      expect(countRows(schema.proxyAuditLog, AGENT_SLUG)).toBe(0)
      expect(countRows(schema.proxyAuditLog, OTHER_AGENT_SLUG)).toBe(1)
    })

    it('deletes MCP audit log entries', async () => {
      insertRemoteMcpServer('mcp-1')
      insertMcpAuditLog(AGENT_SLUG, 'mcp-1')
      insertMcpAuditLog(OTHER_AGENT_SLUG, 'mcp-1')

      await cleanupAgentData(AGENT_SLUG)

      expect(countRows(schema.mcpAuditLog, AGENT_SLUG)).toBe(0)
      expect(countRows(schema.mcpAuditLog, OTHER_AGENT_SLUG)).toBe(1)
    })

    it('deletes ACL entries', async () => {
      insertUser('user-1')
      insertAgentAcl(AGENT_SLUG, 'user-1', 'owner')
      insertAgentAcl(OTHER_AGENT_SLUG, 'user-1', 'user')

      await cleanupAgentData(AGENT_SLUG)

      expect(countRows(schema.agentAcl, AGENT_SLUG)).toBe(0)
      expect(countRows(schema.agentAcl, OTHER_AGENT_SLUG)).toBe(1)
    })

    it('deletes message author records', async () => {
      insertUser('user-1')
      insertMessageAuthor(AGENT_SLUG, 'user-1')
      insertMessageAuthor(AGENT_SLUG, 'user-1')
      insertMessageAuthor(OTHER_AGENT_SLUG, 'user-1')

      await cleanupAgentData(AGENT_SLUG)

      expect(countRows(schema.messageAuthor, AGENT_SLUG)).toBe(0)
      expect(countRows(schema.messageAuthor, OTHER_AGENT_SLUG)).toBe(1)
    })

    it('completes all DB cleanup even when Composio delete fails mid-way', async () => {
      mockDeleteComposioTrigger.mockRejectedValueOnce(new Error('Composio network error'))

      insertConnectedAccount('acct-1')
      insertWebhookTrigger('wt-1', AGENT_SLUG, { composioTriggerId: 'ti_fail' })
      const intId = insertChatIntegration('ci-1', AGENT_SLUG)
      insertChatIntegrationSession(intId)
      insertScheduledTask('st-1', AGENT_SLUG)
      insertNotification('n-1', AGENT_SLUG)
      insertRemoteMcpServer('mcp-1')
      insertAgentRemoteMcp(AGENT_SLUG, 'mcp-1')

      await cleanupAgentData(AGENT_SLUG)

      // Composio was attempted
      expect(mockDeleteComposioTrigger).toHaveBeenCalledWith('ti_fail')
      // Trigger still cancelled in DB despite Composio failure
      const triggers = testDb.select().from(schema.webhookTriggers)
        .where(eq(schema.webhookTriggers.agentSlug, AGENT_SLUG))
        .all()
      expect(triggers.every(t => t.status === 'cancelled')).toBe(true)
      // All other peripheral data still cleaned up
      expect(countRows(schema.chatIntegrations, AGENT_SLUG)).toBe(0)
      expect(countRows(schema.scheduledTasks, AGENT_SLUG)).toBe(0)
      expect(countRows(schema.notifications, AGENT_SLUG)).toBe(0)
      expect(countRows(schema.agentConnectedAccounts, AGENT_SLUG)).toBe(0)
      expect(countRows(schema.agentRemoteMcps, AGENT_SLUG)).toBe(0)
    })

    it('cleans up everything for a fully loaded agent', async () => {
      insertUser('user-1')
      insertConnectedAccount('acct-1')
      insertAgentConnectedAccount(AGENT_SLUG, 'acct-1')
      insertWebhookTrigger('wt-1', AGENT_SLUG, { composioTriggerId: 'ti_abc' })
      const intId = insertChatIntegration('ci-1', AGENT_SLUG)
      insertChatIntegrationSession(intId)
      insertScheduledTask('st-1', AGENT_SLUG)
      insertNotification('n-1', AGENT_SLUG)
      insertRemoteMcpServer('mcp-1')
      insertAgentRemoteMcp(AGENT_SLUG, 'mcp-1')
      insertProxyAuditLog(AGENT_SLUG)
      insertMcpAuditLog(AGENT_SLUG, 'mcp-1')
      insertAgentAcl(AGENT_SLUG, 'user-1', 'owner')
      insertMessageAuthor(AGENT_SLUG, 'user-1')

      await cleanupAgentData(AGENT_SLUG)

      expect(countRows(schema.agentConnectedAccounts, AGENT_SLUG)).toBe(0)
      expect(countRows(schema.chatIntegrations, AGENT_SLUG)).toBe(0)
      expect(countRows(schema.scheduledTasks, AGENT_SLUG)).toBe(0)
      expect(countRows(schema.notifications, AGENT_SLUG)).toBe(0)
      expect(countRows(schema.agentRemoteMcps, AGENT_SLUG)).toBe(0)
      expect(countRows(schema.proxyAuditLog, AGENT_SLUG)).toBe(0)
      expect(countRows(schema.mcpAuditLog, AGENT_SLUG)).toBe(0)
      expect(countRows(schema.agentAcl, AGENT_SLUG)).toBe(0)
      expect(countRows(schema.messageAuthor, AGENT_SLUG)).toBe(0)
      const triggers = testDb.select().from(schema.webhookTriggers)
        .where(eq(schema.webhookTriggers.agentSlug, AGENT_SLUG))
        .all()
      expect(triggers.every(t => t.status === 'cancelled')).toBe(true)
    })

    it('is a no-op for an agent with no peripherals', async () => {
      await expect(cleanupAgentData(AGENT_SLUG)).resolves.not.toThrow()
    })
  })
})
