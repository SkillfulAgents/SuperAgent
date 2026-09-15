import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getConnectionToken: vi.fn(), getConnection: vi.fn() }))

vi.mock('@shared/lib/composio/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/composio/client')>()),
  getConnectionToken: mocks.getConnectionToken,
  getConnection: mocks.getConnection,
}))

import { ComposioAccountProvider } from './composio-account-provider'

describe('ComposioAccountProvider direct forward', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mocks.getConnectionToken.mockResolvedValue({ accessToken: 'tok_123', expiresAt: undefined })
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
  })

  afterEach(() => vi.restoreAllMocks())

  async function forwardedHeaders(toolkitSlug: string, targetUrl: string) {
    await new ComposioAccountProvider().makeApiCall({
      providerConnectionId: `ca_${toolkitSlug}`,
      toolkitSlug,
      targetUrl,
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
    })
    return new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers)
  }

  it("authenticates Shopify with Shopify's access-token header", async () => {
    const headers = await forwardedHeaders('shopify', 'https://gamut-dev.myshopify.com/admin/api/2026-07/graphql.json')
    expect(headers.get('X-Shopify-Access-Token')).toBe('tok_123')
    expect(headers.get('Authorization')).toBeNull()
  })

  it('keeps the Bearer header for every other toolkit', async () => {
    const headers = await forwardedHeaders('github', 'https://api.github.com/user')
    expect(headers.get('Authorization')).toBe('Bearer tok_123')
    expect(headers.get('X-Shopify-Access-Token')).toBeNull()
  })
})

describe('ComposioAccountProvider Shopify account name', () => {
  it('names the account after the store Composio authorized', async () => {
    mocks.getConnection.mockResolvedValue({ id: 'ca_shop', status: 'ACTIVE', shopDomain: 'other-store.myshopify.com' })
    expect(await new ComposioAccountProvider().getAccountDisplayName('ca_shop', 'shopify', 'gamut-dev.myshopify.com'))
      .toBe('other-store.myshopify.com')
  })

  it('keeps the generic name when the store cannot be verified', async () => {
    mocks.getConnection.mockRejectedValue(new Error('Composio down'))
    expect(await new ComposioAccountProvider().getAccountDisplayName('ca_shop', 'shopify', 'Shopify')).toBe('Shopify')
  })
})
