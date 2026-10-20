import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sync: vi.fn(), active: vi.fn(), isActive: vi.fn(), stop: vi.fn(), deliver: vi.fn(),
  status: 'running', order: [] as string[],
}))
vi.mock('@shared/lib/agent-actor', () => ({
  agentRegistry: {
    get: (slug: string) => {
      mocks.order.push(`actor:${slug}`)
      return {
        container: { syncConnectionEnvironment: mocks.sync, status: () => ({ status: mocks.status }) },
        sessions: { activeIds: mocks.active },
        messages: { stop: mocks.stop, deliver: mocks.deliver },
      }
    },
  },
}))

import { finishConnectionReplacement, type ConnectionReplacement } from './connection-replacement'

const change: ConnectionReplacement = {
  agentSlug: 'shared-agent', kind: 'connected-accounts', name: 'Slack', previousId: 'old', replacementId: 'new',
}
const release = vi.fn()

beforeEach(() => {
  vi.resetAllMocks()
  mocks.order = []
  mocks.status = 'running'
  mocks.active.mockReturnValue(['session-1', 'session-2'])
  mocks.isActive.mockReturnValue(true)
  mocks.sync.mockImplementation(async () => { mocks.order.push('refresh'); return true })
  // The stop marks the session itself, in the same op as the interrupt.
  mocks.stop.mockImplementation(async (id: string, options: { ifActive?: boolean }) => {
    if (options.ifActive && !mocks.isActive(id)) return { path: 'skipped-idle', interrupted: false, processKept: false, escalated: false }
    mocks.order.push(`stop:${id}`)
    return { path: 'interrupted', interrupted: true, processKept: true, escalated: false }
  })
  mocks.deliver.mockImplementation(async (request: { sessionId: string }) => {
    mocks.order.push(`send:${request.sessionId}`)
    return { status: 'sent', queued: false }
  })
  release.mockImplementation(() => { mocks.order.push('release') })
})

describe('connection replacement notification', () => {
  it.each(['connected-accounts', 'remote-mcps'] as const)('refreshes and interrupts before notifying active sessions for %s', async (kind) => {
    expect(await finishConnectionReplacement({ ...change, kind }, release))
      .toEqual({ liveRefresh: true, sessionNotification: true })
    expect(mocks.order[0]).toBe('actor:shared-agent')
    expect(mocks.sync).toHaveBeenCalledWith(kind)
    for (const sessionId of ['session-1', 'session-2']) {
      expect(mocks.stop).toHaveBeenCalledWith(sessionId, { scope: 'turn', ifActive: true })
      expect(mocks.order.indexOf(`stop:${sessionId}`)).toBeGreaterThan(mocks.order.indexOf('refresh'))
      expect(mocks.order.indexOf('release')).toBeGreaterThan(mocks.order.indexOf(`stop:${sessionId}`))
      expect(mocks.order.indexOf(`send:${sessionId}`)).toBeGreaterThan(mocks.order.indexOf('release'))
      expect(mocks.deliver).toHaveBeenCalledWith({
        sessionId,
        content: expect.stringMatching(/^\[SYSTEM\] Connection to "Slack" was replaced\./),
        uuid: expect.any(String),
        options: { shouldQuery: true },
      })
    }
    const message = mocks.deliver.mock.calls[0][0].content as string
    expect(message).toContain(kind === 'connected-accounts' ? 'Previous account ID: old. New account ID: new.' : 'Previous MCP ID: old. New MCP ID: new.')
    expect(message).toContain('Update scripts')
    expect(mocks.deliver).toHaveBeenCalledTimes(2)
    expect(release).toHaveBeenCalledOnce()
  })

  it('keeps idle sessions asleep', async () => {
    mocks.active.mockReturnValue([])
    expect(await finishConnectionReplacement(change, release)).toEqual({ liveRefresh: true, sessionNotification: true })
    expect(mocks.deliver).not.toHaveBeenCalled()
    expect(mocks.order.some((step) => step.startsWith('stop:'))).toBe(false)
    expect(release).toHaveBeenCalledOnce()
  })

  it('does not restart a stopped container or a session stopped during refresh', async () => {
    mocks.status = 'stopped'
    await finishConnectionReplacement(change, release)
    mocks.status = 'running'
    mocks.isActive.mockReturnValue(false)
    await finishConnectionReplacement(change, release)
    expect(mocks.deliver).not.toHaveBeenCalled()
    expect(mocks.order.some((step) => step.startsWith('stop:'))).toBe(false)
  })

  it('reports a failed refresh and releases the request without claiming tools are ready', async () => {
    mocks.sync.mockResolvedValue(false)
    expect(await finishConnectionReplacement(change, release)).toEqual({ liveRefresh: false, sessionNotification: false })
    expect(mocks.deliver).not.toHaveBeenCalled()
    expect(mocks.order.some((step) => step.startsWith('stop:'))).toBe(false)
    expect(release).toHaveBeenCalledOnce()
  })

  it('releases the parked call if runtime preparation throws unexpectedly', async () => {
    mocks.sync.mockRejectedValue(new Error('runtime unavailable'))
    expect(await finishConnectionReplacement(change, release)).toEqual({ liveRefresh: false, sessionNotification: false })
    expect(release).toHaveBeenCalledOnce()
    expect(mocks.deliver).not.toHaveBeenCalled()
  })

  it.each(['rejected', 'unacknowledged', 'send'] as const)('reports %s failures while notifying the other session', async (failure) => {
    if (failure === 'rejected') mocks.stop.mockResolvedValueOnce({ path: 'interrupt-failed', interrupted: false, processKept: false, escalated: false })
    if (failure === 'unacknowledged') mocks.stop.mockResolvedValueOnce({ path: 'interrupted', interrupted: false, processKept: false, escalated: false })
    if (failure === 'send') mocks.deliver.mockRejectedValueOnce(new Error('send failed'))
    expect(await finishConnectionReplacement(change, release)).toEqual({ liveRefresh: true, sessionNotification: false })
    expect(mocks.deliver).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-2', options: { shouldQuery: true } }))
    expect(release).toHaveBeenCalledOnce()
  })
})
