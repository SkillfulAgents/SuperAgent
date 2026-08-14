import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { IMessageConnector } from './imessage-connector'

vi.mock('ws', () => {
  const MockWebSocket = vi.fn() as any
  MockWebSocket.OPEN = 1
  return { default: MockWebSocket }
})

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
}))

const CONTACT_CAPTION = "Save me as a contact so I'm not just a number. Text me anytime."
const USER_PHONE = '+15551234567'
const OTHER_PHONE = '+10005551234'

class MockWs {
  readyState = 1
  sent: string[] = []
  send(data: string) { this.sent.push(data) }
  close() {}
  on() {}
}

function createConnector(): IMessageConnector {
  return new IMessageConnector({
    gatewayUrl: 'ws://localhost:3456',
    phoneNumber: USER_PHONE,
    token: 'test-token',
  })
}

function wireUp(connector: IMessageConnector): MockWs {
  const ws = new MockWs()
  ;(connector as any).ws = ws
  ;(connector as any)._connected = true
  return ws
}

function inboundText(messageId: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    messageId,
    chatId: USER_PHONE,
    from: OTHER_PHONE,
    parts: [{ type: 'text', value: text }],
    ...extra,
  }
}

function emitLaterUserText(connector: IMessageConnector, handler: ReturnType<typeof vi.fn>, id = 'later-1') {
  const before = handler.mock.calls.length
  ;(connector as any).handleMessageReceived(inboundText(id, 'hello'))
  expect(handler).toHaveBeenCalledTimes(before + 1)
  expect(handler.mock.calls[before][0].text).toBe('hello')
}

describe('IMessageConnector leftover inbound', () => {
  describe('handleMessageReceived — not a user turn', () => {
    let connector: IMessageConnector

    beforeEach(() => {
      connector = createConnector()
      wireUp(connector)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('does not emit onMessage for fromMe: true (own-send echo)', () => {
      const handler = vi.fn()
      connector.onMessage(handler)

      ;(connector as any).handleMessageReceived(inboundText('echo-1', CONTACT_CAPTION, { fromMe: true }))

      expect(handler).not.toHaveBeenCalled()
      emitLaterUserText(connector, handler)
    })

    it('does not emit onMessage for is_from_me: true', () => {
      const handler = vi.fn()
      connector.onMessage(handler)

      ;(connector as any).handleMessageReceived(inboundText('echo-2', CONTACT_CAPTION, { is_from_me: true }))

      expect(handler).not.toHaveBeenCalled()
      emitLaterUserText(connector, handler)
    })

    it('does not emit onMessage for a message.sent id echo', () => {
      const handler = vi.fn()
      connector.onMessage(handler)

      ;(connector as any).handleMessageSent({ messageId: 'out-1' })
      ;(connector as any).handleMessageReceived(inboundText('out-1', CONTACT_CAPTION, { from: OTHER_PHONE }))

      expect(handler).not.toHaveBeenCalled()
      emitLaterUserText(connector, handler)
    })

    it('does not emit onMessage for the last sendFile caption while it is the last outbound', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
      const handler = vi.fn()
      connector.onMessage(handler)

      const pending = connector.sendFile(USER_PHONE, Buffer.from('BEGIN:VCARD'), 'Bobert.vcf', CONTACT_CAPTION)
      ;(connector as any).handleUploadResponse({
        attachmentId: 'att-1',
        uploadUrl: 'https://example.com/upload',
        downloadUrl: 'https://example.com/dl',
        requiredHeaders: {},
      })
      await pending

      ;(connector as any).handleMessageReceived({
        messageId: 'card-1',
        chatId: USER_PHONE,
        from: OTHER_PHONE,
        parts: [
          {
            type: 'media',
            url: 'https://gateway.example/card.vcf',
            filename: 'Bobert.vcf',
            mimeType: 'text/vcard',
          },
          { type: 'text', value: CONTACT_CAPTION },
        ],
      })

      expect(handler).not.toHaveBeenCalled()
      emitLaterUserText(connector, handler)
    })
  })

  describe('handshake flush', () => {
    it('does not emit message.received before _connected', () => {
      const connector = createConnector()
      const handler = vi.fn()
      connector.onMessage(handler)

      ;(connector as any).handleServerEvent({
        type: 'message.received',
        data: inboundText('early-1', '/setup'),
      })

      expect(handler).not.toHaveBeenCalled()

      ;(connector as any)._connected = true
      ;(connector as any).handleServerEvent({
        type: 'message.received',
        data: inboundText('later-early', 'hello'),
      })
      expect(handler).toHaveBeenCalledOnce()
      expect(handler.mock.calls[0][0].text).toBe('hello')
    })

    it('skips the next queuedCount receives after connected, then emits a later user text', () => {
      const connector = createConnector()
      wireUp(connector)
      const handler = vi.fn()
      connector.onMessage(handler)

      ;(connector as any).handleServerEvent({ type: 'connected', data: { queuedCount: 3 } })
      ;(connector as any).handleServerEvent({
        type: 'message.received',
        data: inboundText('q1', '/setup'),
      })
      ;(connector as any).handleServerEvent({
        type: 'message.received',
        data: inboundText('q2', CONTACT_CAPTION),
      })
      ;(connector as any).handleServerEvent({
        type: 'message.received',
        data: {
          messageId: 'q3',
          chatId: USER_PHONE,
          from: OTHER_PHONE,
          parts: [
            {
              type: 'media',
              url: 'https://gateway.example/card.vcf',
              filename: 'Bobert.vcf',
            },
          ],
        },
      })

      expect(handler).not.toHaveBeenCalled()

      ;(connector as any).handleServerEvent({
        type: 'message.received',
        data: inboundText('real-1', 'hello', { from: OTHER_PHONE }),
      })

      expect(handler).toHaveBeenCalledOnce()
      expect(handler.mock.calls[0][0].text).toBe('hello')
    })

    it('emits the next user text when queuedCount is missing or zero', () => {
      const connector = createConnector()
      wireUp(connector)
      const handler = vi.fn()
      connector.onMessage(handler)

      ;(connector as any).handleServerEvent({ type: 'connected', data: {} })
      ;(connector as any).handleServerEvent({
        type: 'message.received',
        data: inboundText('real-2', 'hello', { from: OTHER_PHONE }),
      })

      expect(handler).toHaveBeenCalledOnce()
      expect(handler.mock.calls[0][0].text).toBe('hello')
    })
  })
})
