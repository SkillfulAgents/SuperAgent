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
  resolveEffectiveWebVendor,
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

  it('returns the exa provider when it is pinned and its key is configured', () => {
    process.env.EXA_API_KEY = 'k'
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

// A pin is a preference ("use Exa when Exa is usable"), not a contract ("fail if it isn't"). An
// unusable pin must behave exactly like no pin, or the agent gets a vendor that can only throw.
describe('resolveEffectiveWebVendor', () => {
  it('honors a pinned vendor while its credential is configured', () => {
    process.env.EXA_API_KEY = 'k'
    setActive('exa')
    expect(resolveEffectiveWebVendor()).toBe('exa')
  })

  it('falls through to the next usable vendor when the pinned credential is gone', () => {
    process.env.PLATFORM_TOKEN = 't' // exa pinned, but only platform is usable
    setActive('exa')
    expect(resolveEffectiveWebVendor()).toBe('platform')
    expect(getActiveWebProvider()?.id).toBe('platform')
  })

  it('falls all the way to native when nothing is usable', () => {
    setActive('exa') // pinned, no key, nothing else configured
    expect(resolveEffectiveWebVendor()).toBe('native')
    expect(getActiveWebProvider()).toBeNull()
  })

  it('heals back to the pin when the credential returns (nothing was persisted)', () => {
    setActive('exa')
    expect(resolveEffectiveWebVendor()).toBe('native')
    process.env.EXA_API_KEY = 'k'
    expect(resolveEffectiveWebVendor()).toBe('exa')
  })

  it('signing out of Gamut drops a pinned platform to the next usable vendor', () => {
    process.env.PLATFORM_TOKEN = 't'
    setActive('platform')
    expect(resolveEffectiveWebVendor()).toBe('platform')
    delete process.env.PLATFORM_TOKEN // signed out
    process.env.EXA_API_KEY = 'k'
    expect(resolveEffectiveWebVendor()).toBe('exa')
  })

  it('keeps an explicit native choice even when a vendor is configured (native needs no credential)', () => {
    process.env.PLATFORM_TOKEN = 't'
    setActive('native')
    expect(resolveEffectiveWebVendor()).toBe('native')
  })

  it('treats an unknown stored id like no pin', () => {
    process.env.PLATFORM_TOKEN = 't'
    vi.mocked(getSettings).mockReturnValue({ webProvider: 'bogus' } as never)
    expect(resolveEffectiveWebVendor()).toBe('platform')
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
