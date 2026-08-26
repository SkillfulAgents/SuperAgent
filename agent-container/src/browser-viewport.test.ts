import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import { inputManager } from './input-manager'
import {
  setViewportChannel,
  syncBrowserViewport,
  requestDesktopWidth,
  detachViewportChannel,
  startBrowserViewportSync,
} from './browser-viewport'

type Sent = { method: string; params?: Record<string, unknown> }

/** Register a recording channel and return the CDP calls it writes into. */
function recordCdp(): Sent[] {
  const sent: Sent[] = []
  setViewportChannel({
    sendCdp: (method, params) => sent.push({ method, params }),
    reportDesktopWidth: () => {},
  })
  return sent
}

/** Register a channel and return the modes reported to the viewer. */
function recordModes(): boolean[] {
  const modes: boolean[] = []
  setViewportChannel({ sendCdp: () => {}, reportDesktopWidth: (v) => modes.push(v) })
  return modes
}

/** Register a browser_input pending without awaiting it — the promise only
 *  settles when the user answers, so awaiting here would hang the test. */
function openHandoff(id: string, sessionId?: string): void {
  void inputManager
    .createPendingWithType(id, 'browser_input', { message: 'Log in.' }, sessionId)
    .catch(() => {})
}

describe('browser viewport', () => {
  beforeAll(() => {
    startBrowserViewportSync()
  })

  beforeEach(() => {
    // Drop the sender first so the reset sync below emits nothing, then let the
    // no-pending sync clear any escape flag through the same path production uses.
    setViewportChannel(null)
    inputManager.rejectByType('browser_input', 'test reset')
    inputManager.rejectByType('secret', 'test reset')
    syncBrowserViewport()
  })

  // Literals, not the production constants: importing those would make this
  // assertion follow any change to them instead of catching it.
  it('narrows while a browser_input handoff is pending', () => {
    const sent = recordCdp()
    openHandoff('t-1')

    expect(sent.at(-1)).toEqual({
      method: 'Emulation.setDeviceMetricsOverride',
      params: { width: 450, height: 900, deviceScaleFactor: 1, mobile: false },
    })
  })

  it('clears when nothing is pending', () => {
    const sent = recordCdp()

    syncBrowserViewport()

    expect(sent).toEqual([
      { method: 'Emulation.clearDeviceMetricsOverride', params: undefined },
    ])
  })

  // The tray reads only the latest request, but a second agent can open its own
  // handoff. Resolving one must not un-narrow the page the user is still typing into.
  it('stays narrow while a second handoff is still open', () => {
    openHandoff('t-1')
    openHandoff('t-2')
    const sent = recordCdp()

    inputManager.resolve('t-1', 'done')
    syncBrowserViewport()

    expect(sent.at(-1)!.method).toBe('Emulation.setDeviceMetricsOverride')
  })

  // Other input types share the pending map. Only browser_input is a handoff.
  it('ignores pendings of other input types', () => {
    void inputManager.createPendingWithType('s-1', 'secret', {}).catch(() => {})
    const sent = recordCdp()

    syncBrowserViewport()

    expect(sent.at(-1)!.method).toBe('Emulation.clearDeviceMetricsOverride')
  })

  it('clears while the user has asked for desktop width, and narrows again when they toggle back', () => {
    openHandoff('t-1')
    const sent = recordCdp()

    requestDesktopWidth(true)
    expect(sent.at(-1)!.method).toBe('Emulation.clearDeviceMetricsOverride')

    requestDesktopWidth(false)
    expect(sent.at(-1)!.method).toBe('Emulation.setDeviceMetricsOverride')
  })

  // The flag is scoped to one handoff. A user who escaped a hostile login page
  // must not silently get desktop width on their next, unrelated handoff.
  it('drops the desktop request once the last handoff closes', () => {
    openHandoff('t-1')
    const sent = recordCdp()
    requestDesktopWidth(true)

    inputManager.resolve('t-1', 'done')
    syncBrowserViewport() // no pendings — resets the flag

    openHandoff('t-2')
    syncBrowserViewport()

    expect(sent.at(-1)!.method).toBe('Emulation.setDeviceMetricsOverride')
  })

  // The tray renders the reported mode directly instead of inferring it from
  // frame width, so a report that disagrees with the CDP call misdraws the toggle.
  it('reports the mode it applied to the viewer', () => {
    openHandoff('t-1')
    const modes = recordModes()

    syncBrowserViewport()
    expect(modes.at(-1)).toBe(false)

    requestDesktopWidth(true)
    expect(modes.at(-1)).toBe(true)

    inputManager.resolve('t-1', 'done')
    syncBrowserViewport()
    expect(modes.at(-1)).toBe(false)
  })

  // The toggle is live as soon as the viewer socket opens, which can be before
  // CDP attaches. A click in that gap has no channel to send on, so the flag has
  // to survive until attach derives it.
  it('remembers a desktop request made before a channel exists', () => {
    openHandoff('t-1')
    setViewportChannel(null)
    requestDesktopWidth(true)

    const sent = recordCdp()
    syncBrowserViewport()

    expect(sent.at(-1)!.method).toBe('Emulation.clearDeviceMetricsOverride')
  })

  // The whole point of subscribing to the input manager rather than calling sync
  // at each route: a route that clears the last handoff re-derives even though
  // nothing here calls syncBrowserViewport. Three of these were missed when the
  // rule was written out by hand at each call site.
  describe('re-derives on every route that clears the last handoff', () => {
    const routes: Array<[string, () => void]> = [
      ['resolve', () => { inputManager.resolve('r-1', 'done') }],
      ['reject', () => { inputManager.reject('r-1', 'declined') }],
      ['reject by type (browser close)', () => { inputManager.rejectByType('browser_input', 'closed') }],
      ['session delete', () => { inputManager.rejectForSession('sess-1') }],
      ['stale sweep', () => { inputManager.cleanupStale(Date.now() + 25 * 60 * 60 * 1000) }],
    ]

    for (const [name, clear] of routes) {
      it(name, () => {
        openHandoff('r-1', 'sess-1')
        const sent = recordCdp()
        syncBrowserViewport()
        expect(sent.at(-1)!.method).toBe('Emulation.setDeviceMetricsOverride')

        clear()

        expect(sent.at(-1)!.method).toBe('Emulation.clearDeviceMetricsOverride')
      })
    }
  })

  // Opening a handoff must narrow immediately, not on the next unrelated event.
  it('re-derives when a handoff opens', () => {
    const sent = recordCdp()
    syncBrowserViewport()
    expect(sent.at(-1)!.method).toBe('Emulation.clearDeviceMetricsOverride')

    openHandoff('r-2')

    expect(sent.at(-1)!.method).toBe('Emulation.setDeviceMetricsOverride')
  })

  // Viewer reconnect tears the screencast down and attaches again. Escape must
  // survive that path so the tray and the page stay on desktop width.
  it('keeps the desktop request across detach while a handoff is pending', () => {
    openHandoff('t-1')
    const sent = recordCdp()
    requestDesktopWidth(true)
    expect(sent.at(-1)!.method).toBe('Emulation.clearDeviceMetricsOverride')

    detachViewportChannel()
    const sent2 = recordCdp()
    syncBrowserViewport()

    expect(sent2.at(-1)!.method).toBe('Emulation.clearDeviceMetricsOverride')
  })
})
