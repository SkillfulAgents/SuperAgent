import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: vi.fn(async () => ({})),
}))

import { getSettings } from '@shared/lib/config/settings'
import { ParallelWebProvider } from './parallel-web-provider'
import { ExaWebProvider } from './exa-web-provider'
import { PlatformWebProvider } from './platform-web-provider'
import type { WebProviderId } from './types'
import {
  findWebProvider,
  getActiveWebProvider,
  resolveEffectiveWebVendor,
} from './web-provider-factory'

function setActive(id?: WebProviderId) {
  vi.mocked(getSettings).mockResolvedValue({ webProvider: id } as unknown as Awaited<ReturnType<typeof getSettings>>)
}

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
  it('returns the provider for a known vendor id string', async () => {
    expect(findWebProvider('parallel')).toBeInstanceOf(ParallelWebProvider)
    expect(findWebProvider('exa')).toBeInstanceOf(ExaWebProvider)
    expect(findWebProvider('platform')).toBeInstanceOf(PlatformWebProvider)
  })

  it('returns null for native or an unknown id (no throw)', async () => {
    expect(findWebProvider('native')).toBeNull()
    expect(findWebProvider('bogus')).toBeNull()
  })
})

describe('getActiveWebProvider', () => {
  it('maps the effective vendor to its provider, and native to null', async () => {
    process.env.PLATFORM_TOKEN = 't'
    setActive(undefined)
    expect((await getActiveWebProvider())?.id).toBe('platform')
    setActive('native')
    expect(await getActiveWebProvider()).toBeNull()
  })
})

describe('resolveEffectiveWebVendor', () => {
  it('honors a keyless Parallel pin without changing the automatic incumbent', async () => {
    setActive('parallel')
    expect(await resolveEffectiveWebVendor()).toBe('parallel')
    expect((await getActiveWebProvider())?.search).toBeTypeOf('function')
    expect((await getActiveWebProvider())?.fetch).toBeUndefined()
  })

  it('honors a pinned vendor even when its credential is gone (fail loud, no silent swap)', async () => {
    process.env.PLATFORM_TOKEN = 't'
    setActive('exa')
    expect(await resolveEffectiveWebVendor()).toBe('exa')
    expect((await getActiveWebProvider())?.id).toBe('exa')
  })

  it('keeps an explicit native choice even when platform is configured', async () => {
    process.env.PLATFORM_TOKEN = 't'
    setActive('native')
    expect(await resolveEffectiveWebVendor()).toBe('native')
  })

  it('treats an unknown stored id like no pin', async () => {
    process.env.PLATFORM_TOKEN = 't'
    vi.mocked(getSettings).mockResolvedValue({ webProvider: 'bogus' } as never)
    expect(await resolveEffectiveWebVendor()).toBe('platform')
  })

  it('defaults to platform when unset and a Gamut login is present', async () => {
    process.env.PLATFORM_TOKEN = 't'
    setActive(undefined)
    expect(await resolveEffectiveWebVendor()).toBe('platform')
  })

  it('defaults to native when unset (does not auto-pick Exa, even with EXA_API_KEY)', async () => {
    process.env.EXA_API_KEY = 'k'
    setActive(undefined)
    expect(await resolveEffectiveWebVendor()).toBe('native')
    delete process.env.EXA_API_KEY
    expect(await resolveEffectiveWebVendor()).toBe('native')
  })
})
