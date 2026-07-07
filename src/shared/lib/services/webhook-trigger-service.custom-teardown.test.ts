/**
 * Custom-endpoint teardown must be gated on platform auth, not on the Composio
 * key mode: a user who configures their own Composio API key flips
 * `isPlatformComposioActive()` to false, but the platform proxy (where custom
 * endpoints live) is still reachable — cancelling must still disable the
 * public URL. Also covers the poll-set fallback for triggers with no derivable
 * member (minted from automated sessions, no connected account).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '../db/schema'

let testDb: ReturnType<typeof drizzle>
let testSqlite: InstanceType<typeof Database>

vi.mock('../db', async () => ({
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

const mockDeleteComposioTrigger = vi.fn().mockResolvedValue(undefined)
vi.mock('@shared/lib/composio/triggers', () => ({
  deleteComposioTrigger: (...args: unknown[]) => mockDeleteComposioTrigger(...args),
}))

const mockDisablePlatformWebhookEndpoint = vi.fn().mockResolvedValue(undefined)
vi.mock('@shared/lib/services/webhook-endpoints-client', () => ({
  disablePlatformWebhookEndpoint: (...args: unknown[]) =>
    mockDisablePlatformWebhookEndpoint(...args),
}))

const mockGetPlatformAccessToken = vi.fn()
const mockGetStoredPlatformMemberId = vi.fn()
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => mockGetPlatformAccessToken(),
  getStoredPlatformMemberId: () => mockGetStoredPlatformMemberId(),
}))

import {
  createWebhookTrigger,
  cancelWebhookTriggerWithCleanup,
  getDistinctPlatformMemberIdsForActiveTriggers,
} from './webhook-trigger-service'

describe('custom-endpoint teardown and poll scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    migrate(testDb, { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })
  })

  afterEach(() => {
    testSqlite?.close()
  })

  async function createCustomTrigger() {
    return createWebhookTrigger({
      agentSlug: 'agent-1',
      kind: 'custom',
      composioTriggerId: 'whep_11111111-2222-4333-8444-555555555555',
      triggerType: 'CUSTOM_WEBHOOK',
      prompt: 'Handle it',
      name: 'Custom endpoint',
    })
  }

  it('disables the platform endpoint even when a local Composio key is active', async () => {
    mockIsPlatformComposioActive.mockReturnValue(false) // user brought their own Composio key
    mockGetPlatformAccessToken.mockReturnValue('opaque_token')
    mockGetStoredPlatformMemberId.mockReturnValue('sub_stored')

    const triggerId = await createCustomTrigger()
    const cancelled = await cancelWebhookTriggerWithCleanup(triggerId)

    expect(cancelled).toBe(true)
    expect(mockDisablePlatformWebhookEndpoint).toHaveBeenCalledWith(
      'sub_stored',
      'whep_11111111-2222-4333-8444-555555555555',
    )
    expect(mockDeleteComposioTrigger).not.toHaveBeenCalled()
  })

  it('refuses to cancel a trigger owned by a different agent when scoped', async () => {
    mockIsPlatformComposioActive.mockReturnValue(false)
    mockGetPlatformAccessToken.mockReturnValue('opaque_token')
    mockGetStoredPlatformMemberId.mockReturnValue('sub_stored')

    const triggerId = await createCustomTrigger() // owned by agent-1

    // agent-2 must not be able to cancel (and disable the public endpoint of)
    // agent-1's trigger by id.
    const cancelled = await cancelWebhookTriggerWithCleanup(triggerId, 'agent-2')

    expect(cancelled).toBe(false)
    expect(mockDisablePlatformWebhookEndpoint).not.toHaveBeenCalled()
  })

  it('cancels when the scoping agent owns the trigger', async () => {
    mockIsPlatformComposioActive.mockReturnValue(false)
    mockGetPlatformAccessToken.mockReturnValue('opaque_token')
    mockGetStoredPlatformMemberId.mockReturnValue('sub_stored')

    const triggerId = await createCustomTrigger() // owned by agent-1
    const cancelled = await cancelWebhookTriggerWithCleanup(triggerId, 'agent-1')

    expect(cancelled).toBe(true)
    expect(mockDisablePlatformWebhookEndpoint).toHaveBeenCalledWith(
      'sub_stored',
      'whep_11111111-2222-4333-8444-555555555555',
    )
  })

  it('skips the platform call when there is no platform auth at all', async () => {
    mockIsPlatformComposioActive.mockReturnValue(false)
    mockGetPlatformAccessToken.mockReturnValue(null)

    const triggerId = await createCustomTrigger()
    const cancelled = await cancelWebhookTriggerWithCleanup(triggerId)

    expect(cancelled).toBe(true)
    expect(mockDisablePlatformWebhookEndpoint).not.toHaveBeenCalled()
  })

  it('still gates composio-kind teardown on isPlatformComposioActive', async () => {
    mockIsPlatformComposioActive.mockReturnValue(false)
    mockGetPlatformAccessToken.mockReturnValue('opaque_token')

    const triggerId = await createWebhookTrigger({
      agentSlug: 'agent-1',
      composioTriggerId: 'ti_composio_1',
      connectedAccountId: 'ca_1',
      triggerType: 'GMAIL_NEW_EMAIL',
      prompt: 'Handle it',
    })
    await cancelWebhookTriggerWithCleanup(triggerId)

    expect(mockDeleteComposioTrigger).not.toHaveBeenCalled()
    expect(mockDisablePlatformWebhookEndpoint).not.toHaveBeenCalled()
  })

  it('falls back to the stored member for triggers with no derivable member', async () => {
    mockGetStoredPlatformMemberId.mockReturnValue('sub_stored')

    // No createdByUserId, no connected account — e.g. minted from a
    // trigger-spawned session. The mint fell back to the stored member, so the
    // poll set must include it or the trigger never fires in acting-member mode.
    await createCustomTrigger()

    expect(getDistinctPlatformMemberIdsForActiveTriggers()).toEqual(['sub_stored'])
  })

  it('omits unresolvable triggers from the poll set when no member is stored', async () => {
    mockGetStoredPlatformMemberId.mockReturnValue(null)

    await createCustomTrigger()

    expect(getDistinctPlatformMemberIdsForActiveTriggers()).toEqual([])
  })
})
