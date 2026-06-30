import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: vi.fn(() => ({ webSearchProvider: 'exa' })),
}))

import { ExaWebSearchProvider } from './exa-web-search-provider'
import { registerAllWebProviders } from './register'
import { clearWebSearchProviders, getActiveWebSearchProvider } from './search-factory'

afterEach(() => clearWebSearchProviders())

describe('registerAllWebProviders', () => {
  it('registers the Exa search provider so it resolves as the active vendor', () => {
    registerAllWebProviders()
    expect(getActiveWebSearchProvider()).toBeInstanceOf(ExaWebSearchProvider)
  })
})
