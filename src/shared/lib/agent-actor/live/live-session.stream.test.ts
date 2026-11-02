/**
 * The main agent's response as it streams (`MainStream`, through the
 * session): text and tool-call deltas, thinking blocks, compaction, the
 * slash commands the session advertises, and the context usage the container measures.
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

import { updateSessionMetadata } from '@shared/lib/services/session-service'
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

  it('replaces the commands on a mid-turn commands_changed and tells viewers', () => {
    sessions().setSlashCommands(SESSION_ID, [{ name: 'compact', description: 'Free up context', argumentHint: '' }])
    sseEvents.length = 0

    const commands = [
      { name: 'compact', description: 'Free up context', argumentHint: '' },
      { name: 'say-banana', description: 'Reply with the word BANANA-OK', argumentHint: '' },
    ]
    mockClient.emit({ type: 'system', subtype: 'commands_changed', session_id: 'claude-session-1', commands })

    expect(sessions().slashCommands(SESSION_ID)).toEqual(commands)
    expect(sseEvents.filter(e => e.type === 'slash_commands_changed')).toEqual([
      { type: 'slash_commands_changed', slashCommands: commands },
    ])
    expect(sseEvents.filter(e => e.type === 'stream_start')).toHaveLength(0)
  })

  it('ignores a commands_changed without a valid list', () => {
    const commands = [{ name: 'compact', description: 'Free up context', argumentHint: '' }]
    sessions().setSlashCommands(SESSION_ID, commands)
    sseEvents.length = 0

    mockClient.emit({ type: 'system', subtype: 'commands_changed', session_id: 'claude-session-1', commands: [{ name: 1 }] })

    expect(sessions().slashCommands(SESSION_ID)).toEqual(commands)
    expect(sseEvents.filter(e => e.type === 'slash_commands_changed')).toHaveLength(0)
  })
})

// ============================================================================
// Context usage tracking
// ============================================================================

describe('context usage from the container', () => {
  const persisted = () => vi.mocked(updateSessionMetadata).mock.calls.filter(([, , patch]) => 'lastUsage' in patch)

  it('forwards the measured size and saves a settled one', () => {
    mockClient.emit({ type: 'context_usage', totalTokens: 64_041, contextWindow: 1_000_000, settled: true })

    expect(sseEvents.filter((e) => e.type === 'context_usage')).toEqual([
      { type: 'context_usage', totalTokens: 64_041, contextWindow: 1_000_000 },
    ])
    expect(persisted()).toEqual([
      [expect.anything(), SESSION_ID, { lastUsage: { totalTokens: 64_041, contextWindow: 1_000_000 } }],
    ])
  })

  it('forwards a mid-turn size without saving it', () => {
    mockClient.emit({ type: 'context_usage', totalTokens: 16_830, contextWindow: 1_000_000, settled: false })

    expect(sseEvents.filter((e) => e.type === 'context_usage')).toHaveLength(1)
    expect(persisted()).toHaveLength(0)
  })

  it('ignores a frame without a size or window', () => {
    mockClient.emit({ type: 'context_usage', contextWindow: 1_000_000, settled: true })
    mockClient.emit({ type: 'context_usage', totalTokens: 10, settled: true })

    expect(sseEvents.filter((e) => e.type === 'context_usage')).toHaveLength(0)
    expect(persisted()).toHaveLength(0)
  })

  it('reads no size from API call usage', () => {
    mockClient.emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-1', model: 'gpt-6.1-sol' } } })
    mockClient.emit({ type: 'stream_event', event: { type: 'message_delta', usage: { input_tokens: 51_300, cache_read_input_tokens: 39_424 } } })
    mockClient.emit({
      type: 'assistant',
      message: { role: 'assistant', model: 'gpt-6.1-sol', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 0, output_tokens: 0 } },
    })
    mockClient.emit({ type: 'result', subtype: 'success', modelUsage: { 'claude-haiku-4-5': { contextWindow: 200_000 } } })

    expect(sseEvents.filter((e) => e.type === 'context_usage')).toHaveLength(0)
    expect(persisted()).toHaveLength(0)
  })

  it('still lands after a stop', () => {
    sessions().markActive(SESSION_ID)
    sessions().markInterrupted(SESSION_ID)
    mockClient.emit({ type: 'context_usage', totalTokens: 2_717, contextWindow: 1_000_000, settled: true })

    expect(sseEvents.filter((e) => e.type === 'context_usage')).toHaveLength(1)
    expect(persisted()).toHaveLength(1)
  })
})
