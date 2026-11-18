import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'

const mockExecWithPath = vi.fn()

vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (_c: unknown, next: () => Promise<void>) => next(),
  IsAdmin: () => async (_c: unknown, next: () => Promise<void>) => next(),
}))
const mockReadMetadata = vi.fn()
vi.mock('@shared/lib/agent-actor', () => ({
  containerHost: { getReadiness: () => ({ status: 'READY' }) },
  agentCatalog: { resolve: async (input: string) => (input === 'known-agent' || input === 'Known Agent' ? 'known-agent' : null) },
  agentRegistry: { get: (slug: string) => ({ sessions: { readMetadata: () => mockReadMetadata(slug) } }) },
}))
vi.mock('@shared/lib/container/client-factory', () => ({ checkAllRunnersAvailability: async () => [] }))
vi.mock('@shared/lib/config/settings', () => ({ getSettings: () => ({ container: { containerRunner: 'lima' } }) }))
vi.mock('@shared/lib/container/base-container-client', () => ({
  execWithPath: (...args: unknown[]) => mockExecWithPath(...args),
}))
// Stand-ins that make it visible whether a route went through the shared
// helper and the VM-name constant rather than building its own command.
vi.mock('@shared/lib/container/lima-container-client', () => ({
  getLimaHome: () => '/lima-home',
  getLimactlPath: () => '/bundle/limactl',
  limactlCommand: (args: string) => `LIMACTL ${args}`,
  LIMA_VM_NAME: 'vm-under-test',
}))

import debug from './debug'

function createApp() {
  const app = new Hono()
  app.route('/api/debug', debug)
  return app
}

function commands(): string[] {
  return mockExecWithPath.mock.calls.map((c) => c[0] as string)
}

describe('debug routes on the Lima runner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExecWithPath.mockResolvedValue({ stdout: '', stderr: '' })
  })

  it('runtime status runs every limactl call through the shared helper against our VM', async () => {
    const res = await createApp().request('http://localhost/api/debug/runtime')

    expect(res.status).toBe(200)
    expect(commands()).toEqual([
      'LIMACTL list --json',
      'LIMACTL shell vm-under-test -- rc-service containerd status',
      'LIMACTL shell vm-under-test -- df -h /',
    ])
  })

  it('container list and logs run nerdctl in our VM through the shared helper', async () => {
    await createApp().request('http://localhost/api/debug/containers')
    await createApp().request('http://localhost/api/debug/containers/superagent-abc/logs?tail=5')

    expect(commands()).toEqual([
      "LIMACTL shell vm-under-test -- sudo nerdctl ps -a --format '{{json .}}'",
      'LIMACTL shell vm-under-test -- sudo nerdctl logs --tail 5 superagent-abc',
    ])
  })
})

describe('debug session metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('answers what the agent\'s session index keeps, by slug or display slug', async () => {
    const metadata = { s1: { name: 'Named', starred: true }, s2: { isWidgetRepair: true, widgetRepairSlug: 'macros' } }
    mockReadMetadata.mockResolvedValue(metadata)

    for (const id of ['known-agent', 'Known%20Agent']) {
      const res = await createApp().request(`http://localhost/api/debug/agents/${id}/session-metadata`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(metadata)
    }
    expect(mockReadMetadata.mock.calls).toEqual([['known-agent'], ['known-agent']])
  })

  it('answers 404 for an agent that does not exist, and reads nothing', async () => {
    const res = await createApp().request('http://localhost/api/debug/agents/nobody/session-metadata')

    expect(res.status).toBe(404)
    expect(mockReadMetadata).not.toHaveBeenCalled()
  })
})
