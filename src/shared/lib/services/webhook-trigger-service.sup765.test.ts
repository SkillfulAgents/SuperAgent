/**
 * Composio-kind teardown must run under the trigger creator's attribution:
 * the proxy scopes trigger DELETE to the subscription's Composio user (the
 * creator), so an ambient deleter identity 404s on cross-member cleanup and
 * silently orphans the upstream subscription (SUP-765).
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

vi.mock('@shared/lib/services/webhook-endpoints-client', () => ({
  disablePlatformWebhookEndpoint: vi.fn().mockResolvedValue(undefined),
}))

const mockGetPlatformAccessToken = vi.fn()
const mockGetStoredPlatformMemberId = vi.fn()
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => mockGetPlatformAccessToken(),
  getStoredPlatformMemberId: () => mockGetStoredPlatformMemberId(),
}))

const mockFromResourceCreator = vi.fn()
const mockRunWithAttribution = vi.fn(
  (auth: unknown, fn: () => Promise<unknown>) => fn(),
)
vi.mock('@shared/lib/platform-attribution', () => ({
  attribution: {
    fromResourceCreator: (...args: unknown[]) => mockFromResourceCreator(...args),
  },
  runWithAttribution: (auth: unknown, fn: () => Promise<unknown>) =>
    mockRunWithAttribution(auth, fn),
}))

import { createWebhookTrigger, cancelWebhookTriggerWithCleanup } from './webhook-trigger-service'

describe('composio teardown attribution (SUP-765)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsPlatformComposioActive.mockReturnValue(true)
    mockGetPlatformAccessToken.mockReturnValue('org_jwt')
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    migrate(testDb, { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })
  })

  afterEach(() => {
    testSqlite?.close()
  })

  async function createComposioTrigger(createdByUserId?: string) {
    return createWebhookTrigger({
      agentSlug: 'agent-1',
      composioTriggerId: 'ti_composio_1',
      connectedAccountId: 'ca_1',
      triggerType: 'GOOGLECALENDAR_EVENT_CANCELED_DELETED_TRIGGER',
      prompt: 'Handle it',
      createdByUserId,
    })
  }

  it('deletes the upstream subscription under the creator attribution', async () => {
    const creatorAuth = { key: 'creator' }
    mockFromResourceCreator.mockImplementation((userId: string | null) =>
      userId === 'user-creator' ? creatorAuth : null,
    )

    const triggerId = await createComposioTrigger('user-creator')
    const cancelled = await cancelWebhookTriggerWithCleanup(triggerId)

    expect(cancelled).toBe(true)
    expect(mockFromResourceCreator).toHaveBeenCalledWith('user-creator')
    expect(mockRunWithAttribution).toHaveBeenCalledWith(creatorAuth, expect.any(Function))
    expect(mockDeleteComposioTrigger).toHaveBeenCalledWith('ti_composio_1')
  })

  it('falls back to the connected-account owner when the creator does not resolve', async () => {
    const ownerAuth = { key: 'owner' }
    mockFromResourceCreator.mockImplementation((userId: string | null) =>
      userId === 'user-owner' ? ownerAuth : null,
    )
    await testDb.insert(schema.connectedAccounts).values({
      id: 'ca_1',
      providerConnectionId: 'pc_1',
      toolkitSlug: 'googlecalendar',
      displayName: 'Calendar',
      userId: 'user-owner',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const triggerId = await createComposioTrigger('user-deleted')
    const cancelled = await cancelWebhookTriggerWithCleanup(triggerId)

    expect(cancelled).toBe(true)
    expect(mockFromResourceCreator).toHaveBeenNthCalledWith(1, 'user-deleted')
    expect(mockFromResourceCreator).toHaveBeenNthCalledWith(2, 'user-owner')
    expect(mockRunWithAttribution).toHaveBeenCalledWith(ownerAuth, expect.any(Function))
    expect(mockDeleteComposioTrigger).toHaveBeenCalledWith('ti_composio_1')
  })

  it('keeps the ambient attribution when neither creator nor owner resolves', async () => {
    mockFromResourceCreator.mockReturnValue(null)

    const triggerId = await createComposioTrigger()
    const cancelled = await cancelWebhookTriggerWithCleanup(triggerId)

    expect(cancelled).toBe(true)
    expect(mockRunWithAttribution).toHaveBeenCalledWith(null, expect.any(Function))
    expect(mockDeleteComposioTrigger).toHaveBeenCalledWith('ti_composio_1')
  })
})
