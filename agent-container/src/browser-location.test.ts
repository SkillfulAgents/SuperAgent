import { describe, expect, it } from 'vitest'
import {
  isLoopbackBrowserUrl,
  requiresBrowserLocationSwitch,
  resolveBrowserRuntimeLocation,
} from './browser-location'

describe('resolveBrowserRuntimeLocation', () => {
  it('uses the configured host provider by default when one is available', () => {
    expect(resolveBrowserRuntimeLocation('configured', true)).toBe('host')
  })

  it('falls back to bundled Chromium when no host provider is configured', () => {
    expect(resolveBrowserRuntimeLocation('configured', false)).toBe('container')
  })

  it('forces bundled Chromium even when a host provider is configured', () => {
    expect(resolveBrowserRuntimeLocation('container', true)).toBe('container')
  })
})

describe('requiresBrowserLocationSwitch', () => {
  it('switches only when a live browser is in a different location', () => {
    expect(requiresBrowserLocationSwitch('host', 'container')).toBe(true)
    expect(requiresBrowserLocationSwitch('container', 'container')).toBe(false)
    expect(requiresBrowserLocationSwitch(null, 'host')).toBe(false)
  })
})

describe('isLoopbackBrowserUrl', () => {
  it.each([
    'http://localhost:3000',
    'https://127.0.0.1/app',
    'http://0.0.0.0:5173',
    'http://[::1]:8080',
  ])('recognizes %s', (url) => {
    expect(isLoopbackBrowserUrl(url)).toBe(true)
  })

  it('does not treat external or malformed URLs as loopback', () => {
    expect(isLoopbackBrowserUrl('https://example.com')).toBe(false)
    expect(isLoopbackBrowserUrl('not a url')).toBe(false)
  })
})
