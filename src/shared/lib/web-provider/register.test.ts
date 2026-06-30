import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: vi.fn(() => ({})),
}))

import { getSettings } from '@shared/lib/config/settings'
import { ExaWebSearchProvider } from './exa-web-search-provider'
import { FirecrawlWebSearchProvider } from './firecrawl-web-search-provider'
import { ParallelWebSearchProvider } from './parallel-web-search-provider'
import { registerAllWebProviders } from './register'
import { clearWebSearchProviders, getActiveWebSearchProvider } from './search-factory'
import type { WebSearchProviderId } from './types'
import { YouComWebSearchProvider } from './youcom-web-search-provider'

function setActive(id: WebSearchProviderId) {
  vi.mocked(getSettings).mockReturnValue({ webSearchProvider: id } as unknown as ReturnType<typeof getSettings>)
}

afterEach(() => clearWebSearchProviders())

describe('registerAllWebProviders', () => {
  it.each([
    ['exa', ExaWebSearchProvider],
    ['parallel', ParallelWebSearchProvider],
    ['youcom', YouComWebSearchProvider],
    ['firecrawl', FirecrawlWebSearchProvider],
  ] as const)('registers the %s provider so it resolves as the active vendor', (id, Cls) => {
    registerAllWebProviders()
    setActive(id)
    expect(getActiveWebSearchProvider()).toBeInstanceOf(Cls)
  })
})
