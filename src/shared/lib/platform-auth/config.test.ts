import { afterEach, describe, expect, it, vi } from 'vitest'

import { getPlatformBaseUrl, getPlatformProxyBaseUrl, httpsBaseUrlOrEmpty, dashboardSharingStatus, miniAppBaseUrlOrEmpty } from './config'

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

  describe('dashboardSharingStatus', () => {
    it('reports enabled with the public URL when a valid https base is set', () => {
      process.env.PLATFORM_BASE_URL = 'https://app.example.com'
      const line = dashboardSharingStatus()
      expect(line).toContain('enabled')
      expect(line).toContain('https://app.example.com')
    })

    it('reports disabled and echoes the bad value when the base is set but not public https', () => {
      process.env.PLATFORM_BASE_URL = 'http://localhost:47891'
      const line = dashboardSharingStatus()
      expect(line).toContain('disabled')
      expect(line).toContain('http://localhost:47891')
    })

    it('reports disabled with a "not set" note when no base is configured', () => {
      delete process.env.PLATFORM_BASE_URL
      const line = dashboardSharingStatus()
      expect(line).toContain('disabled')
      expect(line.toLowerCase()).toContain('no platform_base_url')
    })
  })

  describe('miniAppBaseUrlOrEmpty', () => {
    const prevType = (process as { type?: string }).type
    afterEach(() => {
      if (prevType === undefined) delete (process as { type?: string }).type
      else (process as { type?: string }).type = prevType
    })

    it('returns the public https base in web/server mode', () => {
      delete (process as { type?: string }).type
      process.env.PLATFORM_BASE_URL = 'https://app.example.com'
      expect(miniAppBaseUrlOrEmpty()).toBe('https://app.example.com')
    })

    it('returns empty in Electron (process.type=browser) even with a valid https base baked in', () => {
      ;(process as { type?: string }).type = 'browser'
      process.env.PLATFORM_BASE_URL = 'https://app.example.com'
      expect(miniAppBaseUrlOrEmpty()).toBe('')
    })
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
