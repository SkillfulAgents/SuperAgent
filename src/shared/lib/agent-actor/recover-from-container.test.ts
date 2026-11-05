import { describe, expect, it, vi } from 'vitest'
import type { CoalescedUserMessage } from '@shared/lib/container/runtime-death'
import { recoverFromContainer, type RecoverFromContainerDeps } from './recover-from-container'

/** A container mid-turn in one session, parked on a question in another, idle in a third. */
function container(routes: Record<string, unknown>) {
  return vi.fn(async (path: string) => (path in routes ? Response.json(routes[path]) : new Response('not found', { status: 404 })))
}

function deps(overrides: Partial<RecoverFromContainerDeps> = {}) {
  const order: string[] = []
  // What the actor's durable state holds for messages a restart cut short.
  const stored = new Map<string, CoalescedUserMessage[]>([['turning', [{ uuid: 'msg-1', text: 'also check the invoice' }]]])
  const d = {
    order,
    stored,
    containerStatus: async () => 'running',
    fetch: container({
      '/sessions': [{ id: 'turning' }, { id: 'asking' }, { id: 'idle' }],
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
    storedCoalesced: vi.fn(() => [...stored].map(([sessionId, messages]) => ({ sessionId, messages }))),
    storeCoalesced: (sessionId: string, messages: CoalescedUserMessage[]) => {
      if (messages.length > 0) stored.set(sessionId, messages)
      else stored.delete(sessionId)
    },
    sendHeld: vi.fn(async (sessionId: string, message: { uuid: string }) => {
      order.push(`send ${sessionId} ${message.uuid}`)
    }),
    ...overrides,
  } satisfies RecoverFromContainerDeps & { order: string[]; stored: Map<string, CoalescedUserMessage[]> }
  return d
}

describe('recoverFromContainer', () => {
  it('attaches the turn in flight and the parked session, re-registers the ask, then sends the held message', async () => {
    const d = deps()
    const result = await recoverFromContainer(d)

    expect(result).toEqual({ attached: ['turning', 'asking'], requests: ['toolu_ask'], resent: ['msg-1'] })
    expect(d.recoverAwaitingInput).toHaveBeenCalledWith('asking', [{ toolUseId: 'toolu_ask', toolName: 'AskUserQuestion' }])
    expect(d.order).toEqual(['attach turning', 'attach asking', 'recover asking', 'send turning msg-1'])
    expect([...d.stored]).toEqual([])
  })

  it('does nothing, and keeps held messages, when the container is not running', async () => {
    const d = deps({ containerStatus: async () => 'stopped' })
    expect(await recoverFromContainer(d)).toEqual({ attached: [], requests: [], resent: [] })
    expect(d.fetch).not.toHaveBeenCalled()
    expect(d.storedCoalesced).not.toHaveBeenCalled()
    expect([...d.stored.keys()]).toEqual(['turning'])
  })

  it('keeps a held message whose send failed and the rest of its session for the next recover, and still sends another session\'s', async () => {
    const d = deps()
    d.stored.set('turning', [{ uuid: 'msg-1', text: 'also check the invoice' }, { uuid: 'msg-2', text: 'and the refund' }, { uuid: 'msg-3', text: 'thanks' }])
    d.stored.set('asking', [{ uuid: 'msg-4', text: 'the blue one' }])
    vi.mocked(d.sendHeld).mockImplementation(async (sessionId: string, message: { uuid: string }) => {
      d.order.push(`send ${sessionId} ${message.uuid}`)
      if (message.uuid === 'msg-2') throw new Error('container went away')
    })

    await expect(recoverFromContainer(d)).rejects.toThrow('container went away')

    expect(d.order.filter((step) => step.startsWith('send'))).toEqual(['send turning msg-1', 'send turning msg-2', 'send asking msg-4'])
    expect(d.stored.get('turning')?.map((message) => message.uuid)).toEqual(['msg-2', 'msg-3'])
    expect(d.stored.has('asking')).toBe(false)
  })
})
