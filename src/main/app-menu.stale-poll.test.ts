import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Menu builds overlap: the 30s poll and the target-switch refresh both run
// buildAppMenu, which samples the base URL before its await. A slow response
// from the previous target must not land after a newer build painted the menu
// and overwrite it — last started wins.

import type { AgentInfo } from './agent-status'

const { fetchAgentsWithStatus } = vi.hoisted(() => ({
  fetchAgentsWithStatus: vi.fn(),
}))
vi.mock('./agent-status', () => ({ fetchAgentsWithStatus }))

const { buildFromTemplate, setApplicationMenu } = vi.hoisted(() => ({
  buildFromTemplate: vi.fn((template: unknown) => ({ template })),
  setApplicationMenu: vi.fn(),
}))
vi.mock('electron', () => ({
  Menu: { buildFromTemplate, setApplicationMenu },
  BrowserWindow: class {},
  app: { emit: vi.fn() },
  nativeImage: { createFromPath: vi.fn(() => ({})) },
}))

import { createAppMenu, refreshAppMenu, destroyAppMenu } from './app-menu'

interface TemplateItem {
  label?: string
  submenu?: TemplateItem[]
}

function menuLabels(): string {
  const template = (buildFromTemplate.mock.calls.at(-1)?.[0] ?? []) as TemplateItem[]
  return JSON.stringify(template)
}

const agent = (name: string): AgentInfo => ({ slug: name, name, activityStatus: 'idle' })

describe('stale poll responses never overwrite a newer menu', () => {
  const originalRendererUrl = process.env.ELECTRON_RENDERER_URL
  let resolvers: Array<(agents: AgentInfo[]) => void>

  beforeEach(() => {
    process.env.ELECTRON_RENDERER_URL = 'http://localhost'
    buildFromTemplate.mockClear()
    setApplicationMenu.mockClear()
    resolvers = []
    fetchAgentsWithStatus.mockImplementation(
      () => new Promise<AgentInfo[]>((resolve) => resolvers.push(resolve)),
    )
  })

  afterEach(() => {
    destroyAppMenu()
    if (originalRendererUrl === undefined) delete process.env.ELECTRON_RENDERER_URL
    else process.env.ELECTRON_RENDERER_URL = originalRendererUrl
  })

  it('discards an older build that resolves after a newer one', async () => {
    createAppMenu(null, () => 'http://localhost:1')
    refreshAppMenu()
    expect(resolvers).toHaveLength(2)

    // The newer build (the switch refresh) answers first, with the new target's
    // agents.
    resolvers[1]([agent('cloud-agent')])
    await vi.waitFor(() => expect(setApplicationMenu).toHaveBeenCalledTimes(1))
    expect(menuLabels()).toContain('cloud-agent')

    // The older build (the poll started against the previous target) straggles
    // in — it must not be installed.
    resolvers[0]([agent('local-agent')])
    await Promise.resolve()
    await Promise.resolve()
    expect(setApplicationMenu).toHaveBeenCalledTimes(1)
    expect(menuLabels()).toContain('cloud-agent')
  })
})
