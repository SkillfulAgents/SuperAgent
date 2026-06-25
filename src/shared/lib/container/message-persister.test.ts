import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ContainerClient, StreamMessage } from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SchedMockFn = (...args: any[]) => any
const mockListPendingScheduledTasks = vi.fn<SchedMockFn>(() => Promise.resolve([]))
const mockGetScheduledTask = vi.fn<SchedMockFn>(() => Promise.resolve(null))
const mockCancelScheduledTask = vi.fn<SchedMockFn>(() => Promise.resolve(true))
const mockPauseScheduledTask = vi.fn<SchedMockFn>(() => Promise.resolve(true))
const mockResumeScheduledTask = vi.fn<SchedMockFn>(() => Promise.resolve(true))

// Mock external dependencies before importing
vi.mock('@shared/lib/services/scheduled-task-service', () => ({
  createScheduledTask: vi.fn(),
  listPendingScheduledTasks: (...args: unknown[]) => mockListPendingScheduledTasks(...args),
  getScheduledTask: (...args: unknown[]) => mockGetScheduledTask(...args),
  cancelScheduledTask: (...args: unknown[]) => mockCancelScheduledTask(...args),
  pauseScheduledTask: (...args: unknown[]) => mockPauseScheduledTask(...args),
  resumeScheduledTask: (...args: unknown[]) => mockResumeScheduledTask(...args),
}))
vi.mock('@shared/lib/services/session-service', () => ({
  updateSessionMetadata: vi.fn(() => Promise.resolve()),
  getSessionMetadata: vi.fn(() => Promise.resolve(null)),
}))
vi.mock('@shared/lib/notifications/notification-manager', () => ({
  notificationManager: {
    triggerSessionComplete: vi.fn(() => Promise.resolve()),
    triggerSessionWaitingInput: vi.fn(() => Promise.resolve()),
  },
}))

const mockGetSettings = vi.fn((): Record<string, unknown> => ({}))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => mockGetSettings(),
  getModelCatalogSettings: () => mockGetSettings().modelCatalog ?? {},
  VALID_SCRIPT_TYPES: {
    darwin: ['applescript', 'shell'],
    linux: ['shell'],
    win32: ['powershell'],
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

// Mock computer-use modules
const mockCheckPermission = vi.fn((_agentSlug?: string, _level?: string, _appName?: string): string => 'prompt_needed')
vi.mock('@shared/lib/computer-use/permission-manager', () => ({
  computerUsePermissionManager: {
    checkPermission: (a: string, b: string, c?: string) => mockCheckPermission(a, b, c),
    getGrabbedApp: vi.fn(() => undefined),
    setGrabbedApp: vi.fn(),
    clearGrabbedApp: vi.fn(),
    consumeOnceGrant: vi.fn(),
  },
}))

vi.mock('@shared/lib/computer-use/types', () => ({
  getRequiredPermissionLevel: vi.fn(() => 'use_application'),
  resolveTargetApp: vi.fn(() => undefined),
  READ_ONLY_METHODS: new Set(['apps', 'windows', 'status', 'displays', 'permissions']),
  TIMED_GRANT_DURATION_MS: 15 * 60 * 1000,
}))

// Mock webhook trigger dependencies
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockFn = (...args: any[]) => any
const mockCreateWebhookTrigger = vi.fn<MockFn>(() => Promise.resolve('trigger_new_id'))
const mockListActiveWebhookTriggers = vi.fn<MockFn>(() => Promise.resolve([]))
const mockCancelWebhookTriggerWithCleanup = vi.fn<MockFn>(() => Promise.resolve(true))
vi.mock('@shared/lib/services/webhook-trigger-service', () => ({
  createWebhookTrigger: (...args: unknown[]) => mockCreateWebhookTrigger(...args),
  listActiveWebhookTriggers: (...args: unknown[]) => mockListActiveWebhookTriggers(...args),
  cancelWebhookTriggerWithCleanup: (...args: unknown[]) => mockCancelWebhookTriggerWithCleanup(...args),
}))

const mockGetAvailableTriggers = vi.fn<MockFn>(() => Promise.resolve([]))
const mockEnableComposioTrigger = vi.fn<MockFn>(() => Promise.resolve('composio_trigger_id'))
const mockDeleteComposioTrigger = vi.fn<MockFn>(() => Promise.resolve())
vi.mock('@shared/lib/composio/triggers', () => ({
  getAvailableTriggers: (...args: unknown[]) => mockGetAvailableTriggers(...args),
  enableComposioTrigger: (...args: unknown[]) => mockEnableComposioTrigger(...args),
  deleteComposioTrigger: (...args: unknown[]) => mockDeleteComposioTrigger(...args),
}))

const mockIsPlatformComposioActive = vi.fn(() => true)
vi.mock('@shared/lib/composio/client', () => ({
  isPlatformComposioActive: () => mockIsPlatformComposioActive(),
}))

const mockDbSelect = vi.fn<MockFn>()
vi.mock('@shared/lib/db', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
  },
}))
vi.mock('@shared/lib/db/schema', () => ({
  connectedAccounts: { id: 'id', providerConnectionId: 'provider_connection_id', providerName: 'provider_name', toolkitSlug: 'toolkit_slug' },
}))

// Mock container-manager (used by resolveContainerInput / rejectContainerInput)
const mockContainerClientFetch = vi.fn<MockFn>(() => Promise.resolve({ ok: true }))
vi.mock('./container-manager', () => ({
  containerManager: {
    getClient: () => ({
      fetch: (...args: unknown[]) => mockContainerClientFetch(...args),
    }),
  },
}))

// Import after mocks are set up
import { messagePersister } from './message-persister'
import { getSessionMetadata, updateSessionMetadata } from '@shared/lib/services/session-service'

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

  describe('extended-thinking stream events', () => {
    it('broadcasts thinking_start, thinking_delta (summarized text), and thinking_stop', () => {
      // With display:'summarized', thinking_delta carries text; signature_delta does not.
      sseEvents.length = 0

      mockClient._sendMessage({ type: 'stream_event', event: { type: 'message_start' } })
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'thinking' } },
      })
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Let me ' } },
      })
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'consider.' } },
      })
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'signature_delta' } },
      })
      mockClient._sendMessage({ type: 'stream_event', event: { type: 'content_block_stop' } })

      const starts = sseEvents.filter(e => e.type === 'thinking_start')
      const deltas = sseEvents.filter(e => e.type === 'thinking_delta')
      const stops = sseEvents.filter(e => e.type === 'thinking_stop')
      expect(starts).toHaveLength(1)
      expect(deltas.map(d => d.text)).toEqual(['Let me ', 'consider.'])
      expect(stops).toHaveLength(1)
    })

    it('does not emit thinking_stop for a tool_use content_block_stop', () => {
      sseEvents.length = 0

      mockClient._sendMessage({ type: 'stream_event', event: { type: 'message_start' } })
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: 'Bash' } },
      })
      mockClient._sendMessage({ type: 'stream_event', event: { type: 'content_block_stop' } })

      expect(sseEvents.filter(e => e.type === 'thinking_stop')).toHaveLength(0)
    })
  })

  describe('compaction status events', () => {
    it('broadcasts compact_start on early compacting status', () => {
      sseEvents.length = 0

      mockClient._sendMessage({
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

      mockClient._sendMessage({
        type: 'system',
        subtype: 'status',
        status: 'compacting',
        session_id: SESSION_ID,
        uuid: 'status-1',
      })

      mockClient._sendMessage({
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

    it('uses parent_tool_use_id as parentToolId for any sidechain message', () => {
      // Start a Bash tool (non-Task)
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

      // Sidechain message with parent_tool_use_id should use it as parentToolId
      mockClient._sendMessage({
        type: 'assistant',
        parent_tool_use_id: 'some-id',
        message: { role: 'assistant', content: [{ type: 'text', text: 'text' }] },
      })

      const subagentUpdated = sseEvents.filter(e => e.type === 'subagent_updated')
      expect(subagentUpdated.length).toBeGreaterThanOrEqual(1)
      expect(subagentUpdated[0].parentToolId).toBe('some-id')
    })
  })

  // ============================================================================
  // deliver_file tool-result correlation (ELECTRON-39)
  // ============================================================================

  describe('deliver_file tool_result_ready', () => {
    function streamDeliverFileToolUse(filePath: string, description?: string) {
      mockClient._sendMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'deliver-1', name: 'mcp__user-input__deliver_file' },
        },
      })
      const input = JSON.stringify(description ? { filePath, description } : { filePath })
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: input } },
      })
      mockClient._sendMessage({ type: 'stream_event', event: { type: 'content_block_stop' } })
    }

    it('broadcasts tool_result_ready with the validated path on a successful result', () => {
      streamDeliverFileToolUse('/workspace/out.txt', 'a report')
      sseEvents.length = 0

      mockClient._sendMessage({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'deliver-1', content: 'delivered' }] },
      })

      const ready = sseEvents.filter(e => e.type === 'tool_result_ready')
      expect(ready).toHaveLength(1)
      expect(ready[0].toolName).toBe('mcp__user-input__deliver_file')
      expect(ready[0].filePath).toBe('/workspace/out.txt')
      expect(ready[0].description).toBe('a report')
      expect(ready[0].isError).toBe(false)
    })

    it('marks tool_result_ready as an error when the in-container tool failed', () => {
      streamDeliverFileToolUse('/workspace/missing.txt')
      sseEvents.length = 0

      mockClient._sendMessage({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'deliver-1', content: 'not found', is_error: true }] },
      })

      const ready = sseEvents.filter(e => e.type === 'tool_result_ready')
      expect(ready).toHaveLength(1)
      expect(ready[0].isError).toBe(true)
    })

    it('does not broadcast tool_result_ready for an untracked tool_result', () => {
      mockClient._sendMessage({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'other-tool', content: 'result' }] },
      })

      const ready = sseEvents.filter(e => e.type === 'tool_result_ready')
      expect(ready).toHaveLength(0)
    })

    it('does not re-broadcast tool_result_ready for a duplicate tool_result', () => {
      streamDeliverFileToolUse('/workspace/out.txt')

      const sendResult = () => mockClient._sendMessage({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'deliver-1', content: 'delivered' }] },
      })

      sseEvents.length = 0
      sendResult()
      sendResult()

      const ready = sseEvents.filter(e => e.type === 'tool_result_ready')
      expect(ready).toHaveLength(1)
    })
  })

  // ============================================================================
  // Subagent completion detection
  // ============================================================================

  describe('subagent completion detection', () => {
    it('broadcasts subagent_completed when tool_result matches pendingTaskToolId', async () => {
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

      // task_started sets agentId deterministically
      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_started',
        task_id: 'sub1',
        tool_use_id: 'task-tool-1',
        description: 'test',
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

    // A background subagent (run_in_background Agent) gets only an immediate
    // "async_launched" tool_result; its real completion arrives as a
    // task_notification / task_updated, NOT a second tool_result or a sidechain
    // 'result'. Without handling these the UI shows it running until turn end.
    const startBackgroundSubagent = () => {
      // Stream the Agent tool_use WITH run_in_background so the persister marks
      // the subagent isBackground=true (the discriminator the completion handlers
      // gate on — foreground subagents finish via tool_result instead).
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'bg-tool', name: 'Agent' } },
      })
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"subagent_type":"general-purpose","run_in_background":true}' } },
      })
      mockClient._sendMessage({ type: 'stream_event', event: { type: 'content_block_stop' } })
      mockClient._sendMessage({
        type: 'system', subtype: 'task_started', task_id: 'bgsub', tool_use_id: 'bg-tool',
        subagent_type: 'general-purpose', description: 'Sleep 15 seconds',
      })
      sseEvents.length = 0
    }

    it('completes a background subagent on task_notification (matched by tool_use_id)', () => {
      startBackgroundSubagent()
      mockClient._sendMessage({
        type: 'system', subtype: 'task_notification', task_id: 'bgsub', tool_use_id: 'bg-tool',
        status: 'completed', summary: 'Agent "Sleep 15 seconds" completed',
      })
      const completed = sseEvents.filter(e => e.type === 'subagent_completed')
      expect(completed).toHaveLength(1)
      expect(completed[0].parentToolId).toBe('bg-tool')
      expect(completed[0].agentId).toBe('bgsub')
    })

    it('completes a background subagent on task_updated (matched by agentId)', () => {
      startBackgroundSubagent()
      mockClient._sendMessage({
        type: 'system', subtype: 'task_updated', task_id: 'bgsub', patch: { status: 'completed' },
      })
      const completed = sseEvents.filter(e => e.type === 'subagent_completed')
      expect(completed).toHaveLength(1)
      expect(completed[0].parentToolId).toBe('bg-tool')
    })

    it('fires subagent completion exactly once when task_updated is followed by task_notification', () => {
      startBackgroundSubagent()
      // The real capture emits task_updated then task_notification for the same
      // subagent — the second must not double-fire (the first removes it).
      mockClient._sendMessage({
        type: 'system', subtype: 'task_updated', task_id: 'bgsub', patch: { status: 'completed' },
      })
      mockClient._sendMessage({
        type: 'system', subtype: 'task_notification', task_id: 'bgsub', tool_use_id: 'bg-tool', status: 'completed',
      })
      expect(sseEvents.filter(e => e.type === 'subagent_completed')).toHaveLength(1)
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

  describe('subagent ID resolution (deterministic via task_started)', () => {
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

    it('resolves agentId from task_started.task_id', () => {
      setupTaskTool('task-tool-1')

      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_started',
        task_id: 'abc123',
        tool_use_id: 'task-tool-1',
        subagent_type: 'web-browser',
        description: 'Browse the web',
      })

      const started = sseEvents.filter(e => e.type === 'subagent_started')
      expect(started).toHaveLength(1)
      expect(started[0].agentId).toBe('abc123')
      expect(started[0].parentToolId).toBe('task-tool-1')
      expect(started[0].subagentType).toBe('web-browser')
    })

    it('resolves multiple parallel subagents deterministically', () => {
      setupTaskTool('tool-A')
      setupTaskTool('tool-B')

      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_started',
        task_id: 'abc123',
        tool_use_id: 'tool-A',
        description: 'First',
      })
      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_started',
        task_id: 'def456',
        tool_use_id: 'tool-B',
        description: 'Second',
      })

      const started = sseEvents.filter(e => e.type === 'subagent_started')
      expect(started).toHaveLength(2)
      expect(started[0].agentId).toBe('abc123')
      expect(started[0].parentToolId).toBe('tool-A')
      expect(started[1].agentId).toBe('def456')
      expect(started[1].parentToolId).toBe('tool-B')
    })

    it('agentId from sidechain message updates entry without filesystem', () => {
      setupTaskTool('task-tool-1')
      sseEvents.length = 0

      // Sidechain message arrives before task_started, with agentId on the message
      mockClient._sendMessage({
        type: 'assistant',
        parent_tool_use_id: 'task-tool-1',
        agentId: 'direct-id-123',
        message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
      })

      const updated = sseEvents.filter(e => e.type === 'subagent_updated' && e.agentId === 'direct-id-123')
      expect(updated.length).toBeGreaterThanOrEqual(1)
      expect(mockReaddir).not.toHaveBeenCalled()
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
      setupTaskTool()

      // task_started sets agentId deterministically
      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_started',
        task_id: 'sub1',
        tool_use_id: 'task-tool-1',
        description: 'test',
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

    it('sequential subagents each get their own agentId from task_started', () => {
      // First subagent
      setupTaskTool('task-tool-1')
      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_started',
        task_id: 'sub1',
        tool_use_id: 'task-tool-1',
        description: 'first',
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

      // Second subagent — gets its own agentId, no risk of reusing sub1
      setupTaskTool('task-tool-2')
      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_started',
        task_id: 'sub2',
        tool_use_id: 'task-tool-2',
        description: 'second',
      })

      const started = sseEvents.filter(e => e.type === 'subagent_started')
      expect(started).toHaveLength(1)
      expect(started[0].agentId).toBe('sub2')
      expect(started[0].parentToolId).toBe('task-tool-2')
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
      const updated = sseEvents.filter(e => e.type === 'subagent_updated' && e.agentId === 'direct-id-123')
      expect(updated.length).toBeGreaterThanOrEqual(1)
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
  // Sidechain complete assistant message broadcasts subagent_stream_delta
  // ============================================================================

  describe('sidechain complete assistant message text extraction', () => {
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

    it('broadcasts subagent_stream_delta for sidechain complete assistant message with text blocks', () => {
      setupTaskTool()
      sseEvents.length = 0

      // Send a complete assistant message (not streamed) with text content
      mockClient._sendMessage({
        type: 'assistant',
        parent_tool_use_id: 'task-tool-1',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Here is the analysis result.' },
          ],
        },
      })

      // Should broadcast subagent_stream_delta with the extracted text
      const deltas = sseEvents.filter(e => e.type === 'subagent_stream_delta')
      expect(deltas.length).toBeGreaterThanOrEqual(1)
      expect(deltas[0].text).toBe('Here is the analysis result.')
      expect(deltas[0].parentToolId).toBe('task-tool-1')
    })

    it('extracts and concatenates multiple text blocks from complete assistant message', () => {
      setupTaskTool()
      sseEvents.length = 0

      mockClient._sendMessage({
        type: 'assistant',
        parent_tool_use_id: 'task-tool-1',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Part one. ' },
            { type: 'tool_use', id: 'sub-tool', name: 'Bash', input: {} },
            { type: 'text', text: 'Part two.' },
          ],
        },
      })

      const deltas = sseEvents.filter(e => e.type === 'subagent_stream_delta')
      expect(deltas.length).toBeGreaterThanOrEqual(1)
      // The full concatenated text includes both text blocks
      const allText = deltas.map(d => d.text).join('')
      expect(allText).toBe('Part one. Part two.')
    })
  })

  // ============================================================================
  // Subagent completion includes resultText
  // ============================================================================

  describe('subagent completion resultText', () => {
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

    it('includes resultText in subagent_completed SSE event from tool_result string content', () => {
      setupTaskTool()
      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_started',
        task_id: 'sub1',
        tool_use_id: 'task-tool-1',
        description: 'test',
      })

      sseEvents.length = 0

      // Send tool_result with string content (the exit summary)
      mockClient._sendMessage({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'task-tool-1', content: 'All tasks completed successfully.' },
          ],
        },
      })

      const completed = sseEvents.filter(e => e.type === 'subagent_completed')
      expect(completed).toHaveLength(1)
      expect(completed[0].resultText).toBe('All tasks completed successfully.')
    })

    it('includes resultText in subagent_completed from tool_result array content', () => {
      setupTaskTool()
      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_started',
        task_id: 'sub1',
        tool_use_id: 'task-tool-1',
        description: 'test',
      })

      sseEvents.length = 0

      mockClient._sendMessage({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'task-tool-1',
              content: [
                { type: 'text', text: 'First part. ' },
                { type: 'text', text: 'Second part.' },
              ],
            },
          ],
        },
      })

      const completed = sseEvents.filter(e => e.type === 'subagent_completed')
      expect(completed).toHaveLength(1)
      expect(completed[0].resultText).toBe('First part. Second part.')
    })

    it('omits resultText when tool_result has no text content', () => {
      setupTaskTool()
      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_started',
        task_id: 'sub1',
        tool_use_id: 'task-tool-1',
        description: 'test',
      })

      sseEvents.length = 0

      // tool_result with no content
      mockClient._sendMessage({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'task-tool-1' },
          ],
        },
      })

      const completed = sseEvents.filter(e => e.type === 'subagent_completed')
      expect(completed).toHaveLength(1)
      // resultText should not be set (spread is conditional on truthy value)
      expect(completed[0].resultText).toBeUndefined()
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

    // The persister always fires the trigger; the renderer's notification
    // gate decides whether to actually show the OS popup (it knows focus,
    // per-user viewing, and the `notifyWhenUnfocused` toggle). An SSE
    // viewer being attached does NOT suppress the trigger here.
    it('triggers notification regardless of whether viewers are attached', async () => {
      const { notificationManager } = await import('@shared/lib/notifications/notification-manager')

      sseEvents.length = 0
      vi.mocked(notificationManager.triggerSessionWaitingInput).mockClear()

      // SSE client IS attached — trigger should still fire.
      simulateRemoteMcpToolUse('mcp-notify', {
        url: 'https://mcp.example.com/mcp',
      })

      expect(notificationManager.triggerSessionWaitingInput).toHaveBeenCalledWith(
        SESSION_ID,
        AGENT_SLUG,
        'remote_mcp'
      )
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

  // ============================================================================
  // Context usage tracking
  // ============================================================================

  describe('context usage from assistant messages', () => {
    it('broadcasts context_usage when assistant message includes usage data', () => {
      mockClient._sendMessage({
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
      mockClient._sendMessage({
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
      mockClient._sendMessage({
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
      mockClient._sendMessage({
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

      mockClient._sendMessage({
        type: 'result',
        subtype: 'success',
        modelUsage: { 'gpt-5.5': { inputTokens: 100, outputTokens: 10 } },
      })

      const usageEvents = sseEvents.filter((e) => e.type === 'context_usage')
      expect(usageEvents.at(-1)).toMatchObject({ contextWindow: 1_050_000 })
    })

    it('prefers the catalog window over the SDK default for a listed non-Claude model', () => {
      mockGetSettings.mockReturnValue({ llmProvider: 'platform' })
      seedAssistantUsage()
      sseEvents.length = 0

      // The SDK reports a generic 200K default for gpt; the catalog (1.05M) wins.
      mockClient._sendMessage({
        type: 'result',
        subtype: 'success',
        modelUsage: { 'gpt-5.5': { contextWindow: 200_000 } },
      })

      const usageEvents = sseEvents.filter((e) => e.type === 'context_usage')
      expect(usageEvents.at(-1)).toMatchObject({ contextWindow: 1_050_000 })
    })

    it('uses the SDK window for Claude (no catalog window) — e.g. 1M opus', () => {
      mockGetSettings.mockReturnValue({ llmProvider: 'platform' })
      seedAssistantUsage()
      sseEvents.length = 0

      mockClient._sendMessage({
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

      mockClient._sendMessage({
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
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'message_start' },
      })

      sseEvents.length = 0

      mockClient._sendMessage({
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
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'message_start' },
      })

      sseEvents.length = 0

      mockClient._sendMessage({
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
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'message_start' },
      })

      sseEvents.length = 0

      mockClient._sendMessage({
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
      mockClient._sendMessage({
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
      mockClient._sendMessage({
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
      mockClient._sendMessage({
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

      mockClient._sendMessage({
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
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'message_start' },
      })

      sseEvents.length = 0

      mockClient._sendMessage({
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
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'message_start' },
      })

      sseEvents.length = 0

      mockClient._sendMessage({
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
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'message_start' },
      })
      mockClient._sendMessage({
        type: 'stream_event',
        event: {
          type: 'message_delta',
          usage: { input_tokens: 1000, output_tokens: 100 },
        },
      })

      // Turn 2 (context grows)
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'message_start' },
      })
      mockClient._sendMessage({
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
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'message_start' },
      })
      mockClient._sendMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'tool-1', name: 'Agent' },
        },
      })
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_stop' },
      })

      sseEvents.length = 0

      // Sidechain message_delta (has parent_tool_use_id)
      mockClient._sendMessage({
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

  // ============================================================================
  // Awaiting input status tracking
  // ============================================================================

  describe('awaiting input status tracking', () => {
    // Helper to collect global notification events
    function collectGlobalEvents(): { events: any[]; cleanup: () => void } {
      const events: any[] = []
      const cleanup = messagePersister.addGlobalNotificationClient((data) => {
        events.push(data)
      })
      return { events, cleanup }
    }

    // Helper to simulate a complete tool_use block
    function simulateToolUse(toolName: string, toolId: string, input: Record<string, unknown>) {
      mockClient._sendMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: toolId, name: toolName },
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

    it('isSessionAwaitingInput returns false initially', () => {
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
    })

    it('sets isAwaitingInput after request_secret tool fires', () => {
      simulateToolUse('mcp__user-input__request_secret', 'tool-1', {
        secretName: 'API_KEY',
        reason: 'Need it',
      })

      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)
    })

    it('sets isAwaitingInput after AskUserQuestion tool fires', () => {
      simulateToolUse('AskUserQuestion', 'tool-1', {
        questions: [{ question: 'Pick DB', header: 'DB', options: [], multiSelect: false }],
      })

      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)
    })

    it('sets isAwaitingInput after request_connected_account tool fires', () => {
      simulateToolUse('mcp__user-input__request_connected_account', 'tool-1', {
        toolkit: 'github',
        reason: 'Need access',
      })

      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)
    })

    it('sets isAwaitingInput after request_file tool fires', () => {
      simulateToolUse('mcp__user-input__request_file', 'tool-1', {
        description: 'Upload a CSV',
      })

      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)
    })

    it('sets isAwaitingInput after request_remote_mcp tool fires', () => {
      simulateToolUse('mcp__user-input__request_remote_mcp', 'tool-1', {
        url: 'https://example.com/mcp',
      })

      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)
    })

    it('sets isAwaitingInput after request_browser_input tool fires', () => {
      simulateToolUse('mcp__user-input__request_browser_input', 'tool-1', {
        message: 'Please log in',
        requirements: ['Enter credentials'],
      })

      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)
    })

    it('does NOT set isAwaitingInput for schedule_task tool', () => {
      simulateToolUse('mcp__user-input__schedule_task', 'tool-1', {
        scheduleType: 'at',
        scheduleExpression: '2026-03-20T10:00:00Z',
        prompt: 'Do something',
      })

      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
    })

    it('does NOT set isAwaitingInput for deliver_file tool', () => {
      simulateToolUse('mcp__user-input__deliver_file', 'tool-1', {
        filePath: '/tmp/output.csv',
        description: 'Results',
      })

      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
    })

    it('does NOT set isAwaitingInput for non-user-input tools', () => {
      simulateToolUse('Bash', 'tool-1', { command: 'ls' })

      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
    })

    it('broadcasts session_awaiting_input globally when status transitions', () => {
      const { events: globalEvents, cleanup: globalCleanup } = collectGlobalEvents()

      simulateToolUse('mcp__user-input__request_secret', 'tool-1', {
        secretName: 'KEY',
      })

      const awaitingEvents = globalEvents.filter(e => e.type === 'session_awaiting_input')
      expect(awaitingEvents).toHaveLength(1)
      expect(awaitingEvents[0].sessionId).toBe(SESSION_ID)
      expect(awaitingEvents[0].agentSlug).toBe(AGENT_SLUG)

      globalCleanup()
    })

    it('emits session_awaiting_input on the per-session SSE stream (not only global)', () => {
      // The chat-integration-manager is a per-session SSE subscriber, so the
      // awaiting signal must reach the per-session stream for it to settle the
      // working indicator off the generic signal — global-only left it blind.
      const { events: globalEvents, cleanup: globalCleanup } = collectGlobalEvents()

      simulateToolUse('mcp__user-input__request_secret', 'tool-1', { secretName: 'KEY' })

      const perSession = sseEvents.filter(e => e.type === 'session_awaiting_input')
      expect(perSession).toHaveLength(1)
      expect(perSession[0].sessionId).toBe(SESSION_ID)
      expect(perSession[0].agentSlug).toBe(AGENT_SLUG)

      // Existing global consumers (sidebar / promotion) must still receive it.
      const global = globalEvents.filter(e => e.type === 'session_awaiting_input')
      expect(global).toHaveLength(1)

      globalCleanup()
    })

    it('does not double-broadcast when already awaiting input', () => {
      const { events: globalEvents, cleanup: globalCleanup } = collectGlobalEvents()

      // Fire two user-input tools in sequence
      simulateToolUse('mcp__user-input__request_secret', 'tool-1', { secretName: 'KEY1' })
      simulateToolUse('mcp__user-input__request_file', 'tool-2', { description: 'CSV' })

      const awaitingEvents = globalEvents.filter(e => e.type === 'session_awaiting_input')
      // Should only broadcast once (first transition)
      expect(awaitingEvents).toHaveLength(1)

      globalCleanup()
    })

    it('clears isAwaitingInput when tool result arrives (user message)', () => {
      messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)

      simulateToolUse('mcp__user-input__request_secret', 'tool-1', { secretName: 'KEY' })
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

      // Simulate tool result arriving as a user message
      mockClient._sendMessage({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'secret-value' },
          ],
        },
      })

      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
    })

    it('broadcasts session_input_provided globally when input is received', () => {
      messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)

      simulateToolUse('mcp__user-input__request_secret', 'tool-1', { secretName: 'KEY' })

      const { events: globalEvents, cleanup: globalCleanup } = collectGlobalEvents()

      // Simulate tool result
      mockClient._sendMessage({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'value' },
          ],
        },
      })

      const providedEvents = globalEvents.filter(e => e.type === 'session_input_provided')
      expect(providedEvents).toHaveLength(1)
      expect(providedEvents[0].sessionId).toBe(SESSION_ID)
      expect(providedEvents[0].agentSlug).toBe(AGENT_SLUG)

      globalCleanup()
    })

    it('clears isAwaitingInput when session goes idle (result event)', () => {
      messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)

      simulateToolUse('mcp__user-input__request_secret', 'tool-1', { secretName: 'KEY' })
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

      // Simulate session completing
      mockClient._sendMessage({
        type: 'result',
        subtype: 'success',
      })

      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
    })

    it('clears isAwaitingInput when session is interrupted', async () => {
      messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)

      simulateToolUse('mcp__user-input__request_secret', 'tool-1', { secretName: 'KEY' })
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

      await messagePersister.markSessionInterrupted(SESSION_ID)

      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
    })

    it('clears isAwaitingInput when new user message starts (markSessionActive)', () => {
      simulateToolUse('mcp__user-input__request_secret', 'tool-1', { secretName: 'KEY' })
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

      // New message starts a new turn
      messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)

      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
    })

    it('returns false for unknown session IDs', () => {
      expect(messagePersister.isSessionAwaitingInput('nonexistent-session')).toBe(false)
    })
  })

  // ============================================================================
  // Automated session promotion
  // ============================================================================

  describe('automated session promotion', () => {
    function collectGlobalEvents(): { events: any[]; cleanup: () => void } {
      const events: any[] = []
      const cleanup = messagePersister.addGlobalNotificationClient((data) => {
        events.push(data)
      })
      return { events, cleanup }
    }

    function simulateToolUse(toolName: string, toolId: string, input: Record<string, unknown>) {
      mockClient._sendMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: toolId, name: toolName },
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

    it('promotes a scheduled session when user input is requested', async () => {
      vi.mocked(getSessionMetadata).mockResolvedValueOnce({
        isScheduledExecution: true,
        scheduledTaskId: 'task-1',
      })

      simulateToolUse('AskUserQuestion', 'tool-1', {
        questions: [{ question: 'Pick?', header: 'Q', options: [], multiSelect: false }],
      })

      // Let the async promotion complete
      await vi.waitFor(() => {
        expect(updateSessionMetadata).toHaveBeenCalledWith(
          AGENT_SLUG,
          SESSION_ID,
          { promotedToInteractive: true },
        )
      })
    })

    it('promotes a webhook session when user input is requested', async () => {
      vi.mocked(getSessionMetadata).mockResolvedValueOnce({
        isWebhookExecution: true,
        webhookTriggerId: 'trigger-1',
      })

      simulateToolUse('mcp__user-input__request_secret', 'tool-1', {
        secretName: 'API_KEY',
        reason: 'Need it',
      })

      await vi.waitFor(() => {
        expect(updateSessionMetadata).toHaveBeenCalledWith(
          AGENT_SLUG,
          SESSION_ID,
          { promotedToInteractive: true },
        )
      })
    })

    it('promotes a chat integration session when user input is requested', async () => {
      vi.mocked(getSessionMetadata).mockResolvedValueOnce({
        isChatIntegrationSession: true,
        chatIntegrationId: 'chat-1',
      })

      simulateToolUse('mcp__user-input__request_file', 'tool-1', {
        description: 'Upload a file',
      })

      await vi.waitFor(() => {
        expect(updateSessionMetadata).toHaveBeenCalledWith(
          AGENT_SLUG,
          SESSION_ID,
          { promotedToInteractive: true },
        )
      })
    })

    it('does not promote a regular (non-automated) session', async () => {
      vi.mocked(getSessionMetadata).mockResolvedValueOnce({
        name: 'Regular session',
      })

      simulateToolUse('AskUserQuestion', 'tool-1', {
        questions: [{ question: 'Pick?', header: 'Q', options: [], multiSelect: false }],
      })

      // Give the async code a chance to run
      await new Promise((r) => setTimeout(r, 50))

      expect(updateSessionMetadata).not.toHaveBeenCalled()
    })

    it('does not double-promote an already promoted session', async () => {
      vi.mocked(getSessionMetadata).mockResolvedValueOnce({
        isScheduledExecution: true,
        scheduledTaskId: 'task-1',
        promotedToInteractive: true,
      })

      simulateToolUse('AskUserQuestion', 'tool-1', {
        questions: [{ question: 'Pick?', header: 'Q', options: [], multiSelect: false }],
      })

      await new Promise((r) => setTimeout(r, 50))

      expect(updateSessionMetadata).not.toHaveBeenCalled()
    })

    it('re-broadcasts session_awaiting_input after promotion so sidebar refetches', async () => {
      vi.mocked(getSessionMetadata).mockResolvedValueOnce({
        isScheduledExecution: true,
        scheduledTaskId: 'task-1',
      })

      const { events: globalEvents, cleanup: globalCleanup } = collectGlobalEvents()

      simulateToolUse('AskUserQuestion', 'tool-1', {
        questions: [{ question: 'Pick?', header: 'Q', options: [], multiSelect: false }],
      })

      await vi.waitFor(() => {
        expect(updateSessionMetadata).toHaveBeenCalled()
      })

      const awaitingEvents = globalEvents.filter(e => e.type === 'session_awaiting_input')
      // First broadcast is immediate (before promotion), second is after metadata update
      expect(awaitingEvents.length).toBeGreaterThanOrEqual(2)

      globalCleanup()
    })

    it('promotion re-emit stays global-only (never reaches the per-session stream)', async () => {
      // The promotion re-broadcast runs asynchronously after the user may have
      // already answered and the chat indicator re-armed. If it reached the
      // per-session stream it would stale-settle a live indicator, so it must
      // stay global: the per-session stream sees the awaiting signal exactly once.
      vi.mocked(getSessionMetadata).mockResolvedValueOnce({
        isScheduledExecution: true,
        scheduledTaskId: 'task-1',
      })

      const { events: globalEvents, cleanup: globalCleanup } = collectGlobalEvents()

      simulateToolUse('AskUserQuestion', 'tool-1', {
        questions: [{ question: 'Pick?', header: 'Q', options: [], multiSelect: false }],
      })

      await vi.waitFor(() => {
        expect(updateSessionMetadata).toHaveBeenCalled()
      })

      // Global got the initial mark + the promotion re-emit (≥2)...
      const global = globalEvents.filter(e => e.type === 'session_awaiting_input')
      expect(global.length).toBeGreaterThanOrEqual(2)
      // ...but the per-session stream got only the initial mark (exactly 1).
      const perSession = sseEvents.filter(e => e.type === 'session_awaiting_input')
      expect(perSession).toHaveLength(1)

      globalCleanup()
    })
  })

  // ============================================================================
  // Script run request detection
  // ============================================================================

  describe('Script run request detection', () => {
    // Use existing simulateToolUse helper (already defined above in awaiting input tests)
    // Re-define locally since the other is scoped to that describe block
    function simulateToolUse(toolName: string, toolId: string, input: Record<string, unknown>) {
      mockClient._sendMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: toolId, name: toolName },
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

    it('broadcasts script_run_request with autoApproved:false when permission needed', () => {
      mockCheckPermission.mockReturnValue('prompt_needed')
      sseEvents.length = 0

      simulateToolUse('mcp__user-input__request_script_run', 'tool-sr-1', {
        script: 'sw_vers',
        explanation: 'Check macOS version',
        scriptType: 'shell',
      })

      const scriptEvents = sseEvents.filter(e => e.type === 'script_run_request')
      expect(scriptEvents).toHaveLength(1)
      expect(scriptEvents[0]).toMatchObject({
        type: 'script_run_request',
        toolUseId: 'tool-sr-1',
        script: 'sw_vers',
        explanation: 'Check macOS version',
        scriptType: 'shell',
        agentSlug: AGENT_SLUG,
        autoApproved: false,
      })
    })

    it('auto-executes AND broadcasts with autoApproved:true when use_host_shell granted', async () => {
      const { notificationManager } = await import('@shared/lib/notifications/notification-manager')
      mockCheckPermission.mockReturnValue('granted')
      sseEvents.length = 0
      const fetchMock = vi.fn(() => Promise.resolve({ ok: true } as Response))
      vi.stubGlobal('fetch', fetchMock)
      const triggerSpy = vi.mocked(notificationManager.triggerSessionWaitingInput)
      triggerSpy.mockClear()

      simulateToolUse('mcp__user-input__request_script_run', 'tool-sr-granted', {
        script: 'sw_vers',
        explanation: 'Check macOS version',
        scriptType: 'shell',
      })

      // Broadcast still happens, but flagged as auto-approved so the UI can suppress its prompt.
      const scriptEvents = sseEvents.filter(e => e.type === 'script_run_request')
      expect(scriptEvents).toHaveLength(1)
      expect(scriptEvents[0]).toMatchObject({
        type: 'script_run_request',
        toolUseId: 'tool-sr-granted',
        autoApproved: true,
      })

      // No "user attention required" notification when auto-approved.
      expect(triggerSpy).not.toHaveBeenCalled()

      // Posted to internal /run-script endpoint with the script payload.
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toContain(`/api/agents/${AGENT_SLUG}/sessions/_auto/run-script`)
      expect(init.method).toBe('POST')
      const body = JSON.parse(init.body as string)
      expect(body).toEqual({
        toolUseId: 'tool-sr-granted',
        script: 'sw_vers',
        scriptType: 'shell',
      })

      vi.unstubAllGlobals()
    })

    it('broadcasts script_run_request even without prior permission (prompts user)', () => {
      mockCheckPermission.mockReturnValue('prompt_needed')
      sseEvents.length = 0

      simulateToolUse('mcp__user-input__request_script_run', 'tool-sr-2', {
        script: 'sw_vers',
        explanation: 'Check version',
        scriptType: 'shell',
      })

      // Should broadcast to SSE for user approval (no cached permission → prompt user)
      const scriptEvents = sseEvents.filter(e => e.type === 'script_run_request')
      expect(scriptEvents).toHaveLength(1)
    })

    it('does not broadcast when script is missing from input', () => {
      mockCheckPermission.mockReturnValue('prompt_needed')
      sseEvents.length = 0

      simulateToolUse('mcp__user-input__request_script_run', 'tool-sr-4', {
        explanation: 'Check version',
        scriptType: 'shell',
      })

      const scriptEvents = sseEvents.filter(e => e.type === 'script_run_request')
      expect(scriptEvents).toHaveLength(0)
    })

    it('does not broadcast when scriptType is missing', () => {
      mockCheckPermission.mockReturnValue('prompt_needed')
      sseEvents.length = 0

      simulateToolUse('mcp__user-input__request_script_run', 'tool-sr-5', {
        script: 'sw_vers',
        explanation: 'Check version',
      })

      const scriptEvents = sseEvents.filter(e => e.type === 'script_run_request')
      expect(scriptEvents).toHaveLength(0)
    })

    it('sets isAwaitingInput after request_script_run tool fires (prompt path)', () => {
      mockCheckPermission.mockReturnValue('prompt_needed')

      simulateToolUse('mcp__user-input__request_script_run', 'tool-sr-6', {
        script: 'sw_vers',
        explanation: 'Check version',
        scriptType: 'shell',
      })

      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)
    })

    it('does NOT set isAwaitingInput when use_host_shell is auto-approved', () => {
      mockCheckPermission.mockReturnValue('granted')
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true } as Response)))

      simulateToolUse('mcp__user-input__request_script_run', 'tool-sr-auto-status', {
        script: 'sw_vers',
        explanation: 'Check version',
        scriptType: 'shell',
      })

      // Auto-approved scripts must not flip the global awaiting-input flag — that's
      // what drives the orange agent-status indicator.
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
      vi.unstubAllGlobals()
    })
  })

  // ============================================================================
  // API error code tracking (apiErrorCode in session_error)
  // ============================================================================

  describe('API error code tracking', () => {
    it('captures error code from assistant message and includes it in session_error', () => {
      messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)
      sseEvents.length = 0

      // SDK sends assistant message with error field (e.g., auth failure)
      mockClient._sendMessage({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Invalid API key' }] },
        error: 'authentication_failed',
      })

      // SDK sends error result
      mockClient._sendMessage({
        type: 'result',
        subtype: 'error_during_execution',
        error: 'Invalid API key',
        errors: ['Invalid API key'],
        is_error: true,
        duration_ms: 100,
        num_turns: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      })

      const errorEvents = sseEvents.filter(e => e.type === 'session_error')
      expect(errorEvents).toHaveLength(1)
      expect(errorEvents[0].apiErrorCode).toBe('authentication_failed')
      expect(errorEvents[0].error).toBe('Invalid API key')
    })

    it('broadcasts session_error with null apiErrorCode when no assistant error preceded', () => {
      messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)
      sseEvents.length = 0

      // Error result without a preceding assistant message error
      mockClient._sendMessage({
        type: 'result',
        subtype: 'error',
        error: 'The agent process was terminated unexpectedly.',
        is_error: true,
        duration_ms: 0,
        num_turns: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      })

      const errorEvents = sseEvents.filter(e => e.type === 'session_error')
      expect(errorEvents).toHaveLength(1)
      expect(errorEvents[0].apiErrorCode).toBeNull()
    })

    it('clears lastApiErrorCode on new user message', () => {
      messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)

      // First turn: assistant with error
      mockClient._sendMessage({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Rate limited' }] },
        error: 'rate_limit',
      })
      mockClient._sendMessage({
        type: 'result',
        subtype: 'error_during_execution',
        error: 'Rate limited',
        errors: ['Rate limited'],
        is_error: true,
        duration_ms: 100,
        num_turns: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      })

      // New user message clears the error code
      messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)
      sseEvents.length = 0

      // Second turn: different error without assistant error field
      mockClient._sendMessage({
        type: 'result',
        subtype: 'error',
        error: 'Process killed',
        is_error: true,
        duration_ms: 0,
        num_turns: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      })

      const errorEvents = sseEvents.filter(e => e.type === 'session_error')
      expect(errorEvents).toHaveLength(1)
      expect(errorEvents[0].apiErrorCode).toBeNull()
    })

    it('broadcasts stream_api_error when text was already streaming', () => {
      messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)

      // Simulate SDK streaming text before the error
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'message_start' },
      })
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Some text' } },
      })
      sseEvents.length = 0

      // Complete assistant message with error
      mockClient._sendMessage({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Some text' }] },
        error: 'rate_limit',
      })

      const apiErrorEvents = sseEvents.filter(e => e.type === 'stream_api_error')
      expect(apiErrorEvents).toHaveLength(1)
      expect(apiErrorEvents[0].apiErrorCode).toBe('rate_limit')
      // Should NOT broadcast a stream_delta (to avoid duplicating text)
      const deltas = sseEvents.filter(e => e.type === 'stream_delta')
      expect(deltas).toHaveLength(0)
    })

    it('broadcasts stream_delta with apiErrorCode when no text was streaming', () => {
      messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)
      sseEvents.length = 0

      // Complete assistant message with error (no prior streaming)
      mockClient._sendMessage({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Invalid API key' }] },
        error: 'authentication_failed',
      })

      const deltas = sseEvents.filter(e => e.type === 'stream_delta')
      expect(deltas).toHaveLength(1)
      expect(deltas[0].text).toBe('Invalid API key')
      expect(deltas[0].apiErrorCode).toBe('authentication_failed')
      // Should NOT broadcast stream_api_error
      const apiErrorEvents = sseEvents.filter(e => e.type === 'stream_api_error')
      expect(apiErrorEvents).toHaveLength(0)
    })
  })

  // ============================================================================
  // Webhook trigger tool handling
  // ============================================================================

  describe('webhook trigger tool handling', () => {
    function collectGlobalEvents(): { events: any[]; cleanup: () => void } {
      const events: any[] = []
      const cleanup = messagePersister.addGlobalNotificationClient((data) => {
        events.push(data)
      })
      return { events, cleanup }
    }

    function simulateToolUse(toolName: string, toolId: string, input: Record<string, unknown>) {
      mockClient._sendMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: toolId, name: toolName },
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

    // Helper to set up the db.select() mock chain for connected account lookups
    function mockDbSelectAccount(account: { id: string; providerConnectionId: string; providerName: string; toolkitSlug: string } | null) {
      const result = account ? [account] : []
      mockDbSelect.mockReturnValue({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(result),
          }),
        }),
      })
    }

    // Wait for the fire-and-forget handler to resolve or reject the exact
    // blocking tool input this test emitted. Fixed sleeps were flaky under
    // coverage instrumentation because the async handler chains DB and service
    // promises before calling the container.
    async function flushHandlers(expectedPath: string) {
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        const call = mockContainerClientFetch.mock.calls.find((c) => c[0] === expectedPath)
        if (call) return call
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const paths = mockContainerClientFetch.mock.calls.map((c) => String(c[0])).join(', ')
      throw new Error(`Timed out waiting for ${expectedPath}; observed container fetches: ${paths || '<none>'}`)
    }

    beforeEach(() => {
      mockContainerClientFetch.mockClear()
      mockCreateWebhookTrigger.mockClear()
      mockCancelWebhookTriggerWithCleanup.mockClear()
      mockGetAvailableTriggers.mockClear()
      mockEnableComposioTrigger.mockClear()
      mockDeleteComposioTrigger.mockClear()
      mockListActiveWebhookTriggers.mockClear()
      mockDbSelect.mockClear()

      mockIsPlatformComposioActive.mockReturnValue(true)
      mockContainerClientFetch.mockResolvedValue({ ok: true })
      mockCreateWebhookTrigger.mockResolvedValue('trigger_new_id')
      mockCancelWebhookTriggerWithCleanup.mockResolvedValue(true)
      mockGetAvailableTriggers.mockResolvedValue([
        { slug: 'GMAIL_NEW_EMAIL', name: 'New Email', description: 'Fires on new email', type: 'webhook' },
        { slug: 'SLACK_NEW_MESSAGE', name: 'New Message', description: 'Fires on new Slack message', type: 'webhook' },
      ])
      mockDbSelectAccount({ id: 'ca_1', providerConnectionId: 'composio_ca_1', providerName: 'composio', toolkitSlug: 'gmail' })
    })

    describe('setup_trigger', () => {
      it('broadcasts webhook_trigger_created on success', async () => {
        const { events: globalEvents, cleanup: globalCleanup } = collectGlobalEvents()
        sseEvents.length = 0

        simulateToolUse('mcp__user-input__setup_trigger', 'tool-setup-1', {
          connected_account_id: 'ca_1',
          trigger_type: 'GMAIL_NEW_EMAIL',
          prompt: 'Summarize this email',
          name: 'Email Handler',
        })

        await flushHandlers('/inputs/tool-setup-1/resolve')

        const sseCreated = sseEvents.filter(e => e.type === 'webhook_trigger_created')
        expect(sseCreated).toHaveLength(1)
        expect(sseCreated[0].triggerId).toBe('trigger_new_id')
        expect(sseCreated[0].triggerType).toBe('GMAIL_NEW_EMAIL')
        expect(sseCreated[0].name).toBe('Email Handler')
        expect(sseCreated[0].agentSlug).toBe(AGENT_SLUG)

        const globalCreated = globalEvents.filter(e => e.type === 'webhook_trigger_created')
        expect(globalCreated).toHaveLength(1)
        expect(globalCreated[0].triggerId).toBe('trigger_new_id')

        // Verify resolve was called
        expect(mockContainerClientFetch).toHaveBeenCalledWith(
          '/inputs/tool-setup-1/resolve',
          expect.objectContaining({ method: 'POST' }),
        )

        globalCleanup()
      })

      it('validates trigger type against available triggers', async () => {
        sseEvents.length = 0

        simulateToolUse('mcp__user-input__setup_trigger', 'tool-setup-bad', {
          connected_account_id: 'ca_1',
          trigger_type: 'NONEXISTENT_TRIGGER',
          prompt: 'Test',
        })

        await flushHandlers('/inputs/tool-setup-bad/reject')

        // Should reject with helpful error
        expect(mockContainerClientFetch).toHaveBeenCalledWith(
          '/inputs/tool-setup-bad/reject',
          expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining('Invalid trigger type'),
          }),
        )

        // Should NOT broadcast creation
        const sseCreated = sseEvents.filter(e => e.type === 'webhook_trigger_created')
        expect(sseCreated).toHaveLength(0)
      })

      it('rejects when platform Composio is not active', async () => {
        mockIsPlatformComposioActive.mockReturnValue(false)
        sseEvents.length = 0

        simulateToolUse('mcp__user-input__setup_trigger', 'tool-setup-noplatform', {
          connected_account_id: 'ca_1',
          trigger_type: 'GMAIL_NEW_EMAIL',
          prompt: 'Test',
        })

        await flushHandlers('/inputs/tool-setup-noplatform/reject')

        expect(mockContainerClientFetch).toHaveBeenCalledWith(
          '/inputs/tool-setup-noplatform/reject',
          expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining('only available with platform Composio'),
          }),
        )
      })

      it('rejects when connected account not found', async () => {
        mockDbSelectAccount(null)
        sseEvents.length = 0

        simulateToolUse('mcp__user-input__setup_trigger', 'tool-setup-noaccount', {
          connected_account_id: 'ca_nonexistent',
          trigger_type: 'GMAIL_NEW_EMAIL',
          prompt: 'Test',
        })

        await flushHandlers('/inputs/tool-setup-noaccount/reject')

        expect(mockContainerClientFetch).toHaveBeenCalledWith(
          '/inputs/tool-setup-noaccount/reject',
          expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining('not found'),
          }),
        )
      })

      it('rolls back Composio trigger if SQLite save fails', async () => {
        mockCreateWebhookTrigger.mockRejectedValue(new Error('DB write failed'))
        sseEvents.length = 0

        simulateToolUse('mcp__user-input__setup_trigger', 'tool-setup-dbfail', {
          connected_account_id: 'ca_1',
          trigger_type: 'GMAIL_NEW_EMAIL',
          prompt: 'Test',
        })

        await flushHandlers('/inputs/tool-setup-dbfail/reject')

        expect(mockEnableComposioTrigger).toHaveBeenCalled()
        expect(mockDeleteComposioTrigger).toHaveBeenCalledWith('composio_trigger_id')

        expect(mockContainerClientFetch).toHaveBeenCalledWith(
          '/inputs/tool-setup-dbfail/reject',
          expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining('Failed to save trigger locally'),
          }),
        )
      })
    })

    describe('cancel_trigger', () => {
      it('broadcasts webhook_trigger_cancelled on success', async () => {
        const { events: globalEvents, cleanup: globalCleanup } = collectGlobalEvents()
        sseEvents.length = 0

        simulateToolUse('mcp__user-input__cancel_trigger', 'tool-cancel-1', {
          trigger_id: 'trigger_existing',
        })

        await flushHandlers('/inputs/tool-cancel-1/resolve')

        const sseCancelled = sseEvents.filter(e => e.type === 'webhook_trigger_cancelled')
        expect(sseCancelled).toHaveLength(1)
        expect(sseCancelled[0].triggerId).toBe('trigger_existing')
        expect(sseCancelled[0].agentSlug).toBe(AGENT_SLUG)

        const globalCancelled = globalEvents.filter(e => e.type === 'webhook_trigger_cancelled')
        expect(globalCancelled).toHaveLength(1)

        expect(mockContainerClientFetch).toHaveBeenCalledWith(
          '/inputs/tool-cancel-1/resolve',
          expect.objectContaining({ method: 'POST' }),
        )

        globalCleanup()
      })

      it('rejects when trigger not found or already cancelled', async () => {
        mockCancelWebhookTriggerWithCleanup.mockResolvedValue(false)
        sseEvents.length = 0

        simulateToolUse('mcp__user-input__cancel_trigger', 'tool-cancel-notfound', {
          trigger_id: 'trigger_gone',
        })

        await flushHandlers('/inputs/tool-cancel-notfound/reject')

        expect(mockContainerClientFetch).toHaveBeenCalledWith(
          '/inputs/tool-cancel-notfound/reject',
          expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining('not found or already cancelled'),
          }),
        )

        const sseCancelled = sseEvents.filter(e => e.type === 'webhook_trigger_cancelled')
        expect(sseCancelled).toHaveLength(0)
      })

      it('rejects when trigger_id is missing', async () => {
        sseEvents.length = 0

        simulateToolUse('mcp__user-input__cancel_trigger', 'tool-cancel-noid', {})

        await flushHandlers('/inputs/tool-cancel-noid/reject')

        expect(mockContainerClientFetch).toHaveBeenCalledWith(
          '/inputs/tool-cancel-noid/reject',
          expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining('Missing required field'),
          }),
        )
      })
    })

    describe('list_triggers', () => {
      it('resolves with formatted trigger list', async () => {
        mockListActiveWebhookTriggers.mockResolvedValue([
          {
            id: 't1', name: 'Email Handler', triggerType: 'GMAIL_NEW_EMAIL',
            connectedAccountId: 'ca_1', fireCount: 3, prompt: 'Summarize email',
          },
          {
            id: 't2', name: null, triggerType: 'SLACK_NEW_MESSAGE',
            connectedAccountId: 'ca_2', fireCount: 0, prompt: 'Handle slack message',
          },
        ])

        simulateToolUse('mcp__user-input__list_triggers', 'tool-list-1', {})

        await flushHandlers('/inputs/tool-list-1/resolve')

        expect(mockContainerClientFetch).toHaveBeenCalledWith(
          '/inputs/tool-list-1/resolve',
          expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining('Email Handler'),
          }),
        )
        // Verify both triggers appear in the resolved body
        const resolveCall = mockContainerClientFetch.mock.calls.find(
          (c) => c[0] === '/inputs/tool-list-1/resolve'
        )
        expect(resolveCall).toBeDefined()
        const body = JSON.parse(resolveCall![1].body)
        expect(body.value).toContain('GMAIL_NEW_EMAIL')
        expect(body.value).toContain('SLACK_NEW_MESSAGE')
      })

      it('resolves with empty message when no triggers', async () => {
        mockListActiveWebhookTriggers.mockResolvedValue([])

        simulateToolUse('mcp__user-input__list_triggers', 'tool-list-empty', {})

        await flushHandlers('/inputs/tool-list-empty/resolve')

        const resolveCall = mockContainerClientFetch.mock.calls.find(
          (c) => c[0] === '/inputs/tool-list-empty/resolve'
        )
        expect(resolveCall).toBeDefined()
        const body = JSON.parse(resolveCall![1].body)
        expect(body.value).toContain('No active webhook triggers')
      })
    })

    describe('get_available_triggers', () => {
      it('resolves with formatted available triggers', async () => {
        simulateToolUse('mcp__user-input__get_available_triggers', 'tool-avail-1', {
          connected_account_id: 'ca_1',
        })

        await flushHandlers('/inputs/tool-avail-1/resolve')

        const resolveCall = mockContainerClientFetch.mock.calls.find(
          (c) => c[0] === '/inputs/tool-avail-1/resolve'
        )
        expect(resolveCall).toBeDefined()
        const body = JSON.parse(resolveCall![1].body)
        expect(body.value).toContain('GMAIL_NEW_EMAIL')
        expect(body.value).toContain('SLACK_NEW_MESSAGE')
        expect(body.value).toContain('setup_trigger')
      })

      it('rejects when connected account not found', async () => {
        mockDbSelectAccount(null)

        simulateToolUse('mcp__user-input__get_available_triggers', 'tool-avail-noaccount', {
          connected_account_id: 'ca_missing',
        })

        await flushHandlers('/inputs/tool-avail-noaccount/reject')

        expect(mockContainerClientFetch).toHaveBeenCalledWith(
          '/inputs/tool-avail-noaccount/reject',
          expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining('not found'),
          }),
        )
      })

      it('rejects when platform Composio is not active', async () => {
        mockIsPlatformComposioActive.mockReturnValue(false)

        simulateToolUse('mcp__user-input__get_available_triggers', 'tool-avail-noplatform', {
          connected_account_id: 'ca_1',
        })

        await flushHandlers('/inputs/tool-avail-noplatform/reject')

        expect(mockContainerClientFetch).toHaveBeenCalledWith(
          '/inputs/tool-avail-noplatform/reject',
          expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining('only available with platform Composio'),
          }),
        )
      })

      it('resolves with empty message when no triggers available', async () => {
        mockGetAvailableTriggers.mockResolvedValue([])

        simulateToolUse('mcp__user-input__get_available_triggers', 'tool-avail-empty', {
          connected_account_id: 'ca_1',
        })

        await flushHandlers('/inputs/tool-avail-empty/resolve')

        const resolveCall = mockContainerClientFetch.mock.calls.find(
          (c) => c[0] === '/inputs/tool-avail-empty/resolve'
        )
        expect(resolveCall).toBeDefined()
        const body = JSON.parse(resolveCall![1].body)
        expect(body.value).toContain('No webhook triggers available')
      })
    })
  })

  // ============================================================================
  // Scheduled task tool handling (list_scheduled_tasks / cancel_scheduled_task)
  // ============================================================================

  describe('scheduled task tool handling', () => {
    function collectGlobalEvents(): { events: any[]; cleanup: () => void } {
      const events: any[] = []
      const cleanup = messagePersister.addGlobalNotificationClient((data) => {
        events.push(data)
      })
      return { events, cleanup }
    }

    function simulateToolUse(toolName: string, toolId: string, input: Record<string, unknown>) {
      mockClient._sendMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: toolId, name: toolName },
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

    // Handlers are fire-and-forget via ;(async () => {...})() — let them settle.
    async function flushHandlers() {
      await new Promise((resolve) => setTimeout(resolve, 50))
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    beforeEach(() => {
      mockContainerClientFetch.mockClear()
      mockListPendingScheduledTasks.mockClear()
      mockGetScheduledTask.mockClear()
      mockCancelScheduledTask.mockClear()
      mockPauseScheduledTask.mockClear()
      mockResumeScheduledTask.mockClear()

      mockContainerClientFetch.mockResolvedValue({ ok: true })
      mockListPendingScheduledTasks.mockResolvedValue([])
      mockGetScheduledTask.mockResolvedValue(null)
      mockCancelScheduledTask.mockResolvedValue(true)
      mockPauseScheduledTask.mockResolvedValue(true)
      mockResumeScheduledTask.mockResolvedValue(true)
    })

    describe('list_scheduled_tasks', () => {
      it('resolves with a formatted task list', async () => {
        mockListPendingScheduledTasks.mockResolvedValue([
          {
            id: 'task_1', name: 'Daily report', scheduleType: 'cron',
            scheduleExpression: '0 9 * * 1-5', status: 'pending',
            nextExecutionAt: new Date('2026-06-04T09:00:00Z'), timezone: 'America/New_York',
            prompt: 'Send the daily report',
          },
          {
            id: 'task_2', name: null, scheduleType: 'at',
            scheduleExpression: 'at tomorrow 9am', status: 'paused',
            nextExecutionAt: new Date('2026-06-04T13:00:00Z'), timezone: null,
            prompt: 'One-off reminder',
          },
        ])

        simulateToolUse('mcp__user-input__list_scheduled_tasks', 'tool-sched-list-1', {})

        await flushHandlers()

        expect(mockListPendingScheduledTasks).toHaveBeenCalledWith(AGENT_SLUG)
        const resolveCall = mockContainerClientFetch.mock.calls.find(
          (c) => c[0] === '/inputs/tool-sched-list-1/resolve'
        )
        expect(resolveCall).toBeDefined()
        const body = JSON.parse(resolveCall![1].body)
        expect(body.value).toContain('task_1')
        expect(body.value).toContain('Daily report')
        expect(body.value).toContain('0 9 * * 1-5')
        expect(body.value).toContain('America/New_York')
        expect(body.value).toContain('[PAUSED]')
      })

      it('resolves with empty message when no tasks', async () => {
        mockListPendingScheduledTasks.mockResolvedValue([])

        simulateToolUse('mcp__user-input__list_scheduled_tasks', 'tool-sched-list-empty', {})

        await flushHandlers()

        const resolveCall = mockContainerClientFetch.mock.calls.find(
          (c) => c[0] === '/inputs/tool-sched-list-empty/resolve'
        )
        expect(resolveCall).toBeDefined()
        const body = JSON.parse(resolveCall![1].body)
        expect(body.value).toContain('No scheduled tasks')
      })
    })

    describe('cancel_scheduled_task', () => {
      it('broadcasts scheduled_task_cancelled on success', async () => {
        const { events: globalEvents, cleanup: globalCleanup } = collectGlobalEvents()
        sseEvents.length = 0
        mockGetScheduledTask.mockResolvedValue({ id: 'task_existing', agentSlug: AGENT_SLUG })

        simulateToolUse('mcp__user-input__cancel_scheduled_task', 'tool-sched-cancel-1', {
          task_id: 'task_existing',
        })

        await flushHandlers()

        expect(mockCancelScheduledTask).toHaveBeenCalledWith('task_existing')

        const sseCancelled = sseEvents.filter(e => e.type === 'scheduled_task_cancelled')
        expect(sseCancelled).toHaveLength(1)
        expect(sseCancelled[0].taskId).toBe('task_existing')
        expect(sseCancelled[0].agentSlug).toBe(AGENT_SLUG)

        const globalCancelled = globalEvents.filter(e => e.type === 'scheduled_task_cancelled')
        expect(globalCancelled).toHaveLength(1)

        expect(mockContainerClientFetch).toHaveBeenCalledWith(
          '/inputs/tool-sched-cancel-1/resolve',
          expect.objectContaining({ method: 'POST' }),
        )

        globalCleanup()
      })

      it('rejects when task belongs to a different agent', async () => {
        sseEvents.length = 0
        mockGetScheduledTask.mockResolvedValue({ id: 'task_other', agentSlug: 'someone-else' })

        simulateToolUse('mcp__user-input__cancel_scheduled_task', 'tool-sched-cancel-foreign', {
          task_id: 'task_other',
        })

        await flushHandlers()

        expect(mockCancelScheduledTask).not.toHaveBeenCalled()
        expect(mockContainerClientFetch).toHaveBeenCalledWith(
          '/inputs/tool-sched-cancel-foreign/reject',
          expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining('not found'),
          }),
        )
        const sseCancelled = sseEvents.filter(e => e.type === 'scheduled_task_cancelled')
        expect(sseCancelled).toHaveLength(0)
      })

      it('rejects when the task cannot be cancelled (already executed/cancelled)', async () => {
        mockGetScheduledTask.mockResolvedValue({ id: 'task_done', agentSlug: AGENT_SLUG })
        mockCancelScheduledTask.mockResolvedValue(false)

        simulateToolUse('mcp__user-input__cancel_scheduled_task', 'tool-sched-cancel-done', {
          task_id: 'task_done',
        })

        await flushHandlers()

        expect(mockContainerClientFetch).toHaveBeenCalledWith(
          '/inputs/tool-sched-cancel-done/reject',
          expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining('could not be cancelled'),
          }),
        )
      })

      it('rejects when task_id is missing', async () => {
        simulateToolUse('mcp__user-input__cancel_scheduled_task', 'tool-sched-cancel-noid', {})

        await flushHandlers()

        expect(mockContainerClientFetch).toHaveBeenCalledWith(
          '/inputs/tool-sched-cancel-noid/reject',
          expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining('Missing required field'),
          }),
        )
      })
    })

    describe('pause_scheduled_task', () => {
      it('broadcasts scheduled_task_updated on success', async () => {
        const { events: globalEvents, cleanup: globalCleanup } = collectGlobalEvents()
        sseEvents.length = 0
        mockGetScheduledTask.mockResolvedValue({ id: 'task_cron', agentSlug: AGENT_SLUG })

        simulateToolUse('mcp__user-input__pause_scheduled_task', 'tool-sched-pause-1', {
          task_id: 'task_cron',
        })

        await flushHandlers()

        expect(mockPauseScheduledTask).toHaveBeenCalledWith('task_cron')

        const sseUpdated = sseEvents.filter(e => e.type === 'scheduled_task_updated')
        expect(sseUpdated).toHaveLength(1)
        expect(sseUpdated[0].taskId).toBe('task_cron')
        expect(sseUpdated[0].agentSlug).toBe(AGENT_SLUG)

        const globalUpdated = globalEvents.filter(e => e.type === 'scheduled_task_updated')
        expect(globalUpdated).toHaveLength(1)

        expect(mockContainerClientFetch).toHaveBeenCalledWith(
          '/inputs/tool-sched-pause-1/resolve',
          expect.objectContaining({ method: 'POST' }),
        )

        globalCleanup()
      })

      it('rejects when the task cannot be paused (not an active recurring task)', async () => {
        sseEvents.length = 0
        mockGetScheduledTask.mockResolvedValue({ id: 'task_at', agentSlug: AGENT_SLUG })
        mockPauseScheduledTask.mockResolvedValue(false)

        simulateToolUse('mcp__user-input__pause_scheduled_task', 'tool-sched-pause-bad', {
          task_id: 'task_at',
        })

        await flushHandlers()

        expect(mockContainerClientFetch).toHaveBeenCalledWith(
          '/inputs/tool-sched-pause-bad/reject',
          expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining('could not be paused'),
          }),
        )
        const sseUpdated = sseEvents.filter(e => e.type === 'scheduled_task_updated')
        expect(sseUpdated).toHaveLength(0)
      })

      it('rejects when task belongs to a different agent', async () => {
        mockGetScheduledTask.mockResolvedValue({ id: 'task_other', agentSlug: 'someone-else' })

        simulateToolUse('mcp__user-input__pause_scheduled_task', 'tool-sched-pause-foreign', {
          task_id: 'task_other',
        })

        await flushHandlers()

        expect(mockPauseScheduledTask).not.toHaveBeenCalled()
        expect(mockContainerClientFetch).toHaveBeenCalledWith(
          '/inputs/tool-sched-pause-foreign/reject',
          expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining('not found'),
          }),
        )
      })
    })

    describe('resume_scheduled_task', () => {
      it('broadcasts scheduled_task_updated on success', async () => {
        const { events: globalEvents, cleanup: globalCleanup } = collectGlobalEvents()
        sseEvents.length = 0
        mockGetScheduledTask.mockResolvedValue({ id: 'task_paused', agentSlug: AGENT_SLUG })

        simulateToolUse('mcp__user-input__resume_scheduled_task', 'tool-sched-resume-1', {
          task_id: 'task_paused',
        })

        await flushHandlers()

        expect(mockResumeScheduledTask).toHaveBeenCalledWith('task_paused')

        const sseUpdated = sseEvents.filter(e => e.type === 'scheduled_task_updated')
        expect(sseUpdated).toHaveLength(1)
        expect(sseUpdated[0].taskId).toBe('task_paused')
        expect(sseUpdated[0].agentSlug).toBe(AGENT_SLUG)

        const globalUpdated = globalEvents.filter(e => e.type === 'scheduled_task_updated')
        expect(globalUpdated).toHaveLength(1)

        expect(mockContainerClientFetch).toHaveBeenCalledWith(
          '/inputs/tool-sched-resume-1/resolve',
          expect.objectContaining({ method: 'POST' }),
        )

        globalCleanup()
      })

      it('rejects when the task cannot be resumed (not paused)', async () => {
        sseEvents.length = 0
        mockGetScheduledTask.mockResolvedValue({ id: 'task_active', agentSlug: AGENT_SLUG })
        mockResumeScheduledTask.mockResolvedValue(false)

        simulateToolUse('mcp__user-input__resume_scheduled_task', 'tool-sched-resume-bad', {
          task_id: 'task_active',
        })

        await flushHandlers()

        expect(mockContainerClientFetch).toHaveBeenCalledWith(
          '/inputs/tool-sched-resume-bad/reject',
          expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining('could not be resumed'),
          }),
        )
        const sseUpdated = sseEvents.filter(e => e.type === 'scheduled_task_updated')
        expect(sseUpdated).toHaveLength(0)
      })
    })
  })

  // ============================================================================
  // waitForIdle — sync x-agent invoke race protection
  // ============================================================================

  describe('waitForIdle', () => {
    const WAIT_SESSION = 'wait-session'

    afterEach(() => {
      messagePersister.unsubscribeFromSession(WAIT_SESSION)
    })

    it('rejects with "session never became active" when state never appears (requireActiveFirst default)', async () => {
      await expect(
        messagePersister.waitForIdle(WAIT_SESSION, { observeMs: 100 }),
      ).rejects.toThrow(/never became active/)
    })

    it('resolves immediately for missing state when requireActiveFirst=false', async () => {
      await expect(
        messagePersister.waitForIdle(WAIT_SESSION, { requireActiveFirst: false }),
      ).resolves.toBeUndefined()
    })

    it('rejects with "aborted" when the abort signal fires mid-wait', async () => {
      // Caller cancellation (e.g. HTTP client disconnect) must propagate through
      // waitForIdle so we don't keep polling after no one's listening.
      messagePersister.markSessionActive(WAIT_SESSION, AGENT_SLUG)
      const ctrl = new AbortController()
      const promise = messagePersister.waitForIdle(WAIT_SESSION, { signal: ctrl.signal })
      setTimeout(() => ctrl.abort(), 30)
      await expect(promise).rejects.toThrow(/aborted/)
    })

    it('rejects synchronously when signal is already aborted', async () => {
      messagePersister.markSessionActive(WAIT_SESSION, AGENT_SLUG)
      const ctrl = new AbortController()
      ctrl.abort()
      await expect(
        messagePersister.waitForIdle(WAIT_SESSION, { signal: ctrl.signal }),
      ).rejects.toThrow(/aborted/)
    })

    it('rejects with timeout when an active session never goes idle', async () => {
      // Once the session is active, observeMs no longer applies — timeoutMs is
      // the stop-gap. Verifies the timeout branch (not the never-active branch).
      messagePersister.markSessionActive(WAIT_SESSION, AGENT_SLUG)
      await expect(
        messagePersister.waitForIdle(WAIT_SESSION, { timeoutMs: 200 }),
      ).rejects.toThrow(/timeout after 200ms/)
    })

    it('resolves once an active session goes idle (and preserves isActive across subscribe)', async () => {
      // Mirror the x-agent sync-invoke pattern: markSessionActive *before* subscribe
      messagePersister.markSessionActive(WAIT_SESSION, AGENT_SLUG)
      const client = createMockClient()
      await messagePersister.subscribeToSession(WAIT_SESSION, client, WAIT_SESSION, AGENT_SLUG)
      // Without preservation, isActive would have been wiped here and waitForIdle
      // would reject "never became active" instead of waiting for the result event.
      expect(messagePersister.isSessionActive(WAIT_SESSION)).toBe(true)

      const promise = messagePersister.waitForIdle(WAIT_SESSION, { observeMs: 1000 })
      setTimeout(() => client._sendMessage({ type: 'result', subtype: 'success' }), 50)
      await expect(promise).resolves.toBeUndefined()
    })
  })

  // ============================================================================
  // subscribeToSession preserves isActive (sync x-agent invoke race fix)
  // ============================================================================

  describe('subscribeToSession state preservation', () => {
    const PRESERVE_SESSION = 'preserve-session'

    afterEach(() => {
      messagePersister.unsubscribeFromSession(PRESERVE_SESSION)
    })

    it('preserves isActive=true from prior state when (re-)subscribing', async () => {
      // Caller marks active before subscribing (x-agent sync invoke pattern)
      messagePersister.markSessionActive(PRESERVE_SESSION, AGENT_SLUG)
      expect(messagePersister.isSessionActive(PRESERVE_SESSION)).toBe(true)

      const client = createMockClient()
      await messagePersister.subscribeToSession(PRESERVE_SESSION, client, PRESERVE_SESSION, AGENT_SLUG)

      // Without preservation, isActive would be reset to false here
      expect(messagePersister.isSessionActive(PRESERVE_SESSION)).toBe(true)
    })

    it('defaults isActive=false when subscribing fresh (no prior state)', async () => {
      const client = createMockClient()
      await messagePersister.subscribeToSession(PRESERVE_SESSION, client, PRESERVE_SESSION, AGENT_SLUG)
      expect(messagePersister.isSessionActive(PRESERVE_SESSION)).toBe(false)
    })

    it('concurrent subscribeToSession calls share the in-flight subscription (no double-init)', async () => {
      const client = createMockClient()
      const subscribeSpy = client.subscribeToStream as ReturnType<typeof vi.fn>
      // Fire two concurrent subscribes for the same session before either resolves
      const p1 = messagePersister.subscribeToSession(PRESERVE_SESSION, client, PRESERVE_SESSION, AGENT_SLUG)
      const p2 = messagePersister.subscribeToSession(PRESERVE_SESSION, client, PRESERVE_SESSION, AGENT_SLUG)
      await Promise.all([p1, p2])
      // Underlying transport subscription must only happen once
      expect(subscribeSpy).toHaveBeenCalledTimes(1)
    })
  })

  // ============================================================================
  // Background Bash task tracking
  // ============================================================================

  describe('background Bash task tracking', () => {
    it('detects backgroundTaskId from tool_use_result and broadcasts start event', () => {
      messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)
      sseEvents.length = 0

      mockClient._sendMessage({
        type: 'user',
        tool_use_result: { backgroundTaskId: 'abc123' },
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'tool-bash-1',
            content: 'Command running in background with ID: abc123.',
          }],
        },
      })

      const startEvents = sseEvents.filter(e => e.type === 'background_task_started')
      expect(startEvents).toHaveLength(1)
      expect(startEvents[0].taskId).toBe('abc123')
      expect(startEvents[0].startedAt).toBeTypeOf('number')
    })

    it('keeps isActive true when result arrives with pending background tasks', () => {
      messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)

      // Inject a background task
      mockClient._sendMessage({
        type: 'user',
        tool_use_result: { backgroundTaskId: 'bg-1' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running in background' }] },
      })

      // Agent turn ends
      mockClient._sendMessage({
        type: 'result',
        subtype: 'success',
      })

      // Session should still be active
      expect(messagePersister.isSessionActive(SESSION_ID)).toBe(true)
    })

    it('broadcasts session_waiting_background instead of session_idle when bg tasks pending', () => {
      messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)

      mockClient._sendMessage({
        type: 'user',
        tool_use_result: { backgroundTaskId: 'bg-1' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
      })

      sseEvents.length = 0

      mockClient._sendMessage({
        type: 'result',
        subtype: 'success',
      })

      const waitingEvents = sseEvents.filter(e => e.type === 'session_waiting_background')
      expect(waitingEvents).toHaveLength(1)
      expect(waitingEvents[0].backgroundTaskCount).toBe(1)

      // Should NOT have session_idle
      expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(0)
    })

    it('clears background task on system task-completion and goes idle', () => {
      messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)

      // Start background task
      mockClient._sendMessage({
        type: 'user',
        tool_use_result: { backgroundTaskId: 'bg-1' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
      })

      // Agent turn ends (stays active due to bg task)
      mockClient._sendMessage({
        type: 'result',
        subtype: 'success',
      })
      expect(messagePersister.isSessionActive(SESSION_ID)).toBe(true)

      sseEvents.length = 0

      // SDK delivers task completion as a system message with task_id and status
      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_completed',
        task_id: 'bg-1',
        tool_use_id: 'tool-1',
        status: 'completed',
        summary: 'Background command completed (exit code 0)',
      })

      const completedEvents = sseEvents.filter(e => e.type === 'background_task_completed')
      expect(completedEvents).toHaveLength(1)
      expect(completedEvents[0].taskId).toBe('bg-1')

      // Now when the next result arrives, session should go idle
      mockClient._sendMessage({
        type: 'result',
        subtype: 'success',
      })

      expect(messagePersister.isSessionActive(SESSION_ID)).toBe(false)
      expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(1)
    })

    it('clears background task on task_updated completed (busy-completion path) and goes idle', () => {
      // Regression: when a backgrounded task settles while the agent is still busy
      // (a foreground tool was in flight), the SDK delivers the completion as a
      // `task_updated` patch rather than a matching `task_notification`. The persister
      // must clear it from that signal or the session stays pinned in
      // session_waiting_background forever. See background-bash-busy-completion fixture.
      messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)

      mockClient._sendMessage({
        type: 'user',
        tool_use_result: { backgroundTaskId: 'bg-busy' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
      })

      // Agent turn ends with the bg task still pending → stays active.
      mockClient._sendMessage({ type: 'result', subtype: 'success' })
      expect(messagePersister.isSessionActive(SESSION_ID)).toBe(true)

      sseEvents.length = 0

      // Busy-path completion: a `task_updated` patch, NOT a `task_notification`.
      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'bg-busy',
        patch: { status: 'completed', end_time: Date.now() },
      })

      const completedEvents = sseEvents.filter(e => e.type === 'background_task_completed')
      expect(completedEvents).toHaveLength(1)
      expect(completedEvents[0].taskId).toBe('bg-busy')

      // Next result should now go idle rather than re-emit session_waiting_background.
      mockClient._sendMessage({ type: 'result', subtype: 'success' })
      expect(messagePersister.isSessionActive(SESSION_ID)).toBe(false)
      expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(1)
      expect(sseEvents.filter(e => e.type === 'session_waiting_background')).toHaveLength(0)
    })

    it('ignores task_updated for non-terminal status or untracked task', () => {
      messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)
      mockClient._sendMessage({
        type: 'user',
        tool_use_result: { backgroundTaskId: 'bg-x' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
      })
      sseEvents.length = 0

      // Non-terminal status → no clear.
      mockClient._sendMessage({
        type: 'system', subtype: 'task_updated', task_id: 'bg-x', patch: { status: 'running' },
      })
      // Terminal status but unknown task id → no clear.
      mockClient._sendMessage({
        type: 'system', subtype: 'task_updated', task_id: 'bg-unknown', patch: { status: 'completed' },
      })

      expect(sseEvents.filter(e => e.type === 'background_task_completed')).toHaveLength(0)
      expect(messagePersister.getActiveBackgroundTasks(SESSION_ID).map(t => t.taskId)).toContain('bg-x')
    })

    it('backstop: session_state_changed idle clears phantom tasks and finalizes idle', () => {
      // Simulate a MISSED per-task terminal signal: a tracked bg task that never got a
      // task_updated/task_notification. When the SDK reports the session fully settled
      // (state:idle), the backstop must clear it so the session isn't pinned forever.
      messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)
      mockClient._sendMessage({
        type: 'user',
        tool_use_result: { backgroundTaskId: 'bg-phantom' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
      })
      // Turn ends with the task still tracked → session stays active (waiting).
      mockClient._sendMessage({ type: 'result', subtype: 'success' })
      expect(messagePersister.isSessionActive(SESSION_ID)).toBe(true)

      sseEvents.length = 0

      // SDK reports the session settled while we still (wrongly) track the task.
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })

      expect(sseEvents.filter(e => e.type === 'background_task_completed').map(e => e.taskId)).toContain('bg-phantom')
      expect(messagePersister.getActiveBackgroundTasks(SESSION_ID)).toHaveLength(0)
      expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(1)
      expect(messagePersister.isSessionActive(SESSION_ID)).toBe(false)
    })

    it('backstop: session_state_changed idle is a no-op with no pending tasks (no spurious idle)', () => {
      messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)
      sseEvents.length = 0
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
      expect(sseEvents.filter(e => e.type === 'background_task_completed')).toHaveLength(0)
      expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(0)
    })

    it('backstop: session_state_changed running does not clear pending tasks', () => {
      messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)
      mockClient._sendMessage({
        type: 'user',
        tool_use_result: { backgroundTaskId: 'bg-keep' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
      })
      sseEvents.length = 0
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'running' })
      expect(sseEvents.filter(e => e.type === 'background_task_completed')).toHaveLength(0)
      expect(messagePersister.getActiveBackgroundTasks(SESSION_ID).map(t => t.taskId)).toContain('bg-keep')
    })

    it('tracks multiple concurrent background tasks', () => {
      messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)

      mockClient._sendMessage({
        type: 'user',
        tool_use_result: { backgroundTaskId: 'bg-1' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
      })
      mockClient._sendMessage({
        type: 'user',
        tool_use_result: { backgroundTaskId: 'bg-2' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'Running' }] },
      })

      expect(messagePersister.getActiveBackgroundTasks(SESSION_ID)).toHaveLength(2)

      // Complete first task via system message
      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_completed',
        task_id: 'bg-1',
        status: 'completed',
      })

      expect(messagePersister.getActiveBackgroundTasks(SESSION_ID)).toHaveLength(1)
      expect(messagePersister.getActiveBackgroundTasks(SESSION_ID)[0].taskId).toBe('bg-2')
    })

    it('clears background tasks on session interrupt', async () => {
      messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)

      mockClient._sendMessage({
        type: 'user',
        tool_use_result: { backgroundTaskId: 'bg-1' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
      })

      expect(messagePersister.getActiveBackgroundTasks(SESSION_ID)).toHaveLength(1)

      await messagePersister.markSessionInterrupted(SESSION_ID)

      expect(messagePersister.getActiveBackgroundTasks(SESSION_ID)).toHaveLength(0)
      expect(messagePersister.isSessionActive(SESSION_ID)).toBe(false)
    })

    it('does not duplicate background task on repeated tool_use_result', () => {
      messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)

      // Same backgroundTaskId twice
      mockClient._sendMessage({
        type: 'user',
        tool_use_result: { backgroundTaskId: 'bg-dup' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
      })
      mockClient._sendMessage({
        type: 'user',
        tool_use_result: { backgroundTaskId: 'bg-dup' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'Running' }] },
      })

      expect(messagePersister.getActiveBackgroundTasks(SESSION_ID)).toHaveLength(1)
    })

    it('preserves background tasks across re-subscribe', async () => {
      messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)

      mockClient._sendMessage({
        type: 'user',
        tool_use_result: { backgroundTaskId: 'bg-persist' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
      })

      expect(messagePersister.getActiveBackgroundTasks(SESSION_ID)).toHaveLength(1)

      // Re-subscribe (simulates reconnection)
      const newClient = createMockClient()
      await messagePersister.subscribeToSession(SESSION_ID, newClient, SESSION_ID, AGENT_SLUG)

      expect(messagePersister.getActiveBackgroundTasks(SESSION_ID)).toHaveLength(1)
      expect(messagePersister.isSessionActive(SESSION_ID)).toBe(true)

      // Clean up the new subscription
      messagePersister.unsubscribeFromSession(SESSION_ID)
    })

    it('returns empty array for unknown session', () => {
      expect(messagePersister.getActiveBackgroundTasks('nonexistent')).toEqual([])
    })

    it('ignores system messages with task_id that do not match active bg tasks', () => {
      messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)

      mockClient._sendMessage({
        type: 'user',
        tool_use_result: { backgroundTaskId: 'bg-real' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
      })

      expect(messagePersister.getActiveBackgroundTasks(SESSION_ID)).toHaveLength(1)

      // System message with non-matching task_id
      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_completed',
        task_id: 'bg-nonexistent',
        status: 'completed',
      })

      // Should NOT have cleared our task
      expect(messagePersister.getActiveBackgroundTasks(SESSION_ID)).toHaveLength(1)
    })

    it('also detects snake_case background_task_id', () => {
      messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)
      sseEvents.length = 0

      mockClient._sendMessage({
        type: 'user',
        tool_use_result: { background_task_id: 'snake-1' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
      })

      expect(messagePersister.getActiveBackgroundTasks(SESSION_ID)).toHaveLength(1)
      expect(messagePersister.getActiveBackgroundTasks(SESSION_ID)[0].taskId).toBe('snake-1')
    })
  })
})

// ============================================================================
// connection_closed → re-subscribe (ELECTRON-Q unhandled rejection guard)
// ============================================================================

describe('MessagePersister.handleConnectionClosed re-subscribe', () => {
  const SESSION_ID = 'reconnect-session'
  const AGENT_SLUG = 'reconnect-agent'

  afterEach(() => {
    messagePersister.unsubscribeFromSession(SESSION_ID)
    vi.clearAllMocks()
  })

  it('does not leak an unhandled rejection when the re-subscribe ready promise rejects', async () => {
    let callback: ((message: StreamMessage) => void) | null = null
    let subscribeCount = 0

    const client = {
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
      // Container still reports the session as running, so handleConnectionClosed
      // takes the re-subscribe branch.
      getSession: vi.fn(() => Promise.resolve({ isRunning: true } as any)),
      deleteSession: vi.fn(),
      sendMessage: vi.fn(),
      getMessages: vi.fn(),
      interruptSession: vi.fn(),
      subscribeToStream: vi.fn((_sessionId: string, cb: (message: StreamMessage) => void) => {
        callback = cb
        subscribeCount += 1
        // First subscribe (initial) resolves; the re-subscribe rejects to mirror
        // a failed reconnect (getPortOrThrow → "Container is not running").
        return {
          unsubscribe: vi.fn(),
          ready: subscribeCount === 1
            ? Promise.resolve()
            : Promise.reject(new Error('Container is not running')),
        }
      }),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as ContainerClient

    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)

    try {
      await messagePersister.subscribeToSession(SESSION_ID, client, SESSION_ID, AGENT_SLUG)
      messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)

      // Simulate the WebSocket dropping — the container synthesizes this message.
      callback!({
        type: 'connection_closed',
        content: { type: 'connection_closed' },
        timestamp: new Date(),
        sessionId: SESSION_ID,
      })

      // Let getSession().then(...) and the rejected ready settle.
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))

      // Re-subscribe was attempted (initial + reconnect) and the rejected
      // `ready` promise was caught, not leaked.
      expect(subscribeCount).toBe(2)
      expect(unhandled).toHaveLength(0)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
