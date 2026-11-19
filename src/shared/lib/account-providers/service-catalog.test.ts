import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getToolkitSlugFromProviderSlug, getProviderSlug, getProvider, isProviderSupported, SUPPORTED_PROVIDERS, getAgentOfferedProviders } from './service-catalog'

describe('the account catalog agents search', () => {
  it.each([false, true])('offers platform-only accounts only on Gamut\'s Composio (platform mode %s)', (platformMode) => {
    const offered = getAgentOfferedProviders('composio', platformMode).map((provider) => provider.slug)
    for (const slug of ['twitter', 'plaid', 'highlevel', 'shopify']) expect(offered.includes(slug)).toBe(platformMode)
    for (const slug of ['jira', 'gong', 'pagerduty', 'todoist', 'excel']) expect(offered).toContain(slug)
  })

  it('offers only the toolkits the selected account provider has', () => {
    const offered = getAgentOfferedProviders('nango', true)
    expect(offered.length).toBeGreaterThan(0)
    expect(offered.every((provider) => provider.nangoSlug)).toBe(true)
  })

  it('gives every account a category its search and index can use', () => {
    const missing = SUPPORTED_PROVIDERS.filter((provider) => !provider.category.trim()).map((provider) => provider.slug)
    expect(missing).toEqual([])
  })

  // The FAQ may clarify restricted account types, but should not maintain a
  // second full service catalog that can drift from discovery.
  it('does not let the integrations FAQ grow a second toolkit list', () => {
    const faq = readFileSync(path.resolve(__dirname, '../../../../agent-container/docs/faqs/what-integrations-are-supported.md'), 'utf8')
    const accountTypeExamples = new Set(['facebook', 'whatsapp', 'notebook_lm'])
    const echoed = SUPPORTED_PROVIDERS.map((provider) => provider.slug)
      .filter((slug) => !accountTypeExamples.has(slug) && new RegExp(`\`${slug}\``).test(faq))
    expect(echoed, 'FAQ should point at the prompt/search tool, not restate slugs').toEqual([])
  })

  it('keeps toolkit mappings unambiguous', () => {
    const slugs = SUPPORTED_PROVIDERS.map((provider) => provider.slug)
    const composioSlugs = SUPPORTED_PROVIDERS.map((provider) => provider.composioSlug)
    expect(new Set(slugs).size).toBe(slugs.length)
    expect(new Set(composioSlugs).size).toBe(composioSlugs.length)
  })
})

describe('getToolkitSlugFromProviderSlug', () => {
  it('maps nango slug back to toolkit slug', () => {
    expect(getToolkitSlugFromProviderSlug('google-mail', 'nango')).toBe('gmail')
    expect(getToolkitSlugFromProviderSlug('google-calendar', 'nango')).toBe('googlecalendar')
  })

  it('maps composio slug back to toolkit slug', () => {
    expect(getToolkitSlugFromProviderSlug('gmail', 'composio')).toBe('gmail')
    expect(getToolkitSlugFromProviderSlug('slack', 'composio')).toBe('slack')
  })

  it('maps the bridge-hosted custom_plaid toolkit to plaid and back', () => {
    expect(getToolkitSlugFromProviderSlug('custom_plaid', 'composio')).toBe('plaid')
    expect(getProviderSlug('plaid', 'composio')).toBe('custom_plaid')
    expect(isProviderSupported('plaid', 'composio')).toBe(true)
    expect(isProviderSupported('plaid', 'nango')).toBe(false)
  })

  it('returns undefined for unknown provider slug', () => {
    expect(getToolkitSlugFromProviderSlug('nonexistent-service', 'nango')).toBeUndefined()
    expect(getToolkitSlugFromProviderSlug('nonexistent-service', 'composio')).toBeUndefined()
  })

  it('round-trips with getProviderSlug', () => {
    const toolkitSlug = 'gmail'
    const nangoSlug = getProviderSlug(toolkitSlug, 'nango')
    expect(getToolkitSlugFromProviderSlug(nangoSlug, 'nango')).toBe(toolkitSlug)

    const composioSlug = getProviderSlug(toolkitSlug, 'composio')
    expect(getToolkitSlugFromProviderSlug(composioSlug, 'composio')).toBe(toolkitSlug)
  })
})

describe('getProvider', () => {
  it('finds a provider by slug', () => {
    const p = getProvider('gmail')
    expect(p).toBeDefined()
    expect(p!.displayName).toBe('Gmail')
  })

  it('returns undefined for unknown slug', () => {
    expect(getProvider('nonexistent')).toBeUndefined()
  })
})

describe('isProviderSupported', () => {
  it('returns true for a supported provider', () => {
    expect(isProviderSupported('gmail')).toBe(true)
    expect(isProviderSupported('gmail', 'composio')).toBe(true)
  })

  it('returns false for an unsupported provider-specific slug', () => {
    const p = getProvider('gmail')
    if (p && !p.nangoSlug) {
      expect(isProviderSupported('gmail', 'nango')).toBe(false)
    }
  })

  it('returns false for unknown slug', () => {
    expect(isProviderSupported('nonexistent')).toBe(false)
  })
})
