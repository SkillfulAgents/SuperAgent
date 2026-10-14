import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sockets = vi.hoisted(() => [] as Array<{
  url: string
  sent: Array<Record<string, unknown>>
  readyState: number
  emit(event: string, ...args: unknown[]): void
  receive(frame: Record<string, unknown>): void
}>)

vi.mock('ws', () => {
  class FakeSocket {
    static OPEN = 1
    readyState = 1
    sent: Array<Record<string, unknown>> = []
    private handlers = new Map<string, Array<(...args: unknown[]) => void>>()
    constructor(public url: string) { sockets.push(this) }
    on(event: string, handler: (...args: unknown[]) => void) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]) }
    emit(event: string, ...args: unknown[]) { for (const handler of this.handlers.get(event) ?? []) handler(...args) }
    receive(frame: Record<string, unknown>) { this.emit('message', Buffer.from(JSON.stringify(frame))) }
    send(data: string) { this.sent.push(JSON.parse(data)) }
    close() { this.readyState = 3 }
    ping() {}
    terminate() {}
  }
  return { default: FakeSocket }
})
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))
vi.mock('./imessage-webhooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./imessage-webhooks')>()),
  ensureIMessageWebhook: vi.fn(),
}))
vi.mock('./imessage-gateway-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./imessage-gateway-client')>()),
  registerGatewayWebhook: vi.fn(),
  sendGatewayMessage: vi.fn(),
  sendGatewayReaction: vi.fn(),
  startGatewayTyping: vi.fn(),
  markGatewayChatRead: vi.fn(),
  requestGatewayUpload: vi.fn(),
}))

import { IMessageConnector } from './imessage-connector'
import { IMESSAGE_WEBHOOK_EVENTS, ensureIMessageWebhook } from './imessage-webhooks'
import {
  GatewayRequestError, markGatewayChatRead, registerGatewayWebhook, requestGatewayUpload, sendGatewayMessage, sendGatewayReaction, startGatewayTyping,
} from './imessage-gateway-client'
import { IntegrationRelays } from '../agent-integrations/relay-transport'
import type { IntegrationRelayAccept, IntegrationRelayHost } from '../agent-integrations/transport'
import { createFakeWebhookRelay, type FakeWebhookRelay } from '../webhook-relay/testing/fake-webhook-relay'
import type { IntegrationEvent, IntegrationInputResult } from '../agent-integrations/types'
import { relayedIMessageDelivery } from './test-helpers'

const PHONE = '+15551234567'
const SECRET = 'a'.repeat(64)
const config = { gatewayUrl: 'https://imsgw.test', phoneNumber: PHONE, token: 'phone-token' }
const integration = { id: 'int-1', agentSlug: 'agent', createdByUserId: 'owner' }
const webhook = { relay: { endpointId: 'whep_1', url: 'https://relay.test/v1/hooks/whep_1', scope: 'sub_owner' }, secret: SECRET }
const CONSUMER = 'integration:int-1'

let relay: FakeWebhookRelay
let relays: IntegrationRelays
let inputs: IntegrationEvent[]
let inputResult: (event: IntegrationEvent) => IntegrationInputResult | Promise<IntegrationInputResult>

beforeEach(() => {
  sockets.length = 0
  vi.mocked(ensureIMessageWebhook).mockReset().mockResolvedValue(webhook)
  vi.mocked(registerGatewayWebhook).mockReset().mockResolvedValue({ url: webhook.relay.url, events: [...IMESSAGE_WEBHOOK_EVENTS] })
  vi.mocked(sendGatewayMessage).mockReset().mockResolvedValue({ messageId: 'msg_out', chatId: 'chat_1' })
  for (const command of [sendGatewayReaction, startGatewayTyping, markGatewayChatRead]) vi.mocked(command).mockReset().mockResolvedValue(undefined)
  vi.mocked(requestGatewayUpload).mockReset()
  relay = createFakeWebhookRelay()
  relays = new IntegrationRelays(() => relay)
  inputs = []
  inputResult = () => 'accepted'
})
afterEach(() => { vi.unstubAllGlobals() })

function messageEvent(id: string, messageId: string, extra: Record<string, unknown> = {}) {
  return { type: 'message.received', id, seq: 1, createdAt: '2026-10-13T12:00:00.000Z', data: { messageId, chatId: 'chat_1', from: PHONE, parts: [{ type: 'text', value: `text of ${messageId}` }], sentAt: '2026-10-13T12:00:00.000Z', ...extra } }
}
const relayed = (event: Record<string, unknown>) => relayedIMessageDelivery({ ...event, phoneNumber: PHONE }, SECRET)
const deliver = (...events: Array<Record<string, unknown>>) => relay.deliver(CONSUMER, events.map(relayed))

function connector(relayHost: IntegrationRelayHost | null | undefined) {
  const instance = new IMessageConnector(config, undefined, integration)
  instance.bindHost({ session: async () => undefined, relay: relayHost === undefined ? relays.hostFor('int-1') : relayHost })
  instance.onEvent(event => {
    if (event.type !== 'input') return
    inputs.push(event)
    return inputResult(event)
  })
  return instance
}

/** Connected through webhooks: no socket. */
async function connectWebhooks(relayHost?: IntegrationRelayHost) {
  const instance = connector(relayHost)
  await instance.connect()
  return instance
}

/** Connected over the socket, as without a relay. */
async function connectSocket(relayHost: IntegrationRelayHost | null = null) {
  const instance = connector(relayHost)
  const connecting = instance.connect()
  await vi.waitFor(() => expect(sockets).toHaveLength(1))
  const socket = sockets[0]
  socket.emit('open')
  socket.receive({ type: 'connected', data: { phoneNumber: PHONE, queuedCount: 0 } })
  await connecting
  return { connector: instance, socket }
}

const acks = (socket: (typeof sockets)[number]) => socket.sent.filter(frame => frame.type === 'ack').flatMap(frame => frame.ids as string[])
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const reviewRequest = { type: 'question_request', toolUseId: 'review:req-1', questions: [{ question: 'Allow?' }] } as never

describe('IMessageConnector through webhooks', () => {
  it('receives through the relay and sends over HTTP, with no socket', async () => {
    const instance = await connectWebhooks()

    expect(sockets).toHaveLength(0)
    expect(ensureIMessageWebhook).toHaveBeenCalledWith(integration)
    expect(registerGatewayWebhook).toHaveBeenCalledWith(config, { url: webhook.relay.url, secret: SECRET, events: IMESSAGE_WEBHOOK_EVENTS })
    expect(relay.consumers.get(CONSUMER)?.endpointIds).toEqual(['whep_1'])
    expect(instance.isConnected()).toBe(true)
    expect(instance.activeTransport()).toBe('relay')

    await instance.disconnect()
    expect(relay.consumers.get(CONSUMER)?.endpointIds).toEqual([])
    expect(instance.isConnected()).toBe(false)
    expect(instance.activeTransport()).toBeNull()
  })

  it('uses the socket when webhooks can’t be set up, without claiming relayed events', async () => {
    vi.mocked(ensureIMessageWebhook).mockRejectedValueOnce(new Error('relay down'))
    const first = await connectSocket(relays.hostFor('int-1'))
    expect(first.connector.activeTransport()).toBe('direct')
    expect(registerGatewayWebhook).not.toHaveBeenCalled()
    await first.connector.disconnect()

    sockets.length = 0
    vi.mocked(registerGatewayWebhook).mockRejectedValueOnce(new GatewayRequestError('HTTP 400: url origin is not allowed', 400))
    const second = await connectSocket(relays.hostFor('int-1'))
    expect(second.connector.activeTransport()).toBe('direct')
    expect(relay.consumers.has(CONSUMER)).toBe(false)
  })

  it('hands a relayed message to the host, keyed by its message id, and marks the chat read once', async () => {
    await connectWebhooks()

    const results = await deliver(messageEvent('evt_1', 'msg_1'), messageEvent('evt_2', 'msg_2'))

    expect(results).toEqual(new Map([['whe_evt_1', 'accepted'], ['whe_evt_2', 'accepted']]))
    expect(inputs.map(input => input.type === 'input' && input.id)).toEqual(['msg_1', 'msg_2'])
    expect(inputs[0]).toMatchObject({ externalId: 'chat_1', payload: { text: 'text of msg_1', userId: PHONE } })
    await vi.waitFor(() => expect(markGatewayChatRead).toHaveBeenCalledWith(config, 'chat_1'), { timeout: 2_000 })
    expect(markGatewayChatRead).toHaveBeenCalledTimes(1)
  })

  it('maps the host’s answer to what the relay acknowledges', async () => {
    await connectWebhooks()
    inputResult = () => 'rejected'
    expect(await deliver(messageEvent('evt_1', 'msg_1'))).toEqual(new Map([['whe_evt_1', 'discard']]))
    inputResult = () => 'retry'
    expect(await deliver(messageEvent('evt_2', 'msg_2'))).toEqual(new Map([['whe_evt_2', 'retry']]))
    inputResult = () => { throw new Error('database locked') }
    expect(await deliver(messageEvent('evt_3', 'msg_3'))).toEqual(new Map([['whe_evt_3', 'retry']]))
    // A retried event goes through when it comes back.
    inputResult = () => 'accepted'
    expect(await deliver(messageEvent('evt_3', 'msg_3'))).toEqual(new Map([['whe_evt_3', 'accepted']]))
  })

  it('hands events over one at a time, in arrival order', async () => {
    const order: string[] = []
    inputResult = async (event): Promise<IntegrationInputResult> => {
      if (event.type === 'input' && event.id === 'msg_1') await new Promise(resolve => setTimeout(resolve, 20))
      order.push(event.type === 'input' ? event.id : '')
      return 'accepted'
    }
    await connectWebhooks()

    await Promise.all([deliver(messageEvent('evt_1', 'msg_1')), deliver(messageEvent('evt_2', 'msg_2'))])
    expect(order).toEqual(['msg_1', 'msg_2'])
  })

  it('handles a redelivered event once, even one that answered a question', async () => {
    const instance = await connectWebhooks()
    await instance.sendUserRequestCard('chat_1', { type: 'question_request', toolUseId: 'tool-1', questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] } as never)
    const responses: IntegrationEvent[] = []
    instance.onEvent(event => { if (event.type === 'response') responses.push(event) })

    const answer = messageEvent('evt_1', 'msg_1', { parts: [{ type: 'text', value: '2' }] })
    expect(await deliver(answer)).toEqual(new Map([['whe_evt_1', 'accepted']]))
    expect(await deliver(answer)).toEqual(new Map([['whe_evt_1', 'duplicate']]))

    expect(responses).toHaveLength(1)
    expect(inputs).toHaveLength(0)
  })

  it('answers an approval only by a reaction on its own message', async () => {
    vi.mocked(sendGatewayMessage).mockResolvedValueOnce({ messageId: 'msg_approval', chatId: 'chat_1' })
    const instance = await connectWebhooks()
    expect(await instance.sendUserRequestCard('chat_1', reviewRequest)).toBe('msg_approval')
    const responses: IntegrationEvent[] = []
    instance.onEvent(event => { if (event.type === 'response') responses.push(event) })

    // From before a restart, on a message that's no approval now; and a send confirmation.
    const stale = await deliver(
      { type: 'reaction.added', id: 'evt_old', data: { messageId: 'msg_old', reactionType: 'like', from: PHONE, partIndex: 0 } },
      { type: 'message.sent', id: 'evt_sent', data: { messageId: 'msg_approval', chatId: 'chat_1' } },
    )
    expect(stale).toEqual(new Map([['whe_evt_old', 'discard'], ['whe_evt_sent', 'discard']]))
    expect(responses).toEqual([])

    const answered = await deliver({ type: 'reaction.added', id: 'evt_react', data: { messageId: 'msg_approval', reactionType: 'like', from: PHONE, partIndex: 0 } })
    expect(answered).toEqual(new Map([['whe_evt_react', 'accepted']]))
    expect(responses).toMatchObject([{ type: 'response', requestId: 'req-1', requestKind: 'review', value: 'allow' }])
  })

  it('sends replies, reactions, typing and files over HTTP', async () => {
    const instance = await connectWebhooks()
    await deliver(messageEvent('evt_1', 'msg_1'))

    expect(await instance.sendMessage('chat_1', { text: '[[reaction:heart]] Hello' })).toBe('msg_out')
    expect(sendGatewayReaction).toHaveBeenCalledWith(config, { messageId: 'msg_1', reactionType: 'love', partIndex: 0 })
    expect(sendGatewayMessage).toHaveBeenLastCalledWith(config, { chatId: 'chat_1', parts: [{ type: 'text', value: 'Hello' }] })

    await instance.startWorking('chat_1', 'working')
    expect(startGatewayTyping).toHaveBeenCalledWith(config, 'chat_1')

    vi.mocked(requestGatewayUpload).mockResolvedValue({ attachmentId: 'att_1', uploadUrl: 'https://upload.test/att_1', downloadUrl: 'https://cdn.test/att_1', requiredHeaders: { 'Content-Type': 'text/plain' } })
    const upload = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', upload)
    await instance.sendFile('chat_1', Buffer.from('notes'), 'notes.txt', 'Here you go')
    expect(requestGatewayUpload).toHaveBeenCalledWith(config, { filename: 'notes.txt', contentType: 'text/plain', sizeBytes: 5 })
    expect(upload).toHaveBeenCalledWith('https://upload.test/att_1', expect.objectContaining({ method: 'PUT' }))
    expect(sendGatewayMessage).toHaveBeenLastCalledWith(config, { chatId: 'chat_1', parts: [{ type: 'media', attachmentId: 'att_1' }, { type: 'text', value: 'Here you go' }] })
    expect(sockets).toHaveLength(0)
  })

  it('fails a reply the gateway couldn’t send', async () => {
    vi.mocked(sendGatewayMessage).mockRejectedValueOnce(new GatewayRequestError('HTTP 502: Linq unavailable', 502))
    const instance = await connectWebhooks()
    await expect(instance.sendMessage('chat_1', { text: 'Hello' })).rejects.toThrow('HTTP 502')
  })

  it('discards deliveries it cannot verify', async () => {
    await connectWebhooks()
    const forged = relayedIMessageDelivery({ ...messageEvent('evt_1', 'msg_1'), phoneNumber: PHONE }, 'b'.repeat(64))
    expect(await relay.deliver(CONSUMER, [forged])).toEqual(new Map([['whe_evt_1', 'discard']]))
    expect(inputs).toEqual([])
  })

  it('leaves relayed events for the next connection once disconnected', async () => {
    let accept!: IntegrationRelayAccept
    const instance = await connectWebhooks({ attach: (binding, given) => { accept = given; return relays.attach('int-1', binding, given) } })
    await instance.disconnect()

    expect(await deliver(messageEvent('evt_1', 'msg_1'))).toEqual(new Map([['whe_evt_1', 'retry']]))
    // A claim that was already in flight when it disconnected.
    expect(await accept([relayed(messageEvent('evt_2', 'msg_2'))])).toEqual(new Map([['whe_evt_2', 'retry']]))
    expect(inputs).toEqual([])
  })

  it('keeps reacting to the newest message when an older one arrives after it', async () => {
    const instance = await connectWebhooks()
    await deliver(messageEvent('evt_2', 'msg_new', { sentAt: '2026-10-13T12:05:00.000Z' }))
    await deliver(messageEvent('evt_1', 'msg_old', { sentAt: '2026-10-13T12:00:00.000Z' }))

    expect(inputs.map(input => input.type === 'input' && input.id)).toEqual(['msg_new', 'msg_old'])
    expect((instance as any).lastReceivedMessageId).toBe('msg_new')
  })
})

describe('IMessageConnector over the socket', () => {
  it('announces acks and sends over the socket', async () => {
    const { connector: instance, socket } = await connectSocket()

    expect(ensureIMessageWebhook).not.toHaveBeenCalled()
    expect(socket.sent[0]).toEqual({ type: 'ready', acks: true })
    expect(instance.activeTransport()).toBe('direct')

    await instance.sendMessage('chat_1', { text: 'Hello' })
    expect(socket.sent).toContainEqual({ type: 'send_message', data: { chatId: 'chat_1', parts: [{ type: 'text', value: 'Hello' }] } })
    expect(sendGatewayMessage).not.toHaveBeenCalled()
  })

  it('acks an event once the host has stored it, and leaves a retry or a failure unacked', async () => {
    let release!: (result: IntegrationInputResult) => void
    inputResult = () => new Promise(resolve => { release = resolve })
    const { socket } = await connectSocket()

    socket.receive(messageEvent('evt_1', 'msg_1'))
    await vi.waitFor(() => expect(inputs).toHaveLength(1))
    expect(acks(socket)).toEqual([])
    release('accepted')
    await vi.waitFor(() => expect(acks(socket)).toEqual(['evt_1']))

    // Handed over later, in order: each answer is chosen by message.
    const answers: Record<string, IntegrationInputResult | 'throw'> = { msg_2: 'rejected', msg_3: 'retry', msg_4: 'throw', msg_5: 'duplicate' }
    inputResult = event => {
      const answer = answers[event.type === 'input' ? event.id : '']
      if (answer === 'throw') throw new Error('database locked')
      return answer
    }
    for (const n of [2, 3, 4, 5]) socket.receive(messageEvent(`evt_${n}`, `msg_${n}`))
    await vi.waitFor(() => expect(acks(socket)).toEqual(['evt_1', 'evt_2', 'evt_5']))
    await settle()
    expect(acks(socket)).toEqual(['evt_1', 'evt_2', 'evt_5'])
  })

  it('acks the other kept events but not ephemeral ones', async () => {
    const { socket } = await connectSocket()
    socket.receive({ type: 'message.sent', id: 'evt_sent', data: { messageId: 'msg_out', chatId: 'chat_1' } })
    socket.receive({ type: 'typing.started', id: 'evt_typing', data: { from: PHONE } })
    socket.receive({ type: 'reaction.removed', id: 'evt_unreact', data: { messageId: 'msg_1', reactionType: 'love' } })
    await vi.waitFor(() => expect(acks(socket)).toEqual(['evt_sent', 'evt_unreact']))
  })

  it('handles an event the gateway replays once', async () => {
    const { socket } = await connectSocket()
    socket.receive(messageEvent('evt_1', 'msg_1'))
    socket.receive(messageEvent('evt_1', 'msg_1'))
    await vi.waitFor(() => expect(acks(socket)).toEqual(['evt_1', 'evt_1']))
    expect(inputs).toHaveLength(1)
  })
})
