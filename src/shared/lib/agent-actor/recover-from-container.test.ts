import { describe, expect, it, vi } from 'vitest'
import { recoverFromContainer, type RecoverFromContainerDeps } from './recover-from-container'

/** A container mid-turn in one session, parked on a question in another, idle in a third. */
function container(routes: Record<string, unknown>) {
  return vi.fn(async (path: string) => (path in routes ? Response.json(routes[path]) : new Response('not found', { status: 404 })))
}

function deps(overrides: Partial<RecoverFromContainerDeps> = {}): RecoverFromContainerDeps & { order: string[] } {
  const order: string[] = []
  return {
    order,
    containerStatus: async () => 'running',
    fetch: container({
      '/sessions': [{ sessionId: 'turning' }, { sessionId: 'asking' }, { sessionId: 'idle' }],
      '/sessions/turning': { isRunning: true },
      '/sessions/asking': { isRunning: false },
      '/sessions/idle': { isRunning: false },
      '/inputs/pending': [{ toolUseId: 'toolu_ask', inputType: 'AskUserQuestion', sessionId: 'asking', createdAt: '2026-10-27T12:00:00Z' }],
    }),
    attach: vi.fn(async (sessionId: string) => {
      order.push(`attach ${sessionId}`)
    }),
    recoverAwaitingInput: vi.fn((sessionId: string) => {
      order.push(`recover ${sessionId}`)
    }),
    takeStoredCoalesced: () => [{ sessionId: 'turning', messages: [{ uuid: 'msg-1', text: 'also check the invoice' }] }],
    sendHeld: vi.fn(async (sessionId: string, message: { uuid: string }) => {
      order.push(`send ${sessionId} ${message.uuid}`)
    }),
    ...overrides,
  }
}

describe('recoverFromContainer', () => {
  it('attaches the turn in flight and the parked session, re-registers the ask, then sends the held message', async () => {
    const d = deps()
    const result = await recoverFromContainer(d)

    expect(result).toEqual({ attached: ['turning', 'asking'], requests: ['toolu_ask'], resent: ['msg-1'] })
    expect(d.recoverAwaitingInput).toHaveBeenCalledWith('asking', [{ toolUseId: 'toolu_ask', toolName: 'AskUserQuestion' }])
    expect(d.order).toEqual(['attach turning', 'attach asking', 'recover asking', 'send turning msg-1'])
  })

  it('does nothing, and keeps held messages, when the container is not running', async () => {
    const takeStoredCoalesced = vi.fn(() => [])
    const d = deps({ containerStatus: async () => 'stopped', takeStoredCoalesced })
    expect(await recoverFromContainer(d)).toEqual({ attached: [], requests: [], resent: [] })
    expect(d.fetch).not.toHaveBeenCalled()
    expect(takeStoredCoalesced).not.toHaveBeenCalled()
  })
})
