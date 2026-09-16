import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ watch: vi.fn(), stop: vi.fn() }))
vi.mock('./google-passkey-recovery', () => ({
  GooglePasskeyRecovery: class { watch = h.watch; stop = h.stop },
}))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({ app: {} }),
  getEffectiveBrowserbaseApiKey: () => 'test-key',
  getEffectiveBrowserbaseProjectId: () => 'test-project',
}))
vi.mock('@shared/lib/config/data-dir', () => ({ getDataDir: () => '/test-data' }))
vi.mock('@shared/lib/services/platform-auth-service', () => ({ getPlatformAccessToken: () => 'test-token' }))
vi.mock('@shared/lib/platform-auth/config', () => ({ getPlatformProxyBaseUrl: () => 'https://platform.test' }))
vi.mock('./context-map-store', () => ({ getOrCreateMapping: async () => 'test-context' }))

import { BrowserbaseProvider } from './browserbase-provider'
import { PlatformBrowserProvider } from './platform-provider'

let available = true
let sessionStatus = 'RUNNING'
let created = 0
beforeEach(() => {
  vi.clearAllMocks()
  available = true
  sessionStatus = 'RUNNING'
  created = 0
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn(async (input: string, options?: RequestInit) => {
    if (input.endsWith('/debug')) return Response.json({ wsUrl: available ? `wss://test/debug/${created}` : undefined })
    if (input.endsWith('/sessions') && options?.method === 'POST') {
      created++
      return Response.json({ id: `session-${created}`, connectUrl: `wss://test/single-use/${created}`, status: 'RUNNING', keepAlive: true })
    }
    return Response.json({ status: sessionStatus })
  }))
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

for (const Provider of [BrowserbaseProvider, PlatformBrowserProvider]) {
  describe(`${Provider.name} passkey recovery lifecycle`, () => {
    it('watches the reusable debug connection on launch and reuse, and stops before release', async () => {
      const provider = new Provider()
      expect(await provider.launch('instance')).toEqual({ cdpUrl: 'wss://test/debug/1' })
      expect(h.watch).toHaveBeenLastCalledWith('instance', 'wss://test/debug/1')
      await provider.launch('instance')
      expect(created).toBe(1)
      expect(h.watch).toHaveBeenCalledTimes(2)
      await provider.stop('instance')
      expect(h.stop).toHaveBeenCalledWith('instance')
      expect(h.stop.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(fetch).mock.invocationCallOrder.at(-1)!)
    })

    it('preserves the single-use fallback URL for the agent', async () => {
      available = false
      const provider = new Provider()
      expect(await provider.launch('instance')).toEqual({ cdpUrl: 'wss://test/single-use/1' })
      expect(h.watch).not.toHaveBeenCalled()
      await provider.stop('instance')
    })

    it('disposes observers for expired sessions before starting their replacement', async () => {
      const provider = new Provider()
      await provider.launch('instance')
      sessionStatus = 'COMPLETED'
      await provider.launch('instance')
      expect(h.stop).toHaveBeenCalledWith('instance')
      expect(h.watch).toHaveBeenLastCalledWith('instance', 'wss://test/debug/2')
      expect(h.stop.mock.invocationCallOrder[0]).toBeLessThan(h.watch.mock.invocationCallOrder[1])
      await provider.stopAll()
    })
  })
}
