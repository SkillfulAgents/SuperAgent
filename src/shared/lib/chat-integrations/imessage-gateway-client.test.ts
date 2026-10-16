import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../error-reporting', () => ({ captureException: vi.fn() }))

import type { AgentIntegrationRecord } from '../agent-integrations/types'
import {
  GatewayRequestError,
  deleteGatewayWebhook,
  markGatewayChatRead,
  registerGatewayWebhook,
  requestGatewayUpload,
  sendGatewayMessage,
  sendGatewayReaction,
  startGatewayTyping,
} from './imessage-gateway-client'
import { IMESSAGE_WEBHOOK_EVENTS } from './imessage-webhooks'
import { chatProviders } from './providers'

const PHONE = '+15551234567'
const gateway = { gatewayUrl: 'https://imsgw.test/', phoneNumber: PHONE, token: 'phone-token' }
const PHONE_URL = 'https://imsgw.test/v1/phones/%2B15551234567'
const relay = { endpointId: 'whep_1', url: 'https://relay.test/v1/hooks/whep_1', scope: 'sub_owner' }

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const call = (n: number) => {
  const [url, init] = fetchMock.mock.calls[n]
  return { url, method: init.method, auth: init.headers.Authorization, body: init.body === undefined ? undefined : JSON.parse(init.body) }
}

describe('webhook', () => {
  it('registers the relay endpoint for every event the gateway would otherwise hold', async () => {
    fetchMock.mockResolvedValue(Response.json({ url: relay.url, events: [...IMESSAGE_WEBHOOK_EVENTS], lastDeliveryAt: null, lastError: null, pending: 2, parked: 0 }))

    const registered = await registerGatewayWebhook(gateway, { url: relay.url, secret: 'a'.repeat(64), events: IMESSAGE_WEBHOOK_EVENTS })

    expect(registered.pending).toBe(2)
    expect(call(0)).toEqual({
      url: `${PHONE_URL}/webhook`, method: 'PUT', auth: 'Bearer phone-token',
      body: { url: relay.url, secret: 'a'.repeat(64), events: ['message.received', 'message.sent', 'message.failed', 'message.edited', 'reaction.added', 'reaction.removed'] },
    })
  })

  it('reports a refused registration', async () => {
    fetchMock.mockResolvedValue(Response.json({ error: 'url origin is not allowed' }, { status: 400 }))
    await expect(registerGatewayWebhook(gateway, { url: relay.url, secret: 'a'.repeat(64), events: IMESSAGE_WEBHOOK_EVENTS }))
      .rejects.toThrow('HTTP 400: {"error":"url origin is not allowed"}')
  })

  it('removes the webhook, treating one that is already gone as removed', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await deleteGatewayWebhook(gateway)
    expect(call(0).method).toBe('DELETE')

    fetchMock.mockResolvedValueOnce(Response.json({ error: 'No webhook registered' }, { status: 404 }))
    await expect(deleteGatewayWebhook(gateway)).resolves.toBeUndefined()

    fetchMock.mockResolvedValueOnce(new Response('down', { status: 503 }))
    await expect(deleteGatewayWebhook(gateway)).rejects.toThrow('HTTP 503')
  })

  it('is removed when an installation that registered one is deleted', async () => {
    const imessage = chatProviders.find(provider => provider.definition.provider === 'imessage')!
    const record = { id: 'int-1', provider: 'imessage', agentSlug: 'agent', createdByUserId: 'owner' } as AgentIntegrationRecord

    await imessage.cleanup!({ ...record, config: JSON.stringify(gateway) })
    expect(fetchMock).not.toHaveBeenCalled()

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await imessage.cleanup!({ ...record, config: JSON.stringify({ ...gateway, relay, webhookSecret: 'a'.repeat(64) }) })
    expect(call(0)).toMatchObject({ url: `${PHONE_URL}/webhook`, method: 'DELETE' })
  })
})

describe('commands', () => {
  it('sends a message and answers with Linq’s id', async () => {
    fetchMock.mockResolvedValue(Response.json({ messageId: 'msg_out', chatId: 'chat_1' }))

    expect(await sendGatewayMessage(gateway, { chatId: 'chat_1', parts: [{ type: 'text', value: 'hi' }] })).toEqual({ messageId: 'msg_out', chatId: 'chat_1' })
    expect(call(0)).toEqual({
      url: `${PHONE_URL}/messages`, method: 'POST', auth: 'Bearer phone-token',
      body: { chatId: 'chat_1', parts: [{ type: 'text', value: 'hi' }], idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) },
    })
  })

  it('repeats a send the gateway couldn’t complete under the same idempotency key', async () => {
    vi.useFakeTimers()
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('Linq unavailable', { status: 502 }))
      .mockResolvedValueOnce(Response.json({ messageId: 'msg_out', chatId: 'chat_1' }))

    const sending = sendGatewayMessage(gateway, { parts: [{ type: 'text', value: 'hi' }] })
    await vi.advanceTimersByTimeAsync(4_000)

    expect(await sending).toEqual({ messageId: 'msg_out', chatId: 'chat_1' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const keys = [0, 1, 2].map(n => call(n).body.idempotencyKey)
    expect(new Set(keys).size).toBe(1)
  })

  it('doesn’t repeat a send Linq refused, and gives up after three attempts', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'Chat not found' }, { status: 422 }))
    await expect(sendGatewayMessage(gateway, { parts: [{ type: 'text', value: 'hi' }] })).rejects.toMatchObject({ status: 422, retryable: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.useFakeTimers()
    fetchMock.mockReset()
    fetchMock.mockImplementation(async () => new Response('down', { status: 503 }))
    const sending = sendGatewayMessage(gateway, { parts: [{ type: 'text', value: 'hi' }] })
    const outcome = expect(sending).rejects.toBeInstanceOf(GatewayRequestError)
    await vi.advanceTimersByTimeAsync(4_000)
    await outcome
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('reacts, shows typing, marks read and asks where to upload', async () => {
    fetchMock.mockImplementation(async (url: string) => url.endsWith('/attachments')
      ? Response.json({ attachmentId: 'att_1', uploadUrl: 'https://up.test/1', downloadUrl: 'https://cdn.test/1', requiredHeaders: { 'Content-Type': 'image/png' }, expiresAt: '2026-10-14T00:00:00Z' })
      : new Response(null, { status: 204 }))

    await sendGatewayReaction(gateway, { messageId: 'msg_1', reactionType: 'love', partIndex: 0 })
    await startGatewayTyping(gateway, 'chat_1')
    await markGatewayChatRead(gateway, 'chat_1')
    const upload = await requestGatewayUpload(gateway, { filename: 'a.png', contentType: 'image/png', sizeBytes: 10 })

    expect([0, 1, 2, 3].map(call).map(({ url, method, body }) => ({ url, method, body }))).toEqual([
      { url: `${PHONE_URL}/reactions`, method: 'POST', body: { messageId: 'msg_1', reactionType: 'love', partIndex: 0, operation: 'add' } },
      { url: `${PHONE_URL}/typing`, method: 'POST', body: { chatId: 'chat_1' } },
      { url: `${PHONE_URL}/read`, method: 'POST', body: { chatId: 'chat_1' } },
      { url: `${PHONE_URL}/attachments`, method: 'POST', body: { filename: 'a.png', contentType: 'image/png', sizeBytes: 10 } },
    ])
    expect(upload).toMatchObject({ attachmentId: 'att_1', uploadUrl: 'https://up.test/1', requiredHeaders: { 'Content-Type': 'image/png' } })
  })
})
