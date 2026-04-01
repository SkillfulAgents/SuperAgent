import { afterEach, describe, expect, it, vi } from 'vitest'

import { getPlatformBaseUrl, getPlatformProxyBaseUrl } from './config'

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
})
