import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Context } from 'hono'

// Mock the two primitives the helpers gate on.
const { mockIsAuthMode, mockGetCurrentUserId } = vi.hoisted(() => ({
  mockIsAuthMode: vi.fn<() => boolean>(),
  mockGetCurrentUserId: vi.fn<(c: Context) => string>(),
}))
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: mockIsAuthMode }))
vi.mock('@shared/lib/auth/config', () => ({ getCurrentUserId: mockGetCurrentUserId }))

import { getViewerUserId, ownerScope, isOwnedByCaller } from './ownership'
import { connectedAccounts } from '@shared/lib/db/schema'

const c = {} as Context

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getViewerUserId', () => {
  it('returns null without reading user context in non-auth mode', () => {
    mockIsAuthMode.mockReturnValue(false)
    expect(getViewerUserId(c)).toBeNull()
    expect(mockGetCurrentUserId).not.toHaveBeenCalled()
  })

  it('returns the acting user in auth mode', () => {
    mockIsAuthMode.mockReturnValue(true)
    mockGetCurrentUserId.mockReturnValue('user-123')
    expect(getViewerUserId(c)).toBe('user-123')
    expect(mockGetCurrentUserId).toHaveBeenCalledWith(c)
  })
})

describe('ownerScope', () => {
  it('returns undefined in non-auth mode (no scoping, getCurrentUserId not called)', () => {
    mockIsAuthMode.mockReturnValue(false)
    expect(ownerScope(c, connectedAccounts.userId)).toBeUndefined()
    expect(mockGetCurrentUserId).not.toHaveBeenCalled()
  })

  it('returns a WHERE fragment scoped to the acting user in auth mode', () => {
    mockIsAuthMode.mockReturnValue(true)
    mockGetCurrentUserId.mockReturnValue('user-123')
    const scope = ownerScope(c, connectedAccounts.userId)
    expect(scope).toBeDefined()
    expect(mockGetCurrentUserId).toHaveBeenCalledWith(c)
  })
})

describe('isOwnedByCaller', () => {
  it('is true in non-auth mode regardless of record owner', () => {
    mockIsAuthMode.mockReturnValue(false)
    expect(isOwnedByCaller(c, { userId: 'someone-else' })).toBe(true)
    expect(mockGetCurrentUserId).not.toHaveBeenCalled()
  })

  it('is true in auth mode when the record belongs to the acting user', () => {
    mockIsAuthMode.mockReturnValue(true)
    mockGetCurrentUserId.mockReturnValue('user-123')
    expect(isOwnedByCaller(c, { userId: 'user-123' })).toBe(true)
  })

  it('is false in auth mode when the record belongs to another user', () => {
    mockIsAuthMode.mockReturnValue(true)
    mockGetCurrentUserId.mockReturnValue('user-123')
    expect(isOwnedByCaller(c, { userId: 'attacker' })).toBe(false)
  })

  it('is false in auth mode for a null/undefined record or missing userId', () => {
    mockIsAuthMode.mockReturnValue(true)
    mockGetCurrentUserId.mockReturnValue('user-123')
    expect(isOwnedByCaller(c, null)).toBe(false)
    expect(isOwnedByCaller(c, undefined)).toBe(false)
    expect(isOwnedByCaller(c, { userId: null })).toBe(false)
  })
})
