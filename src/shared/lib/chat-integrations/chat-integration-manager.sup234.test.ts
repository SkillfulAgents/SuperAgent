import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { chatIntegrationManager } from './chat-integration-manager'

// ---------------------------------------------------------------------------
// SUP-234 — cleanupResolvedQueues never removes settled promises.
//
// `cleanupResolvedQueues` tried to detect a settled Promise by attaching
// `.then(() => isSettled = true)` and reading `isSettled` on the very next
// synchronous line. Per ECMAScript, `.then` reactions are enqueued as
// microtasks and never run during the synchronous `.then()` call, so the flag
// is always `false` and the delete branch is unreachable. The companion
// `promise === Promise.resolve()` check can never match a `.then()`-chained
// queue value either. As a result `messageQueues` grows unbounded.
//
// These tests drive the manager's private message-queue mechanics directly
// (handlers stubbed so no container/agent code runs) and assert that:
//   1. a settled chat message queue entry is removed on cleanup,
//   2. a settled SSE queue entry is removed on cleanup,
//   3. an in-flight (never-resolving) entry is retained,
//   4. when a newer pending message replaces a settled one under the same key,
//      the (now unsettled) current entry is retained — the race guard.
// ---------------------------------------------------------------------------

interface ManagerInternals {
  messageQueues: Map<string, unknown>
  cleanupResolvedQueues: () => void
  enqueueMessage: (integrationId: string, message: { chatId: string; text?: string }) => void
  enqueueSSEEvent: (integrationId: string, chatId: string, event: unknown) => void
  handleIncomingMessage: (integrationId: string, message: unknown) => Promise<void>
  handleSSEEvent: (integrationId: string, chatId: string, event: unknown) => Promise<void>
}

const mgr = chatIntegrationManager as unknown as ManagerInternals

/** Let any settled `.then`/`.finally` microtasks drain. */
async function flushMicrotasks(times = 5): Promise<void> {
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

  it('removes already settled chat message queue entries during cleanup', async () => {
    vi.spyOn(mgr, 'handleIncomingMessage').mockResolvedValue(undefined)

    mgr.enqueueMessage('intg-1', { chatId: 'chat-1', text: 'hi' })
    expect(mgr.messageQueues.has('intg-1:chat-1')).toBe(true)

    // Let the queued chain (and its settled marker) drain.
    await flushMicrotasks()

    mgr.cleanupResolvedQueues()

    expect(mgr.messageQueues.has('intg-1:chat-1')).toBe(false)
    expect(mgr.messageQueues.size).toBe(0)
  })

  it('removes already settled SSE queue entries during cleanup', async () => {
    vi.spyOn(mgr, 'handleSSEEvent').mockResolvedValue(undefined)

    mgr.enqueueSSEEvent('intg-2', 'chat-2', { type: 'session_idle' })
    expect(mgr.messageQueues.has('sse:intg-2:chat-2')).toBe(true)

    await flushMicrotasks()

    mgr.cleanupResolvedQueues()

    expect(mgr.messageQueues.has('sse:intg-2:chat-2')).toBe(false)
    expect(mgr.messageQueues.size).toBe(0)
  })

  it('keeps in-flight (unsettled) queue entries during cleanup', async () => {
    vi.spyOn(mgr, 'handleIncomingMessage').mockReturnValue(pendingForever())

    mgr.enqueueMessage('intg-3', { chatId: 'chat-3', text: 'hi' })

    await flushMicrotasks()

    mgr.cleanupResolvedQueues()

    // The handler never resolved — the queue must not be evicted mid-flight.
    expect(mgr.messageQueues.has('intg-3:chat-3')).toBe(true)
  })

  it('retains a queue key when a newer pending message replaces a settled one', async () => {
    const handler = vi.spyOn(mgr, 'handleIncomingMessage')

    // First message settles immediately.
    handler.mockResolvedValueOnce(undefined)
    mgr.enqueueMessage('intg-4', { chatId: 'chat-4', text: 'first' })
    await flushMicrotasks()

    // Second message replaces the map value with a fresh, still-pending entry.
    handler.mockReturnValueOnce(pendingForever())
    mgr.enqueueMessage('intg-4', { chatId: 'chat-4', text: 'second' })
    await flushMicrotasks()

    mgr.cleanupResolvedQueues()

    // The current entry under this key is the unsettled second message — keep it.
    expect(mgr.messageQueues.has('intg-4:chat-4')).toBe(true)
  })
})
