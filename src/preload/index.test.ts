import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  send: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  removeAllListeners: vi.fn(),
  removeListener: vi.fn(),
  getPathForFile: vi.fn(),
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: electronMocks.exposeInMainWorld,
  },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    send: electronMocks.send,
    on: electronMocks.on,
    off: electronMocks.off,
    removeAllListeners: electronMocks.removeAllListeners,
    removeListener: electronMocks.removeListener,
  },
  webUtils: {
    getPathForFile: electronMocks.getPathForFile,
  },
}))

type ExposedApi = {
  [key: string]: unknown
  getApiUrl: () => Promise<string>
  platform: string
  osVersion: string
  openExternal: (url: string) => Promise<void>
  revealInFolder: (hostPath: string) => Promise<string | null>
  createDockShortcut: (agentSlug: string, dashboardSlug: string, dashboardName: string, iconPng: Uint8Array) => Promise<void>
  getPathForFile: (file: File) => string
  showNotification: (
    title: string,
    body: string,
    actions?: Array<{ text: string }>,
    context?: unknown,
  ) => Promise<void>
  minimizeWindow: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  onNavigateToAgent: (callback: (agentSlug: string, sessionId?: string | null) => void) => void
  removeNavigateToAgent: () => void
  onHistoryNavigationCommand: (callback: (command: 'back' | 'forward') => void) => void
  removeHistoryNavigationCommand: () => void
  onNotificationEvent: (
    callback: (event: { type: 'click' | 'action'; actionIndex?: number; context?: unknown }) => void,
  ) => () => void
  onUpdateStatus: (callback: (status: unknown) => void) => () => void
  removeUpdateStatus: () => void
}

const processWithSystemVersion = process as typeof process & {
  getSystemVersion?: () => string
}

const originalGetSystemVersion = processWithSystemVersion.getSystemVersion

async function loadApi(): Promise<ExposedApi> {
  vi.resetModules()
  electronMocks.exposeInMainWorld.mockClear()

  await import('./index')

  expect(electronMocks.exposeInMainWorld).toHaveBeenCalledWith('electronAPI', expect.any(Object))
  return electronMocks.exposeInMainWorld.mock.calls[0][1] as ExposedApi
}

describe('preload electronAPI bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    processWithSystemVersion.getSystemVersion = () => '14.4.1'
  })

  afterEach(() => {
    if (originalGetSystemVersion) {
      processWithSystemVersion.getSystemVersion = originalGetSystemVersion
    } else {
      Reflect.deleteProperty(processWithSystemVersion, 'getSystemVersion')
    }
  })

  it('exposes stable metadata and invoke wrappers without exposing ipcRenderer', async () => {
    const api = await loadApi()

    electronMocks.invoke.mockResolvedValueOnce('http://localhost:3173')
    await expect(api.getApiUrl()).resolves.toBe('http://localhost:3173')
    expect(electronMocks.invoke).toHaveBeenCalledWith('get-api-url')

    await api.openExternal('https://example.com')
    expect(electronMocks.invoke).toHaveBeenLastCalledWith('open-external', 'https://example.com')

    await api.revealInFolder('/workspace/reports/notes.md')
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(
      'reveal-in-folder',
      '/workspace/reports/notes.md',
    )

    await api.showNotification('Ready', 'The job finished', [{ text: 'Open' }], { sessionId: 's1' })
    expect(electronMocks.invoke).toHaveBeenLastCalledWith('show-notification', {
      title: 'Ready',
      body: 'The job finished',
      actions: [{ text: 'Open' }],
      context: { sessionId: 's1' },
    })

    await api.createDockShortcut('agent-one', 'dashboard-one', 'Dashboard', new Uint8Array([1, 2, 3]))
    expect(electronMocks.invoke).toHaveBeenLastCalledWith('create-dock-shortcut', {
      agentSlug: 'agent-one',
      dashboardSlug: 'dashboard-one',
      dashboardName: 'Dashboard',
      iconPng: [1, 2, 3],
    })

    expect(api.platform).toBe(process.platform)
    expect(api.osVersion).toBe('14.4.1')
    expect(api).not.toHaveProperty('ipcRenderer')
  })

  it('maps one-way window commands to ipcRenderer.send channels', async () => {
    const api = await loadApi()

    api.minimizeWindow()
    api.setSidebarCollapsed(true)

    expect(electronMocks.send).toHaveBeenCalledWith('window-minimize')
    expect(electronMocks.send).toHaveBeenCalledWith('set-sidebar-collapsed', true)
  })

  it('forwards navigation events and removes channel listeners', async () => {
    const api = await loadApi()
    const callback = vi.fn()

    api.onNavigateToAgent(callback)

    const handler = electronMocks.on.mock.calls.find(([channel]) => channel === 'navigate-to-agent')?.[1] as
      | ((event: unknown, agentSlug: string, sessionId?: string | null) => void)
      | undefined
    expect(handler).toBeDefined()

    handler?.({}, 'agent-one', 'session-one')
    expect(callback).toHaveBeenCalledWith('agent-one', 'session-one')

    api.removeNavigateToAgent()
    expect(electronMocks.removeAllListeners).toHaveBeenCalledWith('navigate-to-agent')
  })

  it('forwards history navigation commands and filters invalid payloads', async () => {
    const api = await loadApi()
    const callback = vi.fn()

    api.onHistoryNavigationCommand(callback)

    const handler = electronMocks.on.mock.calls.find(([channel]) => channel === 'history-navigation-command')?.[1] as
      | ((event: unknown, command: string) => void)
      | undefined
    expect(handler).toBeDefined()

    handler?.({}, 'back')
    handler?.({}, 'forward')
    handler?.({}, 'sideways')
    expect(callback).toHaveBeenCalledTimes(2)
    expect(callback).toHaveBeenNthCalledWith(1, 'back')
    expect(callback).toHaveBeenNthCalledWith(2, 'forward')

    api.removeHistoryNavigationCommand()
    expect(electronMocks.removeAllListeners).toHaveBeenCalledWith('history-navigation-command')
  })

  it('returns a precise unsubscribe for notification events', async () => {
    const api = await loadApi()
    const callback = vi.fn()

    const unsubscribe = api.onNotificationEvent(callback)
    const handler = electronMocks.on.mock.calls.find(([channel]) => channel === 'notification-event')?.[1] as
      | ((event: unknown, payload: { type: 'click' | 'action'; actionIndex?: number; context?: unknown }) => void)
      | undefined
    expect(handler).toBeDefined()

    handler?.({}, { type: 'action', actionIndex: 0, context: { agentSlug: 'agent-one' } })
    expect(callback).toHaveBeenCalledWith({ type: 'action', actionIndex: 0, context: { agentSlug: 'agent-one' } })

    unsubscribe()
    expect(electronMocks.off).toHaveBeenCalledWith('notification-event', handler)
  })

  it('uses removeListener for update-status unsubscribe and supports bulk cleanup', async () => {
    const api = await loadApi()
    const callback = vi.fn()

    const unsubscribe = api.onUpdateStatus(callback)
    const handler = electronMocks.on.mock.calls.find(([channel]) => channel === 'update-status')?.[1] as
      | ((event: unknown, status: unknown) => void)
      | undefined
    expect(handler).toBeDefined()

    handler?.({}, { state: 'downloaded' })
    expect(callback).toHaveBeenCalledWith({ state: 'downloaded' })

    unsubscribe()
    expect(electronMocks.removeListener).toHaveBeenCalledWith('update-status', handler)

    api.removeUpdateStatus()
    expect(electronMocks.removeAllListeners).toHaveBeenCalledWith('update-status')
  })

  it('delegates dropped-file path resolution to Electron webUtils', async () => {
    const api = await loadApi()
    const file = {} as File
    electronMocks.getPathForFile.mockReturnValue('/Users/test/file.txt')

    expect(api.getPathForFile(file)).toBe('/Users/test/file.txt')
    expect(electronMocks.getPathForFile).toHaveBeenCalledWith(file)
  })
})
