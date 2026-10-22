/**
 * The main agent's response as it streams (`MainStream`, through the
 * session): text and tool-call deltas, thinking blocks, compaction, the
 * slash commands the session advertises, and the context usage it reports.
 *
 * The sessions are real (`attachLiveSessionsHarness`), fed frame by frame
 * through a stream client.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@shared/lib/services/session-service', () => ({
  updateSessionMetadata: vi.fn(() => Promise.resolve()),
  getSessionMetadata: vi.fn(() => Promise.resolve(null)),
  finalizeAutomationStatus: vi.fn(() => Promise.resolve('updated')),
}))
const mockGetSettings = vi.fn((): Record<string, unknown> => ({}))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => mockGetSettings(),
  getAgentCapabilitySettings: () => ({ subagents: 'allow', workflows: 'review' }),
  getModelCatalogSettings: () => mockGetSettings().modelCatalog ?? {},
}))

import { attachLiveSessionsHarness, createStreamClient, type StreamClient } from '../testing/live-sessions-harness'

const SESSION_ID = 'test-session-1'
const AGENT_SLUG = 'test-agent'

const live = attachLiveSessionsHarness()
const sessions = (slug: string = AGENT_SLUG) => live.sessions(slug)

let mockClient: StreamClient
let sseEvents: any[]
let sseCleanup: () => void

beforeEach(async () => {
  mockClient = createStreamClient()
  await sessions().subscribe(SESSION_ID, mockClient, SESSION_ID)

  const sse = live.collect(AGENT_SLUG, SESSION_ID)
  sseEvents = sse.events
  sseCleanup = sse.stop
})

afterEach(() => {
  sseCleanup()
  sessions().unsubscribe(SESSION_ID)
  live.reset()
  mockGetSettings.mockReset()
  vi.clearAllMocks()
})

// ============================================================================
// Main message handling (sanity checks)
// ============================================================================

describe('main message handling', () => {
  it('broadcasts messages_updated for assistant messages', () => {
    mockClient.emit({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
    })

    const updated = sseEvents.filter(e => e.type === 'messages_updated')
    expect(updated).toHaveLength(1)
  })

  it('broadcasts stream_delta for text deltas', () => {
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'message_start' },
    })
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Hello world' },
      },
    })

    const deltas = sseEvents.filter(e => e.type === 'stream_delta')
    expect(deltas).toHaveLength(1)
    expect(deltas[0].text).toBe('Hello world')
  })

  it('broadcasts tool_use_start and tool_use_ready for tool calls', () => {
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash' },
      },
    })

    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    })

    const starts = sseEvents.filter(e => e.type === 'tool_use_start')
    const ready = sseEvents.filter(e => e.type === 'tool_use_ready')
    expect(starts).toHaveLength(1)
    expect(starts[0].toolName).toBe('Bash')
    expect(ready).toHaveLength(1)
    expect(ready[0].toolName).toBe('Bash')
  })

  it('skips messages after session is interrupted (except result)', async () => {
    sessions().markActive(SESSION_ID)
    sessions().markInterrupted(SESSION_ID)

    sseEvents.length = 0

    // These should be ignored
    mockClient.emit({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ignored' }] },
    })

    // But result should still go through
    mockClient.emit({
      type: 'result',
      subtype: 'success',
    })

    const messagesUpdated = sseEvents.filter(e => e.type === 'messages_updated')
    const idle = sseEvents.filter(e => e.type === 'session_idle')
    expect(messagesUpdated).toHaveLength(0)
    expect(idle.length).toBeGreaterThanOrEqual(1)
  })
})

describe('extended-thinking stream events', () => {
  it('broadcasts thinking_start, thinking_delta (summarized text), and thinking_stop', () => {
    // With display:'summarized', thinking_delta carries text; signature_delta does not.
    sseEvents.length = 0

    mockClient.emit({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'msg-thinking-1' } },
    })
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
    })
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me ' } },
    })
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'consider.' } },
    })
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'signature_delta' } },
    })
    mockClient.emit({ type: 'stream_event', event: { type: 'content_block_stop' } })

    const starts = sseEvents.filter(e => e.type === 'thinking_start')
    const deltas = sseEvents.filter(e => e.type === 'thinking_delta')
    const stops = sseEvents.filter(e => e.type === 'thinking_stop')
    expect(starts).toHaveLength(1)
    expect(starts[0].thinkingId).toBe('msg-thinking-1:0')
    expect(deltas.map(d => d.text)).toEqual(['Let me ', 'consider.'])
    expect(deltas.map(d => d.thinkingId)).toEqual(['msg-thinking-1:0', 'msg-thinking-1:0'])
    expect(stops).toHaveLength(1)
    expect(stops[0].thinkingId).toBe('msg-thinking-1:0')
  })

  it('does not emit thinking_stop for a tool_use content_block_stop', () => {
    sseEvents.length = 0

    mockClient.emit({ type: 'stream_event', event: { type: 'message_start' } })
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: 'Bash' } },
    })
    mockClient.emit({ type: 'stream_event', event: { type: 'content_block_stop' } })

    expect(sseEvents.filter(e => e.type === 'thinking_stop')).toHaveLength(0)
  })
})

describe('compaction status events', () => {
  it('broadcasts compact_start on early compacting status', () => {
    sseEvents.length = 0

    mockClient.emit({
      type: 'system',
      subtype: 'status',
      status: 'compacting',
      session_id: SESSION_ID,
      uuid: 'status-1',
    })

    const compactStarts = sseEvents.filter(e => e.type === 'compact_start')
    expect(compactStarts).toHaveLength(1)
  })

  it('does not broadcast duplicate compact_start when boundary follows status', () => {
    sseEvents.length = 0

    mockClient.emit({
      type: 'system',
      subtype: 'status',
      status: 'compacting',
      session_id: SESSION_ID,
      uuid: 'status-1',
    })

    mockClient.emit({
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      session_id: SESSION_ID,
      uuid: 'boundary-1',
      compactMetadata: { trigger: 'auto', preTokens: 170000 },
    })

    const compactStarts = sseEvents.filter(e => e.type === 'compact_start')
    expect(compactStarts).toHaveLength(1)
  })

  it('leaves "compacting" via getSessionActivity when compaction completes (no stale "Compacting…")', () => {
    sessions().markActive(SESSION_ID) // active → 'working'
    mockClient.emit({ type: 'system', subtype: 'status', status: 'compacting', session_id: SESSION_ID, uuid: 's1' })
    expect(sessions().activity(SESSION_ID)).toBe('compacting')

    // The compact-summary user message clears isCompacting (state.isCompacting was true).
    mockClient.emit({ type: 'user', session_id: SESSION_ID, uuid: 'summary-1' })

    // The pull projection must immediately leave 'compacting' (the tick re-reads it).
    expect(sessions().activity(SESSION_ID)).toBe('working')
  })
})

// ============================================================================
// Slash command handling
// ============================================================================

describe('slash commands', () => {
  it('getSlashCommands returns empty array for unknown session', () => {
    expect(sessions().slashCommands('nonexistent')).toEqual([])
  })

  it('getSlashCommands returns empty array initially', () => {
    expect(sessions().slashCommands(SESSION_ID)).toEqual([])
  })

  it('setSlashCommands stores and getSlashCommands retrieves', () => {
    const commands = [
      { name: 'compact', description: 'Clear history', argumentHint: '<instructions>' },
      { name: 'review', description: 'Review code', argumentHint: '' },
    ]
    sessions().setSlashCommands(SESSION_ID, commands)
    expect(sessions().slashCommands(SESSION_ID)).toEqual(commands)
  })

  it('setSlashCommands is a no-op for unknown session', () => {
    // Should not throw
    sessions().setSlashCommands('nonexistent', [
      { name: 'test', description: '', argumentHint: '' },
    ])
    expect(sessions().slashCommands('nonexistent')).toEqual([])
  })

  it('captures slash commands from init event as fallback when none are set', () => {
    sseEvents.length = 0

    mockClient.emit({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session-1',
      slash_commands: ['compact', 'review', 'cost'],
    })

    // Should have broadcast stream_start with slash commands
    const streamStarts = sseEvents.filter(e => e.type === 'stream_start')
    expect(streamStarts).toHaveLength(1)
    expect(streamStarts[0].slashCommands).toEqual([
      { name: 'compact', description: '', argumentHint: '' },
      { name: 'review', description: '', argumentHint: '' },
      { name: 'cost', description: '', argumentHint: '' },
    ])

    // Should be retrievable via accessor
    const stored = sessions().slashCommands(SESSION_ID)
    expect(stored).toHaveLength(3)
    expect(stored[0].name).toBe('compact')
  })

  it('uses init slugs without losing rich command details', () => {
    // Pre-set rich commands (e.g. legacy metadata or a container HTTP response)
    const richCommands = [
      { name: 'Order Canvas Print', description: 'Order a framed canvas', argumentHint: '<image>' },
    ]
    sessions().setSlashCommands(SESSION_ID, richCommands)

    sseEvents.length = 0

    // Init event arrives with plain string names
    mockClient.emit({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session-1',
      slash_commands: ['order-canvas-print', 'review'],
    })

    const stored = sessions().slashCommands(SESSION_ID)
    expect(stored).toEqual([
      { name: 'order-canvas-print', description: 'Order a framed canvas', argumentHint: '<image>' },
      { name: 'review', description: '', argumentHint: '' },
    ])

    const streamStarts = sseEvents.filter(e => e.type === 'stream_start')
    expect(streamStarts[0].slashCommands).toEqual(stored)
  })

  it('broadcasts slash commands in stream_start when available', () => {
    const commands = [
      { name: 'cost', description: 'Show cost', argumentHint: '' },
    ]
    sessions().setSlashCommands(SESSION_ID, commands)

    sseEvents.length = 0

    mockClient.emit({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session-1',
    })

    const streamStarts = sseEvents.filter(e => e.type === 'stream_start')
    expect(streamStarts).toHaveLength(1)
    expect(streamStarts[0].slashCommands).toEqual(commands)
  })

  it('omits slashCommands from stream_start when none are available', () => {
    sseEvents.length = 0

    mockClient.emit({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session-1',
      // No slash_commands field
    })

    const streamStarts = sseEvents.filter(e => e.type === 'stream_start')
    expect(streamStarts).toHaveLength(1)
    expect(streamStarts[0].slashCommands).toBeUndefined()
  })
})

// ============================================================================
// Context usage tracking
// ============================================================================

describe('context usage from assistant messages', () => {
  it('broadcasts context_usage when assistant message includes usage data', () => {
    mockClient.emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        usage: {
          input_tokens: 1500,
          output_tokens: 200,
          cache_creation_input_tokens: 500,
          cache_read_input_tokens: 1000,
        },
      },
    })

    const usageEvents = sseEvents.filter(e => e.type === 'context_usage')
    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0]).toMatchObject({
      type: 'context_usage',
      inputTokens: 1500,
      outputTokens: 200,
      cacheCreationInputTokens: 500,
      cacheReadInputTokens: 1000,
      contextWindow: 200_000, // default
    })
  })

  it('does not broadcast context_usage when assistant message has no usage', () => {
    mockClient.emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
      },
    })

    const usageEvents = sseEvents.filter(e => e.type === 'context_usage')
    expect(usageEvents).toHaveLength(0)
  })

  it('handles null cache token fields gracefully (OpenRouter format)', () => {
    mockClient.emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      },
    })

    const usageEvents = sseEvents.filter(e => e.type === 'context_usage')
    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    })
  })
})

describe('context window fallback from catalog (non-Claude result events)', () => {
  function seedAssistantUsage() {
    mockClient.emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    })
  }

  it('uses the catalog contextWindow when the SDK omits it (gpt via platform)', () => {
    mockGetSettings.mockReturnValue({ llmProvider: 'platform' })
    seedAssistantUsage()
    sseEvents.length = 0

    mockClient.emit({
      type: 'result',
      subtype: 'success',
      modelUsage: { 'gpt-5.6-sol': { inputTokens: 100, outputTokens: 10 } },
    })

    const usageEvents = sseEvents.filter((e) => e.type === 'context_usage')
    expect(usageEvents.at(-1)).toMatchObject({ contextWindow: 1_050_000 })
  })

  it('prefers the catalog window over the SDK default for a listed non-Claude model', () => {
    mockGetSettings.mockReturnValue({ llmProvider: 'platform' })
    seedAssistantUsage()
    sseEvents.length = 0

    // The SDK reports a generic 200K default for gpt; the catalog (1.05M) wins.
    mockClient.emit({
      type: 'result',
      subtype: 'success',
      modelUsage: { 'gpt-5.6-sol': { contextWindow: 200_000 } },
    })

    const usageEvents = sseEvents.filter((e) => e.type === 'context_usage')
    expect(usageEvents.at(-1)).toMatchObject({ contextWindow: 1_050_000 })
  })

  it('uses the SDK window for Claude (no catalog window) — e.g. 1M opus', () => {
    mockGetSettings.mockReturnValue({ llmProvider: 'platform' })
    seedAssistantUsage()
    sseEvents.length = 0

    mockClient.emit({
      type: 'result',
      subtype: 'success',
      modelUsage: { 'claude-opus-4-8': { contextWindow: 1_000_000 } },
    })

    const usageEvents = sseEvents.filter((e) => e.type === 'context_usage')
    expect(usageEvents.at(-1)).toMatchObject({ contextWindow: 1_000_000 })
  })

  it('keeps the 200K default when neither SDK nor catalog has a window', () => {
    mockGetSettings.mockReturnValue({ llmProvider: 'platform' })
    seedAssistantUsage()
    sseEvents.length = 0

    mockClient.emit({
      type: 'result',
      subtype: 'success',
      modelUsage: { 'totally-unknown-model': { inputTokens: 1 } },
    })

    const usageEvents = sseEvents.filter((e) => e.type === 'context_usage')
    expect(usageEvents.at(-1)).toMatchObject({ contextWindow: 200_000 })
  })
})

describe('context usage from message_delta stream events', () => {
  it('broadcasts context_usage from message_delta with real token counts', () => {
    // Simulate OpenRouter: assistant message has zeros, message_delta has real values
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'message_start' },
    })

    sseEvents.length = 0

    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: {
          input_tokens: 4500,
          output_tokens: 300,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    })

    const usageEvents = sseEvents.filter(e => e.type === 'context_usage')
    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0]).toMatchObject({
      type: 'context_usage',
      inputTokens: 4500,
      outputTokens: 300,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      contextWindow: 200_000,
    })
  })

  it('does not broadcast from message_delta when usage has all zeros', () => {
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'message_start' },
    })

    sseEvents.length = 0

    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: {
          input_tokens: 0,
          output_tokens: 0,
        },
      },
    })

    const usageEvents = sseEvents.filter(e => e.type === 'context_usage')
    expect(usageEvents).toHaveLength(0)
  })

  it('does not broadcast from message_delta when no usage field', () => {
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'message_start' },
    })

    sseEvents.length = 0

    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
      },
    })

    const usageEvents = sseEvents.filter(e => e.type === 'context_usage')
    expect(usageEvents).toHaveLength(0)
  })

  it('message_delta usage overwrites earlier zero-usage from assistant (OpenRouter pattern)', () => {
    // Step 1: assistant message with zeros (OpenRouter sends this first)
    mockClient.emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      },
    })

    // Step 2: message_delta arrives with real values
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: {
          input_tokens: 8500,
          output_tokens: 450,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    })

    const usageEvents = sseEvents.filter(e => e.type === 'context_usage')
    // Two broadcasts: first with zeros, then corrected with real values
    expect(usageEvents).toHaveLength(2)
    // The last one should have the real values
    expect(usageEvents[1]).toMatchObject({
      inputTokens: 8500,
      outputTokens: 450,
    })
  })

  it('Anthropic pattern: assistant and message_delta both have same valid usage', () => {
    // Anthropic sends real usage in both assistant message and message_delta
    mockClient.emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        usage: {
          input_tokens: 3000,
          output_tokens: 150,
          cache_creation_input_tokens: 2000,
          cache_read_input_tokens: 5000,
        },
      },
    })

    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: {
          input_tokens: 3000,
          output_tokens: 150,
          cache_creation_input_tokens: 2000,
          cache_read_input_tokens: 5000,
        },
      },
    })

    const usageEvents = sseEvents.filter(e => e.type === 'context_usage')
    // Two broadcasts with identical data - harmless redundancy
    expect(usageEvents).toHaveLength(2)
    expect(usageEvents[0]).toMatchObject({
      inputTokens: 3000,
      outputTokens: 150,
      cacheCreationInputTokens: 2000,
      cacheReadInputTokens: 5000,
    })
    expect(usageEvents[1]).toMatchObject({
      inputTokens: 3000,
      outputTokens: 150,
      cacheCreationInputTokens: 2000,
      cacheReadInputTokens: 5000,
    })
  })

  it('message_delta with only output_tokens triggers broadcast', () => {
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'message_start' },
    })

    sseEvents.length = 0

    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: {
          input_tokens: 0,
          output_tokens: 500,
        },
      },
    })

    const usageEvents = sseEvents.filter(e => e.type === 'context_usage')
    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0].outputTokens).toBe(500)
  })

  it('message_delta usage includes cache fields from Anthropic', () => {
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'message_start' },
    })

    sseEvents.length = 0

    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 2659,
          cache_read_input_tokens: 12442,
          output_tokens: 2042,
        },
      },
    })

    const usageEvents = sseEvents.filter(e => e.type === 'context_usage')
    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0]).toMatchObject({
      inputTokens: 2,
      cacheCreationInputTokens: 2659,
      cacheReadInputTokens: 12442,
      outputTokens: 2042,
      contextWindow: 200_000,
    })
  })

  it('multiple turns accumulate: last message_delta usage wins', () => {
    // Turn 1
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'message_start' },
    })
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'message_delta',
        usage: { input_tokens: 1000, output_tokens: 100 },
      },
    })

    // Turn 2 (context grows)
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'message_start' },
    })
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'message_delta',
        usage: { input_tokens: 3000, output_tokens: 200 },
      },
    })

    const usageEvents = sseEvents.filter(e => e.type === 'context_usage')
    expect(usageEvents).toHaveLength(2)
    // Last usage should reflect the larger context
    expect(usageEvents[1]).toMatchObject({
      inputTokens: 3000,
      outputTokens: 200,
    })
  })

  it('message_delta in sidechain does not affect main context usage', () => {
    // Set up a subagent
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'message_start' },
    })
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'tool-1', name: 'Agent' },
      },
    })
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    })

    sseEvents.length = 0

    // Sidechain message_delta (has parent_tool_use_id)
    mockClient.emit({
      type: 'stream_event',
      parent_tool_use_id: 'tool-1',
      event: {
        type: 'message_delta',
        usage: { input_tokens: 99999, output_tokens: 99999 },
      },
    })

    // Main context should NOT be affected
    const usageEvents = sseEvents.filter(e => e.type === 'context_usage')
    expect(usageEvents).toHaveLength(0)
  })
})
