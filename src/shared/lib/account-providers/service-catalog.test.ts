import { describe, it, expect } from 'vitest'
import { getToolkitSlugFromProviderSlug, getProviderSlug, getProvider, isProviderSupported } from './service-catalog'

describe('getToolkitSlugFromProviderSlug', () => {
  it('maps nango slug back to toolkit slug', () => {
    expect(getToolkitSlugFromProviderSlug('google-mail', 'nango')).toBe('gmail')
    expect(getToolkitSlugFromProviderSlug('google-calendar', 'nango')).toBe('googlecalendar')
  })

  it('maps composio slug back to toolkit slug', () => {
    expect(getToolkitSlugFromProviderSlug('gmail', 'composio')).toBe('gmail')
    expect(getToolkitSlugFromProviderSlug('slack', 'composio')).toBe('slack')
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
