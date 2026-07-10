import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: vi.fn(() => ({})),
}))

import { getSettings } from '@shared/lib/config/settings'
import { ExaWebProvider } from './exa-web-provider'
import type { WebProviderId } from './types'
import { findWebProvider, getActiveWebProvider, getWebProvider } from './web-provider-factory'

function setActive(id?: WebProviderId) {
  vi.mocked(getSettings).mockReturnValue({ webProvider: id } as unknown as ReturnType<typeof getSettings>)
}

afterEach(() => setActive(undefined))

describe('getWebProvider', () => {
  it('returns the singleton provider for the vendor id', () => {
    expect(getWebProvider('exa')).toBeInstanceOf(ExaWebProvider)
  })
})

describe('findWebProvider', () => {
  it('returns the provider for a known vendor id string', () => {
    expect(findWebProvider('exa')).toBeInstanceOf(ExaWebProvider)
  })

  it('returns null for native or an unknown id (no throw)', () => {
    expect(findWebProvider('native')).toBeNull()
    expect(findWebProvider('bogus')).toBeNull()
  })
})

describe('getActiveWebProvider', () => {
  it('returns null when the setting is native', () => {
    setActive('native')
    expect(getActiveWebProvider()).toBeNull()
  })

  it('returns null when nothing is configured (defaults to native)', () => {
    setActive(undefined)
    expect(getActiveWebProvider()).toBeNull()
  })

  it('returns the exa provider when it is the active setting', () => {
    setActive('exa')
    expect(getActiveWebProvider()?.id).toBe('exa')
  })
})
