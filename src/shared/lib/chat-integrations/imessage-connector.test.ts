import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IMessageConnector } from './imessage-connector'

vi.mock('ws', () => {
  const MockWebSocket = vi.fn() as any
  MockWebSocket.OPEN = 1
  return { default: MockWebSocket }
})

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
}))

// ── Helpers ──────────────────────────────────────────────────────────────

class MockWs {
  readyState = 1 // WebSocket.OPEN
  sent: string[] = []
  send(data: string) { this.sent.push(data) }
  close() {}
  on() {}
}

function parseSent(ws: MockWs): Array<Record<string, unknown>> {
  return ws.sent.map((s) => JSON.parse(s))
}

function createConnector(): IMessageConnector {
  return new IMessageConnector({
    gatewayUrl: 'ws://localhost:3456',
    phoneNumber: '+15551234567',
    token: 'test-token',
  })
}

function wireUp(connector: IMessageConnector): MockWs {
  const ws = new MockWs()
  ;(connector as any).ws = ws
  ;(connector as any)._connected = true
  return ws
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('IMessageConnector', () => {
  // ── 1. Reaction tag parsing ────────────────────────────────────────

  describe('extractReactions', () => {
    let connector: IMessageConnector

    beforeEach(() => {
      connector = createConnector()
    })

    function extract(text: string) {
      return (connector as any).extractReactions(text)
    }

    it('parses [[reaction:heart]] as love', () => {
      const result = extract('[[reaction:heart]]')
      expect(result.reactions).toEqual(['love'])
      expect(result.cleanText).toBe('')
    })

    it('parses [[reaction:thumbs_up]] as like', () => {
      const result = extract('[[reaction:thumbs_up]]')
      expect(result.reactions).toEqual(['like'])
      expect(result.cleanText).toBe('')
    })

    it('parses [[reaction:thumbs_down]] as dislike', () => {
      const result = extract('[[reaction:thumbs_down]]')
      expect(result.reactions).toEqual(['dislike'])
      expect(result.cleanText).toBe('')
    })

    it('parses [[reaction:haha]] as laugh', () => {
      const result = extract('[[reaction:haha]]')
      expect(result.reactions).toEqual(['laugh'])
      expect(result.cleanText).toBe('')
    })

    it('parses [[reaction:emphasize]] as emphasize', () => {
      const result = extract('[[reaction:emphasize]]')
      expect(result.reactions).toEqual(['emphasize'])
      expect(result.cleanText).toBe('')
    })

    it('parses [[reaction:question]] as question', () => {
      const result = extract('[[reaction:question]]')
      expect(result.reactions).toEqual(['question'])
      expect(result.cleanText).toBe('')
    })

    it('extracts reaction and preserves remaining text', () => {
      const result = extract('[[reaction:heart]] Great work!')
      expect(result.reactions).toEqual(['love'])
      expect(result.cleanText).toBe('Great work!')
    })

    it('extracts multiple reactions', () => {
      const result = extract('[[reaction:heart]][[reaction:haha]]')
      expect(result.reactions).toEqual(['love', 'laugh'])
      expect(result.cleanText).toBe('')
    })

    it('returns empty reactions for plain text', () => {
      const result = extract('Hello world')
      expect(result.reactions).toEqual([])
      expect(result.cleanText).toBe('Hello world')
    })

    it('ignores unknown reaction names (no mapping)', () => {
      const result = extract('[[reaction:unknown]]')
      expect(result.reactions).toEqual([])
      expect(result.cleanText).toBe('')
    })

    it('handles alias names (love → love, like → like)', () => {
      expect(extract('[[reaction:love]]').reactions).toEqual(['love'])
      expect(extract('[[reaction:like]]').reactions).toEqual(['like'])
      expect(extract('[[reaction:dislike]]').reactions).toEqual(['dislike'])
      expect(extract('[[reaction:laugh]]').reactions).toEqual(['laugh'])
    })

    it('handles exclamation alias for emphasize', () => {
      const result = extract('[[reaction:exclamation]]')
      expect(result.reactions).toEqual(['emphasize'])
    })

    it('is case-insensitive for reaction names', () => {
      // The regex captures \w+ and lowercases it
      const result = extract('[[reaction:Heart]]')
      expect(result.reactions).toEqual(['love'])
    })
  })

  // ── 2. Approval flow ──────────────────────────────────────────────

  describe('approval flow (sendUserRequestCard → review)', () => {
    let connector: IMessageConnector
    let ws: MockWs

    beforeEach(() => {
      connector = createConnector()
      ws = wireUp(connector)
    })

    it('sends approval card text with reaction instructions', async () => {
      const event = {
        type: 'user_question_request' as const,
        toolUseId: 'review:tool-1',
        questions: [{ question: 'Run command: rm -rf /' }],
      }

      await connector.sendUserRequestCard('chat-1', event as any)

      const messages = parseSent(ws)
      expect(messages).toHaveLength(1)
      expect(messages[0].type).toBe('send_message')

      const text = (messages[0].data as any).parts[0].value as string
      expect(text).toContain('Run command: rm -rf /')
      expect(text).toContain('React with 👍 to allow, 👎 to deny.')
    })

    it('tracks the pending approval', async () => {
      const event = {
        type: 'user_question_request' as const,
        toolUseId: 'review:tool-1',
        questions: [{ question: 'Allow this?' }],
      }

      await connector.sendUserRequestCard('chat-1', event as any)

      const pendingApprovals = (connector as any).pendingApprovals as Map<string, any>
      expect(pendingApprovals.size).toBe(1)

      const [, approval] = pendingApprovals.entries().next().value as [string, any]
      expect(approval.toolUseId).toBe('review:tool-1')
    })

    it('uses fallback text when no questions provided', async () => {
      const event = {
        type: 'user_question_request' as const,
        toolUseId: 'review:tool-2',
      }

      await connector.sendUserRequestCard('chat-1', event as any)

      const messages = parseSent(ws)
      const text = (messages[0].data as any).parts[0].value as string
      expect(text).toContain('Allow this action?')
    })

    it('emits allow response on thumbs-up reaction', async () => {
      const event = {
        type: 'user_question_request' as const,
        toolUseId: 'review:tool-1',
        questions: [{ question: 'Allow?' }],
      }

      await connector.sendUserRequestCard('chat-1', event as any)

      const handler = vi.fn()
      connector.onInteractiveResponse(handler)

      // Simulate a thumbs-up reaction from the external user
      ;(connector as any).handleReactionAdded({
        reactionType: 'like',
        from: '+10005551234',
      })

      expect(handler).toHaveBeenCalledWith('review:tool-1', {
        question: '_approval',
        answer: '✅ Allow',
      }, undefined)
    })

    it('emits deny response on thumbs-down reaction', async () => {
      const event = {
        type: 'user_question_request' as const,
        toolUseId: 'review:tool-1',
        questions: [{ question: 'Allow?' }],
      }

      await connector.sendUserRequestCard('chat-1', event as any)

      const handler = vi.fn()
      connector.onInteractiveResponse(handler)

      ;(connector as any).handleReactionAdded({
        reactionType: 'dislike',
        from: '+10005551234',
      })

      expect(handler).toHaveBeenCalledWith('review:tool-1', {
        question: '_approval',
        answer: '❌ Deny',
      }, undefined)
    })

    it('removes pending approval after it is resolved', async () => {
      const event = {
        type: 'user_question_request' as const,
        toolUseId: 'review:tool-1',
        questions: [{ question: 'Allow?' }],
      }

      await connector.sendUserRequestCard('chat-1', event as any)

      ;(connector as any).handleReactionAdded({
        reactionType: 'like',
        from: '+10005551234',
      })

      const pendingApprovals = (connector as any).pendingApprovals as Map<string, any>
      expect(pendingApprovals.size).toBe(0)
    })
  })

  // ── 3. Question flow ──────────────────────────────────────────────

  describe('question flow (sendUserRequestCard → question)', () => {
    let connector: IMessageConnector
    let ws: MockWs

    beforeEach(() => {
      connector = createConnector()
      ws = wireUp(connector)
    })

    it('formats question with numbered options', async () => {
      const event = {
        type: 'user_question_request' as const,
        toolUseId: 'q-1',
        questions: [{
          question: 'Pick a color',
          options: [
            { label: 'Red' },
            { label: 'Blue' },
            { label: 'Green' },
          ],
        }],
      }

      await connector.sendUserRequestCard('chat-1', event as any)

      const messages = parseSent(ws)
      expect(messages).toHaveLength(1)
      const text = (messages[0].data as any).parts[0].value as string
      expect(text).toContain('Pick a color')
      expect(text).toContain('1. Red')
      expect(text).toContain('2. Blue')
      expect(text).toContain('3. Green')
      expect(text).toContain('Reply with a number or type your answer.')
    })

    it('includes option descriptions when present', async () => {
      const event = {
        type: 'user_question_request' as const,
        toolUseId: 'q-2',
        questions: [{
          question: 'Choose a plan',
          options: [
            { label: 'Free', description: 'No cost' },
            { label: 'Pro', description: 'Full features' },
          ],
        }],
      }

      await connector.sendUserRequestCard('chat-1', event as any)

      const text = (parseSent(ws)[0].data as any).parts[0].value as string
      expect(text).toContain('1. Free — No cost')
      expect(text).toContain('2. Pro — Full features')
    })

    it('includes header when present', async () => {
      const event = {
        type: 'user_question_request' as const,
        toolUseId: 'q-3',
        questions: [{
          header: 'Configuration',
          question: 'Select mode',
          options: [{ label: 'Auto' }, { label: 'Manual' }],
        }],
      }

      await connector.sendUserRequestCard('chat-1', event as any)

      const text = (parseSent(ws)[0].data as any).parts[0].value as string
      expect(text).toContain('*Configuration*')
    })

    it('renders "(No question provided)" when questions array is empty', async () => {
      const event = {
        type: 'user_question_request' as const,
        toolUseId: 'q-4',
        questions: [],
      }

      await connector.sendUserRequestCard('chat-1', event as any)

      const text = (parseSent(ws)[0].data as any).parts[0].value as string
      expect(text).toBe('(No question provided)')
    })

    it('tracks pending question', async () => {
      const event = {
        type: 'user_question_request' as const,
        toolUseId: 'q-5',
        questions: [{
          question: 'Pick one',
          options: [{ label: 'A' }, { label: 'B' }],
        }],
      }

      await connector.sendUserRequestCard('chat-1', event as any)

      const pending = (connector as any).pendingQuestions as Map<string, any>
      expect(pending.size).toBe(1)
      expect(pending.has('q-5')).toBe(true)
    })

    it('resolves question by number', async () => {
      const event = {
        type: 'user_question_request' as const,
        toolUseId: 'q-6',
        questions: [{
          question: 'Pick a color',
          options: [
            { label: 'Red' },
            { label: 'Blue' },
            { label: 'Green' },
          ],
        }],
      }

      await connector.sendUserRequestCard('chat-1', event as any)

      const handler = vi.fn()
      connector.onInteractiveResponse(handler)

      // User replies with "2" to select Blue
      ;(connector as any).handleMessageReceived({
        messageId: 'msg-reply',
        chatId: '+15551234567',
        from: '+10005551234',
        parts: [{ type: 'text', value: '2' }],
      })

      expect(handler).toHaveBeenCalledWith('q-6', {
        question: 'Pick a color',
        answer: 'Blue',
      }, undefined)
    })

    it('resolves question by exact label (case-insensitive)', async () => {
      const event = {
        type: 'user_question_request' as const,
        toolUseId: 'q-7',
        questions: [{
          question: 'Pick a color',
          options: [{ label: 'Red' }, { label: 'Blue' }],
        }],
      }

      await connector.sendUserRequestCard('chat-1', event as any)

      const handler = vi.fn()
      connector.onInteractiveResponse(handler)

      ;(connector as any).handleMessageReceived({
        messageId: 'msg-reply',
        chatId: '+15551234567',
        from: '+10005551234',
        parts: [{ type: 'text', value: 'red' }],
      })

      expect(handler).toHaveBeenCalledWith('q-7', {
        question: 'Pick a color',
        answer: 'Red',
      }, undefined)
    })

    it('resolves question with raw text when no match', async () => {
      const event = {
        type: 'user_question_request' as const,
        toolUseId: 'q-8',
        questions: [{
          question: 'Pick a color',
          options: [{ label: 'Red' }, { label: 'Blue' }],
        }],
      }

      await connector.sendUserRequestCard('chat-1', event as any)

      const handler = vi.fn()
      connector.onInteractiveResponse(handler)

      ;(connector as any).handleMessageReceived({
        messageId: 'msg-reply',
        chatId: '+15551234567',
        from: '+10005551234',
        parts: [{ type: 'text', value: 'Purple' }],
      })

      expect(handler).toHaveBeenCalledWith('q-8', {
        question: 'Pick a color',
        answer: 'Purple',
      }, undefined)
    })

    it('does not emit a regular message when answering a question', async () => {
      const event = {
        type: 'user_question_request' as const,
        toolUseId: 'q-9',
        questions: [{
          question: 'Pick one',
          options: [{ label: 'A' }],
        }],
      }

      await connector.sendUserRequestCard('chat-1', event as any)

      const messageHandler = vi.fn()
      connector.onMessage(messageHandler)

      ;(connector as any).handleMessageReceived({
        messageId: 'msg-reply',
        chatId: '+15551234567',
        from: '+10005551234',
        parts: [{ type: 'text', value: '1' }],
      })

      // Should NOT emit as a regular incoming message
      expect(messageHandler).not.toHaveBeenCalled()
    })

    it('removes pending question after resolution', async () => {
      const event = {
        type: 'user_question_request' as const,
        toolUseId: 'q-10',
        questions: [{
          question: 'Pick one',
          options: [{ label: 'A' }],
        }],
      }

      await connector.sendUserRequestCard('chat-1', event as any)

      ;(connector as any).handleMessageReceived({
        messageId: 'msg-reply',
        chatId: '+15551234567',
        from: '+10005551234',
        parts: [{ type: 'text', value: '1' }],
      })

      const pending = (connector as any).pendingQuestions as Map<string, any>
      expect(pending.size).toBe(0)
    })
  })

  // ── 4. Message part extraction ────────────────────────────────────

  describe('handleMessageReceived — message part extraction', () => {
    let connector: IMessageConnector

    beforeEach(() => {
      connector = createConnector()
      wireUp(connector)
    })

    it('concatenates multiple text parts', () => {
      const handler = vi.fn()
      connector.onMessage(handler)

      ;(connector as any).handleMessageReceived({
        messageId: 'msg-1',
        chatId: 'chat-1',
        from: '+10005551234',
        parts: [
          { type: 'text', value: 'Hello' },
          { type: 'text', value: 'World' },
        ],
      })

      expect(handler).toHaveBeenCalledOnce()
      expect(handler.mock.calls[0][0].text).toBe('Hello\nWorld')
    })

    it('extracts media parts as files', () => {
      const handler = vi.fn()
      connector.onMessage(handler)

      ;(connector as any).handleMessageReceived({
        messageId: 'msg-2',
        chatId: 'chat-1',
        from: '+10005551234',
        parts: [
          { type: 'media', url: 'https://example.com/photo.jpg', filename: 'photo.jpg', mimeType: 'image/jpeg' },
        ],
      })

      expect(handler).toHaveBeenCalledOnce()
      const msg = handler.mock.calls[0][0]
      expect(msg.files).toHaveLength(1)
      expect(msg.files[0]).toEqual({
        name: 'photo.jpg',
        url: 'https://example.com/photo.jpg',
        mimeType: 'image/jpeg',
      })
    })

    it('handles mixed text and media parts', () => {
      const handler = vi.fn()
      connector.onMessage(handler)

      ;(connector as any).handleMessageReceived({
        messageId: 'msg-3',
        chatId: 'chat-1',
        from: '+10005551234',
        parts: [
          { type: 'text', value: 'Check this out' },
          { type: 'media', url: 'https://example.com/doc.pdf', filename: 'doc.pdf', mimeType: 'application/pdf' },
        ],
      })

      const msg = handler.mock.calls[0][0]
      expect(msg.text).toBe('Check this out')
      expect(msg.files).toHaveLength(1)
      expect(msg.files[0].name).toBe('doc.pdf')
    })

    it('uses "attachment" as default filename when not provided', () => {
      const handler = vi.fn()
      connector.onMessage(handler)

      ;(connector as any).handleMessageReceived({
        messageId: 'msg-4',
        chatId: 'chat-1',
        from: '+10005551234',
        parts: [
          { type: 'media', url: 'https://example.com/unnamed' },
        ],
      })

      const msg = handler.mock.calls[0][0]
      expect(msg.files[0].name).toBe('attachment')
    })

    it('omits files when there are no media parts', () => {
      const handler = vi.fn()
      connector.onMessage(handler)

      ;(connector as any).handleMessageReceived({
        messageId: 'msg-5',
        chatId: 'chat-1',
        from: '+10005551234',
        parts: [{ type: 'text', value: 'Just text' }],
      })

      const msg = handler.mock.calls[0][0]
      expect(msg.files).toBeUndefined()
    })

    it('tracks lastReceivedMessageId', () => {
      const handler = vi.fn()
      connector.onMessage(handler)

      ;(connector as any).handleMessageReceived({
        messageId: 'msg-abc',
        chatId: 'chat-1',
        from: '+10005551234',
        parts: [{ type: 'text', value: 'hi' }],
      })

      expect((connector as any).lastReceivedMessageId).toBe('msg-abc')
    })

    it('sends mark_read on receiving a message', () => {
      const ws = (connector as any).ws as MockWs
      connector.onMessage(vi.fn())

      ;(connector as any).handleMessageReceived({
        messageId: 'msg-6',
        chatId: 'chat-1',
        from: '+10005551234',
        parts: [{ type: 'text', value: 'hi' }],
      })

      const messages = parseSent(ws)
      expect(messages.some((m) => m.type === 'mark_read')).toBe(true)
    })
  })

  // ── 5. sendMessage with reactions ─────────────────────────────────

  describe('sendMessage', () => {
    let connector: IMessageConnector
    let ws: MockWs

    beforeEach(() => {
      connector = createConnector()
      ws = wireUp(connector)
    })

    it('sends plain text as send_message command', async () => {
      await connector.sendMessage('chat-1', { text: 'Hello there' })

      const messages = parseSent(ws)
      expect(messages).toHaveLength(1)
      expect(messages[0].type).toBe('send_message')
      expect((messages[0].data as any).parts[0].value).toBe('Hello there')
    })

    it('sends reaction-only without a text message', async () => {
      // Set up lastReceivedMessageId so reactions can be sent
      ;(connector as any).lastReceivedMessageId = 'incoming-msg-1'

      const id = await connector.sendMessage('chat-1', { text: '[[reaction:heart]]' })

      const messages = parseSent(ws)
      expect(messages).toHaveLength(1)
      expect(messages[0].type).toBe('send_reaction')
      expect((messages[0].data as any).reactionType).toBe('love')
      expect((messages[0].data as any).messageId).toBe('incoming-msg-1')
      expect(id).toContain('reaction-only')
    })

    it('sends reaction + text message for mixed content', async () => {
      ;(connector as any).lastReceivedMessageId = 'incoming-msg-2'

      await connector.sendMessage('chat-1', { text: '[[reaction:thumbs_up]] Nice work!' })

      const messages = parseSent(ws)
      expect(messages).toHaveLength(2)
      expect(messages[0].type).toBe('send_reaction')
      expect((messages[0].data as any).reactionType).toBe('like')
      expect(messages[1].type).toBe('send_message')
      expect((messages[1].data as any).parts[0].value).toBe('Nice work!')
    })

    it('does not send reaction when there is no lastReceivedMessageId', async () => {
      // lastReceivedMessageId is null by default
      await connector.sendMessage('chat-1', { text: '[[reaction:heart]] Hello' })

      const messages = parseSent(ws)
      // Should only send the text message, not the reaction
      expect(messages).toHaveLength(1)
      expect(messages[0].type).toBe('send_message')
      expect((messages[0].data as any).parts[0].value).toBe('Hello')
    })

    it('sends multiple reactions', async () => {
      ;(connector as any).lastReceivedMessageId = 'incoming-msg-3'

      await connector.sendMessage('chat-1', { text: '[[reaction:heart]][[reaction:haha]]' })

      const messages = parseSent(ws)
      expect(messages).toHaveLength(2)
      expect(messages[0].type).toBe('send_reaction')
      expect((messages[0].data as any).reactionType).toBe('love')
      expect(messages[1].type).toBe('send_reaction')
      expect((messages[1].data as any).reactionType).toBe('laugh')
    })
  })

  // ── 6. Approval denial on incoming message ────────────────────────

  describe('pending approval denial on incoming message', () => {
    it('denies pending approval when a text message arrives', async () => {
      const connector = createConnector()
      wireUp(connector)

      const event = {
        type: 'user_question_request' as const,
        toolUseId: 'review:tool-A',
        questions: [{ question: 'Allow A?' }],
      }

      await connector.sendUserRequestCard('chat-1', event as any)

      const handler = vi.fn()
      connector.onInteractiveResponse(handler)

      // Simulate an incoming message (not a reaction)
      ;(connector as any).handleMessageReceived({
        messageId: 'msg-text',
        chatId: 'chat-1',
        from: '+10005551234',
        parts: [{ type: 'text', value: 'Do something else' }],
      })

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith('review:tool-A', {
        question: '_approval',
        answer: '❌ Deny',
      }, undefined)
    })

    it('denies multiple pending approvals when they have distinct IDs', async () => {
      const connector = createConnector()
      wireUp(connector)

      // Manually insert two pending approvals with distinct keys
      // (in practice Date.now() may collide when called in the same ms)
      const pendingApprovals = (connector as any).pendingApprovals as Map<string, any>
      pendingApprovals.set('approval-1', { toolUseId: 'review:tool-A', sentMessageId: 'approval-1' })
      pendingApprovals.set('approval-2', { toolUseId: 'review:tool-B', sentMessageId: 'approval-2' })

      const handler = vi.fn()
      connector.onInteractiveResponse(handler)

      ;(connector as any).handleMessageReceived({
        messageId: 'msg-text',
        chatId: 'chat-1',
        from: '+10005551234',
        parts: [{ type: 'text', value: 'Do something else' }],
      })

      expect(handler).toHaveBeenCalledTimes(2)
      const deniedIds = handler.mock.calls.map((c: any) => c[0]).sort()
      expect(deniedIds).toEqual(['review:tool-A', 'review:tool-B'])
      for (const call of handler.mock.calls) {
        expect(call[1]).toEqual({ question: '_approval', answer: '❌ Deny' })
      }
    })

    it('still emits the incoming message after denying approvals', async () => {
      const connector = createConnector()
      wireUp(connector)

      const event = {
        type: 'user_question_request' as const,
        toolUseId: 'review:tool-C',
        questions: [{ question: 'Allow?' }],
      }

      await connector.sendUserRequestCard('chat-1', event as any)

      const messageHandler = vi.fn()
      connector.onMessage(messageHandler)

      ;(connector as any).handleMessageReceived({
        messageId: 'msg-new',
        chatId: 'chat-1',
        from: '+10005551234',
        parts: [{ type: 'text', value: 'New instruction' }],
      })

      // The incoming message should still be emitted
      expect(messageHandler).toHaveBeenCalledOnce()
      expect(messageHandler.mock.calls[0][0].text).toBe('New instruction')
    })
  })

  // ── 7. Other user request card types ──────────────────────────────

  describe('sendUserRequestCard — other event types', () => {
    let connector: IMessageConnector
    let ws: MockWs

    beforeEach(() => {
      connector = createConnector()
      ws = wireUp(connector)
    })

    it('sends secret request as a desktop-only fallback (secrets are unsafe to type in chat)', async () => {
      const event = {
        type: 'secret_request' as const,
        toolUseId: 'sec-1',
        secretName: 'API_KEY',
        reason: 'Needed for authentication',
      }

      await connector.sendUserRequestCard('chat-1', event as any)

      const text = (parseSent(ws)[0].data as any).parts[0].value as string
      expect(text).toContain('API_KEY')
      expect(text).toContain('Open Gamut on your desktop')
    })

    it('sends tool status with correct emoji', async () => {
      const event = {
        type: 'tool_status' as const,
        toolUseId: 'ts-1',
        toolName: 'web_search',
        summary: 'Completed search',
        status: 'success',
      }

      await connector.sendUserRequestCard('chat-1', event as any)

      const text = (parseSent(ws)[0].data as any).parts[0].value as string
      expect(text).toContain('web_search')
      expect(text).toContain('Completed search')
      expect(text).toContain('✅')
    })

    it('sends unsupported request text for browser_input_request', async () => {
      const event = {
        type: 'browser_input_request' as const,
        toolUseId: 'br-1',
      }

      await connector.sendUserRequestCard('chat-1', event as any)

      const text = (parseSent(ws)[0].data as any).parts[0].value as string
      expect(text).toContain("isn't supported in chat")
      expect(text).toContain('Open Gamut on your desktop')
    })
  })

  // ── 8. Typing indicator ───────────────────────────────────────────

  describe('startWorking', () => {
    it('sends start_typing command', async () => {
      const connector = createConnector()
      const ws = wireUp(connector)

      await connector.startWorking('chat-1', 'working')

      const messages = parseSent(ws)
      expect(messages).toHaveLength(1)
      expect(messages[0].type).toBe('start_typing')
    })

    // The manager's per-session tick calls startWorking every ~1s for keep-alive;
    // iMessage's bubble self-expires, so we fire start_typing once per working
    // segment instead of on every tick (avoids flooding the bridge).
    it('does not re-send start_typing on repeated calls within a segment', async () => {
      const connector = createConnector()
      const ws = wireUp(connector)

      await connector.startWorking('chat-1', 'working')
      await connector.startWorking('chat-1', 'working') // tick keep-alive
      await connector.startWorking('chat-1', 'thinking')

      const typing = parseSent(ws).filter((m) => m.type === 'start_typing')
      expect(typing).toHaveLength(1)
    })

    it('re-sends start_typing for a new segment after stopWorking', async () => {
      const connector = createConnector()
      const ws = wireUp(connector)

      await connector.startWorking('chat-1', 'working')
      await connector.stopWorking('chat-1')
      await connector.startWorking('chat-1', 'working') // new segment

      const typing = parseSent(ws).filter((m) => m.type === 'start_typing')
      expect(typing).toHaveLength(2)
    })
  })

  // ── 9. Connection state ───────────────────────────────────────────

  describe('isConnected', () => {
    it('returns false by default', () => {
      const connector = createConnector()
      expect(connector.isConnected()).toBe(false)
    })

    it('returns true when _connected is set', () => {
      const connector = createConnector()
      ;(connector as any)._connected = true
      expect(connector.isConnected()).toBe(true)
    })
  })
})
