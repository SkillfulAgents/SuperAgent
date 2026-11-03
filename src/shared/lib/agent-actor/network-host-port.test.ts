import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backgroundSettled } from '@shared/lib/background'
import { memoryLedger, memoryOutbox, remoteHostPort, serveHostPort, type HostEventOutbox, type RemoteHostPort } from './network-host-port'
import { WorkspaceFileError } from './workspace-path'
import type { HostPort } from './host-port'
import type { ActorFetch } from './network-actor'

function fakeHost() {
  const events: Array<{ name: string; event: unknown }> = []
  const port: HostPort = {
    call: vi.fn(async (name: string, request: unknown) => {
      if (name === 'hostScript') throw new WorkspaceFileError('not-found', 'script.sh does not exist')
      return { status: 'resolved', value: `ran ${(request as { toolName: string }).toolName}` }
    }) as unknown as HostPort['call'],
    send: (name, event) => {
      events.push({ name, event })
    },
  }
  return { port, events }
}

const feedEvent = (n: number) => ({ type: 'agent_updated', agentSlug: `agent-${n}` }) as never

describe('network host port', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('answers a call with the host result, and rebuilds a host error as its class', async () => {
    const { port } = fakeHost()
    const remote = remoteHostPort(serveHostPort(port))

    await expect(remote.call('hostTool', { agentSlug: 'a', sessionId: 's', toolUseId: 't', toolName: 'list_triggers', input: '{}' }))
      .resolves.toEqual({ status: 'resolved', value: 'ran list_triggers' })
    await expect(remote.call('hostScript', { script: 'x', scriptType: 'bash' })).rejects.toBeInstanceOf(WorkspaceFileError)
  })

  it('delivers sent events in order', async () => {
    const { port, events } = fakeHost()
    const remote = remoteHostPort(serveHostPort(port))

    for (let n = 1; n <= 3; n++) remote.send('global', feedEvent(n))
    await remote.flush()

    expect(events.map(({ event }) => (event as { agentSlug: string }).agentSlug)).toEqual(['agent-1', 'agent-2', 'agent-3'])
  })

  it('keeps an event until the host acks it, retries after a failed post, and the host drops the repeat', async () => {
    const { port, events } = fakeHost()
    const serve = serveHostPort(port)
    let failures = 1
    // The first post lands on the host, but its answer is lost.
    const flaky: ActorFetch = async (request) => {
      const response = await serve(request)
      if (failures-- > 0) return new Response('gateway timeout', { status: 504 })
      return response
    }
    const remote = remoteHostPort(flaky, { retryDelaysMs: [1_000] })

    remote.send('analytics', { event: 'session_started' })
    await vi.advanceTimersByTimeAsync(0)
    expect(events).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1_000)
    await remote.flush()
    expect(events).toHaveLength(1)
  })

  it('posts what an earlier port left in a shared outbox', async () => {
    const { port, events } = fakeHost()
    const outbox = memoryOutbox()
    const down = remoteHostPort(async () => new Response('down', { status: 503 }), { outbox, retryDelaysMs: [60_000] })
    down.send('global', feedEvent(1))
    await vi.advanceTimersByTimeAsync(0)
    expect(await outbox.pending()).toHaveLength(1)

    const restarted = remoteHostPort(serveHostPort(port), { outbox })
    await restarted.flush()

    expect(events).toHaveLength(1)
    expect(await outbox.pending()).toEqual([])
  })

  it('posts an event sent while a flush was reading the outbox for the last time', async () => {
    const { port, events } = fakeHost()
    const outbox = memoryOutbox()
    let remote!: RemoteHostPort
    let sendLate = true
    const racing: HostEventOutbox = {
      ...outbox,
      pending: async () => {
        const pending = await outbox.pending()
        // Sent after this read found the outbox empty, before the flush that made it ends.
        if (pending.length === 0 && sendLate) {
          sendLate = false
          remote.send('global', feedEvent(2))
        }
        return pending
      },
    }
    remote = remoteHostPort(serveHostPort(port), { outbox: racing })

    remote.send('global', feedEvent(1))
    await backgroundSettled()

    expect(events.map(({ event }) => (event as { agentSlug: string }).agentSlug)).toEqual(['agent-1', 'agent-2'])
  })

  it('still posts the events sent after one the outbox could not store', async () => {
    const { port, events } = fakeHost()
    const outbox = memoryOutbox()
    let failNext = true
    const flaky: HostEventOutbox = {
      ...outbox,
      append: (entry) => {
        if (failNext) {
          failNext = false
          throw new Error('storage full')
        }
        return outbox.append(entry)
      },
    }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const remote = remoteHostPort(serveHostPort(port), { outbox: flaky })

    remote.send('global', feedEvent(1))
    remote.send('global', feedEvent(2))
    await backgroundSettled()

    expect(events.map(({ event }) => (event as { agentSlug: string }).agentSlug)).toEqual(['agent-2'])
    errors.mockRestore()
  })

  it('drops a retried post that reaches another host process sharing the ledger', async () => {
    const { port, events } = fakeHost()
    const ledger = memoryLedger()
    const hostA = serveHostPort(port, { ledger })
    const hostB = serveHostPort(port, { ledger })
    let posts = 0
    // The first post lands on process A but its answer is lost; the retry reaches process B.
    const balancer: ActorFetch = async (request) => {
      if (posts++ > 0) return hostB(request)
      await hostA(request)
      return new Response('gateway timeout', { status: 504 })
    }
    const remote = remoteHostPort(balancer, { retryDelaysMs: [1_000] })

    remote.send('analytics', { event: 'session_started' })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)
    await remote.flush()

    expect(posts).toBe(2)
    expect(events).toHaveLength(1)
  })

  it('refuses an event that is not data, in the sender', () => {
    const remote = remoteHostPort(serveHostPort(fakeHost().port))
    expect(() => remote.send('analytics', { event: 'x', properties: { callback: () => {} } })).toThrow('cannot cross')
  })
})
