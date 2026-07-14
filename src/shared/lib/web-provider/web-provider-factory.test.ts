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
  resolveEffectiveWebVendor,
} from './web-provider-factory'

function setActive(id?: WebProviderId) {
  vi.mocked(getSettings).mockReturnValue({ webProvider: id } as unknown as ReturnType<typeof getSettings>)
}

// The unset default asks whether a platform credential is configured, and with settings mocked
// empty that detection falls through to env (PLATFORM_TOKEN). Clear it so an ambient key in the
// dev environment can't decide the unset-setting cases. EXA_API_KEY is cleared too so a sticky
// Exa pin can't accidentally look configured from env.
function clearVendorEnv() {
  delete process.env.PLATFORM_TOKEN
  delete process.env.EXA_API_KEY
}

beforeEach(clearVendorEnv)
afterEach(() => {
  clearVendorEnv()
  setActive(undefined)
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
  it('maps the effective vendor to its provider, and native to null', () => {
    process.env.PLATFORM_TOKEN = 't'
    setActive(undefined)
    expect(getActiveWebProvider()?.id).toBe('platform')
    setActive('native')
    expect(getActiveWebProvider()).toBeNull()
  })
})

// Sticky like LLM/STT: a stored pin is a contract. Unset is the only adaptive case.
describe('resolveEffectiveWebVendor', () => {
  it('honors a pinned vendor even when its credential is gone (fail loud, no silent swap)', () => {
    process.env.PLATFORM_TOKEN = 't' // would have been the old ladder's next pick
    setActive('exa')
    expect(resolveEffectiveWebVendor()).toBe('exa')
    expect(getActiveWebProvider()?.id).toBe('exa')
  })

  it('honors a pinned vendor while its credential is configured', () => {
    process.env.EXA_API_KEY = 'k'
    setActive('exa')
    expect(resolveEffectiveWebVendor()).toBe('exa')
  })

  it('keeps an explicit native choice even when platform is configured', () => {
    process.env.PLATFORM_TOKEN = 't'
    setActive('native')
    expect(resolveEffectiveWebVendor()).toBe('native')
  })

  it('treats an unknown stored id like no pin', () => {
    process.env.PLATFORM_TOKEN = 't'
    vi.mocked(getSettings).mockReturnValue({ webProvider: 'bogus' } as never)
    expect(resolveEffectiveWebVendor()).toBe('platform')
  })

  it('defaults to platform when unset and a Gamut login is present', () => {
    process.env.PLATFORM_TOKEN = 't'
    setActive(undefined)
    expect(resolveEffectiveWebVendor()).toBe('platform')
  })

  it('defaults to native when unset and no Gamut login (does not auto-pick Exa)', () => {
    process.env.EXA_API_KEY = 'k'
    setActive(undefined)
    expect(resolveEffectiveWebVendor()).toBe('native')
  })

  it('defaults to native when unset and nothing is configured', () => {
    setActive(undefined)
    expect(resolveEffectiveWebVendor()).toBe('native')
  })
})
