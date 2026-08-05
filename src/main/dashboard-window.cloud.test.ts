import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A dashboard popout is built in main, so it is told which Superagent it is
 * for. Three things follow from that, and each of them failed silently: the
 * window looks identical either way, and a dashboard that renders is a
 * dashboard nobody checks.
 */

type FakeWindow = {
  webContents: { setWindowOpenHandler: ReturnType<typeof vi.fn>; downloadURL: ReturnType<typeof vi.fn> }
  loadURL: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  setTitle: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  options: Record<string, any>
  handlers: Record<string, (...args: any[]) => void>
}

const { createdWindows, partitions, onBeforeRequest } = vi.hoisted(() => ({
  createdWindows: [] as FakeWindow[],
  partitions: [] as string[],
  onBeforeRequest: vi.fn(),
}))

vi.mock('electron', () => {
  const BrowserWindow = vi.fn(function (options: Record<string, any>) {
    const handlers: Record<string, (...args: any[]) => void> = {}
    const win: FakeWindow = {
      webContents: { setWindowOpenHandler: vi.fn(), downloadURL: vi.fn() },
      loadURL: vi.fn(),
      on: vi.fn((event: string, cb: (...args: any[]) => void) => {
        handlers[event] = cb
      }),
      setTitle: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      close: vi.fn(),
      isDestroyed: vi.fn(() => false),
      options,
      handlers,
    }
    createdWindows.push(win)
    return win
  })
  const session = {
    fromPartition: vi.fn((partition: string) => {
      partitions.push(partition)
      return { webRequest: { onBeforeRequest } }
    }),
  }
  return { BrowserWindow, session }
})

vi.mock('./safe-open-external', () => ({ safeOpenExternal: vi.fn() }))

import { openDashboardWindow, closeAllDashboardWindows } from './dashboard-window'

const LOCAL = 'http://localhost:3838'
const CLOUD = 'http://localhost:3838/api/cloud-proxy/KEY123'

/** Run the registered rewrite over a URL and report where it ends up. */
function routeThroughRewrite(url: string): string {
  const listener = onBeforeRequest.mock.calls.at(-1)?.[1] as (
    d: { url: string },
    cb: (r: { redirectURL?: string }) => void,
  ) => void
  let result = url
  listener({ url }, (response) => {
    if (response.redirectURL) result = response.redirectURL
  })
  return result
}

beforeEach(() => {
  closeAllDashboardWindows()
  createdWindows.length = 0
  partitions.length = 0
  onBeforeRequest.mockClear()
})

describe('keeping a cloud popout inside the proxy', () => {
  // Only the document URL carries the proxy prefix. The wrapper the deployment
  // serves back builds its status poll, its start-the-agent POST and its iframe
  // from a root-relative `/api/agents/{slug}` — which resolves against the
  // laptop's own API. The window looks right and drives the local Superagent.
  it('sends a root-relative API call back through the proxy', () => {
    openDashboardWindow('sales', 'weekly', CLOUD)

    expect(routeThroughRewrite('http://localhost:3838/api/agents/sales/start')).toBe(
      'http://localhost:3838/api/cloud-proxy/KEY123/api/agents/sales/start',
    )
  })

  it('leaves an already-proxied call alone, so it cannot double up', () => {
    openDashboardWindow('sales', 'weekly', CLOUD)

    const proxied = 'http://localhost:3838/api/cloud-proxy/KEY123/api/agents/sales/artifacts'
    expect(routeThroughRewrite(proxied)).toBe(proxied)
  })

  it('leaves non-API requests on the origin alone', () => {
    openDashboardWindow('sales', 'weekly', CLOUD)

    expect(routeThroughRewrite('http://localhost:3838/assets/app.css')).toBe(
      'http://localhost:3838/assets/app.css',
    )
  })

  it('confines the rewrite to its own session, never the app’s', () => {
    // On the default session this would rewrite the main window's requests too.
    openDashboardWindow('sales', 'weekly', CLOUD)

    expect(partitions).toEqual(['cloud-dashboard:/api/cloud-proxy/KEY123'])
    expect(createdWindows[0].options.webPreferences.partition).toBe(
      'cloud-dashboard:/api/cloud-proxy/KEY123',
    )
  })

  it('does none of this for a local popout', () => {
    openDashboardWindow('sales', 'weekly', LOCAL)

    expect(onBeforeRequest).not.toHaveBeenCalled()
    expect(partitions).toEqual([])
    expect(createdWindows[0].options.webPreferences.partition).toBeUndefined()
  })
})

describe('popout identity', () => {
  it('does not reuse a local window for a cloud dashboard of the same name', () => {
    // Two deployments can hold an agent of the same slug. Reusing the window
    // shows the wrong one's dashboard under the right one's name.
    openDashboardWindow('sales', 'weekly', LOCAL)
    openDashboardWindow('sales', 'weekly', CLOUD)

    expect(createdWindows).toHaveLength(2)
  })

  it('still reuses the window for a repeat request on the same target', () => {
    openDashboardWindow('sales', 'weekly', CLOUD)
    openDashboardWindow('sales', 'weekly', CLOUD)

    expect(createdWindows).toHaveLength(1)
    expect(createdWindows[0].focus).toHaveBeenCalled()
  })
})

describe('marking a cloud popout', () => {
  it('keeps the workspace visible in the title the dashboard sets', () => {
    // The wrapper replaces the generic title with the dashboard's own name, so
    // an unmarked cloud popout is indistinguishable from a local one.
    openDashboardWindow('sales', 'weekly', CLOUD)

    const event = { preventDefault: vi.fn() }
    createdWindows[0].handlers['page-title-updated'](event, 'Weekly — Gamut')

    expect(event.preventDefault).toHaveBeenCalled()
    expect(createdWindows[0].setTitle).toHaveBeenCalledWith('Cloud workspace — Weekly — Gamut')
  })

  it('leaves a local popout’s title to the dashboard', () => {
    openDashboardWindow('sales', 'weekly', LOCAL)
    expect(createdWindows[0].handlers['page-title-updated']).toBeUndefined()
  })
})
