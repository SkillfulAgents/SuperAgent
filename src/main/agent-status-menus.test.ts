import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The tray and the app menu drawn from the real shared source: one fetch
// feeds both, and neither rebuilds its native menu for a list that has not
// changed. Each used to poll on its own and rebuild every time.

const { buildFromTemplate, setApplicationMenu, setContextMenu, createFromPath } = vi.hoisted(() => ({
  buildFromTemplate: vi.fn((template: unknown) => ({ template })),
  setApplicationMenu: vi.fn(),
  setContextMenu: vi.fn(),
  createFromPath: vi.fn(() => ({ setTemplateImage: vi.fn() })),
}))
vi.mock('electron', () => ({
  Tray: class {
    setToolTip() {}
    on() {}
    setContextMenu = setContextMenu
    destroy() {}
  },
  Menu: { buildFromTemplate, setApplicationMenu },
  BrowserWindow: class {},
  app: { emit: vi.fn(), quit: vi.fn() },
  nativeImage: { createFromPath },
}))
vi.mock('./keys/vault-key-export', () => ({ exportVaultKey: vi.fn() }))

import { registerTasks } from '@shared/lib/background-work/testing/register-tasks'
import { createAppMenu, destroyAppMenu } from './app-menu'
import { AGENT_STATUS_POLL_INTERVAL_MS, agentStatusSource } from './agent-status-source'
import { createTray, destroyTray } from './tray'

const BASE = 'http://localhost:4000'

describe('the tray and the app menu on one agent list', () => {
  const originalRendererUrl = process.env.ELECTRON_RENDERER_URL

  beforeEach(() => {
    process.env.ELECTRON_RENDERER_URL = 'http://localhost'
    vi.useFakeTimers()
  })

  afterEach(() => {
    agentStatusSource.stop()
    destroyTray()
    destroyAppMenu()
    vi.useRealTimers()
    if (originalRendererUrl === undefined) delete process.env.ELECTRON_RENDERER_URL
    else process.env.ELECTRON_RENDERER_URL = originalRendererUrl
  })

  it('fetches once for both, and rebuilds each only when the list changes', async () => {
    let agents = [
      { slug: 'a', name: 'Alpha', status: 'running', hasActiveSessions: true },
      { slug: 'b', name: 'Beta', status: 'stopped' },
    ]
    const requests: string[] = []
    const fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      requests.push(url)
      return Response.json(url.endsWith('/api/agents') ? agents : {})
    }) as typeof globalThis.fetch

    agentStatusSource.configure({ activeTarget: async () => ({ target: 'local', baseUrl: BASE }), fetch })
    registerTasks(agentStatusSource)
    createAppMenu(null)
    createTray(null)
    agentStatusSource.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(requests.sort()).toEqual([`${BASE}/api/agents`, `${BASE}/api/user-settings`])
    expect(setApplicationMenu).toHaveBeenCalledTimes(1)
    expect(setContextMenu).toHaveBeenCalledTimes(1)
    for (const [template] of buildFromTemplate.mock.calls) {
      const drawn = JSON.stringify(template)
      expect(drawn).toContain('Alpha')
      expect(drawn).toContain('Working')
      expect(drawn).toContain('Sleeping')
    }

    const icons = createFromPath.mock.calls.length
    await vi.advanceTimersByTimeAsync(AGENT_STATUS_POLL_INTERVAL_MS * 2)
    expect(requests).toHaveLength(6)
    expect(setApplicationMenu).toHaveBeenCalledTimes(1)
    expect(setContextMenu).toHaveBeenCalledTimes(1)
    expect(createFromPath).toHaveBeenCalledTimes(icons)

    agents = [agents[0], { ...agents[1], status: 'running' }]
    await vi.advanceTimersByTimeAsync(AGENT_STATUS_POLL_INTERVAL_MS)
    expect(setApplicationMenu).toHaveBeenCalledTimes(2)
    expect(setContextMenu).toHaveBeenCalledTimes(2)
  })
})
