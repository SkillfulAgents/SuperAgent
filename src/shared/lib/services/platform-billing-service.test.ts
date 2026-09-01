import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: () => mockProxyBase,
}))
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => mockToken,
}))

let mockProxyBase = 'http://proxy.test'
let mockToken: string | null = 'plat_sa_token'

import {
  confirmPlatformPaymentMethod,
  fetchPlatformBillingInfo,
  postPlatformTopup,
  startPlatformPaymentMethodSetup,
} from './platform-billing-service'
import { PlatformRequestError } from '@shared/lib/platform-auth/platform-fetch'

const VALID_SNAPSHOT = {
  configured: true,
  subscription: { status: 'active', paymentStatus: 'current', currentPeriodEnd: '2026-06-01T00:00:00Z' },
  seat: { balanceCents: 3000, startingBalanceCents: 5000 },
  orgPool: { poolBalanceCents: 12345 },
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('fetchPlatformBillingInfo', () => {
  beforeEach(() => {
    mockProxyBase = 'http://proxy.test'
    mockToken = 'plat_sa_token'
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fetches and validates the billing snapshot', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(VALID_SNAPSHOT))

    const result = await fetchPlatformBillingInfo()

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://proxy.test/v1/billing',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer plat_sa_token' }),
      }),
    )
    expect(result).toEqual(VALID_SNAPSHOT)
  })

  it('keeps an optional hasPaymentMethod flag from newer proxies', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      jsonResponse({ ...VALID_SNAPSHOT, hasPaymentMethod: true }),
    )
    const result = await fetchPlatformBillingInfo()
    expect(result.hasPaymentMethod).toBe(true)
  })

  it('accepts a configured:false snapshot with null seat', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      jsonResponse({
        configured: false,
        subscription: { status: null, paymentStatus: null, currentPeriodEnd: null },
        seat: null,
        orgPool: { poolBalanceCents: 0 },
      }),
    )

    const result = await fetchPlatformBillingInfo()
    expect(result.configured).toBe(false)
    expect(result.seat).toBeNull()
  })

  it('throws when the proxy is not configured', async () => {
    mockProxyBase = ''
    await expect(fetchPlatformBillingInfo()).rejects.toBeInstanceOf(PlatformRequestError)
  })

  it('throws when not connected (no token)', async () => {
    mockToken = null
    await expect(fetchPlatformBillingInfo()).rejects.toMatchObject({ status: 401 })
  })

  it('maps 401/403 to a billing-unavailable error', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(jsonResponse({ error: {} }, 403))
    await expect(fetchPlatformBillingInfo()).rejects.toMatchObject({ status: 403 })
  })

  it('maps other non-2xx to 502', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(jsonResponse({ error: {} }, 500))
    await expect(fetchPlatformBillingInfo()).rejects.toMatchObject({ status: 502 })
  })

  it('rejects a malformed payload', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(jsonResponse({ subscription: 'nope' }))
    await expect(fetchPlatformBillingInfo()).rejects.toMatchObject({ status: 502 })
  })

  it('posts a top-up amount to the proxy', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      jsonResponse({ status: 'complete', amountCents: 2000, alreadyIssued: false }),
    )

    await expect(postPlatformTopup(2000)).resolves.toEqual({
      status: 'complete',
      amountCents: 2000,
      alreadyIssued: false,
    })
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://proxy.test/v1/billing/topup',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ amountCents: 2000 }),
      }),
    )
  })

  it('starts payment-method setup', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      jsonResponse({ clientSecret: 'seti_secret', publishableKey: 'pk_test_x' }),
    )
    await expect(startPlatformPaymentMethodSetup()).resolves.toEqual({
      clientSecret: 'seti_secret',
      publishableKey: 'pk_test_x',
    })
  })

  it('confirms a payment method id', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      jsonResponse({ status: 'updated', last4: '4242', brand: 'visa' }),
    )
    await expect(confirmPlatformPaymentMethod('pm_1')).resolves.toEqual({
      status: 'updated',
      last4: '4242',
      brand: 'visa',
    })
  })

  it('surfaces a 402 top-up decline message', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      jsonResponse({ error: { message: 'Your card was declined.' } }, 402),
    )
    await expect(postPlatformTopup(2000)).rejects.toMatchObject({
      status: 402,
      message: 'Your card was declined.',
    })
  })

  it('maps a network failure to 502', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(fetchPlatformBillingInfo()).rejects.toMatchObject({ status: 502 })
  })
})
