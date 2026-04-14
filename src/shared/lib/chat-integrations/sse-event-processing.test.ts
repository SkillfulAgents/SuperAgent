import { describe, it, expect, beforeEach, vi } from 'vitest'
import { processSSEEvent, finalizeStreaming, resolvePendingToolMessages, type ManagedConnector } from './chat-integration-manager'
import { MockChatClientConnector } from './mock-connector'
import type { ChatIntegration } from '@shared/lib/db/schema'

// ── Test helpers ────────────────────────────────────────────────────────

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

/** Simulate a sequence of SSE events */
async function processEvents(
  managed: ManagedConnector,
  events: Array<Record<string, unknown>>,
  showToolCalls = false,
) {
  for (const event of events) {
    await processSSEEvent(managed, event, showToolCalls)
  }
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('processSSEEvent', () => {
  let managed: ManagedConnector

  beforeEach(() => {
    managed = createManagedConnector()
  })

  // ── Basic streaming ─────────────────────────────────────────────

  describe('streaming text', () => {
    it('accumulates stream_delta text', async () => {
      await processEvents(managed, [
        { type: 'stream_delta', text: 'Hello ' },
        { type: 'stream_delta', text: 'world' },
      ])
      expect(managed.streamingState.accumulatedText).toBe('Hello world')
    })

    it('sends streaming updates when throttle period elapsed', async () => {
      managed.streamingState.lastUpdateTime = 0 // force throttle to pass
      await processSSEEvent(managed, { type: 'stream_delta', text: 'Hello' })

      const mock = getMock(managed)
      expect(mock.streamUpdates.length).toBe(1)
      expect(mock.streamUpdates[0].text).toBe('Hello')
    })

    it('throttles streaming updates within 1 second', async () => {
      managed.streamingState.lastUpdateTime = Date.now() // just updated
      await processSSEEvent(managed, { type: 'stream_delta', text: 'Hello' })

      const mock = getMock(managed)
      expect(mock.streamUpdates.length).toBe(0)
      expect(managed.streamingState.accumulatedText).toBe('Hello')
    })

    it('finalizes streaming on session_idle', async () => {
      managed.streamingState.accumulatedText = 'Final text'
      managed.streamingState.currentMessageId = 'msg-1'

      await processSSEEvent(managed, { type: 'session_idle' })

      const mock = getMock(managed)
      expect(mock.finalizedMessages.length).toBe(1)
      expect(mock.finalizedMessages[0].finalText).toBe('Final text')
      expect(managed.streamingState.accumulatedText).toBe('')
    })

    it('sends as new message if no streaming message existed', async () => {
      managed.streamingState.accumulatedText = 'Short response'
      managed.streamingState.currentMessageId = null

      await processSSEEvent(managed, { type: 'session_idle' })

      const mock = getMock(managed)
      expect(mock.sentMessages.length).toBe(1)
      expect(mock.sentMessages[0].message.text).toBe('Short response')
    })

    it('does nothing on session_idle with no accumulated text', async () => {
      await processSSEEvent(managed, { type: 'session_idle' })

      const mock = getMock(managed)
      expect(mock.sentMessages.length).toBe(0)
      expect(mock.finalizedMessages.length).toBe(0)
    })
  })

  // ── Stream start ────────────────────────────────────────────────

  describe('stream_start', () => {
    it('finalizes previous text before new stream', async () => {
      managed.streamingState.accumulatedText = 'Previous text'
      managed.streamingState.currentMessageId = 'msg-1'

      await processSSEEvent(managed, { type: 'stream_start' })

      const mock = getMock(managed)
      expect(mock.finalizedMessages.length).toBe(1)
      expect(mock.finalizedMessages[0].finalText).toBe('Previous text')
      // State should be reset
      expect(managed.streamingState.accumulatedText).toBe('')
      expect(managed.streamingState.currentMessageId).toBeNull()
    })

    it('shows typing indicator', async () => {
      await processSSEEvent(managed, { type: 'stream_start' })

      const mock = getMock(managed)
      expect(mock.typingIndicators.length).toBe(1)
    })
  })

  // ── Message ordering: text → tool → text ────────────────────────

  describe('message ordering', () => {
    it('flushes text before tool_use_start', async () => {
      // Simulate: text streaming → tool starts
      managed.streamingState.accumulatedText = 'Let me check that...'
      managed.streamingState.currentMessageId = 'msg-1'

      await processSSEEvent(managed, { type: 'tool_use_start', toolId: 't1', toolName: 'Bash' })

      const mock = getMock(managed)
      // Text should be finalized before the tool
      expect(mock.finalizedMessages.length).toBe(1)
      expect(mock.finalizedMessages[0].finalText).toBe('Let me check that...')
      expect(managed.streamingState.accumulatedText).toBe('')
    })

    it('preserves correct order: text → tool → text → tool', async () => {
      // Track all outputs in order via a shared log
      const outputLog: string[] = []
      const mock = getMock(managed)
      const origSend = mock.sendMessage.bind(mock)
      const origFinalize = mock.finalizeStreamingMessage.bind(mock)
      const origStream = mock.sendStreamingUpdate.bind(mock)

      mock.sendMessage = async (chatId: string, message: { text: string }) => {
        outputLog.push(`msg:${message.text}`)
        return origSend(chatId, message)
      }
      mock.finalizeStreamingMessage = async (chatId: string, messageId: string, finalText: string) => {
        outputLog.push(`finalize:${finalText}`)
        return origFinalize(chatId, messageId, finalText)
      }
      mock.sendStreamingUpdate = async (chatId: string, text: string, existingMessageId?: string) => {
        // Don't log streaming updates — they're intermediate
        return origStream(chatId, text, existingMessageId)
      }

      const events: Array<Record<string, unknown>> = [
        // First text segment
        { type: 'stream_start' },
        { type: 'stream_delta', text: 'First text' },
        // Tool call
        { type: 'tool_use_start', toolId: 't1', toolName: 'Bash' },
        { type: 'tool_use_streaming', partialInput: '{"command":"ls"}' },
        { type: 'tool_use_ready', toolId: 't1', toolName: 'Bash' },
        // Second text segment
        { type: 'stream_start' },
        { type: 'stream_delta', text: 'Second text' },
        // Another tool
        { type: 'tool_use_start', toolId: 't2', toolName: 'Read' },
        { type: 'tool_use_streaming', partialInput: '{"file_path":"src/index.ts"}' },
        { type: 'tool_use_ready', toolId: 't2', toolName: 'Read' },
        // Final text
        { type: 'stream_start' },
        { type: 'stream_delta', text: 'Done!' },
        { type: 'session_idle' },
      ]

      managed.streamingState.lastUpdateTime = 0
      await processEvents(managed, events, true)

      // Verify ordering: text appears BEFORE tool, not after
      // "First text" (finalize or msg) → Bash tool → "Second text" → Read tool → "Done!"
      expect(outputLog.length).toBe(5)

      expect(outputLog[0]).toContain('First text')
      expect(outputLog[1]).toContain('Bash')
      expect(outputLog[2]).toContain('Second text')
      expect(outputLog[3]).toContain('Read')
      expect(outputLog[4]).toContain('Done!')
    })

    it('does not send tool summary when showToolCalls is false', async () => {
      await processEvents(managed, [
        { type: 'tool_use_start', toolId: 't1', toolName: 'Bash' },
        { type: 'tool_use_streaming', partialInput: '{"command":"ls"}' },
        { type: 'tool_use_ready', toolId: 't1', toolName: 'Bash' },
      ], false) // showToolCalls = false

      const mock = getMock(managed)
      expect(mock.sentMessages.length).toBe(0)
    })

    it('sends tool summary when showToolCalls is true', async () => {
      await processEvents(managed, [
        { type: 'tool_use_start', toolId: 't1', toolName: 'Bash' },
        { type: 'tool_use_streaming', partialInput: '{"command":"ls -la"}' },
        { type: 'tool_use_ready', toolId: 't1', toolName: 'Bash' },
      ], true)

      const mock = getMock(managed)
      expect(mock.sentMessages.length).toBe(1)
      expect(mock.sentMessages[0].message.text).toContain('Bash')
      expect(mock.sentMessages[0].message.text).toContain('ls -la')
    })
  })

  // ── Tool input accumulation ─────────────────────────────────────

  describe('tool input accumulation', () => {
    it('stores latest partialInput (not appended)', async () => {
      await processEvents(managed, [
        { type: 'tool_use_start', toolId: 't1', toolName: 'Bash' },
        { type: 'tool_use_streaming', partialInput: '{"com' },
        { type: 'tool_use_streaming', partialInput: '{"command":"ls"}' },
      ])
      expect(managed.currentToolInput).toBe('{"command":"ls"}')
    })

    it('resets tool input on tool_use_start', async () => {
      managed.currentToolInput = 'leftover'
      await processSSEEvent(managed, { type: 'tool_use_start', toolId: 't1', toolName: 'Bash' })
      expect(managed.currentToolInput).toBe('')
    })

    it('resets tool input after tool_use_ready', async () => {
      await processEvents(managed, [
        { type: 'tool_use_start', toolId: 't1', toolName: 'Bash' },
        { type: 'tool_use_streaming', partialInput: '{"command":"ls"}' },
        { type: 'tool_use_ready', toolId: 't1', toolName: 'Bash' },
      ])
      expect(managed.currentToolInput).toBe('')
    })

    it('handles invalid JSON in tool input gracefully', async () => {
      await processEvents(managed, [
        { type: 'tool_use_start', toolId: 't1', toolName: 'Bash' },
        { type: 'tool_use_streaming', partialInput: '{invalid' },
        { type: 'tool_use_ready', toolId: 't1', toolName: 'Bash' },
      ], true)

      const mock = getMock(managed)
      // Should still send the tool name even if input parse fails
      expect(mock.sentMessages.length).toBe(1)
      expect(mock.sentMessages[0].message.text).toContain('Bash')
    })
  })

  // ── User request tools ──────────────────────────────────────────

  describe('user request tools', () => {
    it('skips user request tools in tool_use_ready', async () => {
      await processEvents(managed, [
        { type: 'tool_use_start', toolId: 't1', toolName: 'AskUserQuestion' },
        { type: 'tool_use_ready', toolId: 't1', toolName: 'AskUserQuestion' },
      ], true) // even with showToolCalls

      const mock = getMock(managed)
      expect(mock.sentMessages.length).toBe(0) // no tool summary
    })

    it('forwards user_question_request to sendUserRequestCard', async () => {
      await processSSEEvent(managed, {
        type: 'user_question_request',
        toolUseId: 'tu-1',
        questions: [{ question: 'Which DB?' }],
      })

      const mock = getMock(managed)
      expect(mock.sentCards.length).toBe(1)
      expect(mock.sentCards[0].event.type).toBe('user_question_request')
    })

    it('forwards secret_request to sendUserRequestCard', async () => {
      await processSSEEvent(managed, {
        type: 'secret_request',
        toolUseId: 'tu-2',
        secretName: 'API_KEY',
      })

      const mock = getMock(managed)
      expect(mock.sentCards.length).toBe(1)
      expect(mock.sentCards[0].event.type).toBe('secret_request')
    })
  })

  // ── Typing indicator ────────────────────────────────────────────

  describe('typing indicator', () => {
    it('sends typing on stream_start', async () => {
      await processSSEEvent(managed, { type: 'stream_start' })
      expect(getMock(managed).typingIndicators.length).toBe(1)
    })

    it('refreshes typing on messages_updated only when streaming', async () => {
      // No accumulated text — should NOT send typing
      await processSSEEvent(managed, { type: 'messages_updated' })
      expect(getMock(managed).typingIndicators.length).toBe(0)

      // With accumulated text — should send typing
      managed.streamingState.accumulatedText = 'some text'
      await processSSEEvent(managed, { type: 'messages_updated' })
      expect(getMock(managed).typingIndicators.length).toBe(1)
    })

    it('does not send typing on tool_use_ready', async () => {
      await processEvents(managed, [
        { type: 'tool_use_start', toolId: 't1', toolName: 'Bash' },
        { type: 'tool_use_ready', toolId: 't1', toolName: 'Bash' },
      ])
      // No typing from tool_use_ready (only from stream_start)
      expect(getMock(managed).typingIndicators.length).toBe(0)
    })
  })
})

// ── finalizeStreaming ──────────────────────────────────────────────────

describe('finalizeStreaming', () => {
  it('does nothing with empty accumulated text', async () => {
    const managed = createManagedConnector()
    await finalizeStreaming(managed)
    expect(getMock(managed).sentMessages.length).toBe(0)
    expect(getMock(managed).finalizedMessages.length).toBe(0)
  })

  it('edits existing message when currentMessageId is set', async () => {
    const managed = createManagedConnector()
    managed.streamingState.accumulatedText = 'Final text'
    managed.streamingState.currentMessageId = 'msg-42'

    await finalizeStreaming(managed)

    const mock = getMock(managed)
    expect(mock.finalizedMessages.length).toBe(1)
    expect(mock.finalizedMessages[0].messageId).toBe('msg-42')
    expect(mock.finalizedMessages[0].finalText).toBe('Final text')
  })

  it('sends new message when no currentMessageId', async () => {
    const managed = createManagedConnector()
    managed.streamingState.accumulatedText = 'Quick reply'

    await finalizeStreaming(managed)

    const mock = getMock(managed)
    expect(mock.sentMessages.length).toBe(1)
    expect(mock.sentMessages[0].message.text).toBe('Quick reply')
  })

  it('resets streaming state after finalization', async () => {
    const managed = createManagedConnector()
    managed.streamingState.accumulatedText = 'Some text'
    managed.streamingState.currentMessageId = 'msg-1'
    managed.streamingState.lastUpdateTime = 999

    await finalizeStreaming(managed)

    expect(managed.streamingState.accumulatedText).toBe('')
    expect(managed.streamingState.currentMessageId).toBeNull()
    expect(managed.streamingState.lastUpdateTime).toBe(0)
  })

  it('falls back to sendMessage when finalizeStreamingMessage throws', async () => {
    const managed = createManagedConnector()
    managed.streamingState.accumulatedText = 'Final text'
    managed.streamingState.currentMessageId = 'msg-1'

    const mock = getMock(managed)
    mock.finalizeStreamingMessage = vi.fn().mockRejectedValue(new Error('Edit failed'))

    await finalizeStreaming(managed)

    // Should have tried to finalize, failed, then sent as new message
    expect(mock.finalizeStreamingMessage).toHaveBeenCalledOnce()
    expect(mock.sentMessages.length).toBe(1)
    expect(mock.sentMessages[0].message.text).toBe('Final text')
    // State should still be reset
    expect(managed.streamingState.accumulatedText).toBe('')
    expect(managed.streamingState.currentMessageId).toBeNull()
  })
})

// ── resolvePendingToolMessages ────────────────────────────────────────────

describe('resolvePendingToolMessages', () => {
  it('does nothing when no pending messages', async () => {
    const managed = createManagedConnector()
    await resolvePendingToolMessages(managed)

    const mock = getMock(managed)
    expect(mock.streamUpdates.length).toBe(0)
  })

  it('updates all pending messages from ⏳ to ✅', async () => {
    const managed = createManagedConnector()
    managed.pendingToolMessages = [
      { messageId: 'msg-1', text: '🔧 *Bash* — `ls -la` ⏳' },
      { messageId: 'msg-2', text: '🔧 *Read* ⏳' },
    ]

    await resolvePendingToolMessages(managed)

    const mock = getMock(managed)
    expect(mock.streamUpdates.length).toBe(2)
    expect(mock.streamUpdates[0].text).toContain('✅')
    expect(mock.streamUpdates[0].text).not.toContain('⏳')
    expect(mock.streamUpdates[0].existingMessageId).toBe('msg-1')
    expect(mock.streamUpdates[1].text).toContain('✅')
    expect(mock.streamUpdates[1].existingMessageId).toBe('msg-2')
  })

  it('clears the pending array after resolution', async () => {
    const managed = createManagedConnector()
    managed.pendingToolMessages = [
      { messageId: 'msg-1', text: '🔧 *Bash* ⏳' },
    ]

    await resolvePendingToolMessages(managed)

    expect(managed.pendingToolMessages.length).toBe(0)
  })

  it('continues resolving remaining messages if one fails', async () => {
    const managed = createManagedConnector()
    managed.pendingToolMessages = [
      { messageId: 'msg-1', text: '🔧 *Bash* ⏳' },
      { messageId: 'msg-2', text: '🔧 *Read* ⏳' },
    ]

    const mock = getMock(managed)
    let callCount = 0
    const origStream = mock.sendStreamingUpdate.bind(mock)
    mock.sendStreamingUpdate = async (chatId: string, text: string, existingMessageId?: string) => {
      callCount++
      if (callCount === 1) throw new Error('Message deleted')
      return origStream(chatId, text, existingMessageId)
    }

    await resolvePendingToolMessages(managed)

    // Second message should still have been resolved
    expect(mock.streamUpdates.length).toBe(1) // only 2nd call succeeded (origStream records it)
    expect(managed.pendingToolMessages.length).toBe(0)
  })
})

// ── Pending tool messages lifecycle ───────────────────────────────────────

describe('pendingToolMessages lifecycle', () => {
  let managed: ManagedConnector

  beforeEach(() => {
    managed = createManagedConnector()
  })

  it('tool_use_ready with showToolCalls populates pendingToolMessages', async () => {
    await processEvents(managed, [
      { type: 'tool_use_start', toolId: 't1', toolName: 'Bash' },
      { type: 'tool_use_streaming', partialInput: '{"command":"ls"}' },
      { type: 'tool_use_ready', toolId: 't1', toolName: 'Bash' },
    ], true)

    expect(managed.pendingToolMessages.length).toBe(1)
    expect(managed.pendingToolMessages[0].text).toContain('⏳')
  })

  it('tool_use_ready with showToolCalls=false does NOT populate pendingToolMessages', async () => {
    await processEvents(managed, [
      { type: 'tool_use_start', toolId: 't1', toolName: 'Bash' },
      { type: 'tool_use_streaming', partialInput: '{"command":"ls"}' },
      { type: 'tool_use_ready', toolId: 't1', toolName: 'Bash' },
    ], false)

    expect(managed.pendingToolMessages.length).toBe(0)
  })

  it('stream_start resolves pending tool messages', async () => {
    // Simulate: tool completes, then new text stream starts
    managed.pendingToolMessages = [
      { messageId: 'msg-1', text: '🔧 *Bash* ⏳' },
    ]

    await processSSEEvent(managed, { type: 'stream_start' })

    const mock = getMock(managed)
    // Pending tool messages should have been resolved (⏳ → ✅)
    expect(mock.streamUpdates.length).toBe(1)
    expect(mock.streamUpdates[0].text).toContain('✅')
    expect(managed.pendingToolMessages.length).toBe(0)
  })

  it('session_idle resolves pending tool messages', async () => {
    managed.pendingToolMessages = [
      { messageId: 'msg-1', text: '🔧 *Bash* ⏳' },
      { messageId: 'msg-2', text: '🔧 *Read* ⏳' },
    ]

    await processSSEEvent(managed, { type: 'session_idle' })

    const mock = getMock(managed)
    expect(mock.streamUpdates.length).toBe(2)
    expect(mock.streamUpdates[0].text).toContain('✅')
    expect(mock.streamUpdates[1].text).toContain('✅')
    expect(managed.pendingToolMessages.length).toBe(0)
  })

  it('full lifecycle: text → tool(⏳) → text(✅ resolved) → idle', async () => {
    const outputLog: string[] = []
    const mock = getMock(managed)
    const origSend = mock.sendMessage.bind(mock)
    const origStream = mock.sendStreamingUpdate.bind(mock)
    const origFinalize = mock.finalizeStreamingMessage.bind(mock)

    mock.sendMessage = async (chatId: string, message: { text: string }) => {
      outputLog.push(`msg:${message.text.slice(0, 30)}`)
      return origSend(chatId, message)
    }
    mock.sendStreamingUpdate = async (chatId: string, text: string, existingMessageId?: string) => {
      if (existingMessageId && text.includes('✅')) {
        outputLog.push(`resolve:${text.slice(0, 30)}`)
      }
      return origStream(chatId, text, existingMessageId)
    }
    mock.finalizeStreamingMessage = async (chatId: string, messageId: string, finalText: string) => {
      outputLog.push(`finalize:${finalText.slice(0, 30)}`)
      return origFinalize(chatId, messageId, finalText)
    }

    managed.streamingState.lastUpdateTime = 0
    await processEvents(managed, [
      { type: 'stream_start' },
      { type: 'stream_delta', text: 'Checking files...' },
      { type: 'tool_use_start', toolId: 't1', toolName: 'Bash' },
      { type: 'tool_use_streaming', partialInput: '{"command":"ls"}' },
      { type: 'tool_use_ready', toolId: 't1', toolName: 'Bash' },
      { type: 'stream_start' },  // should resolve ⏳ → ✅
      { type: 'stream_delta', text: 'Here are the files' },
      { type: 'session_idle' },
    ], true)

    // Text finalized before tool, tool message sent with ⏳, resolved to ✅ on stream_start
    expect(outputLog.some(l => l.includes('Checking files'))).toBe(true)
    expect(outputLog.some(l => l.includes('Bash'))).toBe(true)
    expect(outputLog.some(l => l.includes('resolve:') && l.includes('✅'))).toBe(true)
    expect(outputLog.some(l => l.includes('Here are the files'))).toBe(true)
  })
})

// ── Additional user request event types ──────────────────────────────────

describe('all user request event types', () => {
  let managed: ManagedConnector

  beforeEach(() => {
    managed = createManagedConnector()
  })

  const userRequestEvents = [
    { type: 'file_request', toolUseId: 'tu-1', description: 'Upload a CSV' },
    { type: 'connected_account_request', toolUseId: 'tu-2', provider: 'github' },
    { type: 'remote_mcp_request', toolUseId: 'tu-3', serverName: 'my-mcp' },
    { type: 'browser_input_request', toolUseId: 'tu-4', url: 'https://example.com' },
    { type: 'script_run_request', toolUseId: 'tu-5', script: 'npm test' },
    { type: 'computer_use_request', toolUseId: 'tu-6', action: 'screenshot' },
  ]

  for (const event of userRequestEvents) {
    it(`forwards ${event.type} to sendUserRequestCard`, async () => {
      await processSSEEvent(managed, event)

      const mock = getMock(managed)
      expect(mock.sentCards.length).toBe(1)
      expect(mock.sentCards[0].event.type).toBe(event.type)
    })
  }

  it('skips all user request tool names in tool_use_ready', async () => {
    const userRequestToolNames = [
      'AskUserQuestion',
      'mcp__user-input__request_secret',
      'mcp__user-input__request_file',
      'mcp__user-input__deliver_file',
      'mcp__user-input__request_connected_account',
      'mcp__user-input__request_remote_mcp',
      'mcp__user-input__request_browser_input',
      'mcp__user-input__request_script_run',
    ]

    for (const toolName of userRequestToolNames) {
      const m = createManagedConnector()
      await processEvents(m, [
        { type: 'tool_use_start', toolId: 't1', toolName },
        { type: 'tool_use_ready', toolId: 't1', toolName },
      ], true)

      const mock = getMock(m)
      expect(mock.sentMessages.length).toBe(0)
    }
  })
})

// ── Edge cases and robustness ─────────────────────────────────────────────

describe('edge cases', () => {
  let managed: ManagedConnector

  beforeEach(() => {
    managed = createManagedConnector()
  })

  it('ignores unknown event types without error', async () => {
    await processSSEEvent(managed, { type: 'unknown_event_type', data: 'whatever' })

    const mock = getMock(managed)
    expect(mock.sentMessages.length).toBe(0)
    expect(mock.streamUpdates.length).toBe(0)
    expect(mock.finalizedMessages.length).toBe(0)
  })

  it('handles stream_delta with empty text', async () => {
    await processSSEEvent(managed, { type: 'stream_delta', text: '' })
    expect(managed.streamingState.accumulatedText).toBe('')
  })

  it('handles stream_delta with null text', async () => {
    await processSSEEvent(managed, { type: 'stream_delta', text: null })
    expect(managed.streamingState.accumulatedText).toBe('')
  })

  it('handles stream_delta with undefined text', async () => {
    await processSSEEvent(managed, { type: 'stream_delta' })
    expect(managed.streamingState.accumulatedText).toBe('')
  })

  it('handles event with no type', async () => {
    await processSSEEvent(managed, { data: 'no type field' })

    const mock = getMock(managed)
    expect(mock.sentMessages.length).toBe(0)
  })

  it('handles tool_use_streaming with no partialInput', async () => {
    managed.currentToolInput = 'existing'
    await processSSEEvent(managed, { type: 'tool_use_streaming' })
    // Should not clear existing input when no partialInput provided
    expect(managed.currentToolInput).toBe('existing')
  })

  it('handles multiple consecutive stream_start events', async () => {
    managed.streamingState.accumulatedText = 'Text 1'
    managed.streamingState.currentMessageId = 'msg-1'

    await processSSEEvent(managed, { type: 'stream_start' })
    // First stream_start finalizes "Text 1"

    await processSSEEvent(managed, { type: 'stream_start' })
    // Second stream_start has nothing to finalize — should not error

    const mock = getMock(managed)
    expect(mock.finalizedMessages.length).toBe(1) // Only one finalization
    expect(mock.typingIndicators.length).toBe(2) // Typing sent for both
  })

  it('handles session_idle followed by more streaming', async () => {
    // Simulate: response completes, then a new turn starts
    managed.streamingState.lastUpdateTime = 0
    await processEvents(managed, [
      { type: 'stream_delta', text: 'First response' },
      { type: 'session_idle' },
      { type: 'stream_start' },
      { type: 'stream_delta', text: 'Second response' },
      { type: 'session_idle' },
    ])

    const mock = getMock(managed)
    // Both responses should be delivered
    const allTexts = [
      ...mock.sentMessages.map(m => m.message.text),
      ...mock.finalizedMessages.map(m => m.finalText),
    ]
    expect(allTexts.some(t => t.includes('First response'))).toBe(true)
    expect(allTexts.some(t => t.includes('Second response'))).toBe(true)
  })

  it('handles rapid tool calls without text in between', async () => {
    await processEvents(managed, [
      { type: 'tool_use_start', toolId: 't1', toolName: 'Bash' },
      { type: 'tool_use_streaming', partialInput: '{"command":"ls"}' },
      { type: 'tool_use_ready', toolId: 't1', toolName: 'Bash' },
      { type: 'tool_use_start', toolId: 't2', toolName: 'Read' },
      { type: 'tool_use_streaming', partialInput: '{"file_path":"index.ts"}' },
      { type: 'tool_use_ready', toolId: 't2', toolName: 'Read' },
      { type: 'tool_use_start', toolId: 't3', toolName: 'Bash' },
      { type: 'tool_use_streaming', partialInput: '{"command":"cat file"}' },
      { type: 'tool_use_ready', toolId: 't3', toolName: 'Bash' },
    ], true)

    const mock = getMock(managed)
    expect(mock.sentMessages.length).toBe(3) // One tool summary per tool
    expect(managed.pendingToolMessages.length).toBe(3)
    // No text finalized (no streaming happened)
    expect(mock.finalizedMessages.length).toBe(0)
  })
})

// ── Multi-session isolation ───────────────────────────────────────────────
// Verifies that two chat sessions sharing the same connector have fully
// independent streaming state — the key invariant of the multi-session refactor.

describe('multi-session isolation', () => {
  it('two sessions sharing a connector have independent streaming state', async () => {
    const sharedConnector = new MockChatClientConnector()

    const session1 = createManagedConnector({
      connector: sharedConnector,
      chatId: 'chat-alice',
    })
    const session2 = createManagedConnector({
      connector: sharedConnector,
      chatId: 'chat-bob',
    })

    // Stream text to session 1 only
    session1.streamingState.lastUpdateTime = 0
    await processSSEEvent(session1, { type: 'stream_delta', text: 'Hello Alice' })

    // Session 2 should be unaffected
    expect(session1.streamingState.accumulatedText).toBe('Hello Alice')
    expect(session2.streamingState.accumulatedText).toBe('')
  })

  it('finalizing one session does not affect the other', async () => {
    const sharedConnector = new MockChatClientConnector()

    const session1 = createManagedConnector({
      connector: sharedConnector,
      chatId: 'chat-alice',
    })
    const session2 = createManagedConnector({
      connector: sharedConnector,
      chatId: 'chat-bob',
    })

    // Both sessions accumulate text
    session1.streamingState.accumulatedText = 'Alice response'
    session1.streamingState.currentMessageId = 'msg-a'
    session2.streamingState.accumulatedText = 'Bob response'
    session2.streamingState.currentMessageId = 'msg-b'

    // Finalize session 1
    await finalizeStreaming(session1)

    // Session 1 should be reset
    expect(session1.streamingState.accumulatedText).toBe('')
    expect(session1.streamingState.currentMessageId).toBeNull()

    // Session 2 should be untouched
    expect(session2.streamingState.accumulatedText).toBe('Bob response')
    expect(session2.streamingState.currentMessageId).toBe('msg-b')
  })

  it('pending tool messages are independent per session', async () => {
    const sharedConnector = new MockChatClientConnector()

    const session1 = createManagedConnector({
      connector: sharedConnector,
      chatId: 'chat-alice',
    })
    const session2 = createManagedConnector({
      connector: sharedConnector,
      chatId: 'chat-bob',
    })

    session1.pendingToolMessages = [
      { messageId: 'msg-1', text: '🔧 *Bash* ⏳' },
    ]
    session2.pendingToolMessages = [
      { messageId: 'msg-2', text: '🔧 *Read* ⏳' },
      { messageId: 'msg-3', text: '🔧 *Write* ⏳' },
    ]

    // Resolve session 1
    await resolvePendingToolMessages(session1)

    expect(session1.pendingToolMessages.length).toBe(0)
    // Session 2 unaffected
    expect(session2.pendingToolMessages.length).toBe(2)
  })

  it('messages are sent to the correct chatId', async () => {
    const sharedConnector = new MockChatClientConnector()

    const session1 = createManagedConnector({
      connector: sharedConnector,
      chatId: 'chat-alice',
    })
    const session2 = createManagedConnector({
      connector: sharedConnector,
      chatId: 'chat-bob',
    })

    // Stream to both sessions
    session1.streamingState.lastUpdateTime = 0
    session2.streamingState.lastUpdateTime = 0
    await processSSEEvent(session1, { type: 'stream_delta', text: 'For Alice' })
    await processSSEEvent(session2, { type: 'stream_delta', text: 'For Bob' })

    // Both go through the same connector, but with different chatIds
    expect(sharedConnector.streamUpdates.length).toBe(2)
    expect(sharedConnector.streamUpdates[0].chatId).toBe('chat-alice')
    expect(sharedConnector.streamUpdates[0].text).toBe('For Alice')
    expect(sharedConnector.streamUpdates[1].chatId).toBe('chat-bob')
    expect(sharedConnector.streamUpdates[1].text).toBe('For Bob')
  })

  it('tool input accumulation is independent per session', async () => {
    const sharedConnector = new MockChatClientConnector()

    const session1 = createManagedConnector({
      connector: sharedConnector,
      chatId: 'chat-alice',
    })
    const session2 = createManagedConnector({
      connector: sharedConnector,
      chatId: 'chat-bob',
    })

    // Session 1: tool starts
    await processSSEEvent(session1, { type: 'tool_use_start', toolId: 't1', toolName: 'Bash' })
    await processSSEEvent(session1, { type: 'tool_use_streaming', partialInput: '{"command":"ls"}' })

    // Session 2: different tool
    await processSSEEvent(session2, { type: 'tool_use_start', toolId: 't2', toolName: 'Read' })
    await processSSEEvent(session2, { type: 'tool_use_streaming', partialInput: '{"file_path":"a.ts"}' })

    expect(session1.currentToolInput).toBe('{"command":"ls"}')
    expect(session2.currentToolInput).toBe('{"file_path":"a.ts"}')

    // Resetting session 1's tool input doesn't affect session 2
    await processSSEEvent(session1, { type: 'tool_use_ready', toolId: 't1', toolName: 'Bash' })
    expect(session1.currentToolInput).toBe('')
    expect(session2.currentToolInput).toBe('{"file_path":"a.ts"}')
  })

  it('interleaved streaming across sessions produces correct output', async () => {
    const sharedConnector = new MockChatClientConnector()

    const session1 = createManagedConnector({
      connector: sharedConnector,
      chatId: 'chat-alice',
    })
    const session2 = createManagedConnector({
      connector: sharedConnector,
      chatId: 'chat-bob',
    })

    // Interleave events from both sessions (simulating concurrent conversations)
    await processSSEEvent(session1, { type: 'stream_start' })
    await processSSEEvent(session2, { type: 'stream_start' })
    session1.streamingState.lastUpdateTime = 0
    session2.streamingState.lastUpdateTime = 0
    await processSSEEvent(session1, { type: 'stream_delta', text: 'Alice gets ' })
    await processSSEEvent(session2, { type: 'stream_delta', text: 'Bob gets ' })
    await processSSEEvent(session1, { type: 'stream_delta', text: 'this response' })
    await processSSEEvent(session2, { type: 'stream_delta', text: 'that response' })
    await processSSEEvent(session1, { type: 'session_idle' })
    await processSSEEvent(session2, { type: 'session_idle' })

    // Verify text accumulated independently
    // Both should have been finalized — check sent messages
    const aliceMessages = sharedConnector.sentMessages.filter(m => m.chatId === 'chat-alice')
    const bobMessages = sharedConnector.sentMessages.filter(m => m.chatId === 'chat-bob')

    // Each session should have produced output containing their respective text
    const aliceTexts = [
      ...aliceMessages.map(m => m.message.text),
      ...sharedConnector.finalizedMessages.filter(m => m.chatId === 'chat-alice').map(m => m.finalText),
    ].join(' ')
    const bobTexts = [
      ...bobMessages.map(m => m.message.text),
      ...sharedConnector.finalizedMessages.filter(m => m.chatId === 'chat-bob').map(m => m.finalText),
    ].join(' ')

    expect(aliceTexts).toContain('Alice gets this response')
    expect(bobTexts).toContain('Bob gets that response')
    // Cross-contamination check
    expect(aliceTexts).not.toContain('Bob')
    expect(bobTexts).not.toContain('Alice')
  })
})
