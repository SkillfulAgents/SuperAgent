import { afterEach, describe, expect, it, vi } from 'vitest'

import { getPlatformBaseUrl, getPlatformProxyBaseUrl, httpsBaseUrlOrEmpty } from './config'

describe('platform auth config', () => {
  afterEach(() => {
    delete process.env.PLATFORM_BASE_URL
    delete process.env.PLATFORM_PROXY_URL
    vi.unstubAllGlobals()
  })

  it('prefers runtime env for platform base URL', () => {
    process.env.PLATFORM_BASE_URL = 'https://runtime.example.com'
    vi.stubGlobal('__PLATFORM_BASE_URL__', 'https://build.example.com')

    expect(getPlatformBaseUrl()).toBe('https://runtime.example.com')
  })

  it('falls back to build-time platform base URL', () => {
    vi.stubGlobal('__PLATFORM_BASE_URL__', 'https://build.example.com')

    expect(getPlatformBaseUrl()).toBe('https://build.example.com')
  })

  it('normalizes proxy URL from build-time config', () => {
    vi.stubGlobal('__PLATFORM_PROXY_URL__', 'https://proxy.example.com/v1/')

    expect(getPlatformProxyBaseUrl()).toBe('https://proxy.example.com')
  })

  describe('httpsBaseUrlOrEmpty', () => {
    it('returns the URL unchanged when it is https', () => {
      expect(httpsBaseUrlOrEmpty('https://host.example')).toBe('https://host.example')
    })

    it('returns empty string for a non-https (http) URL', () => {
      expect(httpsBaseUrlOrEmpty('http://host.example')).toBe('')
    })

    it('returns empty string for an empty or malformed URL', () => {
      expect(httpsBaseUrlOrEmpty('')).toBe('')
      expect(httpsBaseUrlOrEmpty('not a url')).toBe('')
    })
  })
})
