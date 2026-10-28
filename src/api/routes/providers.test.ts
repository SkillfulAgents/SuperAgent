import { beforeEach, describe, it, expect, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  isPlatformComposioActive: vi.fn(),
  getDefaultAccountProvider: vi.fn(() => ({ name: 'composio' as 'composio' | 'nango' })),
}))

vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (_c: unknown, next: () => Promise<void>) => next(),
}))
vi.mock('@shared/lib/composio/client', () => ({
  isPlatformComposioActive: mocks.isPlatformComposioActive,
}))
vi.mock('@shared/lib/account-providers/provider-factory', () => ({
  getDefaultAccountProvider: mocks.getDefaultAccountProvider,
}))

import providers from './providers'

async function slugs(): Promise<string[]> {
  const res = await providers.request('http://localhost/')
  const body = await res.json() as { providers: { slug: string }[] }
  return body.providers.map((p) => p.slug)
}

describe('GET /api/providers', () => {
  beforeEach(() => {
    mocks.getDefaultAccountProvider.mockReturnValue({ name: 'composio' })
    mocks.isPlatformComposioActive.mockReturnValue(false)
  })

  it('lists X, Plaid, and Shopify only on Gamut\'s Composio', async () => {
    mocks.isPlatformComposioActive.mockReturnValue(true)
    const platform = await slugs()
    expect(platform).toContain('twitter')
    expect(platform).toContain('plaid')
    expect(platform).toContain('shopify')

    mocks.isPlatformComposioActive.mockReturnValue(false)
    const local = await slugs()
    expect(local).not.toContain('twitter')
    expect(local).not.toContain('plaid')
    expect(local).not.toContain('shopify')
    expect(local).toContain('gmail')
    expect(local).toContain('todoist')
    expect(local).toContain('excel')
  })

  it.each([false, true])('only advertises Nango-supported services when Nango is selected (platform Composio %s)', async (platformComposio) => {
    mocks.getDefaultAccountProvider.mockReturnValue({ name: 'nango' })
    mocks.isPlatformComposioActive.mockReturnValue(platformComposio)
    const listed = await slugs()
    expect(listed).toContain('gmail')
    expect(listed).toContain('github')
    for (const slug of ['canva', 'todoist', 'excel', 'jira', 'twitter', 'plaid', 'shopify', 'highlevel']) {
      expect(listed).not.toContain(slug)
    }
  })
})
