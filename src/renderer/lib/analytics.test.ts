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
