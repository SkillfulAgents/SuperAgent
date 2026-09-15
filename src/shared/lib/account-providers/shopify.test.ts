import { describe, expect, it } from 'vitest'

import { isShopifyGraphqlPath, parseShopDomain } from './shopify'

describe('parseShopDomain', () => {
  it('accepts a myshopify domain and rejects anything else', () => {
    expect(parseShopDomain('gamut-dev.myshopify.com')).toBe('gamut-dev.myshopify.com')
    expect(parseShopDomain('evil.com/.myshopify.com')).toBeNull()
    expect(parseShopDomain('Gamut.myshopify.com')).toBeNull()
    expect(parseShopDomain(undefined)).toBeNull()
  })
})

describe('isShopifyGraphqlPath', () => {
  it('allows only the versioned GraphQL Admin API endpoint', () => {
    expect(isShopifyGraphqlPath('/admin/api/2026-07/graphql.json')).toBe(true)
    expect(isShopifyGraphqlPath('/admin/api/unstable/graphql.json')).toBe(true)
    expect(isShopifyGraphqlPath('/admin/api/2026-07/products.json')).toBe(false)
    expect(isShopifyGraphqlPath('/admin/api/2026-07/graphql.json/../products.json')).toBe(false)
  })
})
