/**
 * Composio-kind teardown must run under the member that minted the upstream
 * subscription: the proxy scopes trigger DELETE to that member's Composio
 * user, so an ambient deleter identity 404s on cross-member cleanup and
 * silently orphans the upstream subscription (SUP-765).
 *
 * Uses the REAL platform-attribution resolver against seeded rows; only the
 * upstream clients and token source are mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import * as schema from '../db/schema'

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

const mockIsPlatformComposioActive = vi.fn()
vi.mock('@shared/lib/composio/client', () => ({
  isPlatformComposioActive: () => mockIsPlatformComposioActive(),
}))

// Real error classes so a constructor change here fails these tests.
const mockDeleteComposioTrigger = vi.fn()
vi.mock('@shared/lib/composio/triggers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/lib/composio/triggers')>()
  return {
    ComposioTriggerError: actual.ComposioTriggerError,
    deleteComposioTrigger: (...args: unknown[]) => mockDeleteComposioTrigger(...args),
  }
})

const mockDisableEndpoint = vi.fn()
vi.mock('@shared/lib/services/webhook-endpoints-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/lib/services/webhook-endpoints-client')>()
  return {
    WebhookEndpointsApiError: actual.WebhookEndpointsApiError,
    disablePlatformWebhookEndpoint: (...args: unknown[]) => mockDisableEndpoint(...args),
  }
})

const mockCaptureException = vi.fn()
vi.mock('@shared/lib/error-reporting', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}))

const mockGetPlatformAccessToken = vi.fn()
const mockGetStoredPlatformMemberId = vi.fn((): string | null => null)
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => mockGetPlatformAccessToken(),
  getStoredPlatformMemberId: () => mockGetStoredPlatformMemberId(),
}))

import { attribution } from '@shared/lib/platform-attribution'
import { ComposioTriggerError } from '@shared/lib/composio/triggers'
import { WebhookEndpointsApiError } from '@shared/lib/services/webhook-endpoints-client'
import {
  createWebhookTrigger,
  cancelWebhookTriggerWithCleanup,
  cancelWebhookTrigger,
  getWebhookTrigger,
  listOwedUpstreamTeardowns,
  listTerminalUpstreamTriggers,
  deleteOrphanedUpstreamSubscription,
  reconcileOrphanedUpstreamSubscriptions,
  resolveTeardownMembers,
  markUpstreamDeleted,
  UpstreamOwnerUnresolvedError,
  RECONCILE_BATCH_SIZE,
  MAX_TEARDOWN_ATTEMPTS,
} from './webhook-trigger-service'

// `failed` has no producer any more; legacy rows can still carry it.
async function forceStatusFailed(triggerId: string) {
  await testDb.update(schema.webhookTriggers).set({ status: 'failed' }).where(eq(schema.webhookTriggers.id, triggerId))
}

function buildOrgToken(orgId: string): string {
  const header = Buffer.from('{"alg":"none"}').toString('base64url')
  const payload = Buffer.from(JSON.stringify({ orgId })).toString('base64url')
  return `${header}.${payload}.sig`
}

const ORG_TOKEN = buildOrgToken('org_test_765')
const NOW = new Date('2026-09-01T12:00:00.000Z')

async function insertUser(id: string) {
  await testDb.insert(schema.user).values({
    id,
    name: id,
    email: `${id}@example.com`,
    createdAt: NOW,
    updatedAt: NOW,
  })
}

async function insertPlatformAccount(userId: string, memberId: string) {
  await testDb.insert(schema.authAccount).values({
    id: `acct_${memberId}`,
    accountId: memberId,
    providerId: 'platform',
    userId,
    createdAt: NOW,
    updatedAt: NOW,
  })
}

async function insertConnectedAccount(id: string, ownerUserId: string | null) {
  await testDb.insert(schema.connectedAccounts).values({
    id,
    providerConnectionId: `pc_${id}`,
    providerName: 'composio',
    toolkitSlug: 'googlecalendar',
    displayName: 'Calendar',
    status: 'active',
    userId: ownerUserId,
    createdAt: NOW,
    updatedAt: NOW,
  })
}

async function createComposioTrigger(params: {
  createdByUserId?: string
  mintedByMemberId?: string
  connectedAccountId?: string
  composioTriggerId?: string
}) {
  return createWebhookTrigger({
    agentSlug: 'agent-1',
    composioTriggerId: params.composioTriggerId ?? 'ti_composio_1',
    connectedAccountId: params.connectedAccountId,
    triggerType: 'GOOGLECALENDAR_EVENT_CANCELED_DELETED_TRIGGER',
    prompt: 'Handle it',
    createdByUserId: params.createdByUserId,
    mintedByMemberId: params.mintedByMemberId,
  })
}

describe('composio teardown attribution (SUP-765)', () => {
  // The attribution key active inside the upstream delete call.
  let deleteAttributionKey: string | null | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    deleteAttributionKey = undefined
    mockIsPlatformComposioActive.mockReturnValue(true)
    mockGetPlatformAccessToken.mockReturnValue(ORG_TOKEN)
    mockGetStoredPlatformMemberId.mockReturnValue(null)
    mockDeleteComposioTrigger.mockImplementation(async () => {
      deleteAttributionKey = attribution.current()?.getKey() ?? null
    })
    mockDisableEndpoint.mockImplementation(async () => {
      deleteAttributionKey = attribution.current()?.getKey() ?? null
    })

    testSqlite = new Database(':memory:')
    // Mirror production (db/index.ts): FK enforcement on, so seeds must be real.
    testSqlite.pragma('foreign_keys = ON')
    testDb = drizzle(testSqlite, { schema })
    migrate(testDb, { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })
  })

  afterEach(() => {
    testSqlite?.close()
  })

  it('deletes under the recorded minting member, even when the creator resolves elsewhere', async () => {
    await insertUser('user-creator')
    await insertPlatformAccount('user-creator', 'sub_creator')

    const triggerId = await createComposioTrigger({
      createdByUserId: 'user-creator',
      mintedByMemberId: 'sub_minted',
    })

    expect(await cancelWebhookTriggerWithCleanup(triggerId)).toBe(true)
    expect(mockDeleteComposioTrigger).toHaveBeenCalledWith('ti_composio_1')
    expect(deleteAttributionKey).toBe('member:sub_minted')
  })

  it('falls back to the creator member for rows minted before the column existed', async () => {
    await insertUser('user-creator')
    await insertPlatformAccount('user-creator', 'sub_creator')

    const triggerId = await createComposioTrigger({ createdByUserId: 'user-creator' })

    expect(await cancelWebhookTriggerWithCleanup(triggerId)).toBe(true)
    expect(deleteAttributionKey).toBe('member:sub_creator')
  })

  it('falls back to the connected-account owner when the creator has no platform member', async () => {
    await insertUser('user-creator')
    await insertUser('user-owner')
    await insertPlatformAccount('user-owner', 'sub_owner')
    await insertConnectedAccount('ca_1', 'user-owner')

    const triggerId = await createComposioTrigger({
      createdByUserId: 'user-creator',
      connectedAccountId: 'ca_1',
    })

    expect(await cancelWebhookTriggerWithCleanup(triggerId)).toBe(true)
    expect(deleteAttributionKey).toBe('member:sub_owner')
  })

  it('keeps the ambient attribution when nothing resolves', async () => {
    const triggerId = await createComposioTrigger({})

    expect(await cancelWebhookTriggerWithCleanup(triggerId)).toBe(true)
    expect(mockDeleteComposioTrigger).toHaveBeenCalledWith('ti_composio_1')
    // No request scope in this test, so ambient attribution is null.
    expect(deleteAttributionKey).toBeNull()
  })

  it('skips member resolution entirely in opaque-access-key mode', async () => {
    mockGetPlatformAccessToken.mockReturnValue('plat_sa_opaque_key')
    await insertUser('user-creator')
    await insertPlatformAccount('user-creator', 'sub_creator')

    const triggerId = await createComposioTrigger({
      createdByUserId: 'user-creator',
      mintedByMemberId: 'sub_minted',
    })

    expect(await cancelWebhookTriggerWithCleanup(triggerId)).toBe(true)
    // requiresActingMember() is false, so no override — ambient (null here).
    expect(deleteAttributionKey).toBeNull()
  })

  it('disables custom endpoints under the recorded minting member too', async () => {
    const triggerId = await createWebhookTrigger({
      agentSlug: 'agent-1',
      kind: 'custom',
      composioTriggerId: 'whep_1',
      triggerType: 'CUSTOM_WEBHOOK',
      prompt: 'Handle it',
      mintedByMemberId: 'sub_minted',
    })

    expect(await cancelWebhookTriggerWithCleanup(triggerId)).toBe(true)
    expect(mockDisableEndpoint).toHaveBeenCalledWith('sub_minted', 'whep_1')
    expect(deleteAttributionKey).toBe('member:sub_minted')
  })

  describe('resolveTeardownMembers', () => {
    it('is known and single when the minting member was recorded', async () => {
      await insertUser('user-creator')
      await insertPlatformAccount('user-creator', 'sub_creator')
      const triggerId = await createComposioTrigger({ createdByUserId: 'user-creator', mintedByMemberId: 'sub_minted' })

      expect(resolveTeardownMembers((await getWebhookTrigger(triggerId))!)).toEqual({
        memberIds: ['sub_minted'],
        known: true,
      })
    })

    it('is a guessed creator → owner → stored chain for pre-column rows', async () => {
      await insertUser('user-creator')
      await insertPlatformAccount('user-creator', 'sub_creator')
      await insertUser('user-owner')
      await insertPlatformAccount('user-owner', 'sub_owner')
      await insertConnectedAccount('ca_1', 'user-owner')
      mockGetStoredPlatformMemberId.mockReturnValue('sub_stored')
      const triggerId = await createComposioTrigger({ createdByUserId: 'user-creator', connectedAccountId: 'ca_1' })

      expect(resolveTeardownMembers((await getWebhookTrigger(triggerId))!)).toEqual({
        memberIds: ['sub_creator', 'sub_owner', 'sub_stored'],
        known: false,
      })
    })

    it('is known with no members in opaque-access-key mode', async () => {
      mockGetPlatformAccessToken.mockReturnValue('plat_sa_opaque_key')
      const triggerId = await createComposioTrigger({ createdByUserId: 'user-creator' })

      expect(resolveTeardownMembers((await getWebhookTrigger(triggerId))!)).toEqual({ memberIds: [], known: true })
    })
  })

  // The proxy 404s a cross-member DELETE exactly like a missing subscription,
  // so a 404 only means "gone" when the acting member is known.
  describe('404 handling', () => {
    it('is set when the upstream is already gone under the recorded minting member', async () => {
      mockDeleteComposioTrigger.mockRejectedValue(new ComposioTriggerError('Trigger not found', 404))
      const triggerId = await createComposioTrigger({ mintedByMemberId: 'sub_minted' })

      expect(await cancelWebhookTriggerWithCleanup(triggerId)).toBe(true)

      expect(mockDeleteComposioTrigger).toHaveBeenCalledTimes(1)
      expect((await getWebhookTrigger(triggerId))!.upstreamDeletedAt).toBeInstanceOf(Date)
      expect(mockCaptureException).not.toHaveBeenCalled()
    })

    it('is set on a 404 in opaque-access-key mode (the proxy ignores members)', async () => {
      mockGetPlatformAccessToken.mockReturnValue('plat_sa_opaque_key')
      mockDeleteComposioTrigger.mockRejectedValue(new ComposioTriggerError('Trigger not found', 404))
      const triggerId = await createComposioTrigger({ createdByUserId: 'user-creator' })

      expect(await cancelWebhookTriggerWithCleanup(triggerId)).toBe(true)

      expect((await getWebhookTrigger(triggerId))!.upstreamDeletedAt).toBeInstanceOf(Date)
      expect(mockCaptureException).not.toHaveBeenCalled()
    })

    it('tries the next guessed member after a 404 and marks on the one that succeeds', async () => {
      await insertUser('user-creator')
      await insertPlatformAccount('user-creator', 'sub_creator')
      await insertUser('user-owner')
      await insertPlatformAccount('user-owner', 'sub_owner')
      await insertConnectedAccount('ca_1', 'user-owner')
      const keys: Array<string | null> = []
      mockDeleteComposioTrigger.mockImplementation(async () => {
        const key = attribution.current()?.getKey() ?? null
        keys.push(key)
        if (key !== 'member:sub_owner') throw new ComposioTriggerError('Trigger not found', 404)
      })
      const triggerId = await createComposioTrigger({ createdByUserId: 'user-creator', connectedAccountId: 'ca_1' })

      expect(await cancelWebhookTriggerWithCleanup(triggerId)).toBe(true)

      expect(keys).toEqual(['member:sub_creator', 'member:sub_owner'])
      expect((await getWebhookTrigger(triggerId))!.upstreamDeletedAt).toBeInstanceOf(Date)
      expect(mockCaptureException).not.toHaveBeenCalled()
    })

    it('leaves the marker null and reports when every guessed member 404s', async () => {
      await insertUser('user-creator')
      await insertPlatformAccount('user-creator', 'sub_creator')
      mockGetStoredPlatformMemberId.mockReturnValue('sub_stored')
      mockDeleteComposioTrigger.mockRejectedValue(new ComposioTriggerError('Trigger not found', 404))
      const triggerId = await createComposioTrigger({ createdByUserId: 'user-creator' })

      expect(await cancelWebhookTriggerWithCleanup(triggerId)).toBe(true)

      expect(mockDeleteComposioTrigger).toHaveBeenCalledTimes(2)
      expect((await getWebhookTrigger(triggerId))!.upstreamDeletedAt).toBeNull()
      expect(mockCaptureException).toHaveBeenCalledTimes(1)
      expect(mockCaptureException.mock.calls[0][0]).toBeInstanceOf(UpstreamOwnerUnresolvedError)
      expect(listOwedUpstreamTeardowns().map((t) => t.id)).toEqual([triggerId])
    })

    it('treats all-404 as expected when a concurrent teardown already set the marker', async () => {
      await insertUser('user-creator')
      await insertPlatformAccount('user-creator', 'sub_creator')
      const triggerId = await createComposioTrigger({ createdByUserId: 'user-creator' })
      // Background reconcile wins the race: it deletes upstream and marks before our 404s land.
      mockDeleteComposioTrigger.mockImplementation(async () => {
        await markUpstreamDeleted('ti_composio_1')
        throw new ComposioTriggerError('Trigger not found', 404)
      })

      expect(await cancelWebhookTriggerWithCleanup(triggerId)).toBe(true)

      expect((await getWebhookTrigger(triggerId))!.upstreamDeletedAt).toBeInstanceOf(Date)
      expect(mockCaptureException).not.toHaveBeenCalled()
    })

    it('stops at the first non-404 failure and leaves the marker null', async () => {
      await insertUser('user-creator')
      await insertPlatformAccount('user-creator', 'sub_creator')
      mockGetStoredPlatformMemberId.mockReturnValue('sub_stored')
      mockDeleteComposioTrigger.mockRejectedValue(new ComposioTriggerError('upstream 502', 502))
      const triggerId = await createComposioTrigger({ createdByUserId: 'user-creator' })

      expect(await cancelWebhookTriggerWithCleanup(triggerId)).toBe(true)

      expect(mockDeleteComposioTrigger).toHaveBeenCalledTimes(1)
      expect((await getWebhookTrigger(triggerId))!.upstreamDeletedAt).toBeNull()
      expect(mockCaptureException).toHaveBeenCalledTimes(1)
    })

    it('recognises a 404 from any status-carrying error, not one class', async () => {
      mockDisableEndpoint.mockRejectedValue(new WebhookEndpointsApiError('API error 404', 404))
      const triggerId = await createWebhookTrigger({
        agentSlug: 'agent-1',
        kind: 'custom',
        composioTriggerId: 'whep_1',
        triggerType: 'CUSTOM_WEBHOOK',
        prompt: 'Handle it',
        mintedByMemberId: 'sub_minted',
      })

      expect(await cancelWebhookTriggerWithCleanup(triggerId)).toBe(true)

      expect((await getWebhookTrigger(triggerId))!.upstreamDeletedAt).toBeInstanceOf(Date)
      expect(mockCaptureException).not.toHaveBeenCalled()
    })
  })

  describe('upstreamDeletedAt marker', () => {
    it('is set by a successful teardown so the row is not reconciled again', async () => {
      const triggerId = await createComposioTrigger({ mintedByMemberId: 'sub_minted' })

      await cancelWebhookTriggerWithCleanup(triggerId)

      expect((await getWebhookTrigger(triggerId))!.upstreamDeletedAt).toBeInstanceOf(Date)
      expect(listOwedUpstreamTeardowns()).toEqual([])
    })

    it('is set on every terminal sibling sharing the upstream id', async () => {
      const first = await createComposioTrigger({ mintedByMemberId: 'sub_minted' })
      const second = await createComposioTrigger({ mintedByMemberId: 'sub_minted' })
      // First cancel keeps the upstream (sibling still subscribed) → no marker yet.
      await cancelWebhookTriggerWithCleanup(first)
      expect(mockDeleteComposioTrigger).not.toHaveBeenCalled()
      expect((await getWebhookTrigger(first))!.upstreamDeletedAt).toBeNull()

      await cancelWebhookTriggerWithCleanup(second)

      expect(mockDeleteComposioTrigger).toHaveBeenCalledTimes(1)
      expect((await getWebhookTrigger(first))!.upstreamDeletedAt).toBeInstanceOf(Date)
      expect((await getWebhookTrigger(second))!.upstreamDeletedAt).toBeInstanceOf(Date)
    })
  })

  // Poll-loop reconcile (SUP-765): owed teardowns are found from local rows —
  // the claim is scoped to active/paused ids, so orphans never deliver events.
  describe('listOwedUpstreamTeardowns', () => {
    it('selects cancelled rows with an upstream id and no marker, one per upstream id', async () => {
      const cancelled = await createComposioTrigger({ composioTriggerId: 'ti_a' })
      await cancelWebhookTrigger(cancelled)
      const preColumn = await createComposioTrigger({ composioTriggerId: 'ti_c' })
      const minted = await createComposioTrigger({ composioTriggerId: 'ti_c', mintedByMemberId: 'sub_minted' })
      await cancelWebhookTrigger(preColumn)
      await cancelWebhookTrigger(minted)

      const owed = listOwedUpstreamTeardowns()

      expect(owed.map((t) => t.composioTriggerId).sort()).toEqual(['ti_a', 'ti_c'])
      // The row carrying the minting member represents the shared id.
      expect(owed.find((t) => t.composioTriggerId === 'ti_c')!.id).toBe(minted)
    })

    it('excludes legacy failed rows: nothing produces failed any more and no teardown was decided', async () => {
      const failed = await createComposioTrigger({ composioTriggerId: 'ti_failed' })
      await forceStatusFailed(failed)

      expect(listOwedUpstreamTeardowns()).toEqual([])
    })

    it('excludes ids still held by an active or paused row', async () => {
      const cancelled = await createComposioTrigger({ composioTriggerId: 'ti_live' })
      await createComposioTrigger({ composioTriggerId: 'ti_live' })
      await cancelWebhookTrigger(cancelled)

      expect(listOwedUpstreamTeardowns()).toEqual([])
    })

    it('excludes active rows and rows without an upstream id', async () => {
      await createComposioTrigger({ composioTriggerId: 'ti_active' })
      const noUpstream = await createWebhookTrigger({
        agentSlug: 'agent-1',
        triggerType: 'GMAIL_NEW_EMAIL',
        prompt: 'Handle it',
      })
      await cancelWebhookTrigger(noUpstream)

      expect(listOwedUpstreamTeardowns()).toEqual([])
    })

    it('excludes composio rows while platform Composio is inactive, keeping custom rows', async () => {
      mockIsPlatformComposioActive.mockReturnValue(false)
      const composio = await createComposioTrigger({ composioTriggerId: 'ti_x', mintedByMemberId: 'sub_minted' })
      const custom = await createWebhookTrigger({
        agentSlug: 'agent-1',
        kind: 'custom',
        composioTriggerId: 'whep_1',
        triggerType: 'CUSTOM_WEBHOOK',
        prompt: 'Handle it',
        mintedByMemberId: 'sub_minted',
      })
      await cancelWebhookTrigger(composio)
      await cancelWebhookTrigger(custom)

      expect(listOwedUpstreamTeardowns().map((t) => t.id)).toEqual([custom])
    })

    it('returns nothing without a platform token', async () => {
      mockGetPlatformAccessToken.mockReturnValue(null)
      mockIsPlatformComposioActive.mockReturnValue(false)
      const custom = await createWebhookTrigger({
        agentSlug: 'agent-1',
        kind: 'custom',
        composioTriggerId: 'whep_1',
        triggerType: 'CUSTOM_WEBHOOK',
        prompt: 'Handle it',
      })
      await cancelWebhookTrigger(custom)

      expect(listOwedUpstreamTeardowns()).toEqual([])
    })

    it('orders least-attempted first so the bounded batch rotates', async () => {
      const stuck = await createComposioTrigger({ composioTriggerId: 'ti_stuck', mintedByMemberId: 'sub_a' })
      const fresh = await createComposioTrigger({ composioTriggerId: 'ti_fresh', mintedByMemberId: 'sub_b' })
      await cancelWebhookTrigger(stuck)
      await cancelWebhookTrigger(fresh)
      await testDb
        .update(schema.webhookTriggers)
        .set({ upstreamTeardownAttempts: 3 })
        .where(eq(schema.webhookTriggers.id, stuck))

      expect(listOwedUpstreamTeardowns().map((t) => t.composioTriggerId)).toEqual(['ti_fresh', 'ti_stuck'])
      expect(listOwedUpstreamTeardowns(1).map((t) => t.composioTriggerId)).toEqual(['ti_fresh'])
    })

    it('leaves rows at the attempt cap to the cleanup script', async () => {
      const capped = await createComposioTrigger({ composioTriggerId: 'ti_capped', mintedByMemberId: 'sub_a' })
      await cancelWebhookTrigger(capped)
      await testDb
        .update(schema.webhookTriggers)
        .set({ upstreamTeardownAttempts: MAX_TEARDOWN_ATTEMPTS })
        .where(eq(schema.webhookTriggers.id, capped))

      expect(listOwedUpstreamTeardowns()).toEqual([])
      expect(listTerminalUpstreamTriggers().map((t) => t.id)).toEqual([capped])
    })
  })

  describe('listTerminalUpstreamTriggers', () => {
    it('includes marked and failed rows (the legacy script confirms liveness upstream instead)', async () => {
      const marked = await createComposioTrigger({ composioTriggerId: 'ti_marked', mintedByMemberId: 'sub_a' })
      await cancelWebhookTriggerWithCleanup(marked)
      const failed = await createComposioTrigger({ composioTriggerId: 'ti_failed' })
      await forceStatusFailed(failed)
      const live = await createComposioTrigger({ composioTriggerId: 'ti_live' })
      await createComposioTrigger({ composioTriggerId: 'ti_live' })
      await cancelWebhookTrigger(live)

      expect(listTerminalUpstreamTriggers().map((t) => t.composioTriggerId).sort()).toEqual(['ti_failed', 'ti_marked'])
    })
  })

  describe('deleteOrphanedUpstreamSubscription', () => {
    it('deletes under the recorded minting member and sets the marker', async () => {
      const triggerId = await createComposioTrigger({ mintedByMemberId: 'sub_minted' })
      await cancelWebhookTrigger(triggerId)
      const [orphan] = listOwedUpstreamTeardowns()

      expect(await deleteOrphanedUpstreamSubscription(orphan)).toBe(true)

      expect(mockDeleteComposioTrigger).toHaveBeenCalledWith('ti_composio_1')
      expect(deleteAttributionKey).toBe('member:sub_minted')
      expect((await getWebhookTrigger(triggerId))!.upstreamDeletedAt).toBeInstanceOf(Date)
    })

    it('falls back to the creator chain for pre-column rows', async () => {
      await insertUser('user-creator')
      await insertPlatformAccount('user-creator', 'sub_creator')
      const triggerId = await createComposioTrigger({ createdByUserId: 'user-creator' })
      await cancelWebhookTrigger(triggerId)

      expect(await deleteOrphanedUpstreamSubscription((await getWebhookTrigger(triggerId))!)).toBe(true)

      expect(deleteAttributionKey).toBe('member:sub_creator')
    })

    it('throws UpstreamOwnerUnresolvedError when every guessed member 404s, leaving the marker null', async () => {
      await insertUser('user-creator')
      await insertPlatformAccount('user-creator', 'sub_creator')
      mockDeleteComposioTrigger.mockRejectedValue(new ComposioTriggerError('Trigger not found', 404))
      const triggerId = await createComposioTrigger({ createdByUserId: 'user-creator' })
      await cancelWebhookTrigger(triggerId)

      await expect(
        deleteOrphanedUpstreamSubscription((await getWebhookTrigger(triggerId))!),
      ).rejects.toBeInstanceOf(UpstreamOwnerUnresolvedError)

      expect((await getWebhookTrigger(triggerId))!.upstreamDeletedAt).toBeNull()
    })

    it('rethrows other failures and leaves the marker null', async () => {
      mockDeleteComposioTrigger.mockRejectedValue(new ComposioTriggerError('forbidden', 403))
      const triggerId = await createComposioTrigger({ mintedByMemberId: 'sub_minted' })
      await cancelWebhookTrigger(triggerId)

      await expect(
        deleteOrphanedUpstreamSubscription((await getWebhookTrigger(triggerId))!),
      ).rejects.toThrow('forbidden')

      expect((await getWebhookTrigger(triggerId))!.upstreamDeletedAt).toBeNull()
    })

    it('skips when the upstream id was re-subscribed since the scan', async () => {
      const triggerId = await createComposioTrigger({ mintedByMemberId: 'sub_minted' })
      await cancelWebhookTrigger(triggerId)
      const [orphan] = listOwedUpstreamTeardowns()
      // Same-slug re-enable gets the same upstream id back.
      await createComposioTrigger({ mintedByMemberId: 'sub_minted' })

      expect(await deleteOrphanedUpstreamSubscription(orphan)).toBe(false)

      expect(mockDeleteComposioTrigger).not.toHaveBeenCalled()
      expect((await getWebhookTrigger(triggerId))!.upstreamDeletedAt).toBeNull()
    })

    it('skips composio rows when platform Composio is inactive', async () => {
      mockIsPlatformComposioActive.mockReturnValue(false)
      const triggerId = await createComposioTrigger({ mintedByMemberId: 'sub_minted' })
      await cancelWebhookTrigger(triggerId)

      expect(await deleteOrphanedUpstreamSubscription((await getWebhookTrigger(triggerId))!)).toBe(false)

      expect(mockDeleteComposioTrigger).not.toHaveBeenCalled()
    })
  })

  describe('reconcileOrphanedUpstreamSubscriptions', () => {
    it('tears down every owed upstream, captures per-row failures, and converges', async () => {
      const ok = await createComposioTrigger({ composioTriggerId: 'ti_ok', mintedByMemberId: 'sub_a' })
      const bad = await createComposioTrigger({ composioTriggerId: 'ti_bad', mintedByMemberId: 'sub_b' })
      await cancelWebhookTrigger(ok)
      await cancelWebhookTrigger(bad)
      mockDeleteComposioTrigger.mockImplementation(async (id: string) => {
        if (id === 'ti_bad') throw new ComposioTriggerError('upstream 502', 502)
      })

      expect(await reconcileOrphanedUpstreamSubscriptions()).toBe(1)

      expect(mockCaptureException).toHaveBeenCalledTimes(1)
      expect((await getWebhookTrigger(ok))!.upstreamDeletedAt).toBeInstanceOf(Date)
      expect((await getWebhookTrigger(bad))!.upstreamDeletedAt).toBeNull()
      expect((await getWebhookTrigger(bad))!.upstreamTeardownAttempts).toBe(1)
      // Only the failed one is retried next pass.
      expect(listOwedUpstreamTeardowns().map((t) => t.composioTriggerId)).toEqual(['ti_bad'])
    })

    it('rotates a stuck row behind untried rows across passes (no head-of-line starvation)', async () => {
      // One persistently failing row plus a full batch of untried rows behind it.
      const stuck = await createComposioTrigger({ composioTriggerId: 'ti_stuck', mintedByMemberId: 'sub_a' })
      await cancelWebhookTrigger(stuck)
      const rest: string[] = []
      for (let i = 0; i < RECONCILE_BATCH_SIZE; i++) {
        const id = await createComposioTrigger({ composioTriggerId: `ti_${i}`, mintedByMemberId: 'sub_a' })
        await cancelWebhookTrigger(id)
        rest.push(id)
      }
      mockDeleteComposioTrigger.mockImplementation(async (id: string) => {
        if (id === 'ti_stuck') throw new ComposioTriggerError('forbidden', 403)
      })

      const first = await reconcileOrphanedUpstreamSubscriptions()
      const second = await reconcileOrphanedUpstreamSubscriptions()

      expect(first + second).toBe(RECONCILE_BATCH_SIZE)
      for (const id of rest) expect((await getWebhookTrigger(id))!.upstreamDeletedAt).toBeInstanceOf(Date)
      expect((await getWebhookTrigger(stuck))!.upstreamDeletedAt).toBeNull()
      expect(listOwedUpstreamTeardowns().map((t) => t.composioTriggerId)).toEqual(['ti_stuck'])
    })

    it('does nothing when there are no owed teardowns', async () => {
      await createComposioTrigger({ mintedByMemberId: 'sub_minted' })

      expect(await reconcileOrphanedUpstreamSubscriptions()).toBe(0)
      expect(mockDeleteComposioTrigger).not.toHaveBeenCalled()
    })
  })
})
