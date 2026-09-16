import { describe, expect, it } from 'vitest'

import { buildBillingEmbedUrl, platformOriginFromBaseUrl } from './billing-embed'

describe('buildBillingEmbedUrl', () => {
  it('includes surface and cta when opening the launcher', () => {
    const href = buildBillingEmbedUrl('https://platform.example.com/', 'org_1', {
      view: 'topup',
      parent: 'https://app.example.com',
      surface: 'cta',
      cta: 'add_card',
    })
    const url = new URL(href!)
    expect(url.origin).toBe('https://platform.example.com')
    expect(url.pathname).toBe('/embed/billing/org_1')
    expect(url.searchParams.get('parent')).toBe('https://app.example.com')
    expect(url.searchParams.get('view')).toBe('topup')
    expect(url.searchParams.get('surface')).toBe('cta')
    expect(url.searchParams.get('cta')).toBe('add_card')
    expect(url.searchParams.get('intent')).toBeNull()
  })

  it('omits surface and cta for the dialog panel', () => {
    const href = buildBillingEmbedUrl('https://platform.example.com', 'org_1', {
      view: 'topup',
      intent: 'topup',
      parent: 'https://app.example.com',
    })
    const url = new URL(href!)
    expect(url.searchParams.get('intent')).toBe('topup')
    expect(url.searchParams.has('surface')).toBe(false)
    expect(url.searchParams.has('cta')).toBe(false)
  })

  it('returns null when the platform origin cannot be parsed', () => {
    expect(platformOriginFromBaseUrl(null)).toBeNull()
    expect(buildBillingEmbedUrl('not-a-url', 'org_1', { parent: 'https://app.example.com' })).toBeNull()
  })
})
