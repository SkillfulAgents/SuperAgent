import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// SUP-264: when the window is closed (app still in the tray/dock), clicking a
// top-menu item recreates the window but the command must NOT be sent live —
// the renderer's IPC listeners aren't mounted yet, so it would be lost. It's
// queued instead and replayed by the renderer on mount. These tests exercise
// that queueing through the real menu click handlers.

// The menu is drawn from the shared agent list; here the list is whatever the
// test says, handed over when the menu subscribes.
const { agentList } = vi.hoisted(() => ({
  agentList: { value: [] as Array<{ slug: string; name: string; activityStatus: string }> },
}))
vi.mock('./agent-status-source', () => ({
  agentStatusSource: {
    subscribe: (listener: (agents: typeof agentList.value) => void) => {
      listener(agentList.value)
      return () => {}
    },
  },
}))

const { buildFromTemplate, setApplicationMenu, appEmit } = vi.hoisted(() => ({
  buildFromTemplate: vi.fn((template: unknown) => ({ template })),
  setApplicationMenu: vi.fn(),
  appEmit: vi.fn(),
}))
vi.mock('electron', () => ({
  Menu: { buildFromTemplate, setApplicationMenu },
  BrowserWindow: class {},
  app: { emit: appEmit },
  nativeImage: { createFromPath: vi.fn(() => ({})) },
}))

import { createAppMenu, destroyAppMenu, flushPendingMenuCommands, sendMenuCommand, updateAppMenuWindow } from './app-menu'

interface TemplateItem {
  label?: string
  click?: () => void
  submenu?: TemplateItem[]
}

function findItem(items: TemplateItem[], label: string): TemplateItem | undefined {
  for (const item of items) {
    if (item.label === label) return item
    if (item.submenu) {
      const found = findItem(item.submenu, label)
      if (found) return found
    }
  }
  return undefined
}

// createAppMenu builds the menu when the agent list is handed over; return the
// captured menu template.
async function buildMenuWithNoWindow(): Promise<TemplateItem[]> {
  createAppMenu(null)
  expect(setApplicationMenu).toHaveBeenCalled()
  const lastCall = buildFromTemplate.mock.calls.at(-1)
  return (lastCall?.[0] ?? []) as TemplateItem[]
}

describe('SUP-264: menu commands queue while the window is closed', () => {
  // Route status-icon loading through the dev (__dirname) branch of getIconDir so
  // it doesn't touch process.resourcesPath, which is undefined outside Electron.
  const originalRendererUrl = process.env.ELECTRON_RENDERER_URL
  beforeEach(() => {
    process.env.ELECTRON_RENDERER_URL = 'http://localhost'
    buildFromTemplate.mockClear()
    setApplicationMenu.mockClear()
    appEmit.mockClear()
    agentList.value = []
    flushPendingMenuCommands() // drain any leftover from a prior test
  })

  afterEach(() => {
    destroyAppMenu()
    if (originalRendererUrl === undefined) delete process.env.ELECTRON_RENDERER_URL
    else process.env.ELECTRON_RENDERER_URL = originalRendererUrl
  })

  it('queues open-settings and recreates the window instead of sending live', async () => {
    agentList.value = []
    const template = await buildMenuWithNoWindow()

    findItem(template, 'Settings...')!.click!()

    expect(appEmit).toHaveBeenCalledWith('activate')
    expect(flushPendingMenuCommands()).toEqual([{ channel: 'open-settings' }])
    // The queue is drained on read — a second flush returns nothing.
    expect(flushPendingMenuCommands()).toEqual([])
  })

  it('queues navigate-to-agent with the clicked agent slug', async () => {
    agentList.value = [
      { slug: 'alpha', name: 'Alpha', activityStatus: 'idle' },
    ]
    const template = await buildMenuWithNoWindow()

    findItem(template, 'Alpha')!.click!()

    expect(flushPendingMenuCommands()).toEqual([
      { channel: 'navigate-to-agent', agentSlug: 'alpha' },
    ])
  })

  it('keeps only the latest command per channel (no duplicate dialogs/agents)', async () => {
    agentList.value = [
      { slug: 'alpha', name: 'Alpha', activityStatus: 'idle' },
      { slug: 'beta', name: 'Beta', activityStatus: 'idle' },
    ]
    const template = await buildMenuWithNoWindow()

    findItem(template, 'New Agent')!.click!()
    findItem(template, 'New Agent')!.click!() // duplicate — must collapse
    findItem(template, 'Alpha')!.click!()
    findItem(template, 'Beta')!.click!() // newer target wins

    expect(flushPendingMenuCommands()).toEqual([
      { channel: 'open-create-agent' },
      { channel: 'navigate-to-agent', agentSlug: 'beta' },
    ])
  })
})

describe('sendMenuCommand', () => {
  beforeEach(() => {
    appEmit.mockClear()
    flushPendingMenuCommands()
  })

  afterEach(() => {
    destroyAppMenu()
  })

  it('queues a target switch and a session navigation while the window is closed', () => {
    updateAppMenuWindow(null)
    sendMenuCommand({ channel: 'switch-target', target: 'cloud' })
    sendMenuCommand({ channel: 'navigate-to-agent', agentSlug: 'alpha', sessionId: 's1' })

    expect(appEmit).toHaveBeenCalledWith('activate')
    expect(flushPendingMenuCommands()).toEqual([
      { channel: 'switch-target', target: 'cloud' },
      { channel: 'navigate-to-agent', agentSlug: 'alpha', sessionId: 's1' },
    ])
  })

  it('queues while the window is still loading, and sends live once it has loaded', () => {
    const send = vi.fn()
    let loading = true
    const win = {
      isDestroyed: () => false,
      show: vi.fn(),
      focus: vi.fn(),
      webContents: { isLoading: () => loading, send },
    }
    updateAppMenuWindow(win as unknown as Parameters<typeof updateAppMenuWindow>[0])

    sendMenuCommand({ channel: 'switch-target', target: 'local' })
    expect(send).not.toHaveBeenCalled()
    expect(flushPendingMenuCommands()).toEqual([{ channel: 'switch-target', target: 'local' }])

    loading = false
    sendMenuCommand({ channel: 'navigate-to-agent', agentSlug: 'alpha', sessionId: null })
    expect(send).toHaveBeenCalledWith('navigate-to-agent', 'alpha', null)
    expect(flushPendingMenuCommands()).toEqual([])
  })
})
