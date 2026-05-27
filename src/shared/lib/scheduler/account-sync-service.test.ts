import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockWhere = vi.fn()
const mockUpdate = vi.fn()
const mockSet = vi.fn()
const mockUpdateWhere = vi.fn()
const mockInsert = vi.fn()
const mockValues = vi.fn()
const mockOnConflictDoNothing = vi.fn()

vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: (...args: unknown[]) => mockWhere(...args) }) }),
    update: (...args: unknown[]) => {
      mockUpdate(...args)
      return { set: (...sArgs: unknown[]) => { mockSet(...sArgs); return { where: (...wArgs: unknown[]) => mockUpdateWhere(...wArgs) } } }
    },
    insert: (...args: unknown[]) => {
      mockInsert(...args)
      return { values: (...vArgs: unknown[]) => { mockValues(...vArgs); return { onConflictDoNothing: () => mockOnConflictDoNothing() } } }
    },
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  connectedAccounts: { id: 'id', providerName: 'provider_name', status: 'status' },
}))

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: string) => ({ col, val }),
}))

const mockListConnections = vi.fn()
const mockGetAccountDisplayName = vi.fn()
const mockProvider = {
  name: 'composio',
  listConnections: (...args: unknown[]) => mockListConnections(...args),
  getAccountDisplayName: (...args: unknown[]) => mockGetAccountDisplayName(...args),
}

vi.mock('@shared/lib/account-providers', () => ({
  getRegisteredProviders: () => [mockProvider],
}))

vi.mock('@shared/lib/account-providers/service-catalog', () => ({
  getProvider: (slug: string) => ({ slug, displayName: slug.charAt(0).toUpperCase() + slug.slice(1) }),
}))

vi.mock('@shared/lib/config/settings', () => ({
  getAccountProviderUserId: () => 'test-user',
}))

// Import after mocks
const { accountSyncService } = await import('./account-sync-service')

describe('AccountSyncService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockOnConflictDoNothing.mockResolvedValue(undefined)
    mockUpdateWhere.mockResolvedValue(undefined)
  })

  afterEach(() => {
    accountSyncService.stop()
  })

  describe('syncAll', () => {
    it('marks local accounts as revoked when remote connection is missing', async () => {
      mockListConnections.mockResolvedValue([])
      mockWhere.mockResolvedValue([
        { id: 'local-1', providerConnectionId: 'conn-1', providerName: 'composio', status: 'active', toolkitSlug: 'gmail' },
      ])

      await accountSyncService.syncAll()

      expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'revoked' }))
    })

    it('marks local account as expired when remote status is EXPIRED', async () => {
      mockListConnections.mockResolvedValue([
        { id: 'conn-1', status: 'EXPIRED', toolkitSlug: 'gmail' },
      ])
      mockWhere.mockResolvedValue([
        { id: 'local-1', providerConnectionId: 'conn-1', providerName: 'composio', status: 'active', toolkitSlug: 'gmail' },
      ])

      await accountSyncService.syncAll()

      expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'expired' }))
    })

    it('marks local account as revoked when remote status is FAILED', async () => {
      mockListConnections.mockResolvedValue([
        { id: 'conn-1', status: 'FAILED', toolkitSlug: 'gmail' },
      ])
      mockWhere.mockResolvedValue([
        { id: 'local-1', providerConnectionId: 'conn-1', providerName: 'composio', status: 'active', toolkitSlug: 'gmail' },
      ])

      await accountSyncService.syncAll()

      expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'revoked' }))
    })

    it('restores local account to active when remote is ACTIVE but local is not', async () => {
      mockListConnections.mockResolvedValue([
        { id: 'conn-1', status: 'ACTIVE', toolkitSlug: 'gmail' },
      ])
      mockWhere.mockResolvedValue([
        { id: 'local-1', providerConnectionId: 'conn-1', providerName: 'composio', status: 'expired', toolkitSlug: 'gmail' },
      ])

      await accountSyncService.syncAll()

      expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }))
    })

    it('does not update when local and remote status match (both active)', async () => {
      mockListConnections.mockResolvedValue([
        { id: 'conn-1', status: 'ACTIVE', toolkitSlug: 'gmail' },
      ])
      mockWhere.mockResolvedValue([
        { id: 'local-1', providerConnectionId: 'conn-1', providerName: 'composio', status: 'active', toolkitSlug: 'gmail' },
      ])

      await accountSyncService.syncAll()

      expect(mockUpdate).not.toHaveBeenCalled()
    })

    it('adds remote ACTIVE connections missing from local DB', async () => {
      mockListConnections.mockResolvedValue([
        { id: 'conn-new', status: 'ACTIVE', toolkitSlug: 'slack' },
      ])
      mockWhere.mockResolvedValue([])
      mockGetAccountDisplayName.mockResolvedValue('work@slack.com')

      await accountSyncService.syncAll()

      expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({
        providerConnectionId: 'conn-new',
        providerName: 'composio',
        toolkitSlug: 'slack',
        displayName: 'work@slack.com',
        status: 'active',
      }))
    })

    it('does not add remote connections that are not ACTIVE', async () => {
      mockListConnections.mockResolvedValue([
        { id: 'conn-expired', status: 'EXPIRED', toolkitSlug: 'gmail' },
      ])
      mockWhere.mockResolvedValue([])

      await accountSyncService.syncAll()

      expect(mockInsert).not.toHaveBeenCalled()
    })

    it('skips INITIATED connections (OAuth in progress)', async () => {
      mockListConnections.mockResolvedValue([
        { id: 'conn-1', status: 'INITIATED', toolkitSlug: 'gmail' },
      ])
      mockWhere.mockResolvedValue([
        { id: 'local-1', providerConnectionId: 'conn-1', providerName: 'composio', status: 'active', toolkitSlug: 'gmail' },
      ])

      await accountSyncService.syncAll()

      expect(mockUpdate).not.toHaveBeenCalled()
    })

    it('does not skip already-revoked local accounts when remote is missing', async () => {
      mockListConnections.mockResolvedValue([])
      mockWhere.mockResolvedValue([
        { id: 'local-1', providerConnectionId: 'conn-1', providerName: 'composio', status: 'revoked', toolkitSlug: 'gmail' },
      ])

      await accountSyncService.syncAll()

      expect(mockUpdate).not.toHaveBeenCalled()
    })

    it('falls back to generic display name when getAccountDisplayName fails', async () => {
      mockListConnections.mockResolvedValue([
        { id: 'conn-new', status: 'ACTIVE', toolkitSlug: 'slack' },
      ])
      mockWhere.mockResolvedValue([])
      mockGetAccountDisplayName.mockRejectedValue(new Error('API error'))

      await accountSyncService.syncAll()

      expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({
        displayName: 'Slack',
      }))
    })

    it('continues syncing other providers when one fails', async () => {
      mockListConnections.mockRejectedValue(new Error('Network error'))
      mockWhere.mockResolvedValue([])

      await expect(accountSyncService.syncAll()).resolves.not.toThrow()
    })

    it('passes userId to listConnections', async () => {
      mockListConnections.mockResolvedValue([])
      mockWhere.mockResolvedValue([])

      await accountSyncService.syncAll()

      expect(mockListConnections).toHaveBeenCalledWith('test-user')
    })
  })
})
