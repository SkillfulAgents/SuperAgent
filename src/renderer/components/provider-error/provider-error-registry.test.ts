// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import { ProviderErrorCard } from '@renderer/components/ui/provider-error-card'

import { PlatformPaywallCard } from './platform-paywall-card'
import { resolveProviderError } from './provider-error-registry'

const base = { severity: 'error' as const, message: 'x', icon: 'info' }

describe('resolveProviderError', () => {
  it('returns the default component at inline when there is no presentation', () => {
    expect(resolveProviderError(undefined)).toEqual({ Component: ProviderErrorCard, placement: 'inline' })
    expect(resolveProviderError(null)).toEqual({ Component: ProviderErrorCard, placement: 'inline' })
  })

  it('returns the default component when component is unset', () => {
    expect(resolveProviderError(base).Component).toBe(ProviderErrorCard)
  })

  it('falls back to the default component for an unregistered key', () => {
    expect(resolveProviderError({ ...base, component: 'not-registered' }).Component).toBe(ProviderErrorCard)
  })

  it('resolves the platform-paywall key to PlatformPaywallCard', () => {
    expect(resolveProviderError({ ...base, component: 'platform-paywall' }).Component).toBe(PlatformPaywallCard)
  })

  it('passes placement through', () => {
    expect(resolveProviderError({ ...base, placement: 'composer' }).placement).toBe('composer')
  })
})
