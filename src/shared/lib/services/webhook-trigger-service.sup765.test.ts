/**
 * Upstream teardown must run under the member that minted the subscription:
 * the proxy scopes DELETE to that member, so an ambient deleter identity 404s
 * on cross-member cleanup and silently orphans the upstream (SUP-765).
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
  getWebhookTrigger,
  resolveTeardownMembers,
  UpstreamOwnerUnresolvedError,
} from './webhook-trigger-service'
import { cleanupAgentData } from './agent-cleanup-service'

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
  agentSlug?: string
  createdByUserId?: string
  mintedByMemberId?: string
  connectedAccountId?: string
  composioTriggerId?: string
}) {
  return createWebhookTrigger({
    agentSlug: params.agentSlug ?? 'agent-1',
    composioTriggerId: params.composioTriggerId ?? 'ti_composio_1',
    connectedAccountId: params.connectedAccountId,
    triggerType: 'GOOGLECALENDAR_EVENT_CANCELED_DELETED_TRIGGER',
    prompt: 'Handle it',
    createdByUserId: params.createdByUserId,
    mintedByMemberId: params.mintedByMemberId,
  })
}

describe('upstream teardown attribution (SUP-765)', () => {
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

  // The SUP-765 incident path: DELETE /api/agents/:id → cleanupAgentData.
  it('tears down as the minting member when the agent is deleted', async () => {
    await insertUser('user-creator')
    await insertPlatformAccount('user-creator', 'sub_creator')
    const triggerId = await createComposioTrigger({
      agentSlug: 'doomed-agent',
      createdByUserId: 'user-creator',
      mintedByMemberId: 'sub_minted',
    })

    await cleanupAgentData('doomed-agent')

    expect((await getWebhookTrigger(triggerId))!.status).toBe('cancelled')
    expect(mockDeleteComposioTrigger).toHaveBeenCalledWith('ti_composio_1')
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
    it('is silent when the upstream is already gone under the recorded minting member', async () => {
      mockDeleteComposioTrigger.mockRejectedValue(new ComposioTriggerError('Trigger not found', 404))
      const triggerId = await createComposioTrigger({ mintedByMemberId: 'sub_minted' })

      expect(await cancelWebhookTriggerWithCleanup(triggerId)).toBe(true)

      expect(mockDeleteComposioTrigger).toHaveBeenCalledTimes(1)
      expect(mockCaptureException).not.toHaveBeenCalled()
    })

    it('is silent on a 404 in opaque-access-key mode (the proxy ignores members)', async () => {
      mockGetPlatformAccessToken.mockReturnValue('plat_sa_opaque_key')
      mockDeleteComposioTrigger.mockRejectedValue(new ComposioTriggerError('Trigger not found', 404))
      const triggerId = await createComposioTrigger({ createdByUserId: 'user-creator' })

      expect(await cancelWebhookTriggerWithCleanup(triggerId)).toBe(true)

      expect(mockCaptureException).not.toHaveBeenCalled()
    })

    it('tries the next guessed member after a 404 and stops on the one that succeeds', async () => {
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
      expect(mockCaptureException).not.toHaveBeenCalled()
    })

    it('reports an unresolved owner when every guessed member 404s', async () => {
      await insertUser('user-creator')
      await insertPlatformAccount('user-creator', 'sub_creator')
      mockGetStoredPlatformMemberId.mockReturnValue('sub_stored')
      mockDeleteComposioTrigger.mockRejectedValue(new ComposioTriggerError('Trigger not found', 404))
      const triggerId = await createComposioTrigger({ createdByUserId: 'user-creator' })

      expect(await cancelWebhookTriggerWithCleanup(triggerId)).toBe(true)

      expect(mockDeleteComposioTrigger).toHaveBeenCalledTimes(2)
      expect(mockCaptureException).toHaveBeenCalledTimes(1)
      expect(mockCaptureException.mock.calls[0][0]).toBeInstanceOf(UpstreamOwnerUnresolvedError)
    })

    it('stops at the first non-404 failure', async () => {
      await insertUser('user-creator')
      await insertPlatformAccount('user-creator', 'sub_creator')
      mockGetStoredPlatformMemberId.mockReturnValue('sub_stored')
      mockDeleteComposioTrigger.mockRejectedValue(new ComposioTriggerError('upstream 502', 502))
      const triggerId = await createComposioTrigger({ createdByUserId: 'user-creator' })

      expect(await cancelWebhookTriggerWithCleanup(triggerId)).toBe(true)

      expect(mockDeleteComposioTrigger).toHaveBeenCalledTimes(1)
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

      expect(mockCaptureException).not.toHaveBeenCalled()
    })
  })
})
