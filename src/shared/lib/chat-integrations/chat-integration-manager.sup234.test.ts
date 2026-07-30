import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { chatIntegrationManager } from './chat-integration-manager'

// ---------------------------------------------------------------------------
// SUP-234 — message queue entries were never reclaimed.
//
// The old `cleanupResolvedQueues` tried to detect a settled Promise by attaching
// `.then(() => isSettled = true)` and reading the flag on the very next
// synchronous line. `.then` reactions run on a future microtask, so the flag was
// always false and the delete branch was unreachable — `messageQueues` grew
// unbounded (one entry per chat + per SSE stream).
//
// Fix: each enqueued tail promise self-evicts in its own `.finally` once it
// settles, guarded by an identity check so a newer chained successor that has
// replaced the map slot is never dropped. No periodic sweep is needed.
//
// These tests drive the manager's private message-queue mechanics directly
// (handlers stubbed so no container/agent code runs) and assert:
//   1. a settled chat message entry self-evicts,
//   2. a settled SSE entry self-evicts,
//   3. an in-flight (never-resolving) entry is retained,
//   4. the identity guard: an older settled chain superseded by a newer in-flight
//      one does NOT evict the live successor,
//   5. bounded growth: many entries across many keys all drain to zero,
//   6. removeIntegration force-drops that integration's queues only — using
//      prefix-colliding ids ('intg' vs 'intg2') to lock in the ':' delimiter,
//   7. a rejecting handler still self-evicts (the .catch keeps the tail resolving).
// ---------------------------------------------------------------------------

interface ManagerInternals {
  messageQueues: Map<string, unknown>
  enqueueMessage: (integrationId: string, message: { chatId: string; text?: string }) => void
  enqueueSSEEvent: (integrationId: string, chatId: string, event: unknown, sessionId: string) => void
  handleIncomingMessage: (integrationId: string, message: unknown) => Promise<void>
  handleSSEEvent: (integrationId: string, chatId: string, event: unknown, sessionId: string) => Promise<void>
  removeIntegration: (id: string) => Promise<void>
}

const mgr = chatIntegrationManager as unknown as ManagerInternals

/** Let queued `.then`/`.finally` microtasks drain. */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

/** A promise that never settles — stands in for an in-flight handler. */
function pendingForever(): Promise<void> {
  return new Promise<void>(() => {})
}

describe('SUP-234: chat integration message queue cleanup', () => {
  beforeEach(() => {
    mgr.messageQueues.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    mgr.messageQueues.clear()
  })

  it('self-evicts a settled chat message queue entry', async () => {
    vi.spyOn(mgr, 'handleIncomingMessage').mockResolvedValue(undefined)

    mgr.enqueueMessage('intg-1', { chatId: 'chat-1', text: 'hi' })
    expect(mgr.messageQueues.has('intg-1:chat-1')).toBe(true)

    await flushMicrotasks()

    expect(mgr.messageQueues.has('intg-1:chat-1')).toBe(false)
    expect(mgr.messageQueues.size).toBe(0)
  })

  it('self-evicts a settled SSE queue entry', async () => {
    vi.spyOn(mgr, 'handleSSEEvent').mockResolvedValue(undefined)

    mgr.enqueueSSEEvent('intg-2', 'chat-2', { type: 'session_idle' }, 'sess-test')
    expect(mgr.messageQueues.has('sse:intg-2:chat-2')).toBe(true)

    await flushMicrotasks()

    expect(mgr.messageQueues.has('sse:intg-2:chat-2')).toBe(false)
    expect(mgr.messageQueues.size).toBe(0)
  })

  it('keeps each SSE event tied to its originating session', async () => {
    const handler = vi.spyOn(mgr, 'handleSSEEvent').mockResolvedValue(undefined)

    mgr.enqueueSSEEvent('intg-2', 'chat-2', { type: 'first' }, 'sess-old')
    mgr.enqueueSSEEvent('intg-2', 'chat-2', { type: 'second' }, 'sess-new')
    await flushMicrotasks()

    expect(handler).toHaveBeenNthCalledWith(1, 'intg-2', 'chat-2', { type: 'first' }, 'sess-old')
    expect(handler).toHaveBeenNthCalledWith(2, 'intg-2', 'chat-2', { type: 'second' }, 'sess-new')
  })

  it('keeps in-flight (unsettled) queue entries', async () => {
    vi.spyOn(mgr, 'handleIncomingMessage').mockReturnValue(pendingForever())

    mgr.enqueueMessage('intg-3', { chatId: 'chat-3', text: 'hi' })
    await flushMicrotasks()

    // The handler never resolved — the queue must not be evicted mid-flight.
    expect(mgr.messageQueues.has('intg-3:chat-3')).toBe(true)
  })

  it('identity guard: a superseded settled chain does not evict the live successor', async () => {
    const handler = vi.spyOn(mgr, 'handleIncomingMessage')
    handler.mockResolvedValueOnce(undefined) // first settles immediately
    handler.mockReturnValueOnce(pendingForever()) // second stays in-flight

    // Enqueue BOTH before flushing: the second chains off the first and replaces
    // the map slot, so when the first settles its eviction must be a no-op.
    mgr.enqueueMessage('intg-4', { chatId: 'chat-4', text: 'first' })
    mgr.enqueueMessage('intg-4', { chatId: 'chat-4', text: 'second' })

    await flushMicrotasks()

    // The first settled (its .finally fired) but the in-flight second holds the
    // slot — the key must survive.
    expect(mgr.messageQueues.has('intg-4:chat-4')).toBe(true)
  })

  it('bounded growth: many settled entries across many keys all drain to zero', async () => {
    vi.spyOn(mgr, 'handleIncomingMessage').mockResolvedValue(undefined)
    vi.spyOn(mgr, 'handleSSEEvent').mockResolvedValue(undefined)

    const CHATS = 12
    const PER_CHAT = 4
    for (let c = 0; c < CHATS; c++) {
      for (let i = 0; i < PER_CHAT; i++) {
        mgr.enqueueMessage('vol', { chatId: `chat-${c}`, text: `m${i}` })
        mgr.enqueueSSEEvent('vol', `chat-${c}`, { type: 'evt' }, 'sess-test')
      }
    }
    expect(mgr.messageQueues.size).toBeGreaterThan(0)

    await flushMicrotasks(100)

    // Every chain settled, so every key self-evicted — no unbounded growth.
    expect(mgr.messageQueues.size).toBe(0)
  })

  it('removeIntegration drops that integration\'s in-flight queues only', async () => {
    vi.spyOn(mgr, 'handleIncomingMessage').mockReturnValue(pendingForever())
    vi.spyOn(mgr, 'handleSSEEvent').mockReturnValue(pendingForever())

    // Use ids where one is a string PREFIX of the other ('intg' vs 'intg2') so
    // this test fails if the `:`-delimited match is ever weakened to a bare
    // startsWith(id): 'intg2:c1'.startsWith('intg') is true, but
    // 'intg2:c1'.startsWith('intg:') is false — only the delimiter keeps intg2 safe.
    mgr.enqueueMessage('intg', { chatId: 'c1', text: 'hi' })
    mgr.enqueueSSEEvent('intg', 'c2', { type: 'evt' }, 'sess-test')
    mgr.enqueueMessage('intg2', { chatId: 'c1', text: 'hi' })
    mgr.enqueueSSEEvent('intg2', 'c2', { type: 'evt' }, 'sess-test')
    await flushMicrotasks()

    // All in-flight, so all retained until explicitly removed.
    expect(mgr.messageQueues.has('intg:c1')).toBe(true)
    expect(mgr.messageQueues.has('sse:intg:c2')).toBe(true)
    expect(mgr.messageQueues.has('intg2:c1')).toBe(true)
    expect(mgr.messageQueues.has('sse:intg2:c2')).toBe(true)

    await mgr.removeIntegration('intg')

    // 'intg' message + SSE queues are gone…
    expect(mgr.messageQueues.has('intg:c1')).toBe(false)
    expect(mgr.messageQueues.has('sse:intg:c2')).toBe(false)
    // …but the prefix-colliding 'intg2' keys are untouched (':' delimiter).
    expect(mgr.messageQueues.has('intg2:c1')).toBe(true)
    expect(mgr.messageQueues.has('sse:intg2:c2')).toBe(true)
  })

  it('self-evicts even when the handler rejects (the .catch keeps the tail resolving)', async () => {
    // Both enqueue paths wrap the handler in .catch, so the tail promise resolves
    // even on failure and the entry still self-evicts — a failing message must not
    // leak a queue entry or surface an unhandled rejection.
    vi.spyOn(mgr, 'handleIncomingMessage').mockRejectedValue(new Error('boom'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    mgr.enqueueMessage('intg-rej', { chatId: 'chat-r', text: 'hi' })
    expect(mgr.messageQueues.has('intg-rej:chat-r')).toBe(true)

    await flushMicrotasks()

    expect(mgr.messageQueues.has('intg-rej:chat-r')).toBe(false)
    expect(mgr.messageQueues.size).toBe(0)
  })
})
