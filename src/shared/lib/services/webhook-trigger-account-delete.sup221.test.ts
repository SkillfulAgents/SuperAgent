/**
 * SUP-221 — Deleting a connected account leaves active webhook triggers orphaned.
 *
 * `webhook_triggers.connected_account_id` has no FK/cascade to
 * `connected_accounts.id`, and the DELETE /api/connected-accounts/:id handler
 * removes the account row without cancelling the webhook triggers that
 * reference it. Orphaned triggers stay status='active', so polling/subscription
 * paths (getActiveComposioTriggerIds) keep feeding their composioTriggerId to
 * the upstream Composio subscription even though the account/auth is gone.
 *
 * Fix: a service-level cleanup primitive
 * `cancelTriggersForConnectedAccount(accountId)` that cancels every active/paused
 * trigger for the account via cancelWebhookTriggerWithCleanup (which also tears
 * down the upstream Composio subscription when no sibling active trigger shares
 * the composioTriggerId), invoked from the DELETE handler BEFORE the account row
 * is deleted.
 *
 * This test mirrors webhook-trigger-service.test.ts: a real better-sqlite3 DB
 * migrated with the actual drizzle migrations, with `../db` mocked to expose the
 * test DB and the Composio client/trigger calls mocked so we can assert the
 * upstream teardown.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { z } from 'zod'
import Database from 'better-sqlite3'
import { and, eq, inArray } from 'drizzle-orm'
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

// Composio teardown is mocked so we can assert the upstream subscription is
// removed exactly when no sibling active trigger shares the composioTriggerId.
const deleteComposioTrigger = vi.fn().mockResolvedValue(undefined)
vi.mock('../composio/triggers', () => ({
  deleteComposioTrigger: (...args: unknown[]) => deleteComposioTrigger(...args),
}))

// Pretend platform Composio is active so cancelWebhookTriggerWithCleanup reaches
// the upstream-teardown branch.
vi.mock('../composio/client', () => ({
  isPlatformComposioActive: () => true,
}))

import {
  cancelTriggersForConnectedAccount,
  createWebhookTrigger,
  getWebhookTrigger,
  getActiveComposioTriggerIds,
} from './webhook-trigger-service'

// Per CLAUDE.md: validate JSON read back from the DB at the boundary with Zod.
const TriggerConfigSchema = z.object({ label: z.string() })

const ACCOUNT_ID = 'ca_to_delete'
const OTHER_ACCOUNT_ID = 'ca_keep'

function insertConnectedAccount(id: string) {
  const now = new Date()
  return testDb.insert(schema.connectedAccounts).values({
    id,
    providerConnectionId: `conn_${id}`,
    providerName: 'composio',
    toolkitSlug: 'gmail',
    displayName: `Account ${id}`,
    userId: null,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  })
}

/** Active/paused triggers still bound to an account (i.e. still "subscribed"). */
function stillSubscribedFor(accountId: string) {
  return testDb
    .select()
    .from(schema.webhookTriggers)
    .where(
      and(
        eq(schema.webhookTriggers.connectedAccountId, accountId),
        inArray(schema.webhookTriggers.status, ['active', 'paused']),
      ),
    )
    .all()
}

describe('SUP-221: cancelTriggersForConnectedAccount', () => {
  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sup221-account-delete-'))
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })

    const migrationsFolder = path.join(process.cwd(), 'src/shared/lib/db/migrations')
    migrate(testDb, { migrationsFolder })

    deleteComposioTrigger.mockClear()

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'))
  })

  afterEach(async () => {
    vi.useRealTimers()
    testSqlite?.close()
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  it('cancels the active trigger for the account and tears down its Composio subscription', async () => {
    await insertConnectedAccount(ACCOUNT_ID)

    const triggerId = await createWebhookTrigger({
      agentSlug: 'agent-1',
      composioTriggerId: 'ti_orphan',
      connectedAccountId: ACCOUNT_ID,
      triggerType: 'GMAIL_NEW_EMAIL',
      triggerConfig: '{"label":"inbox"}',
      prompt: 'Summarize the email',
    })

    // Sanity: before cleanup the trigger is active and feeds the live subscription.
    expect(stillSubscribedFor(ACCOUNT_ID)).toHaveLength(1)
    expect(getActiveComposioTriggerIds()).toContain('ti_orphan')

    await cancelTriggersForConnectedAccount(ACCOUNT_ID)

    // (1) No active/paused trigger remains bound to the deleted account.
    expect(stillSubscribedFor(ACCOUNT_ID)).toHaveLength(0)

    // (2) The trigger row is cancelled with cancelledAt set.
    const trigger = await getWebhookTrigger(triggerId)
    expect(trigger).not.toBeNull()
    expect(trigger!.status).toBe('cancelled')
    expect(trigger!.cancelledAt).not.toBeNull()

    // triggerConfig round-trips through the DB as a valid JSON string (Zod boundary).
    expect(() => TriggerConfigSchema.parse(JSON.parse(trigger!.triggerConfig!))).not.toThrow()

    // (3) Upstream Composio subscription torn down once (no sibling active trigger).
    expect(deleteComposioTrigger).toHaveBeenCalledTimes(1)
    expect(deleteComposioTrigger).toHaveBeenCalledWith('ti_orphan')

    // The trigger no longer counts toward the live subscription.
    expect(getActiveComposioTriggerIds()).not.toContain('ti_orphan')
  })

  it('also cancels paused triggers for the account', async () => {
    await insertConnectedAccount(ACCOUNT_ID)

    const pausedId = await createWebhookTrigger({
      agentSlug: 'agent-1',
      composioTriggerId: 'ti_paused',
      connectedAccountId: ACCOUNT_ID,
      triggerType: 'GMAIL_NEW_EMAIL',
      prompt: 'Paused handler',
    })
    await testDb
      .update(schema.webhookTriggers)
      .set({ status: 'paused', pausedAt: new Date() })
      .where(eq(schema.webhookTriggers.id, pausedId))

    expect(stillSubscribedFor(ACCOUNT_ID)).toHaveLength(1)

    await cancelTriggersForConnectedAccount(ACCOUNT_ID)

    expect(stillSubscribedFor(ACCOUNT_ID)).toHaveLength(0)
    const trigger = await getWebhookTrigger(pausedId)
    expect(trigger!.status).toBe('cancelled')
    expect(deleteComposioTrigger).toHaveBeenCalledWith('ti_paused')
  })

  it('leaves triggers belonging to other accounts untouched', async () => {
    await insertConnectedAccount(ACCOUNT_ID)
    await insertConnectedAccount(OTHER_ACCOUNT_ID)

    await createWebhookTrigger({
      agentSlug: 'agent-1',
      composioTriggerId: 'ti_delete',
      connectedAccountId: ACCOUNT_ID,
      triggerType: 'GMAIL_NEW_EMAIL',
      prompt: 'Delete me',
    })
    const keepId = await createWebhookTrigger({
      agentSlug: 'agent-2',
      composioTriggerId: 'ti_keep',
      connectedAccountId: OTHER_ACCOUNT_ID,
      triggerType: 'SLACK_NEW_MESSAGE',
      prompt: 'Keep me',
    })

    await cancelTriggersForConnectedAccount(ACCOUNT_ID)

    expect(stillSubscribedFor(ACCOUNT_ID)).toHaveLength(0)
    // The unrelated account's trigger is still active and still subscribed.
    expect(stillSubscribedFor(OTHER_ACCOUNT_ID)).toHaveLength(1)
    const kept = await getWebhookTrigger(keepId)
    expect(kept!.status).toBe('active')
    expect(deleteComposioTrigger).toHaveBeenCalledTimes(1)
    expect(deleteComposioTrigger).toHaveBeenCalledWith('ti_delete')
    expect(deleteComposioTrigger).not.toHaveBeenCalledWith('ti_keep')
  })

  it('keeps the upstream subscription when a sibling active trigger shares the composioTriggerId', async () => {
    await insertConnectedAccount(ACCOUNT_ID)
    await insertConnectedAccount(OTHER_ACCOUNT_ID)

    // Two triggers share the same composioTriggerId; only one belongs to the
    // account being deleted. The shared upstream subscription must survive.
    await createWebhookTrigger({
      agentSlug: 'agent-1',
      composioTriggerId: 'ti_shared',
      connectedAccountId: ACCOUNT_ID,
      triggerType: 'GMAIL_NEW_EMAIL',
      prompt: 'Delete me',
    })
    await createWebhookTrigger({
      agentSlug: 'agent-2',
      composioTriggerId: 'ti_shared',
      connectedAccountId: OTHER_ACCOUNT_ID,
      triggerType: 'GMAIL_NEW_EMAIL',
      prompt: 'Sibling keeps subscription alive',
    })

    await cancelTriggersForConnectedAccount(ACCOUNT_ID)

    expect(stillSubscribedFor(ACCOUNT_ID)).toHaveLength(0)
    // A sibling active trigger still references ti_shared → do NOT delete upstream.
    expect(deleteComposioTrigger).not.toHaveBeenCalled()
    expect(getActiveComposioTriggerIds()).toContain('ti_shared')
  })

  it('is a no-op for an account with no triggers', async () => {
    await insertConnectedAccount(ACCOUNT_ID)
    await expect(cancelTriggersForConnectedAccount(ACCOUNT_ID)).resolves.toBeUndefined()
    expect(deleteComposioTrigger).not.toHaveBeenCalled()
  })
})
