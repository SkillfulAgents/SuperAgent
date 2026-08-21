import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The overlay covers the window while a switch reloads it, which means it also
 * swallows every click while it is up. Nothing here is about how the animation
 * looks; it is all about the band coming down — on the signal, on the watchdog,
 * on a second switch, and when the window disappears underneath it.
 */

type FakeView = {
  setBackgroundColor: ReturnType<typeof vi.fn>
  setBounds: ReturnType<typeof vi.fn>
  webContents: {
    loadURL: ReturnType<typeof vi.fn>
    executeJavaScript: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    isDestroyed: ReturnType<typeof vi.fn>
  }
}

const { createdViews } = vi.hoisted(() => ({ createdViews: [] as FakeView[] }))

vi.mock('electron', () => {
  const WebContentsView = vi.fn(function () {
    const view: FakeView = {
      setBackgroundColor: vi.fn(),
      setBounds: vi.fn(),
      webContents: {
        loadURL: vi.fn(),
        executeJavaScript: vi.fn(async () => undefined),
        close: vi.fn(),
        isDestroyed: vi.fn(() => false),
      },
    }
    createdViews.push(view)
    return view
  })
  return { app: { isPackaged: true }, WebContentsView, nativeTheme: { shouldUseDarkColors: false } }
})

import {
  showTargetSwitchOverlay,
  finishTargetSwitchOverlay,
  removeTargetSwitchOverlay,
  _hasTargetSwitchOverlayForTest,
} from './target-switch-overlay'

function fakeWindow(overrides: Record<string, unknown> = {}) {
  const listeners: Record<string, () => void> = {}
  const contentsListeners: Record<string, () => void> = {}
  return {
    isDestroyed: vi.fn(() => false),
    getContentBounds: vi.fn(() => ({ x: 0, y: 0, width: 1200, height: 800 })),
    webContents: {
      capturePage: vi.fn(async () => ({
        isEmpty: () => false,
        // Not resized: the still is used at the display's own resolution.
        toDataURL: () => 'data:image/png;base64,AAA',
      })),
      once: vi.fn((event: string, cb: () => void) => {
        contentsListeners[event] = cb
      }),
      off: vi.fn(),
    },
    contentsListeners,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    on: vi.fn((event: string, cb: () => void) => {
      listeners[event] = cb
    }),
    off: vi.fn(),
    listeners,
    ...overrides,
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any -- the fakes stand in for Electron types */
const show = (win: ReturnType<typeof fakeWindow>) => showTargetSwitchOverlay(win as any)

/**
 * Dismiss and let the clock run out. The band is held for a minimum crossing
 * before it fades, so a test that simply awaits the call would wait on a timer
 * nobody advanced.
 */
async function dismiss(): Promise<void> {
  const done = finishTargetSwitchOverlay()
  await vi.advanceTimersByTimeAsync(3_000)
  await done
}

beforeEach(() => {
  createdViews.length = 0
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  removeTargetSwitchOverlay()
  vi.useRealTimers()
})

describe('showTargetSwitchOverlay', () => {
  it('puts a view over the window content, sized to it', async () => {
    const win = fakeWindow()
    await show(win)

    expect(win.contentView.addChildView).toHaveBeenCalledWith(createdViews[0])
    expect(createdViews[0].setBounds).toHaveBeenCalledWith({
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
    })
  })

  it('paints the outgoing view underneath, so the reload is not a hole', async () => {
    await show(fakeWindow())

    const html = decodeURIComponent(createdViews[0].webContents.loadURL.mock.calls[0][0] as string)
    expect(html).toContain('data:image/png;base64,AAA')
  })

  it('still covers the window when the frame could not be captured', async () => {
    const win = fakeWindow()
    win.webContents.capturePage = vi.fn(async () => {
      throw new Error('window gone')
    })

    await show(win)

    expect(_hasTargetSwitchOverlayForTest()).toBe(true)
    expect(win.contentView.addChildView).toHaveBeenCalled()
  })

  it('does nothing for a window that is already gone', async () => {
    await show(fakeWindow({ isDestroyed: vi.fn(() => true) }))

    expect(createdViews).toHaveLength(0)
    expect(_hasTargetSwitchOverlayForTest()).toBe(false)
  })

  it('replaces an overlay still up from a previous switch rather than stacking', async () => {
    const win = fakeWindow()
    await show(win)
    await show(win)

    expect(createdViews).toHaveLength(2)
    // The first was taken down; only one band can be up to take down later.
    expect(win.contentView.removeChildView).toHaveBeenCalledWith(createdViews[0])
    expect(createdViews[0].webContents.close).toHaveBeenCalled()
  })

  it('takes the view back off when raising the band fails halfway through', async () => {
    // The dangerous window is between the view going on and the watchdog being
    // armed: nothing is tracking it yet, so a throw in there would leave the
    // window covered by something with no way down. `window.on` is the first
    // call after the view is attached.
    const win = fakeWindow()
    win.on = vi.fn(() => {
      throw new Error('window closed')
    })

    await show(win)

    expect(_hasTargetSwitchOverlayForTest()).toBe(false)
    expect(win.contentView.removeChildView).toHaveBeenCalledWith(createdViews[0])
    expect(createdViews[0].webContents.close).toHaveBeenCalled()
  })

  it('keeps the band on the window as it is resized', async () => {
    const win = fakeWindow()
    await show(win)
    win.getContentBounds.mockReturnValue({ x: 0, y: 0, width: 640, height: 480 })

    win.listeners.resize()

    expect(createdViews[0].setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 0,
      width: 640,
      height: 480,
    })
  })
})

describe('finishTargetSwitchOverlay', () => {
  it('fades the still off the new view, then removes it', async () => {
    const win = fakeWindow()
    await show(win)

    await dismiss()

    expect(createdViews[0].webContents.executeJavaScript).toHaveBeenCalled()
    expect(win.contentView.removeChildView).toHaveBeenCalledWith(createdViews[0])
    expect(_hasTargetSwitchOverlayForTest()).toBe(false)
  })

  it('dissolves the still while the band is still crossing, not after it', async () => {
    // Otherwise the whole change of contents lands in one cut at the end, which
    // is the thing the band was covering for.
    const win = fakeWindow()
    await show(win)

    const finished = finishTargetSwitchOverlay()
    await vi.advanceTimersByTimeAsync(0)

    const scripts = createdViews[0].webContents.executeJavaScript.mock.calls.map(([js]) => js)
    expect(scripts).toEqual(['window.__reveal?.()'])
    expect(win.contentView.removeChildView).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(3_000)
    await finished

    const after = createdViews[0].webContents.executeJavaScript.mock.calls.map(([js]) => js)
    expect(after).toEqual(['window.__reveal?.()', 'window.__dismiss?.()'])
  })

  it('still uncovers the window when the dissolve cannot be delivered', async () => {
    const win = fakeWindow()
    await show(win)
    createdViews[0].webContents.executeJavaScript.mockRejectedValue(new Error('gone'))

    await dismiss()

    expect(win.contentView.removeChildView).toHaveBeenCalledWith(createdViews[0])
  })

  it('stops listening for resizes once it is down', async () => {
    const win = fakeWindow()
    await show(win)

    await dismiss()

    expect(win.off).toHaveBeenCalledWith('resize', expect.any(Function))
  })

  it('is safe when no switch is in progress', async () => {
    // Every boot signals that it painted, not just the ones that follow a switch.
    await expect(finishTargetSwitchOverlay()).resolves.toBeUndefined()
    expect(createdViews).toHaveLength(0)
  })

  it('takes the overlay down once when signalled twice', async () => {
    await show(fakeWindow())

    const both = Promise.all([finishTargetSwitchOverlay(), finishTargetSwitchOverlay()])
    await vi.advanceTimersByTimeAsync(3_000)
    await both

    expect(createdViews[0].webContents.close).toHaveBeenCalledTimes(1)
  })

  it('comes down even if the overlay document never answers', async () => {
    await show(fakeWindow())
    createdViews[0].webContents.executeJavaScript.mockRejectedValue(new Error('not loaded'))

    await dismiss()

    expect(_hasTargetSwitchOverlayForTest()).toBe(false)
    expect(createdViews[0].webContents.close).toHaveBeenCalled()
  })

  it('comes down even if the fade never answers', async () => {
    // `executeJavaScript` can sit unresolved against a document that never
    // finished loading. This await is the last thing between the user and a
    // window nothing can uncover, so it has to be bounded.
    const win = fakeWindow()
    await show(win)
    createdViews[0].webContents.executeJavaScript.mockReturnValue(new Promise(() => {}))

    const finished = finishTargetSwitchOverlay()
    await vi.advanceTimersByTimeAsync(3_000)
    await finished

    expect(_hasTargetSwitchOverlayForTest()).toBe(false)
    expect(createdViews[0].webContents.close).toHaveBeenCalled()
  })

  it('leaves the watchdog armed while the fade is in flight', async () => {
    // The dismissal path clears `active` before awaiting, so a watchdog that
    // only knew about "the active overlay" would have nothing left to rescue.
    const win = fakeWindow()
    await show(win)
    createdViews[0].webContents.executeJavaScript.mockReturnValue(new Promise(() => {}))

    void finishTargetSwitchOverlay()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(win.contentView.removeChildView).toHaveBeenCalledWith(createdViews[0])
  })

  it('does not throw when the window went away under it', async () => {
    const win = fakeWindow()
    await show(win)
    win.isDestroyed.mockReturnValue(true)

    await expect(dismiss()).resolves.toBeUndefined()
    expect(win.contentView.removeChildView).not.toHaveBeenCalled()
  })
})

describe('the reloaded document loading', () => {
  // The renderer's own signal is the accurate one, but it needs the renderer to
  // reach the code that sends it. This one reaches main whatever the page does.
  it('takes the band off shortly after the new document loads, unprompted', async () => {
    const win = fakeWindow()
    await show(win)

    win.contentsListeners['did-finish-load']()
    await vi.advanceTimersByTimeAsync(1_500)

    expect(_hasTargetSwitchOverlayForTest()).toBe(false)
    expect(win.contentView.removeChildView).toHaveBeenCalledWith(createdViews[0])
  })

  it('holds the band while the document is still loading', async () => {
    const win = fakeWindow()
    await show(win)

    // Nothing loaded yet: only the watchdog may end this, and not this soon.
    await vi.advanceTimersByTimeAsync(1_500)

    expect(_hasTargetSwitchOverlayForTest()).toBe(true)
  })

  it('stops listening once the band is down', async () => {
    const win = fakeWindow()
    await show(win)

    await dismiss()

    expect(win.webContents.off).toHaveBeenCalledWith('did-finish-load', expect.any(Function))
  })

  it('does not let one switch’s fallback cut the next switch short', async () => {
    // The fallback dismisses whatever is up rather than the overlay it was armed
    // for. Left running while the first band is holding its crossing, it comes
    // due against the second switch and takes that band off before it has drawn.
    const win = fakeWindow()
    await show(win)
    // The real document holds the fade before it answers, which is what puts the
    // first overlay's teardown *after* its own fallback comes due.
    createdViews[0].webContents.executeJavaScript = vi.fn((code: string) =>
      code.includes('__dismiss')
        ? new Promise((resolve) => setTimeout(resolve, 300))
        : Promise.resolve(undefined),
    )
    win.contentsListeners['did-finish-load']()

    const first = finishTargetSwitchOverlay()
    await show(win)
    await vi.advanceTimersByTimeAsync(3_000)
    await first

    expect(_hasTargetSwitchOverlayForTest()).toBe(true)
    expect(win.contentView.removeChildView).not.toHaveBeenCalledWith(createdViews[1])
  })
})

describe('a capture that will not answer', () => {
  it('switches without a still rather than holding the click', async () => {
    // The caller is holding the user's click until this returns. On a vibrant
    // window `capturePage` can be slow or never settle at all.
    const win = fakeWindow()
    win.webContents.capturePage = vi.fn(() => new Promise(() => {}))

    const shown = show(win)
    await vi.advanceTimersByTimeAsync(1_000)
    await shown

    expect(_hasTargetSwitchOverlayForTest()).toBe(true)
    const html = decodeURIComponent(createdViews[0].webContents.loadURL.mock.calls[0][0] as string)
    expect(html).not.toContain('<img id="backdrop"')
  })
})

describe('the watchdog', () => {
  it('uncovers the window when nothing ever signals', async () => {
    const win = fakeWindow()
    await show(win)

    vi.advanceTimersByTime(10_000)

    // A renderer that fails to boot must not leave a band swallowing every click.
    expect(_hasTargetSwitchOverlayForTest()).toBe(false)
    expect(win.contentView.removeChildView).toHaveBeenCalledWith(createdViews[0])
  })

  it('does not fire after the overlay came down on its own', async () => {
    const win = fakeWindow()
    await show(win)
    await dismiss()
    win.contentView.removeChildView.mockClear()

    vi.advanceTimersByTime(10_000)

    expect(win.contentView.removeChildView).not.toHaveBeenCalled()
  })
})

describe('the minimum crossing', () => {
  // The fastest leg — back to this computer, where nothing is fetched from
  // anywhere — was over before the animation was legible.
  it('holds the band for a full crossing when the new view is ready sooner', async () => {
    const win = fakeWindow()
    await show(win)

    const finished = finishTargetSwitchOverlay()
    await vi.advanceTimersByTimeAsync(400)
    expect(_hasTargetSwitchOverlayForTest()).toBe(false) // claimed, but still on screen
    expect(win.contentView.removeChildView).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2_000)
    await finished

    expect(win.contentView.removeChildView).toHaveBeenCalledWith(createdViews[0])
  })

  it('does not add to a switch that already took longer than that', async () => {
    const win = fakeWindow()
    await show(win)
    await vi.advanceTimersByTimeAsync(2_000)

    // Past the floor, so the fade starts at once rather than after another wait.
    const finished = finishTargetSwitchOverlay()
    await vi.advanceTimersByTimeAsync(600)
    await finished

    expect(win.contentView.removeChildView).toHaveBeenCalledWith(createdViews[0])
  })
})
