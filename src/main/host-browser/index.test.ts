import { describe, it, expect, vi } from 'vitest'

// stopInstanceOnAllProviders must stop an instance's browser on EVERY
// provider, independent of which provider is currently selected in settings —
// the user can switch providers while a browser from the previous one is
// still running, and agent deletion must not leave that browser alive while
// its profile directory is removed.

const h = vi.hoisted(() => {
  const created: Array<{ id: string; isRunning: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = []
  function makeProviderClass(id: string, running: (instanceId: string) => boolean) {
    return class {
      id = id
      name = id
      onExternalClose = null
      isRunning = vi.fn(running)
      stop = vi.fn(async () => {})
      stopAll = vi.fn(async () => {})
      detect = vi.fn()
      launch = vi.fn()
      constructor() {
        created.push(this as never)
      }
    }
  }
  return { created, makeProviderClass }
})

vi.mock('./chrome-provider', () => ({
  ChromeProvider: h.makeProviderClass('chrome', (instanceId: string) => instanceId === 'agent1'),
}))
vi.mock('./browserbase-provider', () => ({
  BrowserbaseProvider: h.makeProviderClass('browserbase', () => false),
}))
vi.mock('./platform-provider', () => ({
  PlatformBrowserProvider: h.makeProviderClass('platform', () => false),
}))

// The active provider is NOT chrome — proves the stop is provider-independent.
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({ app: { hostBrowserProvider: 'browserbase' } }),
}))

import { stopInstanceOnAllProviders } from './index'

describe('stopInstanceOnAllProviders', () => {
  it('stops a running instance on a non-active provider and skips idle providers', async () => {
    await stopInstanceOnAllProviders('agent1')

    const chrome = h.created.find((p) => p.id === 'chrome')!
    const browserbase = h.created.find((p) => p.id === 'browserbase')!
    const platform = h.created.find((p) => p.id === 'platform')!

    expect(chrome.stop).toHaveBeenCalledWith('agent1')
    expect(browserbase.stop).not.toHaveBeenCalled()
    expect(platform.stop).not.toHaveBeenCalled()
  })

  it('is a no-op for an instance no provider is running', async () => {
    await stopInstanceOnAllProviders('agent-unknown')
    for (const provider of h.created) {
      expect(provider.stop).not.toHaveBeenCalledWith('agent-unknown')
    }
  })
})
