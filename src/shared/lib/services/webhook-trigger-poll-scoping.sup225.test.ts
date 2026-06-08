/**
 * SUP-225 — Paused webhook trigger events are not polled or acked while paused.
 *
 * `pauseWebhookTrigger()` keeps the upstream Composio subscription alive (see
 * `countActiveTriggersForComposioId`, which counts active+paused), and the
 * docstring promises paused-period events will be acked/discarded. But the
 * platform poll filter is built from `getActiveComposioTriggerIds()`
 * (status='active' only), so events for a Composio ID whose only local trigger
 * is paused are never claimed/acked — they accumulate and fire a session on
 * resume.
 *
 * Fix: a dedicated `getSubscribedComposioTriggerIds()` helper returns the
 * distinct composio IDs for rows still subscribed (status IN active/paused),
 * and `pollAndClaimEvents` uses it to scope the poll. `processEventGroup` then
 * acks/discards events for paused-only IDs (no active local trigger).
 *
 * These tests reproduce the bug:
 *   - the helper must include paused IDs (currently absent → throws / wrong)
 *   - the real poll body must include the paused Composio ID
 */
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

vi.mock('@shared/lib/db', () => ({
  get db() {
    return testDb
  },
  get sqlite() {
    return testSqlite
  },
}))

vi.mock('../analytics/server-analytics', () => ({
  trackServerEvent: vi.fn(),
}))

// Platform deps required by webhook-events-client's real poll path.
vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: () => 'https://proxy.test',
}))
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => 'test-token',
}))
vi.mock('@shared/lib/platform-attribution', () => ({
  // Opaque (non-org) token → buildBearer returns the bare token.
  decodeOrgIdFromToken: () => null,
}))

import {
  createWebhookTrigger,
  pauseWebhookTrigger,
  cancelWebhookTrigger,
  getActiveComposioTriggerIds,
  // New helper introduced by the SUP-225 fix.
  getSubscribedComposioTriggerIds,
} from './webhook-trigger-service'
import { pollAndClaimEvents } from './webhook-events-client'

describe('SUP-225: paused webhook triggers stay pollable', () => {
  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sup225-'))
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })

    const migrationsFolder = path.join(process.cwd(), 'src/shared/lib/db/migrations')
    migrate(testDb, { migrationsFolder })
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    testSqlite?.close()
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  async function seedActiveAndPaused() {
    await createWebhookTrigger({
      agentSlug: 'agent-1',
      composioTriggerId: 'ti_active',
      connectedAccountId: 'ca_1',
      triggerType: 'GMAIL_NEW_EMAIL',
      prompt: 'Active',
    })
    const pausedId = await createWebhookTrigger({
      agentSlug: 'agent-1',
      composioTriggerId: 'ti_paused',
      connectedAccountId: 'ca_2',
      triggerType: 'GMAIL_NEW_EMAIL',
      prompt: 'Paused',
    })
    const paused = await pauseWebhookTrigger(pausedId)
    expect(paused).toBe(true)
  }

  describe('getSubscribedComposioTriggerIds', () => {
    it('includes paused trigger composio IDs (reproduces the lost-poll-scope bug)', async () => {
      await seedActiveAndPaused()

      // The whole point of the fix: the subscribed-ids set must contain BOTH the
      // active and the paused composio IDs so the platform keeps handing us
      // paused-period events to ack/discard. Before the fix this helper does not
      // exist; the active-only helper returns just ['ti_active'].
      expect(getSubscribedComposioTriggerIds().sort()).toEqual(['ti_active', 'ti_paused'])

      // Guard the existing helper's narrower contract is unchanged.
      expect(getActiveComposioTriggerIds().sort()).toEqual(['ti_active'])
    })

    it('skips cancelled and null-composioId rows', async () => {
      await seedActiveAndPaused()

      // A cancelled trigger drops its subscription entirely.
      const cancelledId = await createWebhookTrigger({
        agentSlug: 'agent-1',
        composioTriggerId: 'ti_cancelled',
        connectedAccountId: 'ca_3',
        triggerType: 'GMAIL_NEW_EMAIL',
        prompt: 'Cancelled',
      })
      await cancelWebhookTrigger(cancelledId)

      // A trigger that has not yet received its composio ID contributes nothing.
      await createWebhookTrigger({
        agentSlug: 'agent-2',
        connectedAccountId: 'ca_4',
        triggerType: 'GMAIL_NEW_EMAIL',
        prompt: 'No composio id yet',
      })

      expect(getSubscribedComposioTriggerIds().sort()).toEqual(['ti_active', 'ti_paused'])
    })
  })

  describe('pollAndClaimEvents poll scope', () => {
    it('posts trigger_ids including the paused Composio ID so paused-period events get claimed', async () => {
      await seedActiveAndPaused()

      const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
        ok: true,
        status: 200,
        json: async () => ({ events: [], realtime: null }),
        text: async () => '',
      }))
      vi.stubGlobal('fetch', fetchMock)

      await pollAndClaimEvents('member_1')

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [, init] = fetchMock.mock.calls[0]
      const body = JSON.parse(init.body as string) as { trigger_ids: string[] }
      // Before the fix the poll scope is active-only and excludes 'ti_paused',
      // so those events are never claimed/acked while paused.
      expect(body.trigger_ids.sort()).toEqual(['ti_active', 'ti_paused'])
    })
  })
})
