import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// SUP-264: when the window is closed (app still in the tray/dock), clicking a
// top-menu item recreates the window but the command must NOT be sent live —
// the renderer's IPC listeners aren't mounted yet, so it would be lost. It's
// queued instead and replayed by the renderer on mount. These tests exercise
// that queueing through the real menu click handlers.

const { fetchAgentsWithStatus } = vi.hoisted(() => ({
  fetchAgentsWithStatus: vi.fn(),
}))
vi.mock('./agent-status', () => ({ fetchAgentsWithStatus }))

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

import { createAppMenu, destroyAppMenu, flushPendingMenuCommands } from './app-menu'

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

// createAppMenu kicks off the async buildAppMenu (fire-and-forget); wait for it
// to finish, then return the captured menu template.
async function buildMenuWithNoWindow(): Promise<TemplateItem[]> {
  createAppMenu(null, 0)
  await vi.waitFor(() => expect(setApplicationMenu).toHaveBeenCalled())
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
    fetchAgentsWithStatus.mockReset()
    flushPendingMenuCommands() // drain any leftover from a prior test
  })

  afterEach(() => {
    destroyAppMenu()
    if (originalRendererUrl === undefined) delete process.env.ELECTRON_RENDERER_URL
    else process.env.ELECTRON_RENDERER_URL = originalRendererUrl
  })

  it('queues open-settings and recreates the window instead of sending live', async () => {
    fetchAgentsWithStatus.mockResolvedValue([])
    const template = await buildMenuWithNoWindow()

    findItem(template, 'Settings...')!.click!()

    expect(appEmit).toHaveBeenCalledWith('activate')
    expect(flushPendingMenuCommands()).toEqual([{ channel: 'open-settings' }])
    // The queue is drained on read — a second flush returns nothing.
    expect(flushPendingMenuCommands()).toEqual([])
  })

  it('queues navigate-to-agent with the clicked agent slug', async () => {
    fetchAgentsWithStatus.mockResolvedValue([
      { slug: 'alpha', name: 'Alpha', activityStatus: 'idle' },
    ])
    const template = await buildMenuWithNoWindow()

    findItem(template, 'Alpha')!.click!()

    expect(flushPendingMenuCommands()).toEqual([
      { channel: 'navigate-to-agent', agentSlug: 'alpha' },
    ])
  })

  it('keeps only the latest command per channel (no duplicate dialogs/agents)', async () => {
    fetchAgentsWithStatus.mockResolvedValue([
      { slug: 'alpha', name: 'Alpha', activityStatus: 'idle' },
      { slug: 'beta', name: 'Beta', activityStatus: 'idle' },
    ])
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
