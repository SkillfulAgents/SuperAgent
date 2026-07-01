import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: vi.fn(() => ({})),
}))

import { getSettings } from '@shared/lib/config/settings'
import { ExaWebSearchProvider } from './exa-web-search-provider'
import type { WebSearchProviderId } from './types'
import { findWebSearchProvider, getActiveWebSearchProvider, getWebSearchProvider } from './search-factory'

function setActive(id?: WebSearchProviderId) {
  vi.mocked(getSettings).mockReturnValue({ webSearchProvider: id } as unknown as ReturnType<typeof getSettings>)
}

afterEach(() => setActive(undefined))

describe('getWebSearchProvider', () => {
  it('returns the singleton provider for the vendor id', () => {
    expect(getWebSearchProvider('exa')).toBeInstanceOf(ExaWebSearchProvider)
  })
})

describe('findWebSearchProvider', () => {
  it('returns the provider for a known vendor id string', () => {
    expect(findWebSearchProvider('exa')).toBeInstanceOf(ExaWebSearchProvider)
  })

  it('returns null for native or an unknown id (no throw)', () => {
    expect(findWebSearchProvider('native')).toBeNull()
    expect(findWebSearchProvider('bogus')).toBeNull()
  })
})

describe('getActiveWebSearchProvider', () => {
  it('returns null when the setting is native', () => {
    setActive('native')
    expect(getActiveWebSearchProvider()).toBeNull()
  })

  it('returns null when nothing is configured (defaults to native)', () => {
    setActive(undefined)
    expect(getActiveWebSearchProvider()).toBeNull()
  })

  it('returns the exa provider when it is the active setting', () => {
    setActive('exa')
    expect(getActiveWebSearchProvider()?.id).toBe('exa')
  })
})
