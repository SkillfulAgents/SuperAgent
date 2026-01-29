import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the DB module
const mockFrom = vi.fn()
const mockDelete = vi.fn()
const mockWhere = vi.fn()
const mockLimit = vi.fn()
const mockValues = vi.fn()

vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({ from: mockFrom }),
    insert: () => ({ values: mockValues }),
    delete: () => ({ where: mockDelete }),
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  proxyTokens: { agentSlug: 'agent_slug', token: 'token' },
}))

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: string) => ({ col, val }),
}))

// Must import after mocks
import { getOrCreateProxyToken, validateProxyToken, revokeProxyToken } from './token-store'

describe('token-store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getOrCreateProxyToken', () => {
    it('returns existing token if one exists', async () => {
      mockFrom.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ limit: mockLimit })
      mockLimit.mockResolvedValue([{ token: 'synth_existing123' }])

      const token = await getOrCreateProxyToken('my-agent')
      expect(token).toBe('synth_existing123')
      expect(mockValues).not.toHaveBeenCalled()
    })

    it('creates new token if none exists', async () => {
      mockFrom.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ limit: mockLimit })
      mockLimit.mockResolvedValue([])
      mockValues.mockResolvedValue(undefined)

      const token = await getOrCreateProxyToken('new-agent')
      expect(token).toMatch(/^synth_[0-9a-f]{64}$/)
      expect(mockValues).toHaveBeenCalledOnce()
    })
  })

  describe('validateProxyToken', () => {
    it('returns agentSlug for valid token', async () => {
      mockFrom.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ limit: mockLimit })
      mockLimit.mockResolvedValue([{ agentSlug: 'my-agent' }])

      const result = await validateProxyToken('synth_valid')
      expect(result).toBe('my-agent')
    })

    it('returns null for invalid token', async () => {
      mockFrom.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ limit: mockLimit })
      mockLimit.mockResolvedValue([])

      const result = await validateProxyToken('synth_invalid')
      expect(result).toBeNull()
    })
  })

  describe('revokeProxyToken', () => {
    it('deletes the token for the agent', async () => {
      mockDelete.mockResolvedValue(undefined)

      await revokeProxyToken('my-agent')
      expect(mockDelete).toHaveBeenCalledOnce()
    })
  })
})
