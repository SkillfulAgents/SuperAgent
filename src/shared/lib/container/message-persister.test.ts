import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ContainerClient, StreamMessage } from './types'

// Mock external dependencies before importing
vi.mock('@shared/lib/services/scheduled-task-service', () => ({
  createScheduledTask: vi.fn(),
}))
vi.mock('@shared/lib/services/session-service', () => ({
  updateSessionMetadata: vi.fn(() => Promise.resolve()),
}))
vi.mock('@shared/lib/notifications/notification-manager', () => ({
  notificationManager: {
    triggerSessionComplete: vi.fn(() => Promise.resolve()),
    triggerSessionWaitingInput: vi.fn(() => Promise.resolve()),
  },
}))

const mockReaddir = vi.fn()
const mockStat = vi.fn()
vi.mock('fs', () => ({
  promises: {
    readdir: (...args: unknown[]) => mockReaddir(...args),
    stat: (...args: unknown[]) => mockStat(...args),
  },
}))
vi.mock('@shared/lib/utils/file-storage', () => ({
  getAgentSessionsDir: vi.fn(() => '/mock/sessions'),
}))

// Import after mocks are set up
import { messagePersister } from './message-persister'

// Helper to create a mock ContainerClient
function createMockClient(): ContainerClient & {
  _messageCallback: ((message: StreamMessage) => void) | null
  _sendMessage: (content: any) => void
} {
  let messageCallback: ((message: StreamMessage) => void) | null = null

  const client = {
    _messageCallback: null as ((message: StreamMessage) => void) | null,
    _sendMessage(content: any) {
      if (messageCallback) {
        messageCallback({
          type: 'message',
          content,
          timestamp: new Date(),
          sessionId: 'test-session',
        })
      }
    },
    start: vi.fn(),
    stop: vi.fn(),
    stopSync: vi.fn(),
    getInfoFromRuntime: vi.fn(),
    getInfo: vi.fn(),
    fetch: vi.fn(),
    waitForHealthy: vi.fn(),
    isHealthy: vi.fn(),
    getStats: vi.fn(),
    createSession: vi.fn(),
    getSession: vi.fn(() => Promise.resolve(null)),
    deleteSession: vi.fn(),
    sendMessage: vi.fn(),
    getMessages: vi.fn(),
    interruptSession: vi.fn(),
    subscribeToStream: vi.fn((sessionId: string, callback: (message: StreamMessage) => void) => {
      messageCallback = callback
      client._messageCallback = callback
      return {
        unsubscribe: vi.fn(),
        ready: Promise.resolve(),
      }
    }),
    on: vi.fn(),
    off: vi.fn(),
  }

  return client as any
}

// Helper to collect SSE events from a session
function collectSSEEvents(sessionId: string): { events: any[]; cleanup: () => void } {
  const events: any[] = []
  const cleanup = messagePersister.addSSEClient(sessionId, (data) => {
    events.push(data)
  })
  return { events, cleanup }
}

describe('MessagePersister', () => {
  const SESSION_ID = 'test-session-1'
  const AGENT_SLUG = 'test-agent'

  let mockClient: ReturnType<typeof createMockClient>
  let sseEvents: any[]
  let sseCleanup: () => void

  beforeEach(async () => {
    mockClient = createMockClient()
    await messagePersister.subscribeToSession(SESSION_ID, mockClient, SESSION_ID, AGENT_SLUG)

    const sse = collectSSEEvents(SESSION_ID)
    sseEvents = sse.events
    sseCleanup = sse.cleanup
  })

  afterEach(() => {
    sseCleanup()
    messagePersister.unsubscribeFromSession(SESSION_ID)
    vi.clearAllMocks()
  })

  // ============================================================================
  // Sidechain message filtering
  // ============================================================================

  describe('sidechain message filtering', () => {
    it('filters messages with parent_tool_use_id away from main streaming state', () => {
      // First, trigger a normal assistant message to set some state
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'message_start' },
      })
      mockClient._sendMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Hello' },
        },
      })

      // Clear SSE events from setup
      sseEvents.length = 0

      // Now send a sidechain message (has parent_tool_use_id)
      mockClient._sendMessage({
        type: 'assistant',
        parent_tool_use_id: 'tool-123',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Sidechain text' }] },
      })

      // Should broadcast subagent_updated, NOT messages_updated
      const subagentEvents = sseEvents.filter(e => e.type === 'subagent_updated')
      const messagesUpdated = sseEvents.filter(e => e.type === 'messages_updated')
      expect(subagentEvents.length).toBeGreaterThanOrEqual(1)
      expect(messagesUpdated).toHaveLength(0)
    })

    it('does not filter messages without parent_tool_use_id', () => {
      mockClient._sendMessage({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Main text' }] },
      })

      const messagesUpdated = sseEvents.filter(e => e.type === 'messages_updated')
      expect(messagesUpdated).toHaveLength(1)
    })

    it('broadcasts subagent_stream_delta for sidechain stream events (not subagent_updated)', () => {
      // Stream event with parent_tool_use_id — now routes to subagent stream handler
      mockClient._sendMessage({
        type: 'stream_event',
        parent_tool_use_id: 'tool-123',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'partial' },
        },
      })

      // Should broadcast subagent_stream_delta, NOT subagent_updated
      const streamDelta = sseEvents.filter(e => e.type === 'subagent_stream_delta')
      const subagentUpdated = sseEvents.filter(e => e.type === 'subagent_updated')
      expect(streamDelta).toHaveLength(1)
      expect(streamDelta[0].text).toBe('partial')
      expect(subagentUpdated).toHaveLength(0)
    })

    it('broadcasts subagent_updated for sidechain user messages', () => {
      mockClient._sendMessage({
        type: 'user',
        parent_tool_use_id: 'tool-123',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'sub-tool', content: 'result' }] },
      })

      const subagentUpdated = sseEvents.filter(e => e.type === 'subagent_updated')
      expect(subagentUpdated).toHaveLength(1)
    })
  })

  // ============================================================================
  // Task tool tracking
  // ============================================================================

  describe('Task tool tracking', () => {
    it('sets pendingTaskToolId when Task tool block completes', () => {
      // Start a Task tool_use block
      mockClient._sendMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'task-tool-1', name: 'Task' },
        },
      })

      // Stream some input
      mockClient._sendMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: '{"subagent_type":"Explore"}' },
        },
      })

      // Complete the block
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_stop' },
      })

      // Now sidechain messages should reference this pending tool
      mockClient._sendMessage({
        type: 'assistant',
        parent_tool_use_id: 'task-tool-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Sub-agent working' }] },
      })

      const subagentUpdated = sseEvents.filter(e => e.type === 'subagent_updated')
      expect(subagentUpdated.length).toBeGreaterThanOrEqual(1)
      expect(subagentUpdated[0].parentToolId).toBe('task-tool-1')
    })

    it('does not set pendingTaskToolId for non-Task tools', () => {
      // Start a Bash tool
      mockClient._sendMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'bash-tool-1', name: 'Bash' },
        },
      })

      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_stop' },
      })

      // Sidechain message should have null parentToolId
      mockClient._sendMessage({
        type: 'assistant',
        parent_tool_use_id: 'some-id',
        message: { role: 'assistant', content: [{ type: 'text', text: 'text' }] },
      })

      const subagentUpdated = sseEvents.filter(e => e.type === 'subagent_updated')
      if (subagentUpdated.length > 0) {
        expect(subagentUpdated[0].parentToolId).toBeNull()
      }
    })
  })

  // ============================================================================
  // Subagent completion detection
  // ============================================================================

  describe('subagent completion detection', () => {
    it('broadcasts subagent_completed when tool_result matches pendingTaskToolId', async () => {
      // Set up filesystem mock so agentId can be discovered
      mockReaddir.mockResolvedValue(['agent-sub1.jsonl'])
      mockStat.mockResolvedValue({ mtimeMs: 1000 })

      // Set up Task tool tracking
      mockClient._sendMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'task-tool-1', name: 'Task' },
        },
      })
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_stop' },
      })

      // Send a sidechain message to trigger agentId discovery
      mockClient._sendMessage({
        type: 'assistant',
        parent_tool_use_id: 'task-tool-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
      })

      // Wait for async discovery to complete
      await vi.waitFor(() => {
        const updated = sseEvents.filter(e => e.type === 'subagent_updated' && e.agentId === 'sub1')
        expect(updated.length).toBeGreaterThanOrEqual(1)
      })

      sseEvents.length = 0

      // Send tool_result for the Task tool (subagent completed)
      mockClient._sendMessage({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'task-tool-1', content: 'done' }],
        },
      })

      const completed = sseEvents.filter(e => e.type === 'subagent_completed')
      expect(completed).toHaveLength(1)
      expect(completed[0].parentToolId).toBe('task-tool-1')
      expect(completed[0].agentId).toBe('sub1')
    })

    it('does not broadcast subagent_completed for non-matching tool_result', () => {
      // Set up Task tool tracking
      mockClient._sendMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'task-tool-1', name: 'Task' },
        },
      })
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_stop' },
      })

      sseEvents.length = 0

      // Send tool_result for a different tool
      mockClient._sendMessage({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'other-tool', content: 'result' }],
        },
      })

      const completed = sseEvents.filter(e => e.type === 'subagent_completed')
      expect(completed).toHaveLength(0)
    })

    it('clears pendingTaskToolId after subagent completion', () => {
      // Set up and complete first Task tool
      mockClient._sendMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'task-tool-1', name: 'Task' },
        },
      })
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_stop' },
      })
      mockClient._sendMessage({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'task-tool-1', content: 'done' }],
        },
      })

      sseEvents.length = 0

      // Another tool_result should NOT trigger subagent_completed
      mockClient._sendMessage({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'task-tool-1', content: 'duplicate' }],
        },
      })

      const completed = sseEvents.filter(e => e.type === 'subagent_completed')
      expect(completed).toHaveLength(0)
    })
  })

  // ============================================================================
  // State cleanup on interrupt/inactive
  // ============================================================================

  describe('state cleanup', () => {
    it('clears subagent state on markSessionInterrupted', async () => {
      // Set up Task tool tracking
      mockClient._sendMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'task-tool-1', name: 'Task' },
        },
      })
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_stop' },
      })

      sseEvents.length = 0

      // Interrupt the session
      await messagePersister.markSessionInterrupted(SESSION_ID)

      // Now tool_result should NOT trigger subagent_completed since state was cleared
      mockClient._sendMessage({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'task-tool-1', content: 'done' }],
        },
      })

      const completed = sseEvents.filter(e => e.type === 'subagent_completed')
      expect(completed).toHaveLength(0)
    })

    it('clears subagent state when session goes inactive via result event', () => {
      // Set up Task tool tracking
      mockClient._sendMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'task-tool-1', name: 'Task' },
        },
      })
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_stop' },
      })

      // Mark session active first
      messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)

      sseEvents.length = 0

      // Session completes via result event
      mockClient._sendMessage({
        type: 'result',
        subtype: 'success',
      })

      // Verify session_idle was broadcast
      const idle = sseEvents.filter(e => e.type === 'session_idle')
      expect(idle.length).toBeGreaterThanOrEqual(1)
    })
  })

  // ============================================================================
  // Subagent ID discovery
  // ============================================================================

  describe('subagent ID discovery', () => {
    it('discovers agentId from filesystem on first sidechain message', async () => {
      mockReaddir.mockResolvedValue(['agent-abc123.jsonl', 'agent-def456.jsonl'])
      mockStat.mockImplementation((filePath: string) => {
        if (filePath.includes('abc123')) {
          return Promise.resolve({ mtimeMs: 1000 })
        }
        return Promise.resolve({ mtimeMs: 2000 }) // def456 is newer
      })

      // Send a sidechain message to trigger discovery
      mockClient._sendMessage({
        type: 'assistant',
        parent_tool_use_id: 'task-tool-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
      })

      // Wait for the async discovery to complete
      await vi.waitFor(() => {
        const events = sseEvents.filter(e => e.type === 'subagent_updated' && e.agentId === 'def456')
        expect(events.length).toBeGreaterThanOrEqual(1)
      })
    })

    it('handles missing subagents directory gracefully', async () => {
      mockReaddir.mockRejectedValue(new Error('ENOENT'))

      // Should not throw
      mockClient._sendMessage({
        type: 'assistant',
        parent_tool_use_id: 'task-tool-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
      })

      // Should still broadcast subagent_updated with null agentId
      const events = sseEvents.filter(e => e.type === 'subagent_updated')
      expect(events.length).toBeGreaterThanOrEqual(1)
      expect(events[0].agentId).toBeNull()
    })
  })

  // ============================================================================
  // Subagent streaming
  // ============================================================================

  describe('subagent streaming', () => {
    // Helper: set up a Task tool so parentToolId is tracked
    function setupTaskTool(toolId = 'task-tool-1') {
      mockClient._sendMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: toolId, name: 'Task' },
        },
      })
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_stop' },
      })
    }

    // Helper: send a sidechain stream event
    function sendSidechainStreamEvent(event: any) {
      mockClient._sendMessage({
        type: 'stream_event',
        parent_tool_use_id: 'task-tool-1',
        event,
      })
    }

    it('broadcasts subagent_stream_start on sidechain message_start', () => {
      setupTaskTool()
      sseEvents.length = 0

      sendSidechainStreamEvent({ type: 'message_start' })

      const starts = sseEvents.filter(e => e.type === 'subagent_stream_start')
      expect(starts).toHaveLength(1)
      expect(starts[0].parentToolId).toBe('task-tool-1')
    })

    it('broadcasts subagent_stream_delta for text deltas and accumulates text', () => {
      setupTaskTool()
      sseEvents.length = 0

      sendSidechainStreamEvent({ type: 'message_start' })
      sendSidechainStreamEvent({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Hello ' },
      })
      sendSidechainStreamEvent({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'world' },
      })

      const deltas = sseEvents.filter(e => e.type === 'subagent_stream_delta')
      expect(deltas).toHaveLength(2)
      expect(deltas[0].text).toBe('Hello ')
      expect(deltas[1].text).toBe('world')
    })

    it('broadcasts subagent_tool_use_start and subagent_tool_use_streaming for tool use', () => {
      setupTaskTool()
      sseEvents.length = 0

      sendSidechainStreamEvent({
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'sub-tool-1', name: 'Bash' },
      })
      sendSidechainStreamEvent({
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"cmd":' },
      })
      sendSidechainStreamEvent({
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '"ls"}' },
      })

      const starts = sseEvents.filter(e => e.type === 'subagent_tool_use_start')
      expect(starts).toHaveLength(1)
      expect(starts[0].toolName).toBe('Bash')
      expect(starts[0].toolId).toBe('sub-tool-1')

      const streaming = sseEvents.filter(e => e.type === 'subagent_tool_use_streaming')
      expect(streaming).toHaveLength(2)
      // Input accumulates
      expect(streaming[0].partialInput).toBe('{"cmd":')
      expect(streaming[1].partialInput).toBe('{"cmd":"ls"}')
    })

    it('broadcasts subagent_tool_use_ready on content_block_stop for tool use', () => {
      setupTaskTool()
      sseEvents.length = 0

      sendSidechainStreamEvent({
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'sub-tool-1', name: 'Read' },
      })
      sendSidechainStreamEvent({ type: 'content_block_stop' })

      const ready = sseEvents.filter(e => e.type === 'subagent_tool_use_ready')
      expect(ready).toHaveLength(1)
      expect(ready[0].toolId).toBe('sub-tool-1')
      expect(ready[0].toolName).toBe('Read')
    })

    it('does NOT corrupt main agent streaming state with sidechain events', () => {
      // Start main agent streaming
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'message_start' },
      })
      mockClient._sendMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Main text' },
        },
      })

      sseEvents.length = 0

      // Now send sidechain text delta
      mockClient._sendMessage({
        type: 'stream_event',
        parent_tool_use_id: 'tool-123',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Sub text' },
        },
      })

      // Main agent should still get its own stream_delta, not subagent's
      // And subagent should get subagent_stream_delta
      const mainDeltas = sseEvents.filter(e => e.type === 'stream_delta')
      const subDeltas = sseEvents.filter(e => e.type === 'subagent_stream_delta')
      expect(mainDeltas).toHaveLength(0) // No main delta from this sidechain event
      expect(subDeltas).toHaveLength(1)
      expect(subDeltas[0].text).toBe('Sub text')
    })

    it('clears subagent streaming text when complete assistant message arrives', () => {
      setupTaskTool()
      sseEvents.length = 0

      // Stream some subagent text
      sendSidechainStreamEvent({ type: 'message_start' })
      sendSidechainStreamEvent({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Streaming...' },
      })

      // Now a complete assistant message arrives (persisted)
      mockClient._sendMessage({
        type: 'assistant',
        parent_tool_use_id: 'task-tool-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Full response' }] },
      })

      // The subagent_updated event should be broadcast (for the complete message)
      const updated = sseEvents.filter(e => e.type === 'subagent_updated')
      expect(updated).toHaveLength(1)
    })

    it('clears subagent streaming state on subagent completion', async () => {
      // Pre-populate agentId so completion takes the synchronous path
      mockReaddir.mockResolvedValue(['agent-sub1.jsonl'])
      mockStat.mockResolvedValue({ mtimeMs: 1000 })

      setupTaskTool()

      // Send a sidechain message to trigger agentId discovery
      mockClient._sendMessage({
        type: 'assistant',
        parent_tool_use_id: 'task-tool-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'init' }] },
      })
      await vi.waitFor(() => {
        const found = sseEvents.filter(e => e.type === 'subagent_updated' && e.agentId === 'sub1')
        expect(found.length).toBeGreaterThanOrEqual(1)
      })

      // Stream some subagent content
      sendSidechainStreamEvent({ type: 'message_start' })
      sendSidechainStreamEvent({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Working...' },
      })

      sseEvents.length = 0

      // Subagent completes via tool_result for the Task tool
      mockClient._sendMessage({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'task-tool-1', content: 'done' }],
        },
      })

      const completed = sseEvents.filter(e => e.type === 'subagent_completed')
      expect(completed).toHaveLength(1)
      expect(completed[0].agentId).toBe('sub1')

      // Subsequent sidechain stream events should start fresh
      sseEvents.length = 0
      // Set up a new task tool since the old one was cleared
      setupTaskTool('task-tool-2')
      mockClient._sendMessage({
        type: 'stream_event',
        parent_tool_use_id: 'task-tool-2',
        event: { type: 'message_start' },
      })

      const starts = sseEvents.filter(e => e.type === 'subagent_stream_start')
      expect(starts).toHaveLength(1)
    })

    it('does not reuse completed subagent ID for second subagent (filesystem discovery)', async () => {
      // First subagent: discover agentId from filesystem
      mockReaddir.mockResolvedValue(['agent-sub1.jsonl'])
      mockStat.mockResolvedValue({ mtimeMs: 1000 })

      setupTaskTool('task-tool-1')

      // Trigger agentId discovery via sidechain message
      mockClient._sendMessage({
        type: 'assistant',
        parent_tool_use_id: 'task-tool-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'first subagent' }] },
      })
      await vi.waitFor(() => {
        const found = sseEvents.filter(e => e.type === 'subagent_updated' && e.agentId === 'sub1')
        expect(found.length).toBeGreaterThanOrEqual(1)
      })

      // Complete the first subagent
      mockClient._sendMessage({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'task-tool-1', content: 'done' }],
        },
      })

      sseEvents.length = 0

      // Second subagent: filesystem still has sub1 (new file not created yet)
      // This is the bug scenario — discovery should NOT pick sub1 again
      mockReaddir.mockResolvedValue(['agent-sub1.jsonl', 'agent-sub2.jsonl'])
      mockStat.mockImplementation((filePath: string) => {
        if (filePath.includes('sub1')) return Promise.resolve({ mtimeMs: 1000 })
        return Promise.resolve({ mtimeMs: 2000 }) // sub2 is newer
      })

      setupTaskTool('task-tool-2')

      // Trigger discovery for the second subagent
      mockClient._sendMessage({
        type: 'assistant',
        parent_tool_use_id: 'task-tool-2',
        message: { role: 'assistant', content: [{ type: 'text', text: 'second subagent' }] },
      })

      await vi.waitFor(() => {
        const found = sseEvents.filter(e => e.type === 'subagent_updated' && e.agentId === 'sub2')
        expect(found.length).toBeGreaterThanOrEqual(1)
      })

      // Should NOT have picked sub1 (the completed one)
      const sub1Events = sseEvents.filter(e => e.type === 'subagent_updated' && e.agentId === 'sub1')
      expect(sub1Events).toHaveLength(0)
    })

    it('does not reuse completed subagent ID when only old file exists', async () => {
      // First subagent completes
      mockReaddir.mockResolvedValue(['agent-sub1.jsonl'])
      mockStat.mockResolvedValue({ mtimeMs: 1000 })

      setupTaskTool('task-tool-1')

      mockClient._sendMessage({
        type: 'assistant',
        parent_tool_use_id: 'task-tool-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
      })
      await vi.waitFor(() => {
        const found = sseEvents.filter(e => e.type === 'subagent_updated' && e.agentId === 'sub1')
        expect(found.length).toBeGreaterThanOrEqual(1)
      })

      mockClient._sendMessage({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'task-tool-1', content: 'done' }],
        },
      })

      sseEvents.length = 0

      // Second subagent starts but new file doesn't exist yet — only sub1 on disk
      mockReaddir.mockResolvedValue(['agent-sub1.jsonl'])

      setupTaskTool('task-tool-2')

      // Send stream event (no agentId available from content)
      mockClient._sendMessage({
        type: 'stream_event',
        parent_tool_use_id: 'task-tool-2',
        event: { type: 'message_start' },
      })

      // Discovery should NOT pick sub1 — should leave activeSubagentId as null
      // Give async discovery time to run
      await new Promise(resolve => setTimeout(resolve, 50))

      const updatedWithSub1 = sseEvents.filter(e => e.type === 'subagent_updated' && e.agentId === 'sub1')
      expect(updatedWithSub1).toHaveLength(0)
    })

    it('extracts agentId directly from complete sidechain messages', async () => {
      setupTaskTool('task-tool-1')
      sseEvents.length = 0

      // Send a complete assistant message with agentId field (as written by SDK)
      mockClient._sendMessage({
        type: 'assistant',
        parent_tool_use_id: 'task-tool-1',
        agentId: 'direct-id-123',
        message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
      })

      // Should use the agentId from the message directly, without filesystem discovery
      const updated = sseEvents.filter(e => e.type === 'subagent_updated')
      expect(updated).toHaveLength(1)
      expect(updated[0].agentId).toBe('direct-id-123')
      // Filesystem should NOT have been called
      expect(mockReaddir).not.toHaveBeenCalled()
    })

    it('handles bare events (without stream_event wrapper) as sidechain stream events', () => {
      setupTaskTool()
      sseEvents.length = 0

      // Bare event with parent_tool_use_id (no type: 'stream_event' wrapper)
      mockClient._sendMessage({
        parent_tool_use_id: 'task-tool-1',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'bare event text' },
        },
      })

      const deltas = sseEvents.filter(e => e.type === 'subagent_stream_delta')
      expect(deltas).toHaveLength(1)
      expect(deltas[0].text).toBe('bare event text')
    })
  })

  // ============================================================================
  // Main message handling (sanity checks)
  // ============================================================================

  describe('main message handling', () => {
    it('broadcasts messages_updated for assistant messages', () => {
      mockClient._sendMessage({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
      })

      const updated = sseEvents.filter(e => e.type === 'messages_updated')
      expect(updated).toHaveLength(1)
    })

    it('broadcasts stream_delta for text deltas', () => {
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'message_start' },
      })
      mockClient._sendMessage({
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
      mockClient._sendMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash' },
        },
      })

      mockClient._sendMessage({
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
      messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)
      await messagePersister.markSessionInterrupted(SESSION_ID)

      sseEvents.length = 0

      // These should be ignored
      mockClient._sendMessage({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ignored' }] },
      })

      // But result should still go through
      mockClient._sendMessage({
        type: 'result',
        subtype: 'success',
      })

      const messagesUpdated = sseEvents.filter(e => e.type === 'messages_updated')
      const idle = sseEvents.filter(e => e.type === 'session_idle')
      expect(messagesUpdated).toHaveLength(0)
      expect(idle.length).toBeGreaterThanOrEqual(1)
    })
  })

  // ============================================================================
  // Remote MCP request tool handling
  // ============================================================================

  describe('remote MCP request tool handling', () => {
    // Helper to simulate a complete tool_use block for request_remote_mcp
    function simulateRemoteMcpToolUse(toolId: string, input: Record<string, unknown>) {
      mockClient._sendMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: toolId, name: 'mcp__user-input__request_remote_mcp' },
        },
      })
      mockClient._sendMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
        },
      })
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_stop' },
      })
    }

    it('broadcasts remote_mcp_request event on tool_use completion', () => {
      sseEvents.length = 0

      simulateRemoteMcpToolUse('mcp-tool-1', {
        url: 'https://mcp.example.com/mcp',
        name: 'Example MCP',
        reason: 'Need weather data',
      })

      const mcpRequests = sseEvents.filter(e => e.type === 'remote_mcp_request')
      expect(mcpRequests).toHaveLength(1)
      expect(mcpRequests[0].toolUseId).toBe('mcp-tool-1')
      expect(mcpRequests[0].url).toBe('https://mcp.example.com/mcp')
      expect(mcpRequests[0].name).toBe('Example MCP')
      expect(mcpRequests[0].reason).toBe('Need weather data')
      expect(mcpRequests[0].agentSlug).toBe(AGENT_SLUG)
    })

    it('broadcasts remote_mcp_request with only url (name and reason optional)', () => {
      sseEvents.length = 0

      simulateRemoteMcpToolUse('mcp-tool-2', {
        url: 'https://other.mcp.io/api',
      })

      const mcpRequests = sseEvents.filter(e => e.type === 'remote_mcp_request')
      expect(mcpRequests).toHaveLength(1)
      expect(mcpRequests[0].url).toBe('https://other.mcp.io/api')
      expect(mcpRequests[0].name).toBeUndefined()
      expect(mcpRequests[0].reason).toBeUndefined()
    })

    it('does not broadcast remote_mcp_request for invalid JSON input', () => {
      sseEvents.length = 0

      mockClient._sendMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'mcp-bad', name: 'mcp__user-input__request_remote_mcp' },
        },
      })
      mockClient._sendMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: 'not valid json{{{' },
        },
      })
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_stop' },
      })

      const mcpRequests = sseEvents.filter(e => e.type === 'remote_mcp_request')
      expect(mcpRequests).toHaveLength(0)
    })

    it('does not broadcast remote_mcp_request when url is missing', () => {
      sseEvents.length = 0

      simulateRemoteMcpToolUse('mcp-no-url', { name: 'No URL MCP' })

      const mcpRequests = sseEvents.filter(e => e.type === 'remote_mcp_request')
      expect(mcpRequests).toHaveLength(0)
    })

    it('triggers notification when no active viewers', async () => {
      const { notificationManager } = await import('@shared/lib/notifications/notification-manager')

      sseEvents.length = 0
      vi.mocked(notificationManager.triggerSessionWaitingInput).mockClear()

      // Remove SSE client so there are no active viewers
      sseCleanup()

      simulateRemoteMcpToolUse('mcp-notify', {
        url: 'https://mcp.example.com/mcp',
      })

      expect(notificationManager.triggerSessionWaitingInput).toHaveBeenCalledWith(
        SESSION_ID,
        AGENT_SLUG,
        'remote_mcp'
      )

      // Re-attach SSE client for afterEach cleanup
      const sse = collectSSEEvents(SESSION_ID)
      sseEvents = sse.events
      sseCleanup = sse.cleanup
    })

    it('does not trigger notification when there are active viewers', async () => {
      const { notificationManager } = await import('@shared/lib/notifications/notification-manager')

      sseEvents.length = 0
      vi.mocked(notificationManager.triggerSessionWaitingInput).mockClear()

      // SSE client is attached (active viewer) — notification should NOT fire
      simulateRemoteMcpToolUse('mcp-no-notify', {
        url: 'https://mcp.example.com/mcp',
      })

      expect(notificationManager.triggerSessionWaitingInput).not.toHaveBeenCalled()
    })

    it('still broadcasts tool_use_ready alongside remote_mcp_request', () => {
      sseEvents.length = 0

      simulateRemoteMcpToolUse('mcp-tool-ready', {
        url: 'https://mcp.example.com/mcp',
      })

      const toolReady = sseEvents.filter(e => e.type === 'tool_use_ready')
      expect(toolReady).toHaveLength(1)
      expect(toolReady[0].toolName).toBe('mcp__user-input__request_remote_mcp')
    })
  })

  // ============================================================================
  // Slash command handling
  // ============================================================================

  describe('slash commands', () => {
    it('getSlashCommands returns empty array for unknown session', () => {
      expect(messagePersister.getSlashCommands('nonexistent')).toEqual([])
    })

    it('getSlashCommands returns empty array initially', () => {
      expect(messagePersister.getSlashCommands(SESSION_ID)).toEqual([])
    })

    it('setSlashCommands stores and getSlashCommands retrieves', () => {
      const commands = [
        { name: 'compact', description: 'Clear history', argumentHint: '<instructions>' },
        { name: 'review', description: 'Review code', argumentHint: '' },
      ]
      messagePersister.setSlashCommands(SESSION_ID, commands)
      expect(messagePersister.getSlashCommands(SESSION_ID)).toEqual(commands)
    })

    it('setSlashCommands is a no-op for unknown session', () => {
      // Should not throw
      messagePersister.setSlashCommands('nonexistent', [
        { name: 'test', description: '', argumentHint: '' },
      ])
      expect(messagePersister.getSlashCommands('nonexistent')).toEqual([])
    })

    it('captures slash commands from init event as fallback when none are set', () => {
      sseEvents.length = 0

      mockClient._sendMessage({
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
      const stored = messagePersister.getSlashCommands(SESSION_ID)
      expect(stored).toHaveLength(3)
      expect(stored[0].name).toBe('compact')
    })

    it('does not overwrite rich slash commands with init event strings', () => {
      // Pre-set rich commands (e.g. from container HTTP response)
      const richCommands = [
        { name: 'compact', description: 'Clear conversation history', argumentHint: '<instructions>' },
      ]
      messagePersister.setSlashCommands(SESSION_ID, richCommands)

      sseEvents.length = 0

      // Init event arrives with plain string names
      mockClient._sendMessage({
        type: 'system',
        subtype: 'init',
        session_id: 'claude-session-1',
        slash_commands: ['compact', 'review'],
      })

      // Should still have the rich commands, NOT overwritten by strings
      const stored = messagePersister.getSlashCommands(SESSION_ID)
      expect(stored).toEqual(richCommands)

      // stream_start should include the rich commands
      const streamStarts = sseEvents.filter(e => e.type === 'stream_start')
      expect(streamStarts[0].slashCommands).toEqual(richCommands)
    })

    it('broadcasts slash commands in stream_start when available', () => {
      const commands = [
        { name: 'cost', description: 'Show cost', argumentHint: '' },
      ]
      messagePersister.setSlashCommands(SESSION_ID, commands)

      sseEvents.length = 0

      mockClient._sendMessage({
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

      mockClient._sendMessage({
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
})
