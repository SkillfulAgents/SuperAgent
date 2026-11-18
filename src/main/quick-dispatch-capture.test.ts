import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The overlay window, recorded; the picture and the machine around it, stubbed.
const { FakeWindow, getSources, mediaStatus } = vi.hoisted(() => {
  class FakeWindow {
    static all: FakeWindow[] = []
    options: Record<string, unknown>
    destroyed = false
    webContents = {
      once: vi.fn((event: string, callback: () => void) => {
        if (event === 'did-finish-load') queueMicrotask(callback)
      }),
      executeJavaScript: vi.fn((_code: string) => Promise.resolve()),
      send: vi.fn(),
    }
    setContentProtection = vi.fn()
    setIgnoreMouseEvents = vi.fn()
    setAlwaysOnTop = vi.fn()
    setVisibleOnAllWorkspaces = vi.fn()
    setBounds = vi.fn()
    showInactive = vi.fn()
    hide = vi.fn()
    loadURL = vi.fn(() => Promise.resolve())
    destroy = vi.fn(() => { this.destroyed = true })
    isDestroyed = () => this.destroyed
    constructor(options: Record<string, unknown>) {
      this.options = options
      FakeWindow.all.push(this)
    }
  }
  return { FakeWindow, getSources: vi.fn(), mediaStatus: vi.fn() }
})

const DISPLAY = { id: 7, bounds: { x: 0, y: 0, width: 1512, height: 982 }, size: { width: 1512, height: 982 }, scaleFactor: 2 }

vi.mock('electron', () => ({
  BrowserWindow: FakeWindow,
  desktopCapturer: { getSources },
  screen: { getDisplayMatching: () => DISPLAY },
  systemPreferences: { getMediaAccessStatus: mediaStatus },
}))
vi.mock('child_process', () => ({ execFile: vi.fn() }))
vi.mock('fs', () => ({ default: { existsSync: () => false } }))

import {
  captureQuickDispatchScreen,
  prepareQuickDispatchCapture,
  releaseQuickDispatchCapture,
  setQuickDispatchCaptureTarget,
} from './quick-dispatch-capture'

const realPlatform = process.platform

function picture() {
  const resize = vi.fn(() => ({ toPNG: () => Buffer.from([1, 2, 3]) }))
  return { isEmpty: () => false, resize, toJPEG: () => Buffer.from([9]) }
}

function launcher() {
  return {
    setContentProtection: vi.fn(),
    getBounds: () => ({ x: 396, y: 196, width: 720, height: 106 }),
    getContentBounds: () => ({ x: 396, y: 216, width: 720, height: 106 }),
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  }
}

type Launcher = ReturnType<typeof launcher>
const capture = (win: Launcher) => captureQuickDispatchScreen(win as never)
const overlayWindow = () => FakeWindow.all.at(-1)!
const overlayScripts = () => overlayWindow().webContents.executeJavaScript.mock.calls.map(([code]) => code)

/** A capture the test finishes when it says. */
function pendingCapture() {
  let finish!: (sources: unknown[]) => void
  getSources.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  return (image = picture()) => finish([{ display_id: '7', thumbnail: image }])
}

describe('the launcher screenshot', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    FakeWindow.all = []
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    mediaStatus.mockReturnValue('granted')
  })

  afterEach(() => {
    releaseQuickDispatchCapture()
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', { value: realPlatform })
  })

  it('without Screen Recording, says so and shows nothing', async () => {
    mediaStatus.mockReturnValue('denied')
    const win = launcher()

    await expect(capture(win)).resolves.toEqual({ ok: false, reason: 'permission' })
    expect(win.setContentProtection).not.toHaveBeenCalled()
    expect(FakeWindow.all).toHaveLength(0)
  })

  it('answers the click with the flash and the shutter before the picture exists', async () => {
    const finish = pendingCapture()
    const win = launcher()

    const result = capture(win)
    await vi.advanceTimersByTimeAsync(0)
    // The flash, then the shutter (the fallback sound: this test's machine has no system one).
    expect(overlayScripts()).toEqual(['window.__flash()', 'window.__click?.()'])
    expect(overlayWindow().showInactive).toHaveBeenCalledTimes(1)
    // Neither window is in the picture; the launcher stays on screen.
    expect(overlayWindow().setContentProtection).toHaveBeenCalledWith(true)
    expect(win.setContentProtection).toHaveBeenLastCalledWith(true)

    finish()
    await expect(result).resolves.toMatchObject({ ok: true, png: new Uint8Array([1, 2, 3]), name: expect.stringMatching(/^Screenshot .+\.png$/) })
    expect(win.setContentProtection).toHaveBeenLastCalledWith(false)
    expect(overlayScripts()[2]).toMatch(/^window\.__show\("data:image\/jpeg;base64,/)
    // Shown and sounded once, at the click.
    expect(overlayWindow().showInactive).toHaveBeenCalledTimes(1)
    expect(overlayScripts().filter((code) => code === 'window.__click?.()')).toHaveLength(1)
  })

  it('takes the display at full resolution and attaches it at its size in points', async () => {
    const image = picture()
    getSources.mockResolvedValue([{ display_id: '7', thumbnail: image }])

    await capture(launcher())
    expect(getSources).toHaveBeenCalledWith({ types: ['screen'], thumbnailSize: { width: 3024, height: 1964 } })
    expect(image.resize).toHaveBeenCalledWith({ width: 1512, height: 982, quality: 'best' })
  })

  it('builds the overlay when the toggle is pointed at, and reuses it', async () => {
    const win = launcher()
    prepareQuickDispatchCapture(win as never)
    expect(FakeWindow.all).toHaveLength(1)
    expect(overlayWindow().options).toMatchObject({ show: false, focusable: false, transparent: true, ...DISPLAY.bounds })
    expect(overlayWindow().setIgnoreMouseEvents).toHaveBeenCalledWith(true)
    expect(overlayWindow().setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver')

    getSources.mockResolvedValue([{ display_id: '7', thumbnail: picture() }])
    await capture(win)
    await vi.advanceTimersByTimeAsync(2_000)
    await capture(win)
    expect(FakeWindow.all).toHaveLength(1)
  })

  it('lands the picture on the chip, then hides the overlay for the next one', async () => {
    getSources.mockResolvedValue([{ display_id: '7', thumbnail: picture() }])
    const win = launcher()
    await capture(win)

    setQuickDispatchCaptureTarget({ x: 16, y: 14, width: 44, height: 44 })
    await vi.advanceTimersByTimeAsync(0)
    expect(overlayScripts()).toContain('window.__fly({"x":412,"y":230,"width":44,"height":44})')
    expect(overlayWindow().hide).toHaveBeenCalled()
    expect(overlayWindow().destroy).not.toHaveBeenCalled()
    expect(win.webContents.send).toHaveBeenCalledWith('quick-dispatch:capture-landed')
  })

  it('fades the picture out when the chip never shows', async () => {
    getSources.mockResolvedValue([{ display_id: '7', thumbnail: picture() }])
    await capture(launcher())

    await vi.advanceTimersByTimeAsync(1_600)
    expect(overlayScripts()).toContain('window.__dismiss()')
    expect(overlayWindow().hide).toHaveBeenCalled()
  })

  it('a failed capture fades the flash and lets go of the launcher', async () => {
    getSources.mockResolvedValue([])
    const win = launcher()

    await expect(capture(win)).resolves.toEqual({ ok: false, reason: 'failed' })
    await vi.advanceTimersByTimeAsync(0)
    expect(overlayScripts()).toContain('window.__dismiss()')
    expect(win.setContentProtection).toHaveBeenLastCalledWith(false)
    expect(overlayWindow().hide).toHaveBeenCalled()
  })

  it('before the first capture has asked for Screen Recording, shows no flash and offers no picture', async () => {
    // The first capture is what asks; macOS hands back the wallpaper meanwhile.
    mediaStatus.mockReturnValue('not-determined')
    getSources.mockResolvedValue([{ display_id: '7', thumbnail: picture() }])
    const win = launcher()

    await expect(capture(win)).resolves.toEqual({ ok: false, reason: 'permission' })
    expect(overlayScripts()).not.toContain('window.__flash()')
    expect(overlayWindow().showInactive).not.toHaveBeenCalled()
  })

  it('a closed launcher ends the flight at once and closes the overlay', async () => {
    getSources.mockResolvedValue([{ display_id: '7', thumbnail: picture() }])
    const win = launcher()
    await capture(win)

    releaseQuickDispatchCapture()
    expect(overlayWindow().destroy).toHaveBeenCalled()
    expect(win.setContentProtection).toHaveBeenLastCalledWith(false)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(overlayScripts()).not.toContain('window.__dismiss()')
  })
})
