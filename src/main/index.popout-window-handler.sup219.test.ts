import { describe, it, expect, vi, beforeEach } from 'vitest'

// SUP-219: dashboard popout BrowserWindows render untrusted, agent-generated
// dashboard content but never installed a `setWindowOpenHandler`, so
// window.open() fell back to Electron's default ALLOW behavior — bypassing the
// deny-and-route popup policy the main window enforces. The popout must install
// a handler that denies child windows and safely routes external URLs / file
// downloads.

type FakeWebContents = {
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  downloadURL: ReturnType<typeof vi.fn>
}
type FakeWindow = {
  webContents: FakeWebContents
  loadURL: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
}

// --- electron mock ----------------------------------------------------------
// BrowserWindow is mocked as a constructor that records the created window and
// exposes a webContents stub with spies for setWindowOpenHandler / downloadURL.
// `vi.hoisted` keeps the shared state in scope for the hoisted `vi.mock` factory.
const { openExternal, createdWindows } = vi.hoisted(() => ({
  openExternal: vi.fn(),
  createdWindows: [] as FakeWindow[],
}))

vi.mock('electron', () => {
  // Regular function (not an arrow) so `new BrowserWindow(...)` works.
  const BrowserWindow = vi.fn(function () {
    const win: FakeWindow = {
      webContents: {
        setWindowOpenHandler: vi.fn(),
        downloadURL: vi.fn(),
      },
      loadURL: vi.fn(),
      on: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      close: vi.fn(),
      isDestroyed: vi.fn(() => false),
    }
    createdWindows.push(win)
    return win
  })
  return {
    BrowserWindow,
    shell: { openExternal },
  }
})

import { openDashboardWindow, closeAllDashboardWindows } from './dashboard-window'

beforeEach(() => {
  // The module keeps a dedup Map of open windows; clear it so each test starts
  // from a clean slate and actually creates a fresh window.
  closeAllDashboardWindows()
  createdWindows.length = 0
  openExternal.mockClear()
})

describe('openDashboardWindow popup policy (SUP-219)', () => {
  it('installs a popup handler on the dashboard window webContents', () => {
    openDashboardWindow('agent-one', 'sales', 3838)

    expect(createdWindows).toHaveLength(1)
    const win = createdWindows[0]
    // The load-bearing assertion: the popout must register a window-open handler.
    expect(win.webContents.setWindowOpenHandler).toHaveBeenCalledTimes(1)
  })

  it('denies external popups and routes them through the system browser', () => {
    openDashboardWindow('agent-one', 'sales', 3838)
    const win = createdWindows[0]
    const handler = win.webContents.setWindowOpenHandler.mock.calls[0][0] as (arg: {
      url: string
    }) => { action: string }

    const result = handler({ url: 'https://example.com/evil' })

    expect(result).toEqual({ action: 'deny' })
    expect(openExternal).toHaveBeenCalledWith('https://example.com/evil')
    expect(win.webContents.downloadURL).not.toHaveBeenCalled()
  })

  it('routes /api/agents/.../files/ URLs through downloadURL and denies the popup', () => {
    openDashboardWindow('agent-one', 'sales', 3838)
    const win = createdWindows[0]
    const handler = win.webContents.setWindowOpenHandler.mock.calls[0][0] as (arg: {
      url: string
    }) => { action: string }

    const fileUrl = 'http://localhost:3838/api/agents/agent-one/files/report.csv'
    const result = handler({ url: fileUrl })

    expect(result).toEqual({ action: 'deny' })
    expect(win.webContents.downloadURL).toHaveBeenCalledWith(fileUrl)
    expect(openExternal).not.toHaveBeenCalled()
  })
})
