import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: vi.fn(() => ({})),
}))

import { getSettings } from '@shared/lib/config/settings'
import { ExaWebFetchProvider } from './exa-web-fetch-provider'
import type { WebFetchProviderId } from './types'
import { findWebFetchProvider, getActiveWebFetchProvider, getWebFetchProvider } from './fetch-factory'

function setActive(id?: WebFetchProviderId) {
  vi.mocked(getSettings).mockReturnValue({ webFetchProvider: id } as unknown as ReturnType<typeof getSettings>)
}

afterEach(() => setActive(undefined))

describe('getWebFetchProvider', () => {
  it('returns the singleton provider for the vendor id', () => {
    expect(getWebFetchProvider('exa')).toBeInstanceOf(ExaWebFetchProvider)
  })
})

describe('findWebFetchProvider', () => {
  it('returns the provider for a known vendor id string', () => {
    expect(findWebFetchProvider('exa')).toBeInstanceOf(ExaWebFetchProvider)
  })

  it('returns null for native or an unknown id (no throw)', () => {
    expect(findWebFetchProvider('native')).toBeNull()
    expect(findWebFetchProvider('bogus')).toBeNull()
  })
})

describe('getActiveWebFetchProvider', () => {
  it('returns null when the setting is native', () => {
    setActive('native')
    expect(getActiveWebFetchProvider()).toBeNull()
  })

  it('returns null when nothing is configured (defaults to native)', () => {
    setActive(undefined)
    expect(getActiveWebFetchProvider()).toBeNull()
  })

  it('returns the exa provider when it is the active setting', () => {
    setActive('exa')
    expect(getActiveWebFetchProvider()?.id).toBe('exa')
  })
})
