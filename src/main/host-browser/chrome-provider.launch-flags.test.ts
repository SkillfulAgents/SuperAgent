import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Pins the disk-growth guardrails on Chrome's launch arg list: automation
// profiles must never download the on-device Gemini Nano model (4 GB per
// profile) or browser-level component updates (~130 MB duplicated into every
// per-agent user-data-dir). Also pins that all disabled features live in ONE
// --disable-features flag — Chrome honors only the last occurrence, so a
// second flag would silently re-enable the first flag's features.

const h = vi.hoisted(() => {
  function makeChild(pid: number) {
    const handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
    return {
      pid,
      killed: false,
      stderr: { on: () => {} },
      on(ev: string, cb: (...a: unknown[]) => void) {
        ;(handlers[ev] = handlers[ev] || []).push(cb)
        return this
      },
      kill() {
        this.killed = true
        queueMicrotask(() => (handlers.exit || []).forEach((cb) => cb(0, null)))
        return true
      },
    }
  }

  class Socket {
    private _h: Record<string, () => void> = {}
    setTimeout() {}
    on(ev: string, cb: () => void) {
      this._h[ev] = cb
      return this
    }
    connect() {
      // Report the port as open so waitForPort() resolves immediately.
      queueMicrotask(() => this._h.connect?.())
      return this
    }
    destroy() {}
  }

  function makeServer() {
    const server: Record<string, unknown> = {
      listen: (_port: unknown, _host: unknown, cb?: unknown) => {
        if (typeof cb === 'function') (cb as () => void)()
        return server
      },
      on: () => server,
      address: () => ({ port: 9999 }),
      close: (cb?: unknown) => {
        if (typeof cb === 'function') (cb as () => void)()
        return server
      },
    }
    return server
  }

  const createServer = vi.fn(() => makeServer())
  const connect = vi.fn(() => ({ pipe: () => {}, on: () => {}, destroy: () => {} }))
  const netMock = { createServer, connect, Socket }
  const spawnMock = vi.fn((_cmd: string, _args: string[]) => makeChild(4321))
  const execSyncMock = vi.fn(() => '')

  return { netMock, spawnMock, execSyncMock }
})

const pm = vi.hoisted(() => ({
  markProfileInUse: vi.fn(),
  unmarkProfileInUse: vi.fn(),
  waitForBrowserProfileCleanup: vi.fn(async () => {}),
}))
vi.mock('./profile-maintenance', () => pm)

vi.mock('child_process', () => ({ spawn: h.spawnMock, execSync: h.execSyncMock }))
vi.mock('net', () => ({ default: h.netMock, ...h.netMock }))

vi.mock('fs', () => {
  const m = {
    existsSync: () => true,
    mkdirSync: () => undefined,
    rmSync: () => undefined,
    readFileSync: () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    writeFileSync: () => undefined,
    openSync: () => 1,
    fsyncSync: () => undefined,
    fchmodSync: () => undefined,
    closeSync: () => undefined,
    renameSync: () => undefined,
    statSync: () => ({ size: 0, mtimeMs: 0 }),
    accessSync: () => undefined,
    readdirSync: () => [],
    readlinkSync: () => '',
    constants: { X_OK: 1 },
    promises: {
      readdir: async () => [],
      rm: async () => undefined,
      stat: async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      },
    },
  }
  return { default: m, ...m }
})

vi.mock('@shared/lib/config/data-dir', () => ({
  getDataDir: () => '/tmp/sa-launch-flags-data',
  getAgentDownloadsDir: () => '/tmp/sa-launch-flags-downloads',
}))

vi.mock('@shared/lib/browser/chrome-profile', () => ({
  listChromeProfiles: () => [],
  copyChromeProfileData: () => false,
}))

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: () => {},
  captureMessage: () => {},
  addErrorBreadcrumb: () => {},
}))

vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: {
    getClient: () => ({
      getHostBridgeIp: () => null,
      probeHostPortFromRunner: async () => 'unknown',
    }),
  },
}))

import { ChromeProvider } from './chrome-provider'

const originalPlatform = process.platform

describe('ChromeProvider launch flags (profile disk growth)', () => {
  let provider: ChromeProvider
  let args: string[]

  beforeEach(async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    h.spawnMock.mockClear()
    pm.markProfileInUse.mockClear()
    pm.unmarkProfileInUse.mockClear()
    pm.waitForBrowserProfileCleanup.mockClear()
    provider = new ChromeProvider()
    await provider.launch('agent1')
    const call = h.spawnMock.mock.calls.find((c) =>
      Array.isArray(c[1]) && (c[1] as string[]).some((a) => a.startsWith('--remote-debugging-port='))
    )
    expect(call, 'Chrome should have been spawned').toBeTruthy()
    args = call![1] as string[]
  })

  afterEach(async () => {
    await provider.stopAll()
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  it('disables the optimization-guide on-device model download', () => {
    const disableFeatures = args.filter((a) => a.startsWith('--disable-features='))
    expect(disableFeatures).toHaveLength(1)
    const disabled = disableFeatures[0].replace('--disable-features=', '').split(',')
    expect(disabled).toContain('OptimizationGuideOnDeviceModel')
    expect(disabled).toContain('OptimizationGuideModelDownloading')
    expect(disabled).toContain('OptimizationHints')
    expect(disabled).toContain('TextSafetyClassifier')
    // The pre-existing occlusion-throttling features must remain disabled in
    // the same (single) flag.
    expect(disabled).toContain('CalculateNativeWinOcclusion')
    expect(disabled).toContain('WebContentsOcclusion')
  })

  it('disables the component updater', () => {
    expect(args).toContain('--disable-component-update')
  })

  it('claims the profile before waiting on the cleanup sweep, which precedes the spawn', () => {
    // Mark BEFORE wait: a sweep firing between the two would see the claim and
    // skip this profile; marking after the wait leaves a window where the
    // sweep deletes directories under a spawning Chrome.
    expect(pm.markProfileInUse).toHaveBeenCalledWith('agent1')
    const markOrder = pm.markProfileInUse.mock.invocationCallOrder[0]
    const waitOrder = pm.waitForBrowserProfileCleanup.mock.invocationCallOrder[0]
    const spawnOrder = h.spawnMock.mock.invocationCallOrder[0]
    expect(markOrder).toBeLessThan(waitOrder)
    expect(waitOrder).toBeLessThan(spawnOrder)
  })

  it('releases the profile claim on stop', async () => {
    expect(pm.unmarkProfileInUse).not.toHaveBeenCalledWith('agent1')
    await provider.stop('agent1')
    expect(pm.unmarkProfileInUse).toHaveBeenCalledWith('agent1')
  })
})
