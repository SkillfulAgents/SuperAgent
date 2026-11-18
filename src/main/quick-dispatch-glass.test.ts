import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { existsSync, load, supported, applyNative } = vi.hoisted(() => ({
  existsSync: vi.fn(),
  load: vi.fn(),
  supported: vi.fn(),
  applyNative: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/app' },
}))
vi.mock('fs', () => ({ default: { existsSync } }))
vi.mock('koffi', () => ({ load }))

const realPlatform = process.platform

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform })
}

/** A fresh module per test: the bridge is loaded once per process. */
async function importGlass() {
  vi.resetModules()
  return import('./quick-dispatch-glass')
}

/** A stand-in BrowserWindow whose native handle holds view address 0x1234. */
function fakeWindow() {
  const handle = Buffer.alloc(8)
  handle.writeBigUInt64LE(0x1234n)
  return { getNativeWindowHandle: () => handle } as unknown as import('electron').BrowserWindow
}

describe('quick-dispatch glass', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setPlatform('darwin')
    existsSync.mockReturnValue(true)
    supported.mockReturnValue(true)
    applyNative.mockReturnValue(null)
    load.mockReturnValue({
      func: (signature: string) => (signature.includes('glass_supported') ? supported : applyNative),
    })
  })

  afterEach(() => {
    setPlatform(realPlatform)
    vi.restoreAllMocks()
  })

  it('is unavailable off macOS, without looking for the bridge', async () => {
    setPlatform('win32')
    const glass = await importGlass()
    await glass.loadQuickDispatchGlass()

    expect(glass.quickDispatchGlassAvailable()).toBe(false)
    expect(existsSync).not.toHaveBeenCalled()
  })

  it('is unavailable when the bridge was not built', async () => {
    existsSync.mockReturnValue(false)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const glass = await importGlass()
    await glass.loadQuickDispatchGlass()

    expect(glass.quickDispatchGlassAvailable()).toBe(false)
    expect(load).not.toHaveBeenCalled()
  })

  it('is unavailable on a macOS without Liquid Glass', async () => {
    supported.mockReturnValue(false)
    const glass = await importGlass()
    await glass.loadQuickDispatchGlass()

    expect(glass.quickDispatchGlassAvailable()).toBe(false)
    expect(glass.applyQuickDispatchGlass(fakeWindow())).toBe(false)
    expect(applyNative).not.toHaveBeenCalled()
  })

  it('is unavailable when the bridge fails to load', async () => {
    load.mockImplementation(() => {
      throw new Error('dlopen failed')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const glass = await importGlass()
    await glass.loadQuickDispatchGlass()

    expect(glass.quickDispatchGlassAvailable()).toBe(false)
  })

  it('applies the frosted Clear glass behind the window view', async () => {
    const glass = await importGlass()
    await glass.loadQuickDispatchGlass()

    expect(glass.quickDispatchGlassAvailable()).toBe(true)
    expect(load).toHaveBeenCalledWith('/app/build/glass-bridge/libGlassBridge.dylib')
    expect(glass.applyQuickDispatchGlass(fakeWindow())).toBe(true)
    expect(applyNative).toHaveBeenCalledWith(0x1234n, JSON.stringify(glass.QUICK_DISPATCH_GLASS))
    expect(glass.QUICK_DISPATCH_GLASS).toMatchObject({ style: 1, tint: '#FFFFFF1A', tintDark: '#1C1C1E1F' })
  })

  it('reports a failed apply so the window can fall back to vibrancy', async () => {
    applyNative.mockReturnValue('NSGlassEffectView is not available (needs macOS 26)')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const glass = await importGlass()
    await glass.loadQuickDispatchGlass()

    expect(glass.applyQuickDispatchGlass(fakeWindow())).toBe(false)
  })

  it('reports a throwing native call as a failed apply instead of throwing', async () => {
    applyNative.mockImplementation(() => {
      throw new TypeError('Unexpected value for argument 1')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const glass = await importGlass()
    await glass.loadQuickDispatchGlass()

    expect(glass.applyQuickDispatchGlass(fakeWindow())).toBe(false)
  })

  it('loads the bridge once', async () => {
    const glass = await importGlass()
    await Promise.all([glass.loadQuickDispatchGlass(), glass.loadQuickDispatchGlass()])

    expect(load).toHaveBeenCalledTimes(1)
  })
})
