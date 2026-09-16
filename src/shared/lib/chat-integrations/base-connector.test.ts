import { describe, it, expect, vi } from 'vitest'
import { MockChatClientConnector } from './mock-connector'

// We test the base class behavior through MockChatClientConnector,
// which extends ChatClientConnector and exposes the emit* methods.

describe('ChatAgentIntegration event system', () => {
  // ── onEvent ──────────────────────────────────────────────────────

  describe('onEvent', () => {
    it('calls registered handler when message is emitted', async () => {
      const connector = new MockChatClientConnector()
      const handler = vi.fn()

      connector.onEvent(handler)
      connector.simulateIncomingMessage('hello')
      await Promise.resolve()

      expect(handler).toHaveBeenCalledOnce()
      expect(handler.mock.calls[0][0].payload.text).toBe('hello')
    })

    it('calls multiple handlers', async () => {
      const connector = new MockChatClientConnector()
      const handler1 = vi.fn()
      const handler2 = vi.fn()

      connector.onEvent(handler1)
      connector.onEvent(handler2)
      connector.simulateIncomingMessage('hello')
      await Promise.resolve()

      expect(handler1).toHaveBeenCalledOnce()
      expect(handler2).toHaveBeenCalledOnce()
    })

    it('returns unsubscribe function that removes handler', async () => {
      const connector = new MockChatClientConnector()
      const handler = vi.fn()

      const unsubscribe = connector.onEvent(handler)
      unsubscribe()
      connector.simulateIncomingMessage('hello')
      await Promise.resolve()

      expect(handler).not.toHaveBeenCalled()
    })

    it('unsubscribing one handler does not affect others', async () => {
      const connector = new MockChatClientConnector()
      const handler1 = vi.fn()
      const handler2 = vi.fn()

      const unsub1 = connector.onEvent(handler1)
      connector.onEvent(handler2)

      unsub1()
      connector.simulateIncomingMessage('hello')
      await Promise.resolve()

      expect(handler1).not.toHaveBeenCalled()
      expect(handler2).toHaveBeenCalledOnce()
    })

    it('error in one handler does not prevent others from being called', async () => {
      const connector = new MockChatClientConnector()
      const errorHandler = vi.fn(() => { throw new Error('handler error') })
      const goodHandler = vi.fn()

      connector.onEvent(errorHandler)
      connector.onEvent(goodHandler)

      // Should not throw
      connector.simulateIncomingMessage('hello')
      await Promise.resolve()

      expect(errorHandler).toHaveBeenCalledOnce()
      expect(goodHandler).toHaveBeenCalledOnce()
    })
  })

  // ── response events ──────────────────────────────────────────

  describe('response events', () => {
    it('calls registered handler with the normalized response', async () => {
      const connector = new MockChatClientConnector()
      const handler = vi.fn()

      connector.onEvent(handler)
      connector.simulateInteractiveResponse('tu-1', { question: 'Continue?', answer: 'yes' }, 'chat-42')
      await Promise.resolve()

      expect(handler).toHaveBeenCalledWith({ type: 'response', externalId: 'chat-42', requestId: 'tu-1', requestKind: 'input', value: { 'Continue?': 'yes' } })
    })

    it('returns unsubscribe function', async () => {
      const connector = new MockChatClientConnector()
      const handler = vi.fn()

      const unsub = connector.onEvent(handler)
      unsub()
      connector.simulateInteractiveResponse('tu-1', { answer: 'yes' })
      await Promise.resolve()

      expect(handler).not.toHaveBeenCalled()
    })

    it('calls multiple handlers', async () => {
      const connector = new MockChatClientConnector()
      const h1 = vi.fn()
      const h2 = vi.fn()

      connector.onEvent(h1)
      connector.onEvent(h2)
      connector.simulateInteractiveResponse('tu-1', 'value')
      await Promise.resolve()

      expect(h1).toHaveBeenCalledOnce()
      expect(h2).toHaveBeenCalledOnce()
    })

    it('error in one handler does not prevent others', async () => {
      const connector = new MockChatClientConnector()
      const bad = vi.fn(() => { throw new Error('oops') })
      const good = vi.fn()

      connector.onEvent(bad)
      connector.onEvent(good)
      connector.simulateInteractiveResponse('tu-1', 'val')
      await Promise.resolve()

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
    it('includes all expected fields', async () => {
      const connector = new MockChatClientConnector()
      const handler = vi.fn()

      connector.onEvent(handler)
      connector.simulateIncomingMessage('test message', 'chat-42', 'user-7')
      await Promise.resolve()

      const msg = handler.mock.calls[0][0].payload
      expect(msg.text).toBe('test message')
      expect(msg.chatId).toBe('chat-42')
      expect(msg.userId).toBe('user-7')
      expect(msg.externalMessageId).toBeDefined()
      expect(msg.timestamp).toBeInstanceOf(Date)
      expect(handler.mock.calls[0][0]).toMatchObject({ type: 'input', externalId: 'chat-42', id: msg.externalMessageId, timestamp: msg.timestamp })
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

  it('records working indicators', async () => {
    const mock = new MockChatClientConnector()

    await mock.startWorking('chat-1', 'working')
    await mock.startWorking('chat-2', 'working')

    expect(mock.typingIndicators).toEqual(['chat-1', 'chat-2'])
  })

  it('records sent cards', async () => {
    const mock = new MockChatClientConnector()
    const event = {
      type: 'question_request' as const,
      toolUseId: 'tu-1',
      questions: [{ question: 'Pick one' }],
    }

    await mock.sendUserRequestCard('chat-1', event as any)

    expect(mock.sentCards.length).toBe(1)
    expect(mock.getLastSentCard()?.type).toBe('question_request')
    expect(mock.getCardsOfType('question_request').length).toBe(1)
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
    await mock.startWorking('chat-1', 'working')
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
