// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

describe('hasActivePlugins', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('disables analytics plugins in E2E mock mode', async () => {
    vi.stubGlobal('__E2E_MOCK__', true)
    vi.stubGlobal('__AMPLITUDE_API_KEY__', 'test-amplitude-key')

    const { hasActivePlugins } = await import('./analytics')

    expect(hasActivePlugins(true, [
      { type: 'amplitude', enabled: true, config: { apiKey: 'custom-key' } },
    ])).toBe(false)
  })

  it('keeps normal analytics behavior outside E2E mock mode', async () => {
    vi.stubGlobal('__E2E_MOCK__', false)
    vi.stubGlobal('__AMPLITUDE_API_KEY__', 'test-amplitude-key')

    const { hasActivePlugins } = await import('./analytics')

    expect(hasActivePlugins(true)).toBe(true)
  })
})

describe('createAnalyticsInstance', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  async function loadWith(sharedKey: string) {
    vi.stubGlobal('__E2E_MOCK__', false)
    vi.stubGlobal('__AMPLITUDE_API_KEY__', sharedKey)
    vi.stubGlobal('__APP_VERSION__', 'test')
    return import('./analytics')
  }

  function pluginNames(instance: { getState: (key: string) => unknown }) {
    return Object.keys(instance.getState('plugins') as Record<string, unknown>)
  }

  it('keeps only the first plugin when two custom Amplitude targets are enabled', async () => {
    const { createAnalyticsInstance } = await loadWith('')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const instance = createAnalyticsInstance(false, [
      { type: 'amplitude', enabled: true, config: { apiKey: 'key-a' } },
      { type: 'amplitude', enabled: true, config: { apiKey: 'key-b' } },
    ])

    expect(pluginNames(instance)).toEqual(['amplitude'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('duplicate "amplitude"'))
  })

  it('does not throw when shared analytics and a custom Amplitude target are both on', async () => {
    const { createAnalyticsInstance } = await loadWith('shared-key')
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const instance = createAnalyticsInstance(true, [
      { type: 'amplitude', enabled: true, config: { apiKey: 'custom-key' } },
    ])

    expect(pluginNames(instance)).toEqual(['amplitude'])
  })

  it('keeps one plugin per distinct target type', async () => {
    const { createAnalyticsInstance } = await loadWith('')

    const instance = createAnalyticsInstance(false, [
      { type: 'amplitude', enabled: true, config: { apiKey: 'key-a' } },
      { type: 'mixpanel', enabled: true, config: { token: 'mp-token' } },
      { type: 'google-analytics', enabled: true, config: { measurementId: 'G-TEST' } },
    ])

    expect(pluginNames(instance).sort()).toEqual(['amplitude', 'google-analytics', 'mixpanel'])
  })

  it('ignores a disabled duplicate without warning', async () => {
    const { createAnalyticsInstance } = await loadWith('')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const instance = createAnalyticsInstance(false, [
      { type: 'amplitude', enabled: true, config: { apiKey: 'key-a' } },
      { type: 'amplitude', enabled: false, config: { apiKey: 'key-b' } },
    ])

    expect(pluginNames(instance)).toEqual(['amplitude'])
    expect(warn).not.toHaveBeenCalled()
  })
})
