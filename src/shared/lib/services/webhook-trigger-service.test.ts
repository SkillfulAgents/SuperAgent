import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
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

vi.mock('../analytics/server-analytics', () => ({
  trackServerEvent: vi.fn(),
}))

import {
  createWebhookTrigger,
  getWebhookTrigger,
  getWebhookTriggerByComposioId,
  listWebhookTriggers,
  listActiveWebhookTriggers,
  cancelWebhookTrigger,
  markTriggerFired,
  markTriggerFailed,
  updateComposioTriggerId,
} from './webhook-trigger-service'

describe('webhook-trigger-service', () => {
  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'webhook-trigger-test-')
    )
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })

    const migrationsFolder = path.join(process.cwd(), 'src/shared/lib/db/migrations')
    migrate(testDb, { migrationsFolder })

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'))
  })

  afterEach(async () => {
    vi.useRealTimers()
    testSqlite?.close()
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  describe('createWebhookTrigger', () => {
    it('creates a trigger with all fields', async () => {
      const id = await createWebhookTrigger({
        agentSlug: 'test-agent',
        composioTriggerId: 'ti_abc123',
        connectedAccountId: 'ca_conn1',
        triggerType: 'GMAIL_NEW_EMAIL',
        triggerConfig: '{"label":"inbox"}',
        prompt: 'Summarize the email',
        name: 'Email handler',
        createdBySessionId: 'sess_1',
        createdByUserId: 'user_1',
      })

      expect(id).toBeDefined()
      const trigger = await getWebhookTrigger(id)
      expect(trigger).not.toBeNull()
      expect(trigger!.agentSlug).toBe('test-agent')
      expect(trigger!.composioTriggerId).toBe('ti_abc123')
      expect(trigger!.connectedAccountId).toBe('ca_conn1')
      expect(trigger!.triggerType).toBe('GMAIL_NEW_EMAIL')
      expect(trigger!.triggerConfig).toBe('{"label":"inbox"}')
      expect(trigger!.prompt).toBe('Summarize the email')
      expect(trigger!.name).toBe('Email handler')
      expect(trigger!.status).toBe('active')
      expect(trigger!.fireCount).toBe(0)
      expect(trigger!.createdBySessionId).toBe('sess_1')
      expect(trigger!.createdByUserId).toBe('user_1')
    })

    it('creates a trigger with minimal fields', async () => {
      const id = await createWebhookTrigger({
        agentSlug: 'agent-1',
        connectedAccountId: 'ca_1',
        triggerType: 'SLACK_NEW_MESSAGE',
        prompt: 'Handle the message',
      })

      const trigger = await getWebhookTrigger(id)
      expect(trigger!.composioTriggerId).toBeNull()
      expect(trigger!.triggerConfig).toBeNull()
      expect(trigger!.name).toBeNull()
    })
  })

  describe('getWebhookTriggerByComposioId', () => {
    it('finds active trigger by composio ID', async () => {
      await createWebhookTrigger({
        agentSlug: 'agent-1',
        composioTriggerId: 'ti_findme',
        connectedAccountId: 'ca_1',
        triggerType: 'GMAIL_NEW_EMAIL',
        prompt: 'Test',
      })

      const found = await getWebhookTriggerByComposioId('ti_findme')
      expect(found).not.toBeNull()
      expect(found!.composioTriggerId).toBe('ti_findme')
    })

    it('returns null for cancelled triggers', async () => {
      const id = await createWebhookTrigger({
        agentSlug: 'agent-1',
        composioTriggerId: 'ti_cancelled',
        connectedAccountId: 'ca_1',
        triggerType: 'GMAIL_NEW_EMAIL',
        prompt: 'Test',
      })

      await cancelWebhookTrigger(id)
      const found = await getWebhookTriggerByComposioId('ti_cancelled')
      expect(found).toBeNull()
    })

    it('returns null for non-existent composio ID', async () => {
      const found = await getWebhookTriggerByComposioId('ti_nonexistent')
      expect(found).toBeNull()
    })
  })

  describe('listWebhookTriggers', () => {
    it('lists all triggers for an agent', async () => {
      await createWebhookTrigger({
        agentSlug: 'agent-1',
        connectedAccountId: 'ca_1',
        triggerType: 'GMAIL_NEW_EMAIL',
        prompt: 'Test 1',
      })
      await createWebhookTrigger({
        agentSlug: 'agent-1',
        connectedAccountId: 'ca_2',
        triggerType: 'SLACK_NEW_MESSAGE',
        prompt: 'Test 2',
      })
      await createWebhookTrigger({
        agentSlug: 'agent-2',
        connectedAccountId: 'ca_1',
        triggerType: 'GITHUB_PUSH',
        prompt: 'Test 3',
      })

      const triggers = await listWebhookTriggers('agent-1')
      expect(triggers).toHaveLength(2)
    })

    it('returns empty array for agent with no triggers', async () => {
      const triggers = await listWebhookTriggers('nonexistent-agent')
      expect(triggers).toEqual([])
    })
  })

  describe('listActiveWebhookTriggers', () => {
    it('filters by active status', async () => {
      const id1 = await createWebhookTrigger({
        agentSlug: 'agent-1',
        connectedAccountId: 'ca_1',
        triggerType: 'GMAIL_NEW_EMAIL',
        prompt: 'Test 1',
      })
      await createWebhookTrigger({
        agentSlug: 'agent-1',
        connectedAccountId: 'ca_2',
        triggerType: 'SLACK_NEW_MESSAGE',
        prompt: 'Test 2',
      })

      await cancelWebhookTrigger(id1)

      const active = await listActiveWebhookTriggers('agent-1')
      expect(active).toHaveLength(1)
      expect(active[0].triggerType).toBe('SLACK_NEW_MESSAGE')
    })

    it('lists all active triggers when no agentSlug provided', async () => {
      await createWebhookTrigger({
        agentSlug: 'agent-1',
        connectedAccountId: 'ca_1',
        triggerType: 'T1',
        prompt: 'Test',
      })
      await createWebhookTrigger({
        agentSlug: 'agent-2',
        connectedAccountId: 'ca_2',
        triggerType: 'T2',
        prompt: 'Test',
      })

      const all = await listActiveWebhookTriggers()
      expect(all).toHaveLength(2)
    })
  })

  describe('cancelWebhookTrigger', () => {
    it('cancels an active trigger', async () => {
      const id = await createWebhookTrigger({
        agentSlug: 'agent-1',
        connectedAccountId: 'ca_1',
        triggerType: 'GMAIL_NEW_EMAIL',
        prompt: 'Test',
      })

      const result = await cancelWebhookTrigger(id)
      expect(result).toBe(true)

      const trigger = await getWebhookTrigger(id)
      expect(trigger!.status).toBe('cancelled')
      expect(trigger!.cancelledAt).not.toBeNull()
    })

    it('returns false for already-cancelled trigger', async () => {
      const id = await createWebhookTrigger({
        agentSlug: 'agent-1',
        connectedAccountId: 'ca_1',
        triggerType: 'GMAIL_NEW_EMAIL',
        prompt: 'Test',
      })

      await cancelWebhookTrigger(id)
      const result = await cancelWebhookTrigger(id)
      expect(result).toBe(false)
    })
  })

  describe('markTriggerFired', () => {
    it('updates lastFiredAt and increments fireCount', async () => {
      const id = await createWebhookTrigger({
        agentSlug: 'agent-1',
        connectedAccountId: 'ca_1',
        triggerType: 'GMAIL_NEW_EMAIL',
        prompt: 'Test',
      })

      await markTriggerFired(id, 'sess_run1')
      let trigger = await getWebhookTrigger(id)
      expect(trigger!.fireCount).toBe(1)
      expect(trigger!.lastSessionId).toBe('sess_run1')
      expect(trigger!.lastFiredAt).not.toBeNull()

      vi.setSystemTime(new Date('2026-04-01T13:00:00.000Z'))
      await markTriggerFired(id, 'sess_run2')
      trigger = await getWebhookTrigger(id)
      expect(trigger!.fireCount).toBe(2)
      expect(trigger!.lastSessionId).toBe('sess_run2')
    })
  })

  describe('markTriggerFailed', () => {
    it('sets status to failed', async () => {
      const id = await createWebhookTrigger({
        agentSlug: 'agent-1',
        connectedAccountId: 'ca_1',
        triggerType: 'GMAIL_NEW_EMAIL',
        prompt: 'Test',
      })

      await markTriggerFailed(id, 'Agent not found')
      const trigger = await getWebhookTrigger(id)
      expect(trigger!.status).toBe('failed')
    })
  })

  describe('updateComposioTriggerId', () => {
    it('updates the composio trigger ID', async () => {
      const id = await createWebhookTrigger({
        agentSlug: 'agent-1',
        connectedAccountId: 'ca_1',
        triggerType: 'GMAIL_NEW_EMAIL',
        prompt: 'Test',
      })

      await updateComposioTriggerId(id, 'ti_new_id')
      const trigger = await getWebhookTrigger(id)
      expect(trigger!.composioTriggerId).toBe('ti_new_id')
    })
  })
})
