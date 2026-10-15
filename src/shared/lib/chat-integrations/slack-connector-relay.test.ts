import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebClient } from '@slack/web-api'
import { SocketModeClient } from '@slack/socket-mode'

vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn(), addErrorBreadcrumb: vi.fn() }))
vi.mock('./slack-webhooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./slack-webhooks')>()),
  recordSlackWebhookStatus: vi.fn(async () => true),
}))

import { SlackConnector, decodeSlackAnswer, encodeSlackAnswer, forgetSlackInstallation, type SlackConfig } from './slack-connector'
import { recordSlackWebhookStatus } from './slack-webhooks'
import { IntegrationRelays } from '../agent-integrations/relay-transport'
import type { IntegrationRelayHost } from '../agent-integrations/transport'
import { createFakeWebhookRelay, type FakeWebhookRelay } from '../webhook-relay/testing/fake-webhook-relay'
import type { IntegrationEvent, IntegrationInputResult, IntegrationResponseEvent } from '../agent-integrations/types'
import type { IncomingMessage } from './chat-agent-integration'
import { relayedSlackPost } from './test-helpers'

/**
 * The real Bolt App, with every Web API call answered here instead of by
 * Slack, and Socket Mode's socket only pretending to open.
 */
const slack = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; options: Record<string, any> }>,
  sockets: { started: 0, closed: 0, failStart: false },
}))

const SECRET = 'signing-secret'
const relayBinding = { endpointId: 'whep_1', url: 'https://relay.test/v1/hooks/whep_1', scope: 'sub_owner' }
const integration = { id: 'int-1' }
const CONSUMER = 'integration:int-1'

let relay: FakeWebhookRelay
let relays: IntegrationRelays
let inputs: IncomingMessage[]
let responses: IntegrationResponseEvent[]
let inputResult: (event: IntegrationEvent) => IntegrationInputResult | Promise<IntegrationInputResult>
let nextTs: number

beforeEach(() => {
  slack.calls.length = 0
  Object.assign(slack.sockets, { started: 0, closed: 0, failStart: false })
  vi.spyOn(WebClient.prototype, 'apiCall').mockImplementation(async function (method: string, options?: Record<string, unknown>) {
    slack.calls.push({ method, options: options ?? {} })
    switch (method) {
      case 'auth.test': return { ok: true, user_id: 'U_BOT', bot_id: 'B_BOT', user: 'helper', team: 'Acme', url: 'https://acme.slack.com/' }
      case 'users.info': return { ok: true, user: { id: options?.user, real_name: 'Alice' } }
      case 'conversations.info': return { ok: true, channel: { id: options?.channel, is_im: true } }
      case 'chat.postMessage': return { ok: true, ts: `${++nextTs}.000100` }
      default: return { ok: true }
    }
  } as never)
  vi.spyOn(SocketModeClient.prototype, 'start').mockImplementation(async function (this: SocketModeClient) {
    if (slack.sockets.failStart) throw new Error('socket mode is off for this app')
    slack.sockets.started++
    this.emit('connected')
    return {} as never
  })
  vi.spyOn(SocketModeClient.prototype, 'disconnect').mockImplementation(async function (this: SocketModeClient) {
    slack.sockets.closed++
    this.emit('disconnected')
  })
  vi.mocked(recordSlackWebhookStatus).mockClear()
  forgetSlackInstallation('int-1')
  relay = createFakeWebhookRelay()
  relays = new IntegrationRelays(() => relay)
  inputs = []
  responses = []
  inputResult = () => 'accepted'
  nextTs = 1_760_000_100
})
afterEach(() => { vi.restoreAllMocks() })

const webhookConfig = (extra: Partial<SlackConfig> = {}): SlackConfig => ({ botToken: 'xoxb-1', signingSecret: SECRET, relay: relayBinding, webhookStatus: 'verified', ...extra })

function connector(config: SlackConfig, relayHost: IntegrationRelayHost | null | undefined = undefined) {
  const instance = new SlackConnector(config, undefined, undefined, integration)
  instance.bindHost({ session: async () => undefined, relay: relayHost === undefined ? relays.hostFor('int-1') : relayHost })
  instance.onEvent(event => {
    if (event.type === 'response') responses.push(event)
    if (event.type !== 'input') return
    inputs.push(event.payload as IncomingMessage)
    return inputResult(event)
  })
  return instance
}

async function connected(config: SlackConfig, relayHost?: IntegrationRelayHost | null) {
  const instance = connector(config, relayHost)
  await instance.connect()
  return instance
}

let eventId = 0
function messageEvent(text: string, ts = `${++nextTs}.000200`) {
  return {
    type: 'event_callback', team_id: 'T1', api_app_id: 'A1', event_id: `Ev${++eventId}`, event_time: 1_760_000_000,
    authorizations: [{ team_id: 'T1', user_id: 'U_BOT', is_bot: true }],
    event: { type: 'message', channel: 'D1', channel_type: 'im', user: 'U_ALICE', text, ts },
  }
}
function clickBody(value: string, triggerId = `tr_${++eventId}`) {
  return {
    type: 'block_actions', trigger_id: triggerId, team: { id: 'T1' }, user: { id: 'U_ALICE' }, api_app_id: 'A1',
    channel: { id: 'D1' }, container: { type: 'message', message_ts: '1.1', channel_id: 'D1' },
    message: { ts: '1.1', text: 'Pick one', blocks: [{ type: 'section' }, { type: 'actions' }] },
    actions: [{ type: 'button', action_id: 'answer_0', block_id: 'b', value, action_ts: '2.2' }],
  }
}
const deliver = (...posts: Parameters<typeof relayedSlackPost>[]) => relay.deliver(CONSUMER, posts.map(args => relayedSlackPost(...args)))

describe('SlackConnector through the webhook', () => {
  it('opens no socket once posts have verified, and hands relayed messages to the same handler', async () => {
    const instance = await connected(webhookConfig())
    expect(slack.sockets.started).toBe(0)
    expect(instance.isConnected()).toBe(true)
    expect(instance.activeTransport()).toBe('relay')

    const event = messageEvent('hello from Slack')
    const results = await deliver([event, SECRET])
    expect(results.get(`whe_${event.event_id}`)).toBe('accepted')
    expect(inputs).toEqual([expect.objectContaining({ externalMessageId: event.event.ts, chatId: 'D1', text: 'hello from Slack', userName: 'Alice' })])
    await instance.disconnect()
  })

  it('reports what the host did with each message, and acts once on a post the relay offers again', async () => {
    const instance = await connected(webhookConfig())
    const first = messageEvent('one')
    inputResult = () => 'retry'
    expect((await deliver([first, SECRET])).get(`whe_${first.event_id}`)).toBe('retry')
    inputResult = () => 'rejected'
    expect((await deliver([first, SECRET])).get(`whe_${first.event_id}`)).toBe('discard')
    // Slack's retry of the same event, stored as another post.
    expect((await deliver([first, SECRET, { id: 'whe_retry' }])).get('whe_retry')).toBe('duplicate')
    expect(inputs).toHaveLength(2)
    await instance.disconnect()
  })

  it('ignores the bot’s own messages, as Socket Mode does', async () => {
    const instance = await connected(webhookConfig())
    const own = messageEvent('my own reply')
    own.event.user = 'U_BOT'
    expect((await deliver([own, SECRET])).get(`whe_${own.event_id}`)).toBe('accepted')
    expect(inputs).toEqual([])
    await instance.disconnect()
  })

  it('discards posts that are not Slack’s, without acting on them', async () => {
    const instance = await connected(webhookConfig())
    const forged = messageEvent('transfer the funds')
    expect((await deliver([forged, 'not-the-secret'])).get(`whe_${forged.event_id}`)).toBe('discard')
    expect(inputs).toEqual([])
    // Posts have verified before: a mismatch is not the app's, so nothing is recorded.
    expect(recordSlackWebhookStatus).not.toHaveBeenCalled()
    await instance.disconnect()
  })

  it('answers a button click from its value, on any connection of the installation', async () => {
    const first = await connected(webhookConfig())
    const value = encodeSlackAnswer({ t: 'tool_1', c: 'D1|1.0', q: 'Deploy?', a: 'Yes', n: 1 })
    await first.disconnect()
    const second = await connected(webhookConfig())
    const body = clickBody(value)
    expect((await deliver([body, SECRET, { form: true }])).get(`whe_${body.trigger_id}`)).toBe('accepted')
    await vi.waitFor(() => expect(responses).toHaveLength(1))
    expect(responses[0]).toMatchObject({ requestId: 'tool_1', externalId: 'D1|1.0', value: { 'Deploy?': 'Yes' } })
    expect(slack.calls.find(call => call.method === 'chat.update')?.options).toMatchObject({ channel: 'D1', ts: '1.1', blocks: [{ type: 'section' }] })

    // The same click redelivered acts once.
    expect((await deliver([body, SECRET, { form: true, id: 'whe_again' }])).get('whe_again')).toBe('duplicate')
    expect(responses).toHaveLength(1)
    await second.disconnect()
  })

  it('collects a multi-question request’s answers across connections, answering once all are in', async () => {
    const first = await connected(webhookConfig())
    await deliver([clickBody(encodeSlackAnswer({ t: 'tool_2', c: 'D1', q: 'Region?', a: 'EU', n: 2 })), SECRET, { form: true }])
    await first.disconnect()
    expect(responses).toEqual([])
    const second = await connected(webhookConfig())
    await deliver([clickBody(encodeSlackAnswer({ t: 'tool_2', c: 'D1', q: 'Size?', a: 'Large', n: 2 })), SECRET, { form: true }])
    await vi.waitFor(() => expect(responses).toHaveLength(1))
    expect(responses[0]).toMatchObject({ requestId: 'tool_2', value: { 'Region?': 'EU', 'Size?': 'Large' } })
    await second.disconnect()
  })

  it('leaves posts for a replaced connection to its successor', async () => {
    const instance = await connected(webhookConfig())
    const attached = relay.consumers.get(CONSUMER)!
    await instance.disconnect()
    const event = messageEvent('while reconnecting')
    const result = await attached.accept([relayedSlackPost(event, SECRET)])
    expect(result).toBe('retry')
    expect(inputs).toEqual([])
  })

  it('without a relay, connects for sending only and reports itself disconnected so it is rebuilt', async () => {
    const instance = await connected(webhookConfig({ appToken: 'xapp-1' }), null)
    expect(slack.sockets.started).toBe(0)
    expect(instance.isConnected()).toBe(false)
    expect(instance.activeTransport()).toBeNull()
    await instance.disconnect()
  })

  it('needs a bot token, and a way to receive', async () => {
    await expect(connector({ signingSecret: SECRET, relay: relayBinding }).connect()).rejects.toThrow(/bot token/)
    await expect(connector({ botToken: 'xoxb-1' }).connect()).rejects.toThrow(/app-level token/)
  })
})

describe('SlackConnector moving from Socket Mode to the webhook', () => {
  const pending = (extra: Partial<SlackConfig> = {}) => webhookConfig({ appToken: 'xapp-1', webhookStatus: undefined, ...extra })

  it('keeps Socket Mode until a post to the webhook verifies, then closes it', async () => {
    const instance = await connected(pending())
    expect(slack.sockets.started).toBe(1)
    expect(instance.activeTransport()).toBe('direct')
    expect(relay.consumers.get(CONSUMER)?.endpointIds).toEqual(['whep_1'])

    // Slack checking the request URL as the app's owner saves it.
    const check = { type: 'url_verification', token: 't', challenge: 'c1' }
    expect((await deliver([check, SECRET, { handshake: true, id: 'whe_check' }])).get('whe_check')).toBe('discard')
    expect(recordSlackWebhookStatus).toHaveBeenCalledWith('int-1', 'verified', { signingSecret: SECRET, endpointId: 'whep_1' })
    expect(slack.sockets.closed).toBe(1)
    expect(instance.activeTransport()).toBe('relay')
    expect(instance.isConnected()).toBe(true)

    // The retired socket doesn't come back.
    await new Promise(resolve => setTimeout(resolve, 1100))
    expect(slack.sockets.started).toBe(1)
    await instance.disconnect()
  })

  it('records a URL check signed with another secret, and keeps Socket Mode', async () => {
    const instance = await connected(pending())
    await deliver([{ type: 'url_verification', challenge: 'c2' }, 'another-apps-secret', { handshake: true }])
    expect(recordSlackWebhookStatus).toHaveBeenCalledWith('int-1', 'rejected', { signingSecret: SECRET, endpointId: 'whep_1' })
    expect(slack.sockets.closed).toBe(0)
    expect(instance.activeTransport()).toBe('direct')

    // A post the endpoint accepted was signed before the secret changed: not the saved secret's fault.
    vi.mocked(recordSlackWebhookStatus).mockClear()
    const second = await connected(pending())
    await deliver([messageEvent('old'), 'old-secret', { edgeVerified: true }])
    expect(recordSlackWebhookStatus).not.toHaveBeenCalled()
    await instance.disconnect()
    await second.disconnect()
  })

  it('receives through the webhook alone if the socket can’t open', async () => {
    slack.sockets.failStart = true
    const instance = await connected(pending())
    expect(instance.activeTransport()).toBe('relay')
    await deliver([messageEvent('via webhook'), SECRET])
    expect(inputs).toHaveLength(1)
    await instance.disconnect()
  })

  it('still fails a Socket Mode connect that has no webhook to fall back on', async () => {
    slack.sockets.failStart = true
    await expect(connector({ botToken: 'xoxb-1', appToken: 'xapp-1' }).connect()).rejects.toThrow(/Socket Mode failed to start/)
  })
})

describe('answer buttons', () => {
  it('round-trips, and fits Slack’s 2000-character limit by shortening the question', () => {
    const answer = { t: 'tool_1', c: 'C1|1.2', q: 'Ship it?', a: 'Yes', n: 1 }
    expect(decodeSlackAnswer(encodeSlackAnswer(answer))).toEqual(answer)

    const long = { ...answer, q: `${'Why "this"? '.repeat(400)}end` }
    const value = encodeSlackAnswer(long)
    expect(value.length).toBeLessThanOrEqual(2000)
    expect(decodeSlackAnswer(value)).toMatchObject({ t: 'tool_1', a: 'Yes', q: expect.stringMatching(/^Why "this"\?.*…$/) })
  })

  it('ignores values that are not answers', () => {
    expect(decodeSlackAnswer('cb_1')).toBeNull()
    expect(decodeSlackAnswer(JSON.stringify({ t: 'x' }))).toBeNull()
    expect(decodeSlackAnswer(undefined)).toBeNull()
  })
})
