import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sync: vi.fn(), active: vi.fn(), isActive: vi.fn(), interrupt: vi.fn(), markInterrupted: vi.fn(),
  send: vi.fn(), withSend: vi.fn(), status: 'running', order: [] as string[],
}))
vi.mock('./connection-runtime-sync', () => ({
  syncAgentConnectionEnvironment: mocks.sync,
}))
vi.mock('./container-host', () => ({
  containerHost: {
    runtime: () => ({
      getCachedInfo: () => ({ status: mocks.status }),
      getClient: () => ({ interruptSession: mocks.interrupt, sendMessage: mocks.send }),
    }),
  },
}))
vi.mock('./message-persister', () => ({
  messagePersister: {
    getActiveSessionIdsForAgent: mocks.active,
    isSessionActive: mocks.isActive,
    getTurnGeneration: () => 7,
    markSessionInterrupted: mocks.markInterrupted,
    withSessionSend: mocks.withSend,
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
  mocks.interrupt.mockImplementation(async (id: string) => {
    mocks.order.push(`interrupt:${id}`)
    return { interrupted: true, processKept: true }
  })
  mocks.markInterrupted.mockImplementation(async (_agent: string, id: string) => { mocks.order.push(`mark:${id}`) })
  mocks.send.mockImplementation(async (id: string) => { mocks.order.push(`send:${id}`) })
  mocks.withSend.mockImplementation(async (_agent: string, _id: string, _client: unknown, send: () => Promise<void>) => send())
  release.mockImplementation(() => { mocks.order.push('release') })
})

describe('connection replacement notification', () => {
  it.each(['connected-accounts', 'remote-mcps'] as const)('refreshes and interrupts before notifying active sessions for %s', async (kind) => {
    expect(await finishConnectionReplacement({ ...change, kind }, release))
      .toEqual({ liveRefresh: true, sessionNotification: true })
    expect(mocks.active).toHaveBeenCalledWith('shared-agent')
    expect(mocks.sync).toHaveBeenCalledWith(
      'shared-agent',
      kind,
      expect.objectContaining({ getCachedInfo: expect.any(Function), getClient: expect.any(Function) }),
    )
    for (const sessionId of ['session-1', 'session-2']) {
      expect(mocks.interrupt).toHaveBeenCalledWith(sessionId, { scope: 'turn' })
      expect(mocks.markInterrupted).toHaveBeenCalledWith('shared-agent', sessionId, {
        processKept: true, turnGenerationBefore: 7,
      })
      expect(mocks.order.indexOf(`interrupt:${sessionId}`)).toBeGreaterThan(mocks.order.indexOf('refresh'))
      expect(mocks.order.indexOf('release')).toBeGreaterThan(mocks.order.indexOf(`mark:${sessionId}`))
      expect(mocks.order.indexOf(`send:${sessionId}`)).toBeGreaterThan(mocks.order.indexOf('release'))
      expect(mocks.send).toHaveBeenCalledWith(sessionId,
        expect.stringMatching(/^\[SYSTEM\] Connection to "Slack" was replaced\./),
        expect.any(String), { shouldQuery: true })
    }
    const message = mocks.send.mock.calls[0][1] as string
    expect(message).toContain(kind === 'connected-accounts' ? 'Previous account ID: old. New account ID: new.' : 'Previous MCP ID: old. New MCP ID: new.')
    expect(message).toContain('Update scripts')
    expect(mocks.withSend).toHaveBeenCalledTimes(2)
    expect(release).toHaveBeenCalledOnce()
  })

  it('keeps idle sessions asleep', async () => {
    mocks.active.mockReturnValue([])
    expect(await finishConnectionReplacement(change, release)).toEqual({ liveRefresh: true, sessionNotification: true })
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.interrupt).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })

  it('does not restart a stopped container or a session stopped during refresh', async () => {
    mocks.status = 'stopped'
    await finishConnectionReplacement(change, release)
    mocks.status = 'running'
    mocks.isActive.mockReturnValue(false)
    await finishConnectionReplacement(change, release)
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.interrupt).not.toHaveBeenCalled()
  })

  it('reports a failed refresh and releases the request without claiming tools are ready', async () => {
    mocks.sync.mockResolvedValue(false)
    expect(await finishConnectionReplacement(change, release)).toEqual({ liveRefresh: false, sessionNotification: false })
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.interrupt).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })

  it('releases the parked call if runtime preparation throws unexpectedly', async () => {
    mocks.sync.mockRejectedValue(new Error('runtime unavailable'))
    expect(await finishConnectionReplacement(change, release)).toEqual({ liveRefresh: false, sessionNotification: false })
    expect(release).toHaveBeenCalledOnce()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it.each(['rejected', 'unacknowledged', 'send'] as const)('reports %s failures while notifying the other session', async (failure) => {
    if (failure === 'rejected') mocks.interrupt.mockRejectedValueOnce(new Error('interrupt failed'))
    if (failure === 'unacknowledged') mocks.interrupt.mockResolvedValueOnce({ interrupted: false, processKept: false })
    if (failure === 'send') mocks.send.mockRejectedValueOnce(new Error('send failed'))
    expect(await finishConnectionReplacement(change, release)).toEqual({ liveRefresh: true, sessionNotification: false })
    expect(mocks.send).toHaveBeenCalledWith('session-2', expect.any(String), expect.any(String), { shouldQuery: true })
    expect(release).toHaveBeenCalledOnce()
  })
})
