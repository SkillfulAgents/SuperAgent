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

// Status-carrying error shapes the service uses to recognise a 404.
const { MockComposioTriggerError, MockWebhookEndpointsApiError } = vi.hoisted(() => {
  class MockComposioTriggerError extends Error {
    constructor(message: string, public statusCode: number) {
      super(message)
    }
  }
  class MockWebhookEndpointsApiError extends Error {
    constructor(message: string, public statusCode: number) {
      super(message)
    }
  }
  return { MockComposioTriggerError, MockWebhookEndpointsApiError }
})

const mockDeleteComposioTrigger = vi.fn()
vi.mock('@shared/lib/composio/triggers', () => ({
  ComposioTriggerError: MockComposioTriggerError,
  deleteComposioTrigger: (...args: unknown[]) => mockDeleteComposioTrigger(...args),
}))

const mockDisableEndpoint = vi.fn()
vi.mock('@shared/lib/services/webhook-endpoints-client', () => ({
  WebhookEndpointsApiError: MockWebhookEndpointsApiError,
  disablePlatformWebhookEndpoint: (...args: unknown[]) => mockDisableEndpoint(...args),
}))

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
import {
  createWebhookTrigger,
  cancelWebhookTriggerWithCleanup,
  cancelWebhookTrigger,
  getWebhookTrigger,
  markTriggerFailed,
  listOrphanedUpstreamTriggers,
  deleteOrphanedUpstreamSubscription,
  reconcileOrphanedUpstreamSubscriptions,
} from './webhook-trigger-service'

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

  describe('upstreamDeletedAt marker', () => {
    it('is set by a successful teardown so the row is not reconciled again', async () => {
      const triggerId = await createComposioTrigger({ mintedByMemberId: 'sub_minted' })

      await cancelWebhookTriggerWithCleanup(triggerId)

      expect((await getWebhookTrigger(triggerId))!.upstreamDeletedAt).toBeInstanceOf(Date)
      expect(listOrphanedUpstreamTriggers()).toEqual([])
    })

    it('is set when the upstream is already gone (404)', async () => {
      mockDeleteComposioTrigger.mockRejectedValue(new MockComposioTriggerError('Trigger not found', 404))
      const triggerId = await createComposioTrigger({ mintedByMemberId: 'sub_minted' })

      expect(await cancelWebhookTriggerWithCleanup(triggerId)).toBe(true)

      expect((await getWebhookTrigger(triggerId))!.upstreamDeletedAt).toBeInstanceOf(Date)
      expect(mockCaptureException).not.toHaveBeenCalled()
    })

    it('stays null when the teardown fails for any other reason', async () => {
      mockDeleteComposioTrigger.mockRejectedValue(new MockComposioTriggerError('upstream 502', 502))
      const triggerId = await createComposioTrigger({ mintedByMemberId: 'sub_minted' })

      expect(await cancelWebhookTriggerWithCleanup(triggerId)).toBe(true)

      expect((await getWebhookTrigger(triggerId))!.upstreamDeletedAt).toBeNull()
      expect(mockCaptureException).toHaveBeenCalledTimes(1)
      expect(listOrphanedUpstreamTriggers().map((t) => t.id)).toEqual([triggerId])
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
  describe('listOrphanedUpstreamTriggers', () => {
    it('selects terminal rows with an upstream id and no marker, one per upstream id', async () => {
      const cancelled = await createComposioTrigger({ composioTriggerId: 'ti_a' })
      await cancelWebhookTrigger(cancelled)
      const failed = await createComposioTrigger({ composioTriggerId: 'ti_b' })
      await markTriggerFailed(failed, 'Agent no longer exists')
      const preColumn = await createComposioTrigger({ composioTriggerId: 'ti_c' })
      const minted = await createComposioTrigger({ composioTriggerId: 'ti_c', mintedByMemberId: 'sub_minted' })
      await cancelWebhookTrigger(preColumn)
      await cancelWebhookTrigger(minted)

      const orphans = listOrphanedUpstreamTriggers()

      expect(orphans.map((t) => t.composioTriggerId).sort()).toEqual(['ti_a', 'ti_b', 'ti_c'])
      // The row carrying the minting member represents the shared id.
      expect(orphans.find((t) => t.composioTriggerId === 'ti_c')!.id).toBe(minted)
    })

    it('excludes ids still held by an active or paused row', async () => {
      const cancelled = await createComposioTrigger({ composioTriggerId: 'ti_live' })
      await createComposioTrigger({ composioTriggerId: 'ti_live' })
      await cancelWebhookTrigger(cancelled)

      expect(listOrphanedUpstreamTriggers()).toEqual([])
    })

    it('excludes active rows and rows without an upstream id', async () => {
      await createComposioTrigger({ composioTriggerId: 'ti_active' })
      const noUpstream = await createWebhookTrigger({
        agentSlug: 'agent-1',
        triggerType: 'GMAIL_NEW_EMAIL',
        prompt: 'Handle it',
      })
      await cancelWebhookTrigger(noUpstream)

      expect(listOrphanedUpstreamTriggers()).toEqual([])
    })
  })

  describe('deleteOrphanedUpstreamSubscription', () => {
    it('deletes under the recorded minting member and sets the marker', async () => {
      const triggerId = await createComposioTrigger({ mintedByMemberId: 'sub_minted' })
      await cancelWebhookTrigger(triggerId)
      const [orphan] = listOrphanedUpstreamTriggers()

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

    it('treats a 404 as already gone', async () => {
      mockDeleteComposioTrigger.mockRejectedValue(new MockComposioTriggerError('Trigger not found', 404))
      const triggerId = await createComposioTrigger({ mintedByMemberId: 'sub_minted' })
      await cancelWebhookTrigger(triggerId)

      expect(await deleteOrphanedUpstreamSubscription((await getWebhookTrigger(triggerId))!)).toBe(true)

      expect((await getWebhookTrigger(triggerId))!.upstreamDeletedAt).toBeInstanceOf(Date)
    })

    it('treats a custom-endpoint 404 as already gone', async () => {
      mockDisableEndpoint.mockRejectedValue(new MockWebhookEndpointsApiError('API error 404', 404))
      const triggerId = await createWebhookTrigger({
        agentSlug: 'agent-1',
        kind: 'custom',
        composioTriggerId: 'whep_1',
        triggerType: 'CUSTOM_WEBHOOK',
        prompt: 'Handle it',
        mintedByMemberId: 'sub_minted',
      })
      await cancelWebhookTrigger(triggerId)

      expect(await deleteOrphanedUpstreamSubscription((await getWebhookTrigger(triggerId))!)).toBe(true)

      expect(mockDisableEndpoint).toHaveBeenCalledWith('sub_minted', 'whep_1')
      expect((await getWebhookTrigger(triggerId))!.upstreamDeletedAt).toBeInstanceOf(Date)
    })

    it('rethrows other failures and leaves the marker null', async () => {
      mockDeleteComposioTrigger.mockRejectedValue(new MockComposioTriggerError('forbidden', 403))
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
      const [orphan] = listOrphanedUpstreamTriggers()
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
    it('tears down every orphan, captures per-row failures, and converges', async () => {
      const ok = await createComposioTrigger({ composioTriggerId: 'ti_ok', mintedByMemberId: 'sub_a' })
      const bad = await createComposioTrigger({ composioTriggerId: 'ti_bad', mintedByMemberId: 'sub_b' })
      await cancelWebhookTrigger(ok)
      await markTriggerFailed(bad, 'Agent no longer exists')
      mockDeleteComposioTrigger.mockImplementation(async (id: string) => {
        if (id === 'ti_bad') throw new MockComposioTriggerError('upstream 502', 502)
      })

      expect(await reconcileOrphanedUpstreamSubscriptions()).toBe(1)

      expect(mockCaptureException).toHaveBeenCalledTimes(1)
      expect((await getWebhookTrigger(ok))!.upstreamDeletedAt).toBeInstanceOf(Date)
      expect((await getWebhookTrigger(bad))!.upstreamDeletedAt).toBeNull()
      // Only the failed one is retried next pass.
      expect(listOrphanedUpstreamTriggers().map((t) => t.composioTriggerId)).toEqual(['ti_bad'])
    })

    it('does nothing when there are no orphans', async () => {
      await createComposioTrigger({ mintedByMemberId: 'sub_minted' })

      expect(await reconcileOrphanedUpstreamSubscriptions()).toBe(0)
      expect(mockDeleteComposioTrigger).not.toHaveBeenCalled()
    })
  })
})
