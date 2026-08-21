/**
 * Regression: automated blocking tools (list_triggers, list_scheduled_tasks,
 * schedule_task, …) called from inside a subagent must be dispatched by the
 * host on every delivery road. The container parks the pending request and
 * waits for POST /inputs/:toolUseId/resolve; without a shared dispatcher on
 * the subagent stream and complete-assistant roads the push never happens.
 *
 * Main-stream cells are positive controls. Sidechain cells pin dispatch parity.
 * A stream+complete double delivery of the same toolUseId must execute once.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ContainerClient, StreamMessage } from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockFn = (...args: any[]) => any

// Mock external dependencies before importing (same seam set as
// message-persister.request-lifecycle.test.ts — the persister pulls these in
// at module load).
vi.mock('@shared/lib/services/scheduled-task-service', () => ({
  createScheduledTask: vi.fn(() => Promise.resolve('task_new_id')),
  createSessionWake: vi.fn(() => Promise.resolve({ taskId: 'wake_new_id', replaced: null })),
  listPendingScheduledTasks: vi.fn(() => Promise.resolve([])),
  getScheduledTask: vi.fn(() => Promise.resolve(null)),
  cancelScheduledTask: vi.fn(() => Promise.resolve(true)),
  pauseScheduledTask: vi.fn(() => Promise.resolve(true)),
  resumeScheduledTask: vi.fn(() => Promise.resolve(true)),
}))
vi.mock('@shared/lib/services/session-service', () => ({
  updateSessionMetadata: vi.fn(() => Promise.resolve()),
  getSessionMetadata: vi.fn(() => Promise.resolve(null)),
  finalizeAutomationStatus: vi.fn(() => Promise.resolve('updated')),
}))
vi.mock('@shared/lib/services/session-transcript-append', () => ({
  appendInformationalEntry: vi.fn(() => Promise.resolve()),
}))
vi.mock('@shared/lib/services/timezone-resolver', () => ({
  resolveTimezoneForAgent: vi.fn(() => 'UTC'),
}))
vi.mock('@shared/lib/notifications/notification-manager', () => ({
  notificationManager: {
    triggerSessionComplete: vi.fn(() => Promise.resolve()),
    triggerSessionWaitingInput: vi.fn(() => Promise.resolve()),
    triggerSessionApiReviewWaiting: vi.fn(() => Promise.resolve()),
  },
}))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({}),
  getAgentCapabilitySettings: () => ({ subagents: 'allow', workflows: 'review' }),
  getModelCatalogSettings: () => ({}),
  VALID_SCRIPT_TYPES: {
    darwin: ['applescript', 'shell'],
    linux: ['shell'],
    win32: ['powershell'],
  },
}))
vi.mock('fs', () => ({
  promises: {
    readdir: vi.fn(),
    stat: vi.fn(),
  },
}))
vi.mock('@shared/lib/utils/file-storage', () => ({
  getAgentSessionsDir: vi.fn(() => '/mock/sessions'),
}))
vi.mock('@shared/lib/computer-use/permission-manager', () => ({
  computerUsePermissionManager: {
    checkPermission: vi.fn(() => 'prompt_needed'),
    getGrabbedApp: vi.fn(() => undefined),
    setGrabbedApp: vi.fn(),
    clearGrabbedApp: vi.fn(),
    consumeOnceGrant: vi.fn(),
  },
}))
vi.mock('@shared/lib/computer-use/types', () => ({
  computerUseMethodFromToolName: vi.fn((toolName: string) =>
    toolName.replace('mcp__computer-use__computer_', '')
  ),
  getRequiredPermissionLevel: vi.fn(() => 'use_application'),
  resolveTargetApp: vi.fn(() => undefined),
  READ_ONLY_METHODS: new Set(['apps', 'windows', 'status', 'displays', 'permissions']),
  TIMED_GRANT_DURATION_MS: 15 * 60 * 1000,
}))
vi.mock('@shared/lib/services/webhook-trigger-service', () => ({
  createWebhookTrigger: vi.fn(() => Promise.resolve('trigger_new_id')),
  listActiveWebhookTriggers: vi.fn(() => Promise.resolve([])),
  cancelWebhookTriggerWithCleanup: vi.fn(() => Promise.resolve(true)),
  getWebhookTrigger: vi.fn(() => Promise.resolve(null)),
  resolvePlatformMemberForCandidates: () => null,
}))
vi.mock('@shared/lib/services/webhook-endpoints-client', () => ({
  createPlatformWebhookEndpoint: vi.fn(),
  updatePlatformWebhookEndpoint: vi.fn(() => Promise.resolve({})),
  disablePlatformWebhookEndpoint: vi.fn(() => Promise.resolve()),
  listPlatformWebhookEvents: vi.fn(() => Promise.resolve({ filterExp: null, events: [] })),
  testPlatformWebhookFilter: vi.fn(),
}))
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getStoredPlatformMemberId: () => null,
  getPlatformAccessToken: () => 'opaque_token',
}))
vi.mock('@shared/lib/composio/triggers', () => ({
  getAvailableTriggers: vi.fn(() => Promise.resolve([])),
  enableComposioTrigger: vi.fn(() => Promise.resolve('composio_trigger_id')),
  deleteComposioTrigger: vi.fn(() => Promise.resolve()),
}))
vi.mock('@shared/lib/composio/client', () => ({
  isPlatformComposioActive: () => true,
}))
vi.mock('@shared/lib/db', () => ({
  db: {
    select: vi.fn(),
  },
}))
vi.mock('@shared/lib/db/schema', () => ({
  connectedAccounts: {
    id: 'id',
    providerConnectionId: 'provider_connection_id',
    providerName: 'provider_name',
    toolkitSlug: 'toolkit_slug',
  },
}))
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
import { userInputRequestManager } from '@shared/lib/user-input/request-manager'
import { createScheduledTask } from '@shared/lib/services/scheduled-task-service'

function createMockClient(): ContainerClient & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _sendMessage: (content: any) => void
} {
  let messageCallback: ((message: StreamMessage) => void) | null = null

  const client = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    interruptSession: vi.fn(),
    subscribeToStream: vi.fn((_sid: string, callback: (message: StreamMessage) => void) => {
      messageCallback = callback
      return {
        unsubscribe: vi.fn(),
        ready: Promise.resolve(),
      }
    }),
    on: vi.fn(),
    off: vi.fn(),
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return client as any
}

interface AutomatedToolCase {
  label: string
  toolName: string
  input: Record<string, unknown>
}

// The two reported tools. Both read local state and resolve immediately on the
// main path, so a mocked empty store answers instantly.
const AUTOMATED_TOOLS: AutomatedToolCase[] = [
  {
    label: 'list_triggers',
    toolName: 'mcp__user-input__list_triggers',
    input: {},
  },
  {
    label: 'list_scheduled_tasks',
    toolName: 'mcp__user-input__list_scheduled_tasks',
    input: {},
  },
]

describe('automated blocking tools from a subagent must receive a container push', () => {
  const SESSION_ID = 'subagent-automated-1'
  const AGENT_SLUG = 'repro-agent'

  let mockClient: ReturnType<typeof createMockClient>

  beforeEach(async () => {
    userInputRequestManager.reset()
    mockClient = createMockClient()
    await messagePersister.subscribeToSession(SESSION_ID, mockClient, SESSION_ID, AGENT_SLUG)
    messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)
  })

  afterEach(() => {
    messagePersister.unsubscribeFromSession(SESSION_ID)
    vi.clearAllMocks()
  })

  // Answer pushes the host sent for this toolUseId. Matches the exact resolve
  // path so a reject (the failure the container reports as a timeout) does not
  // read as a successful answer.
  const resolvePushesFor = (toolUseId: string) =>
    mockContainerClientFetch.mock.calls.filter(([path]) => path === `/inputs/${toolUseId}/resolve`)

  function sendMainToolUse(toolName: string, toolId: string, input: Record<string, unknown>) {
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

  function sendSidechainStreamToolUse(
    toolName: string,
    toolId: string,
    input: Record<string, unknown>,
    parentToolId = 'parent-task-1'
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const send = (event: any) =>
      mockClient._sendMessage({
        type: 'stream_event',
        parent_tool_use_id: parentToolId,
        event,
      })
    send({
      type: 'content_block_start',
      content_block: { type: 'tool_use', id: toolId, name: toolName },
    })
    send({
      type: 'content_block_delta',
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    })
    send({ type: 'content_block_stop' })
  }

  function sendSidechainCompleteAssistantToolUse(
    toolName: string,
    toolId: string,
    input: Record<string, unknown>,
    parentToolId = 'parent-task-2'
  ) {
    mockClient._sendMessage({
      type: 'assistant',
      parent_tool_use_id: parentToolId,
      message: {
        content: [{ type: 'tool_use', id: toolId, name: toolName, input }],
      },
    })
  }

  describe.each(AUTOMATED_TOOLS)('$label', ({ label, toolName, input }) => {
    it('main stream (control): the host pushes an answer to the container', async () => {
      const toolId = `${label}-main`
      sendMainToolUse(toolName, toolId, input)

      await vi.waitFor(() => {
        expect(resolvePushesFor(toolId).length).toBeGreaterThan(0)
      })
    })

    it('subagent stream: the host pushes an answer to the container', async () => {
      const toolId = `${label}-side-stream`
      sendSidechainStreamToolUse(toolName, toolId, input)

      await vi.waitFor(() => {
        expect(resolvePushesFor(toolId).length).toBeGreaterThan(0)
      })
    })

    it('subagent complete assistant message: the host pushes an answer to the container', async () => {
      const toolId = `${label}-side-complete`
      sendSidechainCompleteAssistantToolUse(toolName, toolId, input)

      await vi.waitFor(() => {
        expect(resolvePushesFor(toolId).length).toBeGreaterThan(0)
      })
    })
  })

  it('stream + complete-assistant double delivery: mutating handler runs once', async () => {
    const toolId = 'side-dedupe-1'
    const toolName = 'mcp__user-input__schedule_task'
    const input = {
      scheduleType: 'cron',
      scheduleExpression: '0 9 * * *',
      prompt: 'ping',
      name: 'dedupe-check',
    }

    // Both roads carry the same tool_use under the same parent, the way the
    // container emits it.
    const parentToolId = 'parent-dedupe'
    sendSidechainStreamToolUse(toolName, toolId, input, parentToolId)
    sendSidechainCompleteAssistantToolUse(toolName, toolId, input, parentToolId)

    // Wait on a monotonic condition, then assert the counts: `waitFor` on
    // `toBe(1)` would pass on the poll where a doubled count transits 1.
    await vi.waitFor(() => {
      expect(createScheduledTask).toHaveBeenCalled()
    })
    expect(createScheduledTask).toHaveBeenCalledTimes(1)
    expect(resolvePushesFor(toolId)).toHaveLength(1)
  })

  // Every tool name on every road is looked up in the handler table, so the
  // lookup must not reach the prototype chain. '__proto__' is the case with a
  // consequence: it resolves to a non-function, which throws when called and
  // takes the stream handler down with it. The other inherited names resolve
  // to harmless functions, so they are not worth a row here.
  it('a tool named __proto__ is not treated as an automated tool', async () => {
    const toolId = 'proto-lookup'
    expect(() => sendMainToolUse('__proto__', toolId, {})).not.toThrow()

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(resolvePushesFor(toolId)).toHaveLength(0)
  })

  it('reattach between the two deliveries: mutating handler still runs once', async () => {
    const toolId = 'side-reattach-1'
    const toolName = 'mcp__user-input__schedule_task'
    const input = {
      scheduleType: 'cron',
      scheduleExpression: '0 9 * * *',
      prompt: 'ping',
      name: 'reattach-check',
    }
    const parentToolId = 'parent-reattach'

    sendSidechainStreamToolUse(toolName, toolId, input, parentToolId)
    await vi.waitFor(() => {
      expect(createScheduledTask).toHaveBeenCalled()
    })

    // A live session re-subscribes on every inbound chat message, wake and
    // x-agent call, which builds a fresh streaming state.
    mockClient = createMockClient()
    await messagePersister.subscribeToSession(SESSION_ID, mockClient, SESSION_ID, AGENT_SLUG)
    sendSidechainCompleteAssistantToolUse(toolName, toolId, input, parentToolId)

    await vi.waitFor(() => {
      expect(resolvePushesFor(toolId)).toHaveLength(1)
    })
    expect(createScheduledTask).toHaveBeenCalledTimes(1)
  })
})
