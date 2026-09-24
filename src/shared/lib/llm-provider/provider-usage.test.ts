import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexSubscriptionLlmProvider } from './codex-subscription-provider'
import { GrokSubscriptionLlmProvider } from './grok-subscription-provider'
import { PlatformLlmProvider } from './platform-provider'
import { fetchPlatformBillingInfo } from '../services/platform-billing-service'
vi.mock('../services/platform-billing-service', () => ({ fetchPlatformBillingInfo: vi.fn() }))
afterEach(() => vi.restoreAllMocks())

describe('subscription allowance reads', () => {
  for (const Provider of [CodexSubscriptionLlmProvider, GrokSubscriptionLlmProvider]) {
    it(`${Provider.name} retries one 401 using the app credential resolver`, async () => {
      const resolveCredential = vi.fn().mockResolvedValueOnce({ accessToken: 'old', accountId: 'account', generation: 1 }).mockResolvedValue({ accessToken: 'new', accountId: 'account', generation: 2 })
      const provider = new Provider({ apiKeys: {}, env: {}, resolveCredential })
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 401 })).mockResolvedValue(new Response(JSON.stringify({ config: {}, credits: { balance: '0' } })))
      await provider.getUsage()
      expect(resolveCredential.mock.calls).toEqual([[undefined], [1]])
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      const headers = new Headers(fetchSpy.mock.calls[1][1]?.headers)
      expect(headers.get('authorization')).toBe('Bearer new')
      if (provider.id === 'codex-subscription') expect(headers.get('ChatGPT-Account-ID')).toBe('account')
      expect(fetchSpy.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
      expect(fetchSpy.mock.calls[0][1]?.redirect).toBe('error')
    })
    it(`${Provider.name} does not refresh on quota/network errors or leak upstream details`, async () => {
      const resolveCredential = vi.fn().mockResolvedValue({ accessToken: 'access', accountId: 'account', generation: 1 })
      const provider = new Provider({ apiKeys: {}, env: {}, resolveCredential })
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private billing account', { status: 429 }))
      await expect(provider.getUsage()).rejects.toThrow('Could not load')
      expect(resolveCredential).toHaveBeenCalledTimes(1)
    })
  }
  it('reports Platform seat consumption and distinct balances, including exhausted/negative credit', async () => {
    vi.mocked(fetchPlatformBillingInfo).mockResolvedValue({ configured: true, subscription: { status: 'active', paymentStatus: null, currentPeriodEnd: '2026-10-01T00:00:00Z' }, seat: { balanceCents: -100, startingBalanceCents: 1000 }, orgPool: { poolBalanceCents: 0 } })
    const usage = await new PlatformLlmProvider().getUsage()
    expect(usage.limits[0]).toMatchObject({ label: 'Seat allowance' })
    expect(usage.limits[0].kind === 'window' && usage.limits[0].usedPercent).toBeCloseTo(110)
    expect(usage.limits.slice(1)).toEqual([
      { kind: 'balance', id: 'seat-credits', label: 'Seat credits', remaining: -1, unit: 'USD' },
      { kind: 'balance', id: 'organization-credits', label: 'Organization credits', remaining: 0, unit: 'USD' },
    ])
  })
})
