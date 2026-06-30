import { describe, it, expect } from 'vitest'
import { routeSlackMessage, resolveSlackChannel, touchAndCapSet, touchAndCapMap, reactionsForChat, type SlackMessageRoutingParams } from './slack-connector'

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

  // ── thread reply when answerInThread is off (SUP-282) ──────────────

  describe('answerInThread off but message is inside a thread (SUP-282)', () => {
    it('replies in the thread when the inbound message has a thread_ts', () => {
      const result = routeSlackMessage(makeParams({
        ts: '2000.002',
        threadTs: '1000.001',
        config: { answerInThread: false },
      }))
      expect(result.threadContext).toEqual({ channel: 'C123', threadTs: '1000.001' })
      expect(result.threadKey).toBe('C123|1000.001')
    })

    it('does NOT thread a top-level channel message when answerInThread is off', () => {
      const result = routeSlackMessage(makeParams({
        ts: '1000.001',
        config: { answerInThread: false },
      }))
      expect(result.threadContext).toBeUndefined()
      expect(result.threadKey).toBeUndefined()
      expect(result.effectiveChatId).toBe('C123')
    })

    it('replies in the thread for a mention inside a thread with onlyMentioned on', () => {
      const result = routeSlackMessage(makeParams({
        rawText: '<@U_BOT> help me here',
        ts: '2000.002',
        threadTs: '1000.001',
        config: { onlyMentioned: true, answerInThread: false },
      }))
      expect(result.shouldProcess).toBe(true)
      expect(result.threadContext).toEqual({ channel: 'C123', threadTs: '1000.001' })
    })

    it('does not thread DMs even when inside a thread', () => {
      const result = routeSlackMessage(makeParams({
        channelType: 'im',
        chatId: 'D456',
        ts: '2000.002',
        threadTs: '1000.001',
        config: { answerInThread: false },
      }))
      expect(result.threadContext).toBeUndefined()
    })

    it('uses a per-thread session (composite chatId) for an in-thread message when answerInThread is off', () => {
      // Race-free routing: the channel otherwise shares one session across threads,
      // so the reply destination would live only in the mutable threadContextMap.
      // Encoding the anchor in effectiveChatId makes it travel with the session.
      const result = routeSlackMessage(makeParams({
        ts: '2000.002',
        threadTs: '1000.001',
        config: { answerInThread: false, newSessionPerThread: false },
      }))
      expect(result.effectiveChatId).toBe('C123|1000.001')
    })

    it('reply destination is recoverable from the composite chatId alone — no shared map needed (race-free)', () => {
      const result = routeSlackMessage(makeParams({
        ts: '2000.002',
        threadTs: '1000.001',
        config: { answerInThread: false },
      }))
      // Pass an EMPTY map: a concurrent message could have cleared/overwritten it.
      // The destination must still resolve to the correct thread.
      expect(resolveSlackChannel(result.effectiveChatId, new Map())).toEqual({
        channel: 'C123',
        threadTs: '1000.001',
      })
    })

    it('distinct threads in the same channel get distinct sessions (no collision)', () => {
      const t1 = routeSlackMessage(makeParams({ ts: '2000.002', threadTs: '1000.001', config: { answerInThread: false } }))
      const t2 = routeSlackMessage(makeParams({ ts: '3000.003', threadTs: '1500.001', config: { answerInThread: false } }))
      expect(t1.effectiveChatId).toBe('C123|1000.001')
      expect(t2.effectiveChatId).toBe('C123|1500.001')
      expect(t1.effectiveChatId).not.toBe(t2.effectiveChatId)
    })
  })

  // ── isNewThreadEntry (thread-history backfill trigger) ─────────────

  describe('isNewThreadEntry', () => {
    it('is true on first tag inside an existing thread even when answerInThread is off (SUP-282)', () => {
      const result = routeSlackMessage(makeParams({
        ts: '2000.002',
        threadTs: '1000.001',
        config: { answerInThread: false },
        activeThreads: new Set(),
      }))
      expect(result.isNewThreadEntry).toBe(true)
    })

    it('is true on first entry into an existing thread when answerInThread is on', () => {
      const result = routeSlackMessage(makeParams({
        ts: '2000.002',
        threadTs: '1000.001',
        config: { answerInThread: true },
        activeThreads: new Set(),
      }))
      expect(result.isNewThreadEntry).toBe(true)
    })

    it('is false once the thread is already active (no re-fetch of history)', () => {
      const result = routeSlackMessage(makeParams({
        ts: '2000.003',
        threadTs: '1000.001',
        config: { answerInThread: false },
        activeThreads: new Set(['C123|1000.001']),
      }))
      expect(result.isNewThreadEntry).toBe(false)
    })

    it('is false for a brand-new top-level message (nothing to backfill)', () => {
      const result = routeSlackMessage(makeParams({
        ts: '1000.001',
        config: { answerInThread: true },
      }))
      expect(result.isNewThreadEntry).toBe(false)
    })

    it('is false for DMs even inside a thread', () => {
      const result = routeSlackMessage(makeParams({
        channelType: 'im',
        chatId: 'D456',
        ts: '2000.002',
        threadTs: '1000.001',
        config: {},
      }))
      expect(result.isNewThreadEntry).toBe(false)
    })

    it('is false for a filtered-out message (onlyMentioned, no mention, unknown thread)', () => {
      const result = routeSlackMessage(makeParams({
        rawText: 'just chatting',
        threadTs: '9999.999',
        config: { onlyMentioned: true },
        activeThreads: new Set(),
      }))
      expect(result.shouldProcess).toBe(false)
      expect(result.isNewThreadEntry).toBe(false)
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

// ── bounded MRU eviction (touchAndCapSet / touchAndCapMap) ─────────────

describe('touchAndCapSet', () => {
  it('adds keys and keeps them under the cap', () => {
    const set = new Set<string>()
    touchAndCapSet(set, 'a', 3)
    touchAndCapSet(set, 'b', 3)
    expect([...set]).toEqual(['a', 'b'])
  })

  it('evicts the oldest entry once the cap is exceeded', () => {
    const set = new Set<string>()
    touchAndCapSet(set, 'a', 2)
    touchAndCapSet(set, 'b', 2)
    touchAndCapSet(set, 'c', 2) // evicts 'a'
    expect([...set]).toEqual(['b', 'c'])
    expect(set.has('a')).toBe(false)
  })

  it('re-touching an existing key refreshes its recency so it survives eviction', () => {
    const set = new Set<string>()
    touchAndCapSet(set, 'a', 2)
    touchAndCapSet(set, 'b', 2)
    touchAndCapSet(set, 'a', 2) // 'a' becomes most-recent
    touchAndCapSet(set, 'c', 2) // evicts 'b' (now oldest), not 'a'
    expect([...set]).toEqual(['a', 'c'])
  })

  it('never grows beyond the cap across many inserts', () => {
    const set = new Set<string>()
    for (let i = 0; i < 5000; i++) touchAndCapSet(set, `k${i}`, 1000)
    expect(set.size).toBe(1000)
    expect(set.has('k4999')).toBe(true)
    expect(set.has('k0')).toBe(false)
  })
})

describe('touchAndCapMap', () => {
  it('evicts the oldest entry once the cap is exceeded', () => {
    const map = new Map<string, number>()
    touchAndCapMap(map, 'a', 1, 2)
    touchAndCapMap(map, 'b', 2, 2)
    touchAndCapMap(map, 'c', 3, 2) // evicts 'a'
    expect([...map.keys()]).toEqual(['b', 'c'])
    expect(map.has('a')).toBe(false)
  })

  it('updating an existing key refreshes recency and value without growing', () => {
    const map = new Map<string, number>()
    touchAndCapMap(map, 'a', 1, 2)
    touchAndCapMap(map, 'b', 2, 2)
    touchAndCapMap(map, 'a', 99, 2) // refresh 'a' (value + recency)
    touchAndCapMap(map, 'c', 3, 2) // evicts 'b', not 'a'
    expect(map.get('a')).toBe(99)
    expect([...map.keys()]).toEqual(['a', 'c'])
  })
})

// ── reactionsForChat (thinking-reaction sweep on clear) ──────────────────
// The working indicator is a :thinking_face: reaction keyed on the user's last
// message ts. If a second message lands mid-turn the ts changes and a second
// reaction is added; clearing must sweep EVERY reaction for the chat, not just
// the latest ts, or the first one is orphaned until disconnect.

describe('reactionsForChat', () => {
  it('returns all tracked reactions for the chat, extracting the ts', () => {
    const set = new Set(['C123:1000.1', 'C123:1000.2', 'C999:1000.3'])
    expect(reactionsForChat(set, 'C123')).toEqual([
      { key: 'C123:1000.1', ts: '1000.1' },
      { key: 'C123:1000.2', ts: '1000.2' },
    ])
  })

  it('does not match a chat whose id is a prefix of another (colon-delimited)', () => {
    const set = new Set(['C12:1000.1', 'C123:1000.2'])
    expect(reactionsForChat(set, 'C12').map((r) => r.ts)).toEqual(['1000.1'])
  })

  it('returns empty when nothing is tracked for the chat', () => {
    expect(reactionsForChat(new Set(['C999:1000.1']), 'C123')).toEqual([])
  })
})
