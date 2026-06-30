import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: vi.fn(() => ({})),
}))

import { getSettings } from '@shared/lib/config/settings'
import { BaseWebSearchProvider } from './base-web-search-provider'
import type { WebSearchProviderId } from './types'
import {
  clearWebSearchProviders,
  findWebSearchProvider,
  getActiveWebSearchProvider,
  getWebSearchProvider,
  registerWebSearchProvider,
} from './search-factory'

class FakeExa extends BaseWebSearchProvider {
  readonly id: WebSearchProviderId = 'exa'
  readonly name = 'Fake Exa'
  protected readonly settingsKeyField = 'exaApiKey' as const
  protected readonly envVarName = 'EXA_API_KEY'
  async search() {
    return { hits: [] }
  }
  async validateKey() {
    return { valid: true }
  }
}

function setActive(id?: WebSearchProviderId) {
  vi.mocked(getSettings).mockReturnValue({ webSearchProvider: id } as unknown as ReturnType<typeof getSettings>)
}

afterEach(() => {
  clearWebSearchProviders()
  setActive(undefined)
})

describe('web-search provider registry', () => {
  it('registers and retrieves a provider by id', () => {
    const p = new FakeExa()
    registerWebSearchProvider(p)
    expect(getWebSearchProvider('exa')).toBe(p)
  })

  it('throws when getting an unregistered provider', () => {
    expect(() => getWebSearchProvider('exa')).toThrow()
  })
})

describe('findWebSearchProvider', () => {
  it('returns the registered provider for a known id string', () => {
    const p = new FakeExa()
    registerWebSearchProvider(p)
    expect(findWebSearchProvider('exa')).toBe(p)
  })

  it('returns null for an unknown id string (no throw)', () => {
    expect(findWebSearchProvider('bogus')).toBeNull()
  })
})

describe('getActiveWebSearchProvider', () => {
  it('returns null when the setting is native', () => {
    registerWebSearchProvider(new FakeExa())
    setActive('native')
    expect(getActiveWebSearchProvider()).toBeNull()
  })

  it('returns null when nothing is configured (defaults to native)', () => {
    registerWebSearchProvider(new FakeExa())
    setActive(undefined)
    expect(getActiveWebSearchProvider()).toBeNull()
  })

  it('returns the registered provider when its id is the active setting', () => {
    const p = new FakeExa()
    registerWebSearchProvider(p)
    setActive('exa')
    expect(getActiveWebSearchProvider()).toBe(p)
  })

  it('falls back to null when the active vendor is not registered', () => {
    setActive('exa') // never registered
    expect(getActiveWebSearchProvider()).toBeNull()
  })
})
