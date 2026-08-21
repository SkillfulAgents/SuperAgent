import { beforeEach, describe, expect, it, vi } from 'vitest'

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

const { createdWindows, ensureCloudDashboardSession } = vi.hoisted(() => ({
  createdWindows: [] as FakeWindow[],
  ensureCloudDashboardSession: vi.fn(),
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
  return { BrowserWindow, session: { defaultSession: { cookies: {} }, fromPartition: vi.fn() } }
})

vi.mock('./safe-open-external', () => ({ safeOpenExternal: vi.fn() }))
vi.mock('./cloud-dashboard-session', () => ({ ensureCloudDashboardSession }))

import { openDashboardWindow, closeAllDashboardWindows } from './dashboard-window'

const LOCAL = 'http://localhost:3838'
const DOOR = 'http://localhost:3838/cloud/KEY123'
const CLOUD_ORIGIN = 'https://ws.example.com'

beforeEach(() => {
  closeAllDashboardWindows()
  createdWindows.length = 0
  ensureCloudDashboardSession.mockReset()
  ensureCloudDashboardSession.mockResolvedValue({ useCloudOrigin: false, origin: null })
})

describe('popout origin', () => {
  it('loads the local API for a local target', async () => {
    ensureCloudDashboardSession.mockResolvedValue({
      useCloudOrigin: true,
      origin: CLOUD_ORIGIN,
    })
    await openDashboardWindow('sales', 'weekly', LOCAL)
    expect(ensureCloudDashboardSession).toHaveBeenCalledWith('local')
    expect(createdWindows[0].loadURL).toHaveBeenCalledWith(
      'http://localhost:3838/api/agents/sales/artifacts/weekly/view',
    )
    expect(createdWindows[0].options.webPreferences.partition).toBeUndefined()
  })

  it('loads the cloud origin when the jar has a cookie', async () => {
    ensureCloudDashboardSession.mockResolvedValue({
      useCloudOrigin: true,
      origin: CLOUD_ORIGIN,
    })
    await openDashboardWindow('sales', 'weekly', DOOR)
    expect(ensureCloudDashboardSession).toHaveBeenCalledWith('cloud')
    expect(createdWindows[0].loadURL).toHaveBeenCalledWith(
      'https://ws.example.com/api/agents/sales/artifacts/weekly/view',
    )
    expect(createdWindows[0].options.webPreferences.partition).toBeUndefined()
  })

  it('falls back to the door when the cookie is missing', async () => {
    await openDashboardWindow('sales', 'weekly', DOOR)
    expect(createdWindows[0].loadURL).toHaveBeenCalledWith(
      'http://localhost:3838/cloud/KEY123/api/agents/sales/artifacts/weekly/view',
    )
  })
})

describe('popout identity', () => {
  it('does not reuse a local window for a cloud dashboard of the same name', async () => {
    await openDashboardWindow('sales', 'weekly', LOCAL)
    await openDashboardWindow('sales', 'weekly', DOOR)
    expect(createdWindows).toHaveLength(2)
  })

  it('still reuses the window for a repeat request on the same target', async () => {
    await openDashboardWindow('sales', 'weekly', DOOR)
    await openDashboardWindow('sales', 'weekly', DOOR)
    expect(createdWindows).toHaveLength(1)
    expect(createdWindows[0].focus).toHaveBeenCalled()
  })
})

describe('marking a cloud popout', () => {
  it('keeps the workspace visible in the title the dashboard sets', async () => {
    await openDashboardWindow('sales', 'weekly', DOOR)
    const event = { preventDefault: vi.fn() }
    createdWindows[0].handlers['page-title-updated'](event, 'Weekly — Gamut')
    expect(event.preventDefault).toHaveBeenCalled()
    expect(createdWindows[0].setTitle).toHaveBeenCalledWith('Cloud workspace — Weekly — Gamut')
  })

  it('marks a direct cloud origin as a cloud workspace', async () => {
    ensureCloudDashboardSession.mockResolvedValue({
      useCloudOrigin: true,
      origin: CLOUD_ORIGIN,
    })
    await openDashboardWindow('sales', 'weekly', DOOR)
    expect(createdWindows[0].handlers['page-title-updated']).toBeDefined()
  })

  it('leaves a local popout’s title to the dashboard', async () => {
    await openDashboardWindow('sales', 'weekly', LOCAL)
    expect(createdWindows[0].handlers['page-title-updated']).toBeUndefined()
  })
})
