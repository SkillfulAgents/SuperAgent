import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Same race as app-menu.stale-poll.test.ts, on the tray's side: an in-flight
// poll against the previous target must not overwrite the menu a target-switch
// refresh already painted.

import type { AgentInfo } from './agent-status'

const { fetchAgentsWithStatus } = vi.hoisted(() => ({
  fetchAgentsWithStatus: vi.fn(),
}))
vi.mock('./agent-status', () => ({ fetchAgentsWithStatus }))

const { buildFromTemplate, setContextMenu } = vi.hoisted(() => ({
  buildFromTemplate: vi.fn((template: unknown) => ({ template })),
  setContextMenu: vi.fn(),
}))
vi.mock('electron', () => ({
  Tray: class {
    setToolTip() {}
    on() {}
    setContextMenu = setContextMenu
    destroy() {}
  },
  Menu: { buildFromTemplate },
  BrowserWindow: class {},
  app: { emit: vi.fn(), quit: vi.fn() },
  nativeImage: { createFromPath: vi.fn(() => ({ setTemplateImage: vi.fn() })) },
}))

import { createTray, refreshTrayMenu, destroyTray } from './tray'

interface TemplateItem {
  label?: string
}

function menuLabels(): string {
  const template = (buildFromTemplate.mock.calls.at(-1)?.[0] ?? []) as TemplateItem[]
  return JSON.stringify(template)
}

const agent = (name: string): AgentInfo => ({ slug: name, name, activityStatus: 'idle' })

describe('stale poll responses never overwrite a newer tray menu', () => {
  const originalRendererUrl = process.env.ELECTRON_RENDERER_URL
  let resolvers: Array<(agents: AgentInfo[]) => void>

  beforeEach(() => {
    process.env.ELECTRON_RENDERER_URL = 'http://localhost'
    buildFromTemplate.mockClear()
    setContextMenu.mockClear()
    resolvers = []
    fetchAgentsWithStatus.mockImplementation(
      () => new Promise<AgentInfo[]>((resolve) => resolvers.push(resolve)),
    )
  })

  afterEach(() => {
    destroyTray()
    if (originalRendererUrl === undefined) delete process.env.ELECTRON_RENDERER_URL
    else process.env.ELECTRON_RENDERER_URL = originalRendererUrl
  })

  it('discards an older build that resolves after a newer one', async () => {
    createTray(null, () => 'http://localhost:1')
    refreshTrayMenu()
    expect(resolvers).toHaveLength(2)

    resolvers[1]([agent('cloud-agent')])
    await vi.waitFor(() => expect(setContextMenu).toHaveBeenCalledTimes(1))
    expect(menuLabels()).toContain('cloud-agent')

    resolvers[0]([agent('local-agent')])
    await Promise.resolve()
    await Promise.resolve()
    expect(setContextMenu).toHaveBeenCalledTimes(1)
    expect(menuLabels()).toContain('cloud-agent')
  })
})
