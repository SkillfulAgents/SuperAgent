import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SlackConnector, type SlackConfig } from './slack-connector'
import { AgentIntegrationRegistry } from '../agent-integrations/registry'
import type { AgentIntegration } from '../agent-integrations/agent-integration'
import type { AgentIntegrationRecord } from '../agent-integrations/types'
import { chatProviders } from './providers'
import * as threadState from './slack-thread-state'

type SlackMessage = { text: string; ts: string; thread_ts?: string; channel?: string }
type MessageListener = (event: { message: Record<string, string>; say: unknown }) => Promise<void>

const slack = vi.hoisted(() => ({
  listeners: [] as MessageListener[],
  onStart: undefined as (() => Promise<void>) | undefined,
  replies: vi.fn(async () => ({ ok: true, messages: [] })),
  postMessage: vi.fn(async (_message: unknown) => ({ ok: true, ts: '2000.001' })),
}))

vi.mock('@slack/bolt', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    SocketModeReceiver: class {
      client = new EventEmitter()
    },
    App: class {
      client = {
        auth: { test: async () => ({ ok: true, user_id: 'U_BOT' }) },
        users: { info: async () => ({ user: { real_name: 'Tester' } }) },
        conversations: { info: async () => ({ channel: { name: 'test' } }), replies: slack.replies },
        chat: { postMessage: slack.postMessage },
      }
      event() {}
      action() {}
      message(listener: MessageListener) { slack.listeners.push(listener) }
      async init() {}
      async start() { await slack.onStart?.() }
      async stop() {}
    },
  }
})

vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))

// Copy on load/save: a fresh connector cannot inherit the old one's Set by
// reference. The SQLite store has separate tests that close/reopen the DB.
function memoryStore() {
  let saved: string[] = []
  return {
    load: vi.fn((_botUserId: string) => [...saved]),
    save: vi.fn((_botUserId: string, threads: readonly string[]) => { saved = [...threads] }),
  }
}

const connectors: AgentIntegration[] = []
async function connect(config: Partial<SlackConfig>, store: ReturnType<typeof memoryStore>) {
  return observe(new SlackConnector({
    botToken: 'xoxb-test', appToken: 'xapp-test', onlyMentioned: true, ...config,
  }, undefined, store))
}

async function observe<T extends AgentIntegration>(connector: T) {
  connectors.push(connector)
  const received = vi.fn()
  connector.onEvent(event => { if (event.type === 'input') received(event.payload) })
  await connector.connect()
  const listener = slack.listeners.at(-1)!
  return {
    connector,
    received,
    async receive(message: SlackMessage) {
      await listener({ message: { channel: 'C123', channel_type: 'channel', user: 'U_PERSON', ...message }, say: undefined })
    },
  }
}

beforeEach(() => {
  slack.listeners.length = 0
  slack.onStart = undefined
  vi.clearAllMocks()
})
afterEach(async () => {
  await Promise.all(connectors.splice(0).map(connector => connector.disconnect()))
})

describe('Slack thread participation across connector recreation (SUP-861)', () => {
  it('restores installation-scoped state through the application provider registry', async () => {
    const stores = { first: memoryStore(), other: memoryStore() }
    const factory = vi.spyOn(threadState, 'createSlackThreadStateStore').mockImplementation(id => stores[id as keyof typeof stores])
    const registry = new AgentIntegrationRegistry(chatProviders)
    const record: AgentIntegrationRecord = {
      id: 'first', agentSlug: 'test-agent', provider: 'slack', name: null, status: 'active',
      config: JSON.stringify({ botToken: 'xoxb-test', appToken: 'xapp-test', onlyMentioned: true, answerInThread: true }),
      errorMessage: null, createdByUserId: null, model: null, effort: null, speed: null,
      createdAt: new Date(), updatedAt: new Date(),
    }
    try {
      const first = await observe(await registry.create(record))
      await first.receive({ text: '<@U_BOT> start a thread', ts: '1000.001' })
      await first.connector.disconnect()

      const restored = await observe(await registry.create(record))
      await restored.receive({ text: 'after registry recreation', ts: '1000.002', thread_ts: '1000.001' })
      expect(restored.received).toHaveBeenCalledWith(expect.objectContaining({ text: 'after registry recreation' }))

      const other = await observe(await registry.create({ ...record, id: 'other' }))
      await other.receive({ text: 'different installation', ts: '1000.003', thread_ts: '1000.001' })
      expect(other.received).not.toHaveBeenCalled()
    } finally {
      factory.mockRestore()
    }
  })

  it('restores participation before Socket Mode delivers its first event', async () => {
    const store = memoryStore()
    store.save('U_BOT', ['C123|1000.001'])
    slack.onStart = async () => slack.listeners.at(-1)!({ message: {
      channel: 'C123', channel_type: 'channel', user: 'U_PERSON',
      text: 'first event during startup', ts: '1000.002', thread_ts: '1000.001',
    }, say: undefined })
    const first = await connect({ answerInThread: true }, store)
    expect(first.received).toHaveBeenCalledWith(expect.objectContaining({ text: 'first event during startup' }))
  })

  it.each([
    { answerInThread: true, newSessionPerThread: true, expectedChatId: 'C123|1000.001' },
    { answerInThread: true, newSessionPerThread: false, expectedChatId: 'C123' },
    { answerInThread: false, newSessionPerThread: false, expectedChatId: 'C123|1000.001' },
  ])('continues a joined thread after restart: %j', async ({ expectedChatId, ...config }) => {
    const store = memoryStore()
    const first = await connect(config, store)
    await first.receive({ text: '<@U_BOT> remember CEDAR', ts: '1000.002', thread_ts: '1000.001' })
    expect(first.received).toHaveBeenCalledOnce()
    await first.connector.disconnect()

    const restarted = await connect(config, store)
    slack.replies.mockClear()
    await restarted.receive({ text: 'what is the code?', ts: '1000.003', thread_ts: '1000.001' })
    expect(restarted.received).toHaveBeenCalledWith(expect.objectContaining({
      chatId: expectedChatId, text: 'what is the code?',
    }))
    expect(slack.replies).not.toHaveBeenCalled() // retained session already has history
    await restarted.connector.sendMessage(expectedChatId, { text: 'CEDAR' })
    expect(slack.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C123', thread_ts: '1000.001' }))

    restarted.received.mockClear()
    await restarted.receive({ text: 'unjoined thread', ts: '3000.002', thread_ts: '3000.001' })
    await restarted.receive({ text: 'different channel', ts: '1000.004', thread_ts: '1000.001', channel: 'C456' })
    await restarted.receive({ text: 'channel chatter', ts: '4000.001' })
    expect(restarted.received).not.toHaveBeenCalled()

    const otherIntegration = await connect(config, memoryStore())
    await otherIntegration.receive({ text: 'same thread, different integration', ts: '1000.005', thread_ts: '1000.001' })
    expect(otherIntegration.received).not.toHaveBeenCalled()
  })

  it('persists a newly started thread before shutdown, including shared-session mode', async () => {
    const store = memoryStore()
    const config = { answerInThread: true, newSessionPerThread: false }
    const first = await connect(config, store)
    await first.receive({ text: '<@U_BOT> start thread A', ts: '1000.001' })
    await first.receive({ text: '<@U_BOT> start thread B', ts: '2000.001' })

    // No disconnect/flush: model a process exit and a brand-new connector.
    const restarted = await connect(config, store)
    await restarted.receive({ text: 'continue A', ts: '1000.002', thread_ts: '1000.001' })
    await restarted.receive({ text: 'continue B', ts: '2000.002', thread_ts: '2000.001' })
    expect(restarted.received).toHaveBeenCalledTimes(2)
  })

  it('restores participation when the same connector disconnects and connects again', async () => {
    const first = await connect({ answerInThread: true }, memoryStore())
    await first.receive({ text: '<@U_BOT> start a thread', ts: '1000.001' })
    await first.connector.disconnect()
    await first.connector.connect()
    first.received.mockClear()
    await slack.listeners.at(-1)!({ message: {
      channel: 'C123', channel_type: 'group', user: 'U_PERSON',
      text: 'follow-up after reconnect', ts: '1000.002', thread_ts: '1000.001',
    }, say: undefined })
    expect(first.received).toHaveBeenCalledOnce()
  })

  it('ignores late events from a disconnected connector without overwriting saved participation', async () => {
    const store = memoryStore()
    const first = await connect({ answerInThread: true }, store)
    await first.receive({ text: '<@U_BOT> start a thread', ts: '1000.001' })
    await first.connector.disconnect()
    store.save.mockClear()
    first.received.mockClear()
    await first.receive({ text: '<@U_BOT> late event', ts: '2000.001' })
    expect(first.received).not.toHaveBeenCalled()
    expect(store.save).not.toHaveBeenCalled()
    expect(store.load('U_BOT')).toEqual(['C123|1000.001'])
  })

  it('keeps delivering if a state write fails, and retries persistence on the next message', async () => {
    const store = memoryStore()
    const first = await connect({ answerInThread: true }, store)
    store.save.mockImplementationOnce(() => { throw new Error('disk full') })
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await first.receive({ text: '<@U_BOT> start a thread', ts: '1000.001' })
      await first.receive({ text: 'follow-up', ts: '1000.002', thread_ts: '1000.001' })
      expect(first.received).toHaveBeenCalledTimes(2)
      expect(store.load('U_BOT')).toEqual(['C123|1000.001'])
    } finally {
      errorLog.mockRestore()
    }
  })
})
