import type { Context } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ composioFetch: vi.fn(), storeAccounts: [] as Array<{ id: string }> }))

vi.mock('@shared/lib/composio/client', () => ({ composioFetch: mocks.composioFetch, getOrCreateAuthConfig: vi.fn() }))
vi.mock('@shared/lib/auth/ownership', () => ({ ownerScope: () => undefined }))
vi.mock('@shared/lib/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => mocks.storeAccounts }) }) }) },
}))

import { shopifyAdapter } from './shopify'

const c = {} as Context
const { afterConnect } = shopifyAdapter

describe('shopifyAdapter.afterConnect', () => {
  beforeEach(() => {
    mocks.storeAccounts = []
  })

  it('names the account after the store Composio authorized, and replaces that store\'s account', async () => {
    mocks.composioFetch.mockResolvedValue({ toolkit: { slug: 'shopify' }, state: { val: { subdomain: 'Other-Store' } } })
    mocks.storeAccounts = [{ id: 'shop-acc' }]
    expect(await afterConnect!({ c, connectionId: 'ca_shop' }))
      .toEqual({ displayName: 'other-store.myshopify.com', reconnectAccountId: 'shop-acc' })
  })

  // A grant for another toolkit, completed as Shopify, would otherwise replace a store's account.
  it('refuses a store read from another toolkit\'s grant', async () => {
    mocks.composioFetch.mockResolvedValue({ toolkit: { slug: 'zendesk' }, state: { val: { subdomain: 'acme' } } })
    expect(await afterConnect!({ c, connectionId: 'ca_zd' })).toHaveProperty('error')
  })

  it('refuses a grant whose store is not a myshopify subdomain', async () => {
    mocks.composioFetch.mockResolvedValue({ toolkit: { slug: 'shopify' }, state: { val: { subdomain: 'evil.com/x' } } })
    expect(await afterConnect!({ c, connectionId: 'ca_shop' })).toHaveProperty('error')
  })

  it('refuses when the store cannot be verified', async () => {
    mocks.composioFetch.mockRejectedValue(new Error('Composio down'))
    expect(await afterConnect!({ c, connectionId: 'ca_shop' })).toHaveProperty('error')
  })
})
