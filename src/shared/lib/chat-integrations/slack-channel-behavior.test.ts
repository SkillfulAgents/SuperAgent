import { describe, it, expect } from 'vitest'
import { routeSlackMessage, resolveSlackChannel, type SlackMessageRoutingParams } from './slack-connector'

// ── Helpers ────────────────────────────────────────────────────────────

function makeParams(overrides: Partial<SlackMessageRoutingParams> = {}): SlackMessageRoutingParams {
  return {
    rawText: 'hello world',
    chatId: 'C123',
    ts: '1000.001',
    channelType: 'channel',
    botUserId: 'U_BOT',
    config: {},
    activeThreads: new Set(),
    ...overrides,
  }
}

// ── routeSlackMessage ──────────────────────────────────────────────────

describe('routeSlackMessage', () => {
  // ── Mention filtering ─────────────────────────────────────────────

  describe('onlyMentioned filtering', () => {
    it('processes all channel messages when onlyMentioned is off', () => {
      const result = routeSlackMessage(makeParams({
        config: { onlyMentioned: false },
      }))
      expect(result.shouldProcess).toBe(true)
    })

    it('filters out channel messages without bot mention', () => {
      const result = routeSlackMessage(makeParams({
        rawText: 'hello everyone',
        config: { onlyMentioned: true },
      }))
      expect(result.shouldProcess).toBe(false)
    })

    it('processes channel messages that mention the bot', () => {
      const result = routeSlackMessage(makeParams({
        rawText: 'hey <@U_BOT> help me',
        config: { onlyMentioned: true },
      }))
      expect(result.shouldProcess).toBe(true)
    })

    it('never filters DMs regardless of onlyMentioned', () => {
      const result = routeSlackMessage(makeParams({
        rawText: 'hello',
        channelType: 'im',
        config: { onlyMentioned: true },
      }))
      expect(result.shouldProcess).toBe(true)
    })

    it('never filters group DMs regardless of onlyMentioned', () => {
      const result = routeSlackMessage(makeParams({
        rawText: 'hello',
        channelType: 'mpim',
        config: { onlyMentioned: true },
      }))
      expect(result.shouldProcess).toBe(true)
    })

    it('filters private channel messages without mention', () => {
      const result = routeSlackMessage(makeParams({
        rawText: 'hello',
        channelType: 'group',
        config: { onlyMentioned: true },
      }))
      expect(result.shouldProcess).toBe(false)
    })

    it('processes private channel messages with mention', () => {
      const result = routeSlackMessage(makeParams({
        rawText: '<@U_BOT> do something',
        channelType: 'group',
        config: { onlyMentioned: true },
      }))
      expect(result.shouldProcess).toBe(true)
    })
  })

  // ── Thread continuity ─────────────────────────────────────────────

  describe('thread continuity (replies in active threads)', () => {
    it('allows thread replies without mention when thread is active', () => {
      const activeThreads = new Set(['C123|1000.001'])

      const result = routeSlackMessage(makeParams({
        rawText: 'follow-up question',
        threadTs: '1000.001',
        config: { onlyMentioned: true },
        activeThreads,
      }))
      expect(result.shouldProcess).toBe(true)
    })

    it('filters thread replies in unknown threads without mention', () => {
      const result = routeSlackMessage(makeParams({
        rawText: 'random thread reply',
        threadTs: '9999.999',
        config: { onlyMentioned: true },
        activeThreads: new Set(),
      }))
      expect(result.shouldProcess).toBe(false)
    })

    it('processes thread replies with mention even in unknown threads', () => {
      const result = routeSlackMessage(makeParams({
        rawText: '<@U_BOT> new question in thread',
        threadTs: '9999.999',
        config: { onlyMentioned: true },
        activeThreads: new Set(),
      }))
      expect(result.shouldProcess).toBe(true)
    })

    it('returns threadKey so caller can track active threads', () => {
      const result = routeSlackMessage(makeParams({
        rawText: '<@U_BOT> start something',
        ts: '2000.001',
        config: { onlyMentioned: true, answerInThread: true },
      }))
      expect(result.shouldProcess).toBe(true)
      expect(result.threadKey).toBe('C123|2000.001')
    })

    it('end-to-end: mention creates thread, follow-up passes filter', () => {
      const activeThreads = new Set<string>()

      // Step 1: bot is mentioned in a channel message
      const mention = routeSlackMessage(makeParams({
        rawText: '<@U_BOT> help me',
        ts: '2000.001',
        config: { onlyMentioned: true, answerInThread: true },
        activeThreads,
      }))
      expect(mention.shouldProcess).toBe(true)
      expect(mention.threadKey).toBe('C123|2000.001')

      // Simulate the connector adding the thread key
      activeThreads.add(mention.threadKey!)

      // Step 2: user replies in that thread without mentioning the bot
      const reply = routeSlackMessage(makeParams({
        rawText: 'thanks, one more thing',
        ts: '2000.002',
        threadTs: '2000.001',
        config: { onlyMentioned: true, answerInThread: true },
        activeThreads,
      }))
      expect(reply.shouldProcess).toBe(true)

      // Step 3: unrelated message in the channel is still filtered
      const unrelated = routeSlackMessage(makeParams({
        rawText: 'hey team lunch?',
        ts: '2000.003',
        config: { onlyMentioned: true, answerInThread: true },
        activeThreads,
      }))
      expect(unrelated.shouldProcess).toBe(false)
    })
  })

  // ── answerInThread / effective chatId ──────────────────────────────

  describe('answerInThread routing', () => {
    it('returns thread context for channel messages', () => {
      const result = routeSlackMessage(makeParams({
        ts: '1000.001',
        config: { answerInThread: true },
      }))
      expect(result.shouldProcess).toBe(true)
      expect(result.threadContext).toEqual({ channel: 'C123', threadTs: '1000.001' })
    })

    it('uses thread_ts as anchor for thread replies', () => {
      const result = routeSlackMessage(makeParams({
        ts: '2000.002',
        threadTs: '1000.001',
        config: { answerInThread: true },
      }))
      expect(result.threadContext).toEqual({ channel: 'C123', threadTs: '1000.001' })
    })

    it('does not set thread context for DMs', () => {
      const result = routeSlackMessage(makeParams({
        channelType: 'im',
        config: { answerInThread: true },
      }))
      expect(result.threadContext).toBeUndefined()
    })

    it('keeps effectiveChatId as channel when newSessionPerThread is off', () => {
      const result = routeSlackMessage(makeParams({
        ts: '1000.001',
        config: { answerInThread: true, newSessionPerThread: false },
      }))
      expect(result.effectiveChatId).toBe('C123')
    })
  })

  // ── newSessionPerThread ───────────────────────────────────────────

  describe('newSessionPerThread', () => {
    it('creates composite chatId for top-level messages', () => {
      const result = routeSlackMessage(makeParams({
        ts: '1000.001',
        config: { answerInThread: true, newSessionPerThread: true },
      }))
      expect(result.effectiveChatId).toBe('C123|1000.001')
    })

    it('creates composite chatId using thread_ts for replies', () => {
      const result = routeSlackMessage(makeParams({
        ts: '2000.002',
        threadTs: '1000.001',
        config: { answerInThread: true, newSessionPerThread: true },
      }))
      expect(result.effectiveChatId).toBe('C123|1000.001')
    })

    it('does not create composite chatId for DMs', () => {
      const result = routeSlackMessage(makeParams({
        channelType: 'im',
        chatId: 'D456',
        config: { answerInThread: true, newSessionPerThread: true },
      }))
      expect(result.effectiveChatId).toBe('D456')
    })

    it('newSessionPerThread without answerInThread has no effect', () => {
      const result = routeSlackMessage(makeParams({
        ts: '1000.001',
        config: { newSessionPerThread: true },
      }))
      expect(result.effectiveChatId).toBe('C123')
      expect(result.threadContext).toBeUndefined()
    })
  })
})

// ── resolveSlackChannel ────────────────────────────────────────────────

describe('resolveSlackChannel', () => {
  it('returns plain channel for regular chatId', () => {
    const result = resolveSlackChannel('C123', new Map())
    expect(result).toEqual({ channel: 'C123' })
  })

  it('returns channel + threadTs from threadContextMap', () => {
    const map = new Map([['C123', { channel: 'C123', threadTs: '1000.001' }]])
    const result = resolveSlackChannel('C123', map)
    expect(result).toEqual({ channel: 'C123', threadTs: '1000.001' })
  })

  it('parses composite chatId when not in map', () => {
    const result = resolveSlackChannel('C123|1000.001', new Map())
    expect(result).toEqual({ channel: 'C123', threadTs: '1000.001' })
  })

  it('prefers threadContextMap over parsing composite chatId', () => {
    const map = new Map([
      ['C123|1000.001', { channel: 'C123', threadTs: '2000.002' }],
    ])
    const result = resolveSlackChannel('C123|1000.001', map)
    expect(result).toEqual({ channel: 'C123', threadTs: '2000.002' })
  })

  it('returns DM channel as-is', () => {
    const result = resolveSlackChannel('D456', new Map())
    expect(result).toEqual({ channel: 'D456' })
  })
})
