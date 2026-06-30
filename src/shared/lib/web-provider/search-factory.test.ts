import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: vi.fn(() => ({})),
}))

import { getSettings } from '@shared/lib/config/settings'
import { ExaWebSearchProvider } from './exa-web-search-provider'
import { FirecrawlWebSearchProvider } from './firecrawl-web-search-provider'
import { ParallelWebSearchProvider } from './parallel-web-search-provider'
import { YouComWebSearchProvider } from './youcom-web-search-provider'
import type { WebSearchProviderId } from './types'
import { findWebSearchProvider, getActiveWebSearchProvider, getWebSearchProvider } from './search-factory'

function setActive(id?: WebSearchProviderId) {
  vi.mocked(getSettings).mockReturnValue({ webSearchProvider: id } as unknown as ReturnType<typeof getSettings>)
}

afterEach(() => setActive(undefined))

describe('getWebSearchProvider', () => {
  it('returns the singleton provider for each vendor id', () => {
    expect(getWebSearchProvider('exa')).toBeInstanceOf(ExaWebSearchProvider)
    expect(getWebSearchProvider('parallel')).toBeInstanceOf(ParallelWebSearchProvider)
    expect(getWebSearchProvider('youcom')).toBeInstanceOf(YouComWebSearchProvider)
    expect(getWebSearchProvider('firecrawl')).toBeInstanceOf(FirecrawlWebSearchProvider)
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

  it.each(['exa', 'parallel', 'youcom', 'firecrawl'] as const)(
    'returns the %s provider when it is the active setting',
    (id) => {
      setActive(id)
      expect(getActiveWebSearchProvider()?.id).toBe(id)
    },
  )
})
