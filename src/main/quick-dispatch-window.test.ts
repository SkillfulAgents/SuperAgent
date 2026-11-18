import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// A stand-in BrowserWindow that records its construction options and calls.
const { FakeWindow, glassAvailable, applyGlass } = vi.hoisted(() => {
  class FakeWindow {
    static last: FakeWindow | null = null
    options: Record<string, unknown>
    webContents = { on: vi.fn(), once: vi.fn(), send: vi.fn() }
    setAlwaysOnTop = vi.fn()
    setVisibleOnAllWorkspaces = vi.fn()
    setVibrancy = vi.fn()
    loadURL = vi.fn(() => Promise.resolve())
    loadFile = vi.fn(() => Promise.resolve())
    on = vi.fn()
    destroy = vi.fn()
    isDestroyed = () => false
    constructor(options: Record<string, unknown>) {
      this.options = options
      FakeWindow.last = this
    }
  }
  return { FakeWindow, glassAvailable: vi.fn(), applyGlass: vi.fn() }
})

vi.mock('electron', () => ({
  app: { dock: { show: () => Promise.resolve() } },
  BrowserWindow: FakeWindow,
  screen: {},
}))
vi.mock('./dashboard-window', () => ({ installPopupHandler: vi.fn() }))
vi.mock('./quick-dispatch-glass', () => ({
  quickDispatchGlassAvailable: glassAvailable,
  applyQuickDispatchGlass: applyGlass,
  loadQuickDispatchGlass: () => Promise.resolve(),
}))

import { closeQuickDispatchWindow, getQuickDispatchWindow } from './quick-dispatch-window'

const realPlatform = process.platform

function build(): InstanceType<typeof FakeWindow> {
  getQuickDispatchWindow()
  return FakeWindow.last!
}

describe('quick-dispatch window material (macOS)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    delete process.env.ELECTRON_RENDERER_URL
  })

  afterEach(() => {
    closeQuickDispatchWindow()
    Object.defineProperty(process, 'platform', { value: realPlatform })
  })

  it('builds a transparent window with Liquid Glass and tells the renderer', () => {
    glassAvailable.mockReturnValue(true)
    applyGlass.mockReturnValue(true)
    const win = build()

    expect(win.options).toMatchObject({ transparent: true, backgroundColor: '#00000000', visualEffectState: 'active' })
    expect(win.options).not.toHaveProperty('vibrancy')
    expect(applyGlass).toHaveBeenCalledWith(win)
    expect(win.setVibrancy).not.toHaveBeenCalled()
    expect(win.loadFile).toHaveBeenCalledWith(expect.stringMatching(/quick-dispatch\.html$/), { query: { material: 'glass' } })
  })

  it('falls back to active vibrancy when the glass fails to apply, without telling the renderer it has glass', () => {
    glassAvailable.mockReturnValue(true)
    applyGlass.mockReturnValue(false)
    const win = build()

    expect(win.options).toMatchObject({ transparent: true, visualEffectState: 'active' })
    expect(win.setVibrancy).toHaveBeenCalledWith('under-window')
    expect(win.loadFile).toHaveBeenCalledWith(expect.any(String), { query: undefined })
  })

  it('keeps the vibrancy window when Liquid Glass is unavailable', () => {
    glassAvailable.mockReturnValue(false)
    const win = build()

    expect(win.options).toMatchObject({ transparent: false, vibrancy: 'under-window', visualEffectState: 'active' })
    expect(win.options).not.toHaveProperty('backgroundColor')
    expect(applyGlass).not.toHaveBeenCalled()
    expect(win.loadFile).toHaveBeenCalledWith(expect.any(String), { query: undefined })
  })

  it('passes the glass material on the dev server URL', () => {
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173'
    glassAvailable.mockReturnValue(true)
    applyGlass.mockReturnValue(true)
    const win = build()

    expect(win.loadURL).toHaveBeenCalledWith('http://localhost:5173/quick-dispatch.html?material=glass')
  })
})
