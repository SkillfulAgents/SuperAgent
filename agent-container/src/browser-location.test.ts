import { describe, expect, it } from 'vitest'
import {
  isLoopbackBrowserUrl,
  requiresBrowserLocationSwitch,
  resolveBrowserRuntimeLocation,
  shouldRefuseImplicitHostLoopback,
} from './browser-location'

describe('resolveBrowserRuntimeLocation', () => {
  it('uses the configured host provider when no browser is live', () => {
    expect(resolveBrowserRuntimeLocation(undefined, null, true)).toBe('host')
  })

  it('falls back to bundled Chromium when no host provider is configured', () => {
    expect(resolveBrowserRuntimeLocation(undefined, null, false)).toBe('container')
  })

  it('keeps an existing container browser when location is omitted', () => {
    expect(resolveBrowserRuntimeLocation(undefined, 'container', true)).toBe('container')
  })

  it('keeps an existing host browser when location is omitted', () => {
    expect(resolveBrowserRuntimeLocation(undefined, 'host', true)).toBe('host')
  })

  it('forces bundled Chromium even when a host provider is configured', () => {
    expect(resolveBrowserRuntimeLocation('container', 'host', true)).toBe('container')
  })

  it('switches back to the configured host only when explicitly requested', () => {
    expect(resolveBrowserRuntimeLocation('configured', 'container', true)).toBe('host')
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

describe('shouldRefuseImplicitHostLoopback', () => {
  it('refuses an omitted-location loopback open that would target the host', () => {
    expect(shouldRefuseImplicitHostLoopback('http://localhost:5000', undefined, 'host')).toBe(true)
  })

  it('allows loopback in container Chromium and explicit host-loopback requests', () => {
    expect(shouldRefuseImplicitHostLoopback('http://localhost:5000', undefined, 'container')).toBe(false)
    expect(shouldRefuseImplicitHostLoopback('http://localhost:5000', 'configured', 'host')).toBe(false)
    expect(shouldRefuseImplicitHostLoopback('http://localhost:5000', 'container', 'container')).toBe(false)
  })
})
