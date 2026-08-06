import { afterEach, describe, expect, it, vi } from 'vitest'

const mockIsPlatformControlledAuth = vi.hoisted(() => vi.fn(() => false))
const mockRun = vi.hoisted(() => vi.fn(() => ({ changes: 0 })))
const mockWhere = vi.hoisted(() => vi.fn(() => ({ run: mockRun })))
const mockSet = vi.hoisted(() => vi.fn(() => ({ where: mockWhere })))
const mockUpdate = vi.hoisted(() => vi.fn(() => ({ set: mockSet })))

vi.mock('./auth-settings', () => ({
  isPlatformControlledAuth: () => mockIsPlatformControlledAuth(),
}))

vi.mock('@shared/lib/db', () => ({
  db: { update: mockUpdate },
}))

vi.mock('@shared/lib/db/schema', () => ({
  user: { banned: 'banned', banReason: 'ban_reason' },
}))

import { clearPendingApprovalBans, PENDING_APPROVAL_BAN_REASON } from './clear-pending-approval-bans'

describe('clearPendingApprovalBans', () => {
  afterEach(() => {
    mockIsPlatformControlledAuth.mockReturnValue(false)
    mockRun.mockReset().mockReturnValue({ changes: 0 })
    mockWhere.mockClear()
    mockSet.mockClear()
    mockUpdate.mockClear()
  })

  it('is a no-op when not platform-controlled', () => {
    expect(clearPendingApprovalBans()).toBe(0)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('clears pending-approval bans when platform-controlled', () => {
    mockIsPlatformControlledAuth.mockReturnValue(true)
    mockRun.mockReturnValue({ changes: 2 })
    expect(clearPendingApprovalBans()).toBe(2)
    expect(mockUpdate).toHaveBeenCalled()
    expect(mockSet).toHaveBeenCalledWith({ banned: false, banReason: null })
    expect(PENDING_APPROVAL_BAN_REASON).toBe('Pending admin approval')
  })
})
