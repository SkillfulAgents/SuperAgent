import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexSubscriptionLlmProvider } from './codex-subscription-provider'
import { GrokSubscriptionLlmProvider } from './grok-subscription-provider'
import { PlatformLlmProvider } from './platform-provider'
import { fetchPlatformBillingInfo } from '../services/platform-billing-service'
vi.mock('../services/platform-billing-service', () => ({ fetchPlatformBillingInfo: vi.fn() }))
afterEach(() => vi.restoreAllMocks())

describe('subscription allowance reads', () => {
  for (const Provider of [CodexSubscriptionLlmProvider, GrokSubscriptionLlmProvider]) {
    const oauth = { accessToken: 'saved', refreshToken: 'private', accountId: 'account', expiresAt: 0 }
    it(`${Provider.name} uses the saved token without waiting on refresh`, async () => {
      const resolveCredential = vi.fn(() => new Promise<never>(() => {}))
      const provider = new Provider({ apiKeys: {}, env: {}, oauth, resolveCredential })
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ config: {}, credits: { balance: '0' } })))
      await provider.getUsage()
      expect(resolveCredential).not.toHaveBeenCalled()
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const headers = new Headers(fetchSpy.mock.calls[0][1]?.headers)
      expect(headers.get('authorization')).toBe('Bearer saved')
      if (provider.id === 'codex-subscription') expect(headers.get('ChatGPT-Account-ID')).toBe('account')
      expect(fetchSpy.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
      expect(fetchSpy.mock.calls[0][1]?.redirect).toBe('error')
    })
    it.each([401, 403, 429])(`${Provider.name} never refreshes or writes failure state on HTTP %i`, async status => {
      const resolveCredential = vi.fn().mockRejectedValue(new Error('refresh failed'))
      const provider = new Provider({ apiKeys: {}, env: {}, oauth, resolveCredential })
      const before = JSON.stringify(oauth)
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private billing account', { status }))
      await expect(provider.getUsage()).rejects.toThrow('Could not load')
      expect(resolveCredential).not.toHaveBeenCalled()
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(oauth)).toBe(before)
    })
    it(`${Provider.name} aborts the sole upstream request after ten seconds`, async () => {
      vi.useFakeTimers()
      const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
        const controller = new AbortController()
        setTimeout(() => controller.abort(new Error('timeout')), ms)
        return controller.signal
      })
      const provider = new Provider({ apiKeys: {}, env: {}, oauth, resolveCredential: vi.fn() })
      vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('timeout')), { once: true })
      }))
      try {
        const pending = expect(provider.getUsage()).rejects.toThrow('timeout')
        await vi.advanceTimersByTimeAsync(10_000)
        await pending
        expect(timeout).toHaveBeenCalledWith(10_000)
      } finally { vi.useRealTimers() }
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
