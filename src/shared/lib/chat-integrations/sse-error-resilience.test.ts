/**
 * SSE Error Resilience Tests
 *
 * Verifies that processSSEEvent branches survive connector method throws
 * without crashing the pipeline or leaving state inconsistent.
 * These test the try/catch guards added for stability.
 */

import { describe, it, expect, vi } from 'vitest'
import { processSSEEvent, finalizeStreaming, resolvePendingToolMessages, type ManagedConnector } from './chat-integration-manager'
import { MockChatClientConnector } from './mock-connector'
import type { ChatIntegration } from '@shared/lib/db/schema'

// Suppress console.error noise from intentional throws
vi.spyOn(console, 'error').mockImplementation(() => {})

// Mock error-reporting so Sentry calls don't fail in test
vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
  addErrorBreadcrumb: vi.fn(),
}))

// ── Helpers ─────────────────────────────────────────────────────────────

function createManagedConnector(overrides?: Partial<ManagedConnector>): ManagedConnector {
  const connector = new MockChatClientConnector()
  return {
    connector,
    integration: {
      id: 'test-integration',
      agentSlug: 'test-agent',
      provider: 'telegram',
      name: 'Test Bot',
      config: '{}',
      showToolCalls: false,
      status: 'active',
      errorMessage: null,
      createdByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as ChatIntegration,
    chatId: 'chat-123',
    sseUnsubscribe: null,
    messageUnsubscribe: null,
    interactiveUnsubscribe: null,
    errorUnsubscribe: null,
    streamingState: {
      currentMessageId: null,
      accumulatedText: '',
      lastUpdateTime: 0,
    },
    currentToolInput: '',
    pendingToolMessages: [],
    ...overrides,
  }
}

function getMock(managed: ManagedConnector): MockChatClientConnector {
  return managed.connector as MockChatClientConnector
}

// ── stream_delta: sendStreamingUpdate throws ────────────────────────────

describe('stream_delta error resilience', () => {
  it('does not throw when sendStreamingUpdate fails', async () => {
    const managed = createManagedConnector()
    managed.streamingState.lastUpdateTime = 0 // force throttle to pass
    const mock = getMock(managed)
    mock.sendStreamingUpdate = async () => { throw new Error('network failure') }

    // Should not throw
    await processSSEEvent(managed, { type: 'stream_delta', text: 'Hello' })

    // Text should still be accumulated even though sending failed
    expect(managed.streamingState.accumulatedText).toBe('Hello')
  })

  it('preserves state for retry after streaming failure', async () => {
    const managed = createManagedConnector()
    managed.streamingState.lastUpdateTime = 0
    const mock = getMock(managed)

    let callCount = 0
    mock.sendStreamingUpdate = async (_chatId: string, _text: string) => {
      callCount++
      if (callCount === 1) throw new Error('first call fails')
      return 'msg-1'
    }

    // First call fails
    await processSSEEvent(managed, { type: 'stream_delta', text: 'Hello ' })
    expect(managed.streamingState.accumulatedText).toBe('Hello ')
    // currentMessageId should be unchanged (null) since the first call failed
    expect(managed.streamingState.currentMessageId).toBeNull()

    // Second delta arrives after throttle — retry succeeds
    managed.streamingState.lastUpdateTime = 0
    await processSSEEvent(managed, { type: 'stream_delta', text: 'world' })
    expect(managed.streamingState.accumulatedText).toBe('Hello world')
    expect(managed.streamingState.currentMessageId).toBe('msg-1')
  })
})

// ── session_idle: finalizeStreaming / resolvePendingToolMessages throw ──

describe('session_idle error resilience', () => {
  it('does not throw when finalizeStreamingMessage fails', async () => {
    const managed = createManagedConnector()
    managed.streamingState.accumulatedText = 'Final text'
    managed.streamingState.currentMessageId = 'msg-1'
    const mock = getMock(managed)
    mock.finalizeStreamingMessage = async () => { throw new Error('finalize failed') }

    // finalizeStreaming falls back to sendMessage
    await processSSEEvent(managed, { type: 'session_idle' })

    // Fallback sendMessage should have been called
    expect(mock.sentMessages.length).toBe(1)
    expect(mock.sentMessages[0].message.text).toBe('Final text')
    // State should be reset
    expect(managed.streamingState.accumulatedText).toBe('')
  })

  it('does not throw when both finalize and fallback sendMessage fail', async () => {
    const managed = createManagedConnector()
    managed.streamingState.accumulatedText = 'Final text'
    managed.streamingState.currentMessageId = 'msg-1'
    const mock = getMock(managed)
    mock.finalizeStreamingMessage = async () => { throw new Error('finalize failed') }
    mock.sendMessage = async () => { throw new Error('sendMessage also failed') }

    // Should not throw — the session_idle catch handles it
    await processSSEEvent(managed, { type: 'session_idle' })

    // State may not be fully reset since sendMessage threw inside finalizeStreaming,
    // but the outer catch in session_idle prevents the crash
  })

  it('does not throw when sendStreamingUpdate fails during resolvePendingToolMessages', async () => {
    const managed = createManagedConnector()
    managed.pendingToolMessages = [
      { messageId: 'msg-1', text: '🔧 *Bash* ⏳' },
      { messageId: 'msg-2', text: '🔧 *Read* ⏳' },
    ]
    const mock = getMock(managed)
    mock.sendStreamingUpdate = async () => { throw new Error('update failed') }

    await processSSEEvent(managed, { type: 'session_idle' })

    // Pending messages should be cleared regardless
    expect(managed.pendingToolMessages).toEqual([])
  })
})

// ── stream_start: finalize throws ───────────────────────────────────────

describe('stream_start error resilience', () => {
  it('does not throw when finalize fails on stream_start', async () => {
    const managed = createManagedConnector()
    managed.streamingState.accumulatedText = 'Previous text'
    managed.streamingState.currentMessageId = 'msg-1'
    const mock = getMock(managed)
    mock.finalizeStreamingMessage = async () => { throw new Error('finalize failed') }
    mock.sendMessage = async () => { throw new Error('fallback also failed') }

    // Should not throw
    await processSSEEvent(managed, { type: 'stream_start' })

    // Typing indicator should still be sent
    expect(mock.typingIndicators.length).toBe(1)
  })
})

// ── tool_use_start: finalize throws ─────────────────────────────────────

describe('tool_use_start error resilience', () => {
  it('does not throw when finalize fails on tool_use_start', async () => {
    const managed = createManagedConnector()
    managed.streamingState.accumulatedText = 'Text before tool'
    managed.streamingState.currentMessageId = 'msg-1'
    const mock = getMock(managed)
    mock.finalizeStreamingMessage = async () => { throw new Error('finalize failed') }
    mock.sendMessage = async () => { throw new Error('fallback also failed') }

    await processSSEEvent(managed, { type: 'tool_use_start', toolId: 't1', toolName: 'Bash' })

    // currentToolInput should still be reset
    expect(managed.currentToolInput).toBe('')
  })
})

// ── user request card: sendUserRequestCard throws ───────────────────────

describe('user request card error resilience', () => {
  const requestTypes = [
    'user_question_request',
    'secret_request',
    'file_request',
    'connected_account_request',
    'remote_mcp_request',
    'browser_input_request',
    'script_run_request',
    'computer_use_request',
  ]

  for (const eventType of requestTypes) {
    it(`does not throw when sendUserRequestCard fails for ${eventType}`, async () => {
      const managed = createManagedConnector()
      const mock = getMock(managed)
      mock.sendUserRequestCard = async () => { throw new Error('card send failed') }

      // Should not throw
      await processSSEEvent(managed, { type: eventType, toolUseId: 'tu-1' })
    })
  }

  it('subsequent events still process after sendUserRequestCard failure', async () => {
    const managed = createManagedConnector()
    managed.streamingState.lastUpdateTime = 0
    const mock = getMock(managed)
    mock.sendUserRequestCard = async () => { throw new Error('card send failed') }

    // Card fails
    await processSSEEvent(managed, { type: 'user_question_request', toolUseId: 'tu-1' })
    // Streaming still works
    await processSSEEvent(managed, { type: 'stream_delta', text: 'After card failure' })

    expect(managed.streamingState.accumulatedText).toBe('After card failure')
    expect(mock.streamUpdates.length).toBe(1)
  })
})

// ── tool_use_ready with showToolCalls: sendMessage throws ───────────────

describe('tool call message error resilience', () => {
  it('does not throw when sendMessage fails for tool call display', async () => {
    const managed = createManagedConnector()
    const mock = getMock(managed)
    mock.sendMessage = async () => { throw new Error('send failed') }

    await processSSEEvent(managed, {
      type: 'tool_use_ready',
      toolId: 't1',
      toolName: 'Bash',
    }, /* showToolCalls */ true)

    // Should not have been added to pending since the send failed
    expect(managed.pendingToolMessages.length).toBe(0)
    // currentToolInput should still be reset
    expect(managed.currentToolInput).toBe('')
  })
})

// ── finalizeStreaming: fallback path ─────────────────────────────────────

describe('finalizeStreaming fallback behavior', () => {
  it('sends as new message when finalizeStreamingMessage throws', async () => {
    const managed = createManagedConnector()
    managed.streamingState.accumulatedText = 'Test text'
    managed.streamingState.currentMessageId = 'msg-1'
    const mock = getMock(managed)
    mock.finalizeStreamingMessage = async () => { throw new Error('finalize failed') }

    await finalizeStreaming(managed)

    // Fallback: sent as new message
    expect(mock.sentMessages.length).toBe(1)
    expect(mock.sentMessages[0].message.text).toBe('Test text')
    // State reset
    expect(managed.streamingState.accumulatedText).toBe('')
    expect(managed.streamingState.currentMessageId).toBeNull()
  })

  it('does nothing when accumulatedText is empty', async () => {
    const managed = createManagedConnector()
    managed.streamingState.accumulatedText = ''
    const mock = getMock(managed)

    await finalizeStreaming(managed)

    expect(mock.sentMessages.length).toBe(0)
    expect(mock.finalizedMessages.length).toBe(0)
  })
})

// ── resolvePendingToolMessages: connector throws ───���────────────────────

describe('resolvePendingToolMessages error resilience', () => {
  it('clears all pending messages even when sendStreamingUpdate throws', async () => {
    const managed = createManagedConnector()
    managed.pendingToolMessages = [
      { messageId: 'msg-1', text: '🔧 *Bash* ⏳' },
      { messageId: 'msg-2', text: '🔧 *Read* ⏳' },
      { messageId: 'msg-3', text: '🔧 *Write* ⏳' },
    ]
    const mock = getMock(managed)
    mock.sendStreamingUpdate = async () => { throw new Error('every update fails') }

    await resolvePendingToolMessages(managed)

    // All cleared even though updates failed
    expect(managed.pendingToolMessages).toEqual([])
  })

  it('processes all messages even when some fail', async () => {
    const managed = createManagedConnector()
    managed.pendingToolMessages = [
      { messageId: 'msg-1', text: '🔧 *Bash* ⏳' },
      { messageId: 'msg-2', text: '🔧 *Read* ⏳' },
    ]
    const mock = getMock(managed)
    let callCount = 0
    mock.sendStreamingUpdate = async (_chatId: string, text: string, existingId?: string) => {
      callCount++
      if (callCount === 1) throw new Error('first fails')
      return existingId || 'new-id'
    }

    await resolvePendingToolMessages(managed)

    // Both were attempted
    expect(callCount).toBe(2)
    expect(managed.pendingToolMessages).toEqual([])
  })
})

// ── Full pipeline: errors don't cascade across events ───────────────────

describe('pipeline isolation', () => {
  it('error in one event does not affect subsequent events', async () => {
    const managed = createManagedConnector()
    managed.streamingState.lastUpdateTime = 0
    const mock = getMock(managed)

    // Make sendUserRequestCard throw
    const origSendCard = mock.sendUserRequestCard.bind(mock)
    mock.sendUserRequestCard = async () => {
      mock.sendUserRequestCard = origSendCard // restore after first call
      throw new Error('one-time card failure')
    }

    // Process a card event (fails), then a streaming event (should succeed)
    await processSSEEvent(managed, { type: 'user_question_request', toolUseId: 'tu-1' })
    await processSSEEvent(managed, { type: 'stream_delta', text: 'Still works' })

    expect(managed.streamingState.accumulatedText).toBe('Still works')
    expect(mock.streamUpdates.length).toBe(1)
  })

  it('handles interleaved errors gracefully across event types', async () => {
    const managed = createManagedConnector()
    managed.streamingState.lastUpdateTime = 0
    const mock = getMock(managed)

    // Streaming update fails
    let streamCallCount = 0
    const origStreamUpdate = mock.sendStreamingUpdate.bind(mock)
    mock.sendStreamingUpdate = async (...args) => {
      streamCallCount++
      if (streamCallCount === 1) throw new Error('stream fails once')
      return origStreamUpdate(...args)
    }

    // First delta fails to send but text is accumulated
    await processSSEEvent(managed, { type: 'stream_delta', text: 'First ' })
    expect(managed.streamingState.accumulatedText).toBe('First ')

    // Second delta succeeds (includes all accumulated text)
    managed.streamingState.lastUpdateTime = 0
    await processSSEEvent(managed, { type: 'stream_delta', text: 'second' })
    expect(managed.streamingState.accumulatedText).toBe('First second')

    // Session idle finalizes everything
    await processSSEEvent(managed, { type: 'session_idle' })
    const allOutputs = [
      ...mock.sentMessages.map(m => m.message.text),
      ...mock.finalizedMessages.map(m => m.finalText),
    ]
    expect(allOutputs.some(t => t.includes('First second'))).toBe(true)
  })
})
