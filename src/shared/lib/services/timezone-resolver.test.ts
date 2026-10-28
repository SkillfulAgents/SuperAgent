import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies before importing
const mockIsAuthMode = vi.fn()
const mockGetUserTimezone = vi.fn()
const mockDbAll = vi.fn()

vi.mock('@shared/lib/auth/mode', () => ({
  isAuthMode: () => mockIsAuthMode(),
}))

vi.mock('@shared/lib/services/user-settings-service', () => ({
  getUserTimezone: (userId: string) => mockGetUserTimezone(userId),
}))

vi.mock('@shared/lib/db', () => {
  const chainable = {
    select: () => chainable,
    from: () => chainable,
    where: () => chainable,
    orderBy: () => chainable,
    limit: () => chainable,
    all: () => mockDbAll(),
  }
  return { db: chainable }
})

vi.mock('@shared/lib/db/schema', () => ({
  agentAcl: {
    userId: 'user_id',
    agentSlug: 'agent_slug',
    role: 'role',
    createdAt: 'created_at',
  },
}))

vi.mock('drizzle-orm', () => ({
  eq: (a: string, b: string) => `${a}=${b}`,
  and: (...args: string[]) => args.join(' AND '),
  asc: (col: string) => `asc(${col})`,
}))

import { resolveTimezoneForAgent } from './timezone-resolver'

describe('resolveTimezoneForAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns local user timezone in non-auth mode', async () => {
    mockIsAuthMode.mockReturnValue(false)
    mockGetUserTimezone.mockReturnValue('America/Chicago')

    const result = await resolveTimezoneForAgent('my-agent')

    expect(result).toBe('America/Chicago')
    expect(mockGetUserTimezone).toHaveBeenCalledWith('local')
  })

  it('returns agent owner timezone in auth mode', async () => {
    mockIsAuthMode.mockReturnValue(true)
    mockDbAll.mockReturnValue([{ userId: 'user-123' }])
    mockGetUserTimezone.mockReturnValue('Europe/London')

    const result = await resolveTimezoneForAgent('shared-agent')

    expect(result).toBe('Europe/London')
    expect(mockGetUserTimezone).toHaveBeenCalledWith('user-123')
  })

  it('falls back to system timezone when no owner found in auth mode', async () => {
    mockIsAuthMode.mockReturnValue(true)
    mockDbAll.mockReturnValue([])

    const result = await resolveTimezoneForAgent('orphan-agent')

    // Should be a valid IANA timezone string (system default or UTC)
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })
})
