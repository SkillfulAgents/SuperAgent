import { describe, it, expect, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ isPlatformComposioActive: vi.fn() }))

vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (_c: unknown, next: () => Promise<void>) => next(),
}))
vi.mock('@shared/lib/composio/client', () => ({
  isPlatformComposioActive: mocks.isPlatformComposioActive,
}))

import providers from './providers'

async function slugs(): Promise<string[]> {
  const res = await providers.request('http://localhost/')
  const body = await res.json() as { providers: { slug: string }[] }
  return body.providers.map((p) => p.slug)
}

describe('GET /api/providers', () => {
  it('lists X and Plaid only on Gamut\'s Composio, and never Shopify', async () => {
    mocks.isPlatformComposioActive.mockReturnValue(true)
    const platform = await slugs()
    expect(platform).toContain('twitter')
    expect(platform).toContain('plaid')
    // Shopify is unlisted until its App Store listing is live: arrivals still connect it.
    expect(platform).not.toContain('shopify')

    mocks.isPlatformComposioActive.mockReturnValue(false)
    const local = await slugs()
    expect(local).not.toContain('twitter')
    expect(local).not.toContain('plaid')
    expect(local).not.toContain('shopify')
    expect(local).toContain('gmail')
  })
})
