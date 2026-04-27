import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetPlatformAccessToken = vi.fn()
const mockGetPlatformAccountIdForUserId = vi.fn()
const mockGetOwnerAccountIdForProvider = vi.fn()

vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => mockGetPlatformAccessToken(),
}))

vi.mock('./member-lookup', () => ({
  getPlatformAccountIdForUserId: (...args: unknown[]) => mockGetPlatformAccountIdForUserId(...args),
  getOwnerAccountIdForProvider: (...args: unknown[]) => mockGetOwnerAccountIdForProvider(...args),
}))

import { attribution } from './attribution'
import { runWithRequestUser } from './request-context'

function buildOrgToken(orgId: string): string {
  const header = Buffer.from('{"alg":"none"}').toString('base64url')
  const payload = Buffer.from(JSON.stringify({ orgId })).toString('base64url')
  return `${header}.${payload}.sig`
}

const ORG_TOKEN = buildOrgToken('org_test_123')
const ACCESS_KEY = 'opaque_access_key_xyz'

describe('attribution factories', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetPlatformAccessToken.mockReturnValue(ORG_TOKEN)
    mockGetPlatformAccountIdForUserId.mockReturnValue('sub_user_123')
    mockGetOwnerAccountIdForProvider.mockReturnValue('sub_owner_123')
  })

  describe('fromCurrentRequest', () => {
    it('resolves the acting user from AsyncLocalStorage', async () => {
      await runWithRequestUser('user_request_xyz', () => {
        const auth = attribution.fromCurrentRequest()
        const headers = new Headers()
        auth?.applyTo(headers)

        expect(mockGetPlatformAccountIdForUserId).toHaveBeenCalledWith('user_request_xyz')
        expect(headers.get('X-Platform-Member-Id')).toBe('sub_user_123')
        expect(auth?.getKey()).toBe('member:sub_user_123')
      })
    })

    it('returns null when called outside a request scope', () => {
      // No silent fallback -- prevents cross-tenant leak via "latest user".
      expect(attribution.fromCurrentRequest()).toBeNull()
      expect(mockGetPlatformAccountIdForUserId).not.toHaveBeenCalled()
    })
  })

  describe('fromAgentOwner', () => {
    it('attributes to the agent owner', () => {
      const auth = attribution.fromAgentOwner('agent-x')
      const headers = new Headers()
      auth?.applyTo(headers)

      expect(mockGetOwnerAccountIdForProvider).toHaveBeenCalledWith('agent-x', 'platform')
      expect(headers.get('X-Platform-Member-Id')).toBe('sub_owner_123')
    })

    it('returns null on org-scoped installs where the agent has no owner mapping', () => {
      mockGetOwnerAccountIdForProvider.mockReturnValue(null)
      expect(attribution.fromAgentOwner('agent-orphan')).toBeNull()
    })
  })

  describe('fromResourceCreator', () => {
    it('translates the connection creator userId into a platform member id', () => {
      const auth = attribution.fromResourceCreator('user_alice')
      const headers = new Headers()
      auth?.applyTo(headers)

      expect(mockGetPlatformAccountIdForUserId).toHaveBeenCalledWith('user_alice')
      expect(headers.get('X-Platform-Member-Id')).toBe('sub_user_123')
    })

    it('returns null when the creator is missing (orphaned resource)', () => {
      expect(attribution.fromResourceCreator(null)).toBeNull()
    })
  })

  describe('access-key path', () => {
    it('omits the member header for opaque tokens even when memberId resolves', () => {
      mockGetPlatformAccessToken.mockReturnValue(ACCESS_KEY)
      const auth = attribution.fromAgentOwner('agent-x')
      const headers = new Headers()
      auth?.applyTo(headers)

      expect(headers.get('Authorization')).toBe(`Bearer ${ACCESS_KEY}`)
      // Proxy reconstructs memberId from the access_key row; sending the
      // header would be dead noise + wire-format delta from main.
      expect(headers.get('X-Platform-Member-Id')).toBeNull()
      expect(auth?.getKey()).toBe('access_key')
    })

    it('builds an attribution even when memberId is null on access-key tokens', () => {
      mockGetPlatformAccessToken.mockReturnValue(ACCESS_KEY)
      mockGetPlatformAccountIdForUserId.mockReturnValue(null)
      // Single-user installs may have no platform-linked authAccount row;
      // access-key path doesn't need one because the proxy reads memberId
      // from the access_key DB row.
      const auth = attribution.fromResourceCreator('local')
      expect(auth).not.toBeNull()
      expect(auth?.getKey()).toBe('access_key')
    })
  })

  describe('org-scoped + missing member', () => {
    it('refuses to construct attribution when memberId is null on org-scoped tokens', () => {
      // Producing one would (a) 401 the proxy on member-required routes
      // and (b) collapse orphan resources onto the same `'org'` lane.
      mockGetOwnerAccountIdForProvider.mockReturnValue(null)
      expect(attribution.fromAgentOwner('agent-orphan')).toBeNull()
    })
  })

  describe('toExtraHeaderEntries', () => {
    it('omits Authorization (bearer rides via the side channel)', () => {
      const auth = attribution.fromAgentOwner('agent-x')
      expect(auth?.toExtraHeaderEntries()).toEqual([
        ['X-Platform-Member-Id', 'sub_owner_123'],
      ])
    })

    it('returns empty for access-key tokens', () => {
      mockGetPlatformAccessToken.mockReturnValue(ACCESS_KEY)
      const auth = attribution.fromAgentOwner('agent-x')
      expect(auth?.toExtraHeaderEntries()).toEqual([])
    })
  })

  it('returns null when no platform token is configured', () => {
    mockGetPlatformAccessToken.mockReturnValue(null)
    expect(attribution.fromCurrentRequest()).toBeNull()
    expect(attribution.fromAgentOwner('agent-x')).toBeNull()
    expect(attribution.fromResourceCreator('user_alice')).toBeNull()
  })
})
