import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: vi.fn(() => ({})),
}))

import { getSettings } from '@shared/lib/config/settings'
import { ExaWebProvider } from './exa-web-provider'
import { PlatformWebProvider } from './platform-web-provider'
import type { WebProviderId } from './types'
import {
  findWebProvider,
  getActiveWebProvider,
  getWebProvider,
  resolveDefaultWebVendor,
} from './web-provider-factory'

function setActive(id?: WebProviderId) {
  vi.mocked(getSettings).mockReturnValue({ webProvider: id } as unknown as ReturnType<typeof getSettings>)
}

// The default resolver asks each provider whether a credential is configured, and with settings
// mocked empty that detection falls through to env (platform -> PLATFORM_TOKEN, exa -> EXA_API_KEY).
// Clear both so an ambient key in the dev environment can't decide the unset-setting cases.
function clearVendorEnv() {
  delete process.env.PLATFORM_TOKEN
  delete process.env.EXA_API_KEY
}

beforeEach(clearVendorEnv)
afterEach(() => {
  clearVendorEnv()
  setActive(undefined)
})

describe('getWebProvider', () => {
  it('returns the singleton provider for the vendor id', () => {
    expect(getWebProvider('exa')).toBeInstanceOf(ExaWebProvider)
    expect(getWebProvider('platform')).toBeInstanceOf(PlatformWebProvider)
  })
})

describe('findWebProvider', () => {
  it('returns the provider for a known vendor id string', () => {
    expect(findWebProvider('exa')).toBeInstanceOf(ExaWebProvider)
    expect(findWebProvider('platform')).toBeInstanceOf(PlatformWebProvider)
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

  it('resolves the automatic default only when the setting is unset', () => {
    process.env.PLATFORM_TOKEN = 't'
    setActive(undefined)
    expect(getActiveWebProvider()?.id).toBe('platform')
    setActive('native') // an explicit native choice still wins over the resolver
    expect(getActiveWebProvider()).toBeNull()
  })
})

describe('resolveDefaultWebVendor', () => {
  it('prefers platform when the platform token is configured', () => {
    process.env.PLATFORM_TOKEN = 't'
    expect(resolveDefaultWebVendor()).toBe('platform')
  })

  it('falls back to exa when only an Exa key is set', () => {
    process.env.EXA_API_KEY = 'k'
    expect(resolveDefaultWebVendor()).toBe('exa')
  })

  it('prefers platform over exa when BOTH are configured (precedence tie-break)', () => {
    process.env.PLATFORM_TOKEN = 't'
    process.env.EXA_API_KEY = 'k'
    expect(resolveDefaultWebVendor()).toBe('platform')
  })

  it('falls back to native when nothing is configured', () => {
    expect(resolveDefaultWebVendor()).toBe('native')
  })
})
