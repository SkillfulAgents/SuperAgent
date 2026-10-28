import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'

const mockExecWithPath = vi.fn()

vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (_c: unknown, next: () => Promise<void>) => next(),
  IsAdmin: () => async (_c: unknown, next: () => Promise<void>) => next(),
}))
vi.mock('@shared/lib/agent-actor', () => ({ containerHost: { getReadiness: () => ({ status: 'READY' }) } }))
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
