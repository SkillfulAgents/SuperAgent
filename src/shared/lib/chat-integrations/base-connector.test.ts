import { describe, it, expect, vi } from 'vitest'
import { MockChatClientConnector } from './mock-connector'

// We test the base class behavior through MockChatClientConnector,
// which extends ChatClientConnector and exposes the emit* methods.

describe('ChatClientConnector event system', () => {
  // ── onMessage ──────────────────────────────────────────────────────

  describe('onMessage', () => {
    it('calls registered handler when message is emitted', () => {
      const connector = new MockChatClientConnector()
      const handler = vi.fn()

      connector.onMessage(handler)
      connector.simulateIncomingMessage('hello')

      expect(handler).toHaveBeenCalledOnce()
      expect(handler.mock.calls[0][0].text).toBe('hello')
    })

    it('calls multiple handlers', () => {
      const connector = new MockChatClientConnector()
      const handler1 = vi.fn()
      const handler2 = vi.fn()

      connector.onMessage(handler1)
      connector.onMessage(handler2)
      connector.simulateIncomingMessage('hello')

      expect(handler1).toHaveBeenCalledOnce()
      expect(handler2).toHaveBeenCalledOnce()
    })

    it('returns unsubscribe function that removes handler', () => {
      const connector = new MockChatClientConnector()
      const handler = vi.fn()

      const unsubscribe = connector.onMessage(handler)
      unsubscribe()
      connector.simulateIncomingMessage('hello')

      expect(handler).not.toHaveBeenCalled()
    })

    it('unsubscribing one handler does not affect others', () => {
      const connector = new MockChatClientConnector()
      const handler1 = vi.fn()
      const handler2 = vi.fn()

      const unsub1 = connector.onMessage(handler1)
      connector.onMessage(handler2)

      unsub1()
      connector.simulateIncomingMessage('hello')

      expect(handler1).not.toHaveBeenCalled()
      expect(handler2).toHaveBeenCalledOnce()
    })

    it('error in one handler does not prevent others from being called', () => {
      const connector = new MockChatClientConnector()
      const errorHandler = vi.fn(() => { throw new Error('handler error') })
      const goodHandler = vi.fn()

      connector.onMessage(errorHandler)
      connector.onMessage(goodHandler)

      // Should not throw
      connector.simulateIncomingMessage('hello')

      expect(errorHandler).toHaveBeenCalledOnce()
      expect(goodHandler).toHaveBeenCalledOnce()
    })
  })

  // ── onInteractiveResponse ──────────────────────────────────────────

  describe('onInteractiveResponse', () => {
    it('calls registered handler with toolUseId and response', () => {
      const connector = new MockChatClientConnector()
      const handler = vi.fn()

      connector.onInteractiveResponse(handler)
      connector.simulateInteractiveResponse('tu-1', { answer: 'yes' })

      expect(handler).toHaveBeenCalledWith('tu-1', { answer: 'yes' })
    })

    it('returns unsubscribe function', () => {
      const connector = new MockChatClientConnector()
      const handler = vi.fn()

      const unsub = connector.onInteractiveResponse(handler)
      unsub()
      connector.simulateInteractiveResponse('tu-1', { answer: 'yes' })

      expect(handler).not.toHaveBeenCalled()
    })

    it('calls multiple handlers', () => {
      const connector = new MockChatClientConnector()
      const h1 = vi.fn()
      const h2 = vi.fn()

      connector.onInteractiveResponse(h1)
      connector.onInteractiveResponse(h2)
      connector.simulateInteractiveResponse('tu-1', 'value')

      expect(h1).toHaveBeenCalledOnce()
      expect(h2).toHaveBeenCalledOnce()
    })

    it('error in one handler does not prevent others', () => {
      const connector = new MockChatClientConnector()
      const bad = vi.fn(() => { throw new Error('oops') })
      const good = vi.fn()

      connector.onInteractiveResponse(bad)
      connector.onInteractiveResponse(good)
      connector.simulateInteractiveResponse('tu-1', 'val')

      expect(good).toHaveBeenCalledOnce()
    })
  })

  // ── onError ────────────────────────────────────────────────────────

  describe('onError', () => {
    it('calls registered handler with error', () => {
      const connector = new MockChatClientConnector()
      const handler = vi.fn()
      const error = new Error('connection lost')

      connector.onError(handler)
      connector.simulateError(error)

      expect(handler).toHaveBeenCalledWith(error)
    })

    it('returns unsubscribe function', () => {
      const connector = new MockChatClientConnector()
      const handler = vi.fn()

      const unsub = connector.onError(handler)
      unsub()
      connector.simulateError(new Error('test'))

      expect(handler).not.toHaveBeenCalled()
    })

    it('error in one error handler does not prevent others', () => {
      const connector = new MockChatClientConnector()
      const bad = vi.fn(() => { throw new Error('handler error') })
      const good = vi.fn()

      connector.onError(bad)
      connector.onError(good)
      connector.simulateError(new Error('connection error'))

      expect(good).toHaveBeenCalledOnce()
    })
  })

  // ── Message data structure ─────────────────────────────────────────

  describe('incoming message shape', () => {
    it('includes all expected fields', () => {
      const connector = new MockChatClientConnector()
      const handler = vi.fn()

      connector.onMessage(handler)
      connector.simulateIncomingMessage('test message', 'chat-42', 'user-7')

      const msg = handler.mock.calls[0][0]
      expect(msg.text).toBe('test message')
      expect(msg.chatId).toBe('chat-42')
      expect(msg.userId).toBe('user-7')
      expect(msg.externalMessageId).toBeDefined()
      expect(msg.timestamp).toBeInstanceOf(Date)
    })
  })
})

// ── MockChatClientConnector recording ────────────────────────────────────

describe('MockChatClientConnector', () => {
  it('records sent messages', async () => {
    const mock = new MockChatClientConnector()
    await mock.connect()

    await mock.sendMessage('chat-1', { text: 'hello' })
    await mock.sendMessage('chat-1', { text: 'world' })

    expect(mock.sentMessages.length).toBe(2)
    expect(mock.getLastSentMessage()?.text).toBe('world')
    expect(mock.getSentMessageCount()).toBe(2)
  })

  it('records streaming updates', async () => {
    const mock = new MockChatClientConnector()

    const id = await mock.sendStreamingUpdate('chat-1', 'partial text')
    expect(id).toBeDefined()
    expect(mock.streamUpdates.length).toBe(1)
    expect(mock.streamUpdates[0].text).toBe('partial text')
  })

  it('records finalized messages', async () => {
    const mock = new MockChatClientConnector()

    await mock.finalizeStreamingMessage('chat-1', 'msg-1', 'final text')

    expect(mock.finalizedMessages.length).toBe(1)
    expect(mock.finalizedMessages[0].messageId).toBe('msg-1')
    expect(mock.finalizedMessages[0].finalText).toBe('final text')
  })

  it('records typing indicators', async () => {
    const mock = new MockChatClientConnector()

    await mock.showTypingIndicator('chat-1')
    await mock.showTypingIndicator('chat-2')

    expect(mock.typingIndicators).toEqual(['chat-1', 'chat-2'])
  })

  it('records sent cards', async () => {
    const mock = new MockChatClientConnector()
    const event = {
      type: 'user_question_request' as const,
      toolUseId: 'tu-1',
      questions: [{ question: 'Pick one' }],
    }

    await mock.sendUserRequestCard('chat-1', event as any)

    expect(mock.sentCards.length).toBe(1)
    expect(mock.getLastSentCard()?.type).toBe('user_question_request')
    expect(mock.getCardsOfType('user_question_request').length).toBe(1)
  })

  it('tracks connection state', async () => {
    const mock = new MockChatClientConnector()

    expect(mock.isConnected()).toBe(false)
    await mock.connect()
    expect(mock.isConnected()).toBe(true)
    await mock.disconnect()
    expect(mock.isConnected()).toBe(false)
  })

  it('reset clears all recorded state', async () => {
    const mock = new MockChatClientConnector()

    await mock.sendMessage('chat-1', { text: 'hello' })
    await mock.sendStreamingUpdate('chat-1', 'partial')
    await mock.finalizeStreamingMessage('chat-1', 'msg-1', 'final')
    await mock.showTypingIndicator('chat-1')
    await mock.sendUserRequestCard('chat-1', { type: 'secret_request', toolUseId: 'tu-1', secretName: 'KEY' } as any)

    mock.reset()

    expect(mock.sentMessages.length).toBe(0)
    expect(mock.streamUpdates.length).toBe(0)
    expect(mock.finalizedMessages.length).toBe(0)
    expect(mock.typingIndicators.length).toBe(0)
    expect(mock.sentCards.length).toBe(0)
  })

  it('returns unique message IDs', async () => {
    const mock = new MockChatClientConnector()

    const id1 = await mock.sendMessage('chat-1', { text: 'a' })
    const id2 = await mock.sendMessage('chat-1', { text: 'b' })
    const id3 = await mock.sendStreamingUpdate('chat-1', 'c')

    expect(id1).not.toBe(id2)
    expect(id2).not.toBe(id3)
  })
})
