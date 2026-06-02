import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => mockIsAuthMode }))
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAuthStatus: () => {
    if (mockStatusThrows) throw new Error('settings read failed')
    return { connected: mockConnected }
  },
  refreshStoredPlatformAccount: () => mockRefreshAccount(),
}))
vi.mock('@shared/lib/services/platform-billing-service', () => ({
  fetchPlatformBillingInfo: () => mockFetchBilling(),
}))

let mockIsAuthMode = false
let mockConnected = true
let mockStatusThrows = false
const mockRefreshAccount = vi.fn(async () => false)
const mockFetchBilling = vi.fn()

import { platformService } from './platform-service'

const SNAPSHOT = {
  configured: true,
  subscription: { status: 'active', paymentStatus: 'current', currentPeriodEnd: null },
  seat: { balanceCents: 1000, startingBalanceCents: 5000 },
  orgPool: { poolBalanceCents: 200 },
}

describe('PlatformService', () => {
  beforeEach(() => {
    mockIsAuthMode = false
    mockConnected = true
    mockStatusThrows = false
    mockRefreshAccount.mockClear()
    mockFetchBilling.mockReset()
    platformService.clearCache()
  })

  afterEach(() => {
    platformService.stop()
  })

  it('caches the billing snapshot in non-auth mode', async () => {
    mockFetchBilling.mockResolvedValue(SNAPSHOT)
    const result = await platformService.refreshBilling()
    expect(result).toEqual(SNAPSHOT)
    expect(platformService.getCachedBilling()).toEqual(SNAPSHOT)
  })

  it('does NOT cache billing in auth_mode (avoids cross-user leak)', async () => {
    mockIsAuthMode = true
    mockFetchBilling.mockResolvedValue(SNAPSHOT)
    const result = await platformService.refreshBilling()
    expect(result).toEqual(SNAPSHOT) // still returned to the caller
    expect(platformService.getCachedBilling()).toBeNull() // but never cached in the shared singleton
  })

  it('refresh() warms account + billing when connected', async () => {
    mockFetchBilling.mockResolvedValue(SNAPSHOT)
    await platformService.refresh()
    expect(mockRefreshAccount).toHaveBeenCalledOnce()
    expect(platformService.getCachedBilling()).toEqual(SNAPSHOT)
  })

  it('refresh() is a no-op and clears cache when disconnected', async () => {
    mockFetchBilling.mockResolvedValue(SNAPSHOT)
    await platformService.refreshBilling() // seed cache
    mockConnected = false
    await platformService.refresh()
    expect(mockRefreshAccount).not.toHaveBeenCalled()
    expect(platformService.getCachedBilling()).toBeNull()
  })

  it('onAuthChanged(false) clears the cache', async () => {
    mockFetchBilling.mockResolvedValue(SNAPSHOT)
    await platformService.refreshBilling()
    expect(platformService.getCachedBilling()).toEqual(SNAPSHOT)
    platformService.onAuthChanged(false)
    expect(platformService.getCachedBilling()).toBeNull()
  })

  it('refresh() swallows a billing fetch failure', async () => {
    mockFetchBilling.mockRejectedValue(new Error('boom'))
    await expect(platformService.refresh()).resolves.toBeUndefined()
  })

  it('refresh() never rejects even if the status read throws', async () => {
    mockStatusThrows = true
    await expect(platformService.refresh()).resolves.toBeUndefined()
  })
})
