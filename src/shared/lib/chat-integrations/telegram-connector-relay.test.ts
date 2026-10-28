import { inspect } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Every Bot API call the connector makes, answered here instead of by Telegram.
 * A failure is Telegram's refusal, every time, or a thrown error, once. A
 * gate holds a method's answer until the test opens it.
 */
const telegram = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; payload: Record<string, any> }>,
  failures: new Map<string, { error_code: number; description: string } | Error>(),
  gates: new Map<string, Promise<void>>(),
  nextMessageId: 1000,
}))

vi.mock('grammy', async (importOriginal) => {
  const grammy = await importOriginal<typeof import('grammy')>()
  const answer = async (method: string, payload: Record<string, any>): Promise<unknown> => {
    switch (method) {
      case 'getMe': return { id: 123, is_bot: true, first_name: 'Helper', username: 'helper_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false }
      // Long polling: an empty batch, a little later.
      case 'getUpdates': await new Promise(resolve => setTimeout(resolve, 10)); return []
      case 'getFile': return { file_id: payload.file_id, file_unique_id: 'u', file_path: 'photos/file_1.jpg' }
      case 'sendRichMessage': case 'sendMessage': return { message_id: ++telegram.nextMessageId, date: 0, chat: { id: Number(payload.chat_id), type: 'private' } }
      default: return true
    }
  }
  class Bot extends grammy.Bot {
    constructor(token: string) {
      super(token)
      this.api.config.use(async (_prev, method, payload) => {
        telegram.calls.push({ method, payload: (payload ?? {}) as Record<string, any> })
        await telegram.gates.get(method)
        const failure = telegram.failures.get(method)
        if (failure instanceof Error) { telegram.failures.delete(method); throw failure }
        if (failure) return { ok: false, ...failure } as never
        return { ok: true, result: await answer(method, (payload ?? {}) as Record<string, any>) } as never
      })
    }
  }
  return { ...grammy, Bot }
})
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))
vi.mock('./telegram-webhooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./telegram-webhooks')>()),
  ensureTelegramWebhook: vi.fn(),
}))

import { captureException } from '@shared/lib/error-reporting'
import { TelegramConnector, forgetTelegramInstallation } from './telegram-connector'
import { ensureTelegramWebhook, telegramSecretToken } from './telegram-webhooks'
import { IntegrationRelays } from '../agent-integrations/relay-transport'
import { IntegrationSetupError } from '../agent-integrations/setup-types'
import type { IntegrationRelayHost } from '../agent-integrations/transport'
import { createFakeWebhookRelay, type FakeWebhookRelay } from '../webhook-relay/testing/fake-webhook-relay'
import type { IntegrationEvent, IntegrationInputResult, IntegrationResponseEvent } from '../agent-integrations/types'
import type { IncomingMessage } from './chat-agent-integration'
import { relayedTelegramUpdate } from './test-helpers'

const BOT_TOKEN = '123:abc'
const SECRET = 'a'.repeat(64)
const SECRET_TOKEN = telegramSecretToken(SECRET, BOT_TOKEN)
const integration = { id: 'int-1', agentSlug: 'agent', createdByUserId: 'owner' }
const webhook = { relay: { endpointId: 'whep_1', url: 'https://relay.test/v1/hooks/whep_1', scope: 'sub_owner' }, secret: SECRET }
const CONSUMER = 'integration:int-1'
const CHAT = 42

let relay: FakeWebhookRelay
let relays: IntegrationRelays
let inputs: IncomingMessage[]
let responses: IntegrationResponseEvent[]
let inputResult: (event: IntegrationEvent) => IntegrationInputResult | Promise<IntegrationInputResult>
let nextUpdateId: number

afterEach(() => { vi.useRealTimers() })

beforeEach(() => {
  telegram.calls.length = 0
  telegram.failures.clear()
  telegram.gates.clear()
  forgetTelegramInstallation('int-1')
  vi.mocked(captureException).mockClear()
  vi.mocked(ensureTelegramWebhook).mockReset().mockResolvedValue(webhook)
  relay = createFakeWebhookRelay()
  relays = new IntegrationRelays(() => relay)
  inputs = []
  responses = []
  inputResult = () => 'accepted'
  nextUpdateId = 1
})

const methods = () => telegram.calls.map(call => call.method)
const from = { id: 7, is_bot: false, first_name: 'Alice' }

function textUpdate(text: string, messageId: number) {
  return { update_id: nextUpdateId++, message: { message_id: messageId, date: 1_760_000_000, chat: { id: CHAT, type: 'private', first_name: 'Alice' }, from, text } }
}
function tapUpdate(data: string, messageId: number) {
  return { update_id: nextUpdateId++, callback_query: { id: `cbq_${nextUpdateId}`, from, chat_instance: 'ci', data, message: { message_id: messageId, date: 0, chat: { id: CHAT, type: 'private' } } } }
}
const deliver = (...updates: Array<Record<string, unknown>>) =>
  relay.deliver(CONSUMER, updates.map(update => relayedTelegramUpdate(update, SECRET_TOKEN)))

function connector(relayHost: IntegrationRelayHost | null | undefined = undefined) {
  const instance = new TelegramConnector({ botToken: BOT_TOKEN }, undefined, integration)
  instance.bindHost({ session: async () => undefined, relay: relayHost === undefined ? relays.hostFor('int-1') : relayHost })
  instance.onEvent(event => {
    if (event.type === 'response') responses.push(event)
    if (event.type !== 'input') return
    inputs.push(event.payload as IncomingMessage)
    return inputResult(event)
  })
  return instance
}

async function connected(relayHost?: IntegrationRelayHost | null) {
  const instance = connector(relayHost)
  await instance.connect()
  return instance
}

/** Sends a one-question card with options A and B; returns its message id and the buttons' callback data. */
async function sendCard(instance: TelegramConnector, toolUseId = 'toolu_1') {
  await instance.sendUserRequestCard(String(CHAT), { type: 'question_request', toolUseId, questions: [{ question: 'Pick one?', options: [{ label: 'A' }, { label: 'B' }] }] } as never)
  const sent = telegram.calls.filter(call => call.method === 'sendRichMessage').at(-1)!
  const buttons = (sent.payload.reply_markup.inline_keyboard as Array<Array<{ callback_data: string }>>).map(row => row[0].callback_data)
  return { messageId: telegram.nextMessageId, buttons }
}

describe('TelegramConnector through the webhook', () => {
  it('sets the bot webhook to the endpoint with a secret token on connect, and never polls', async () => {
    const instance = await connected()

    expect(ensureTelegramWebhook).toHaveBeenCalledWith(integration)
    const setWebhook = telegram.calls.find(call => call.method === 'setWebhook')
    expect(setWebhook?.payload).toEqual({ url: webhook.relay.url, secret_token: SECRET_TOKEN, allowed_updates: ['message', 'callback_query'], drop_pending_updates: false })
    expect(methods()).not.toContain('getUpdates')
    expect(methods()).not.toContain('deleteWebhook')
    expect(relay.consumers.get(CONSUMER)?.endpointIds).toEqual(['whep_1'])
    expect(instance.isConnected()).toBe(true)
    expect(instance.activeTransport()).toBe('relay')

    await instance.disconnect()
    expect(instance.activeTransport()).toBeNull()
    expect(relay.consumers.get(CONSUMER)?.endpointIds).toEqual([])
  })

  it('hands relayed messages over one by one, without batching held ones, and reports what the host did', async () => {
    const instance = await connected()
    inputResult = event => event.type === 'input' && (event.payload as IncomingMessage).text === 'second' ? 'retry' : 'accepted'

    const results = await deliver(textUpdate('first', 11), textUpdate('second', 12))

    expect(inputs.map(input => [input.externalMessageId, input.text, input.chatId, input.chatType])).toEqual([['11', 'first', '42', 'private'], ['12', 'second', '42', 'private']])
    expect([...results.values()]).toEqual(['accepted', 'retry'])

    inputResult = () => 'rejected'
    expect([...(await deliver(textUpdate('third', 13))).values()]).toEqual(['discard'])
    inputResult = () => 'duplicate'
    expect([...(await deliver(textUpdate('first', 11))).values()]).toEqual(['duplicate'])
    await instance.disconnect()
  })

  it('reports a relayed photo once the host has it, without the file URL in the logs', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const instance = await connected()
    const photo = { update_id: nextUpdateId++, message: { message_id: 20, date: 0, chat: { id: CHAT, type: 'private' }, from, caption: 'look', photo: [{ file_id: 'small', file_unique_id: 's', width: 1, height: 1 }, { file_id: 'large', file_unique_id: 'l', width: 9, height: 9 }] } }
    inputResult = async (): Promise<IntegrationInputResult> => 'retry'

    expect([...(await deliver(photo)).values()]).toEqual(['retry'])
    expect(inputs[0].files).toEqual([{ name: 'photo.jpg', url: `https://api.telegram.org/file/bot${BOT_TOKEN}/photos/file_1.jpg`, mimeType: 'image/jpeg' }])
    expect(telegram.calls.find(call => call.method === 'getFile')?.payload).toEqual({ file_id: 'large' })
    expect(JSON.stringify(log.mock.calls)).not.toContain(BOT_TOKEN)
    log.mockRestore()
    await instance.disconnect()
  })

  it('discards posts without the bot secret token, and handshakes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const instance = await connected()
    const forged = relayedTelegramUpdate(textUpdate('forged', 30), telegramSecretToken(SECRET, '456:other-bot'))
    const unsigned = relayedTelegramUpdate(textUpdate('unsigned', 31), null)
    const handshake = relayedTelegramUpdate(textUpdate('hello', 32), SECRET_TOKEN)
    ;(handshake.payload as { kind: string }).kind = 'handshake'

    const results = await relay.deliver(CONSUMER, [forged, unsigned, handshake])

    expect([...results.values()]).toEqual(['discard', 'discard', 'discard'])
    expect(inputs).toEqual([])
    warn.mockRestore()
    await instance.disconnect()
  })

  it('answers relayed button taps, even when Telegram refuses to answer a stale one', async () => {
    const instance = await connected()
    const { messageId, buttons } = await sendCard(instance)
    telegram.failures.set('answerCallbackQuery', { error_code: 400, description: 'Bad Request: query is too old and response timeout expired or query ID is invalid' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const results = await deliver(tapUpdate(buttons[1], messageId))

    expect([...results.values()]).toEqual(['accepted'])
    expect(methods()).toContain('answerCallbackQuery')
    expect(responses).toMatchObject([{ type: 'response', requestId: 'toolu_1', externalId: '42', value: { 'Pick one?': 'B' } }])
    // A second tap on the answered card does nothing.
    await deliver(tapUpdate(buttons[0], messageId))
    expect(responses).toHaveLength(1)
    warn.mockRestore()
    await instance.disconnect()
  })

  it('keeps open cards across a reconnect, so a tap that arrives after it still answers', async () => {
    const first = await connected()
    const { messageId, buttons } = await sendCard(first, 'toolu_2')
    await first.disconnect()

    const second = await connected()
    await deliver(tapUpdate(buttons[0], messageId))

    expect(responses).toMatchObject([{ requestId: 'toolu_2', value: { 'Pick one?': 'A' } }])
    await second.disconnect()
  })

  it('acts once on an update the relay offers again, unless it was left for a retry', async () => {
    const instance = await connected()
    const kept = textUpdate('kept', 50)
    const retried = textUpdate('retried', 51)
    inputResult = event => event.type === 'input' && (event.payload as IncomingMessage).text === 'retried' ? 'retry' : 'accepted'
    await deliver(kept, retried)

    inputResult = () => 'accepted'
    expect([...(await deliver(kept, retried)).values()]).toEqual(['duplicate', 'accepted'])
    expect(inputs.map(input => input.text)).toEqual(['kept', 'retried', 'retried'])

    // A multi-select toggle offered twice stays checked.
    await instance.sendUserRequestCard(String(CHAT), { type: 'question_request', toolUseId: 'toolu_3', questions: [{ question: 'Which?', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }] } as never)
    const keyboard = telegram.calls.filter(call => call.method === 'sendRichMessage').at(-1)!.payload.reply_markup.inline_keyboard as Array<Array<{ callback_data: string }>>
    const toggle = tapUpdate(keyboard[0][0].callback_data, telegram.nextMessageId)
    await deliver(toggle)
    await deliver(toggle)
    const redraws = telegram.calls.filter(call => call.method === 'editMessageReplyMarkup')
    expect(redraws).toHaveLength(1)
    expect(redraws[0].payload.reply_markup.inline_keyboard[0][0].text).toBe('✅ A')
    await instance.disconnect()

    // Offered again to the next connection, which keeps the card.
    const next = await connected()
    expect([...(await deliver(toggle)).values()]).toEqual(['duplicate'])
    expect(telegram.calls.filter(call => call.method === 'editMessageReplyMarkup')).toHaveLength(1)
    await next.disconnect()
  })

  it('sets no webhook once disconnected mid-setup, and the disconnect waits for setup to finish', async () => {
    let openGetMe!: () => void
    telegram.gates.set('getMe', new Promise(resolve => { openGetMe = resolve }))
    const instance = connector()
    const connecting = instance.connect()
    await vi.waitFor(() => expect(methods()).toContain('getMe'))

    let disconnected = false
    const disconnecting = instance.disconnect().then(() => { disconnected = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(disconnected).toBe(false)

    openGetMe()
    await disconnecting
    await connecting
    expect(methods()).not.toContain('setWebhook')
    expect(relay.consumers.get(CONSUMER)).toBeUndefined()

    // A setWebhook already sent lands before the disconnect returns.
    let openSetWebhook!: () => void
    telegram.gates.set('setWebhook', new Promise(resolve => { openSetWebhook = resolve }))
    const second = connector()
    const connectingSecond = second.connect()
    await vi.waitFor(() => expect(methods()).toContain('setWebhook'))
    disconnected = false
    const disconnectingSecond = second.disconnect().then(() => { disconnected = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(disconnected).toBe(false)
    openSetWebhook()
    await disconnectingSecond
    await connectingSecond
    expect(second.activeTransport()).toBeNull()
  })

  it('makes the next connection wait out a setWebhook its predecessor left in flight', async () => {
    let openSetWebhook!: () => void
    telegram.gates.set('setWebhook', new Promise(resolve => { openSetWebhook = resolve }))
    const old = connector()
    const connectingOld = old.connect()
    await vi.waitFor(() => expect(methods()).toContain('setWebhook'))
    // The manager stops waiting for a teardown after a few seconds and connects the replacement.
    const disconnectingOld = old.disconnect()
    const next = connector(null)
    const connectingNext = next.connect()

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(methods()).not.toContain('deleteWebhook')

    openSetWebhook()
    await Promise.all([connectingOld, disconnectingOld, connectingNext])
    expect(methods().indexOf('deleteWebhook')).toBeGreaterThan(methods().indexOf('setWebhook'))
    expect(next.activeTransport()).toBe('direct')
    await next.disconnect()
  })

  it('gives every button its own random callback id, within Telegram’s 64 bytes', async () => {
    const instance = await connected()
    const first = await sendCard(instance, 'toolu_4')
    const second = await sendCard(instance, 'toolu_5')
    const ids = [...first.buttons, ...second.buttons]
    expect(new Set(ids).size).toBe(4)
    for (const id of ids) expect(id).toMatch(/^cb_[A-Za-z0-9_-]{16}$/)
    await instance.disconnect()
  })

  it('keeps the bot token out of what it logs and reports when Telegram can’t be reached', async () => {
    const { HttpError } = await import('grammy')
    telegram.failures.set('getMe', new HttpError("Network request for 'getMe' failed!", new Error(`request to https://api.telegram.org/bot${BOT_TOKEN}/getMe failed, reason: getaddrinfo ENOTFOUND`)) as never)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const instance = await connected()

    expect(instance.activeTransport()).toBe('direct')
    expect(vi.mocked(captureException)).toHaveBeenCalled()
    expect(inspect([error.mock.calls, vi.mocked(captureException).mock.calls], { depth: 10 })).not.toContain(BOT_TOKEN)
    error.mockRestore()
    await instance.disconnect()
  })

  it('leaves updates claimed after a disconnect to the next connection', async () => {
    const instance = await connected()
    await instance.disconnect()

    expect([...(await deliver(textUpdate('late', 40))).values()]).toEqual(['retry'])
    expect(inputs).toEqual([])
  })
})

describe('TelegramConnector long polling', () => {
  it('polls without a relay, deleting any webhook first', async () => {
    const instance = await connected(null)

    expect(ensureTelegramWebhook).not.toHaveBeenCalled()
    expect(methods()).not.toContain('setWebhook')
    expect(methods().indexOf('deleteWebhook')).toBeLessThan(methods().indexOf('getUpdates'))
    expect(telegram.calls.find(call => call.method === 'deleteWebhook')?.payload).toEqual({ drop_pending_updates: false })
    expect(instance.activeTransport()).toBe('direct')
    await instance.disconnect()
  })

  it('polls when Telegram refuses the webhook, and reports it', async () => {
    telegram.failures.set('setWebhook', { error_code: 400, description: 'Bad Request: bad webhook: HTTPS url must be provided for webhook' })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const instance = await connected()

    expect(methods()).toContain('getUpdates')
    expect(instance.activeTransport()).toBe('direct')
    expect(captureException).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tags: expect.objectContaining({ operation: 'telegram-webhooks' }) }))

    // An earlier connection's webhook left updates on the relay; they're drained
    // alongside the poll, each on its own, not batched with the first poll.
    expect(relay.consumers.get(CONSUMER)?.endpointIds).toEqual(['whep_1'])
    expect([...(await deliver(textUpdate('held', 60), textUpdate('also held', 61))).values()]).toEqual(['accepted', 'accepted'])
    expect(inputs.map(input => input.text)).toEqual(['held', 'also held'])
    error.mockRestore()
    await instance.disconnect()
  })

  it('polls when creating the endpoint takes too long', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.mocked(ensureTelegramWebhook).mockReturnValue(new Promise(() => {}))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const instance = connector()
    const connecting = instance.connect()
    await vi.advanceTimersByTimeAsync(10_000)
    vi.useRealTimers()
    await connecting

    expect(methods()).not.toContain('setWebhook')
    expect(methods()).toContain('deleteWebhook')
    expect(captureException).toHaveBeenCalledWith(expect.objectContaining({ message: 'Creating the webhook endpoint timed out' }), expect.anything())
    error.mockRestore()
    await instance.disconnect()
  })

  it('polls, without reporting, when the relay has no endpoint to give', async () => {
    vi.mocked(ensureTelegramWebhook).mockRejectedValue(new IntegrationSetupError('This workspace has reached its limit of active webhook endpoints.'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const instance = await connected()

    expect(methods()).not.toContain('setWebhook')
    expect(instance.activeTransport()).toBe('direct')
    expect(captureException).not.toHaveBeenCalled()
    warn.mockRestore()
    await instance.disconnect()
  })
})
