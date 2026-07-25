/**
 * Characterization suite for the pending user-input request lifecycle.
 *
 * Every user-facing request kind must satisfy the same contract on the main
 * stream path: open → broadcast exactly one request card → mark the session
 * awaiting → notify exactly once → resolve → drop the replay entry → clear
 * awaiting only when it was the last blocking wait.
 *
 * This file pins CURRENT behavior. The awaiting status is DERIVED from the
 * userInputRequestManager registry (Phase 3): the split-brains this suite
 * originally pinned as known-wrong — the first of two parallel requests
 * dropping the waiting light, the computer-use and capability-review clear
 * doors leaving the bit stuck — are fixed, and their tests now assert the
 * correct arithmetic. The sidechain matrix at the bottom is the acceptance
 * table for the unified dispatcher: every kind must surface from every
 * delivery path. Rows were `surfacesToday: false` before the dispatcher
 * landed — those kinds hung silently when a subagent called them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ContainerClient, StreamMessage } from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockFn = (...args: any[]) => any

// Mock external dependencies before importing (same seam set as
// message-persister.test.ts — the persister pulls these in at module load).
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
  },
}))

const mockGetSettings = vi.fn((): Record<string, unknown> => ({}))
const mockAgentCapabilities: Record<'subagents' | 'workflows', 'allow' | 'review' | 'block'> = {
  subagents: 'allow',
  workflows: 'review',
}
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => mockGetSettings(),
  getAgentCapabilitySettings: () => ({ ...mockAgentCapabilities }),
  getModelCatalogSettings: () => mockGetSettings().modelCatalog ?? {},
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

const mockCheckPermission = vi.fn(
  (_agentSlug?: string, _level?: string, _appName?: string): string => 'prompt_needed'
)
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
  computerUseMethodFromToolName: vi.fn((toolName: string) => {
    const suffix = toolName.replace('mcp__computer-use__computer_', '')
    return suffix === 'menu' ? 'menuClick' : suffix
  }),
  getRequiredPermissionLevel: vi.fn((method: string) =>
    ['apps', 'windows', 'status', 'displays', 'permissions'].includes(method)
      ? 'list_apps_windows'
      : 'use_application'
  ),
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
import { notificationManager } from '@shared/lib/notifications/notification-manager'
import { userInputRequestManager } from '@shared/lib/user-input/request-manager'

function createMockClient(): ContainerClient & {
  _messageCallback: ((message: StreamMessage) => void) | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _sendMessage: (content: any) => void
} {
  let messageCallback: ((message: StreamMessage) => void) | null = null

  const client = {
    _messageCallback: null as ((message: StreamMessage) => void) | null,
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return client as any
}

interface RequestKindCase {
  label: string
  toolName: string
  input: Record<string, unknown>
  sseType: string
  waitingFor: string
}

/**
 * The standard kinds: every row must satisfy the identical lifecycle
 * contract. A new user-input request kind belongs in this table; if it can't
 * satisfy the shared contract, that divergence needs its own documented test
 * below (like computer-use and capability review).
 */
const STANDARD_KINDS: RequestKindCase[] = [
  {
    label: 'secret',
    toolName: 'mcp__user-input__request_secret',
    input: { secretName: 'API_KEY', reason: 'Need it' },
    sseType: 'secret_request',
    waitingFor: 'secret',
  },
  {
    label: 'question',
    toolName: 'AskUserQuestion',
    input: {
      questions: [{ question: 'Pick DB', header: 'DB', options: [], multiSelect: false }],
    },
    sseType: 'user_question_request',
    waitingFor: 'question',
  },
  {
    label: 'connected account',
    toolName: 'mcp__user-input__request_connected_account',
    input: { toolkit: 'github', reason: 'Need access' },
    sseType: 'connected_account_request',
    waitingFor: 'connected_account',
  },
  {
    label: 'file',
    toolName: 'mcp__user-input__request_file',
    input: { description: 'Upload a CSV' },
    sseType: 'file_request',
    waitingFor: 'file',
  },
  {
    label: 'remote MCP',
    toolName: 'mcp__user-input__request_remote_mcp',
    input: { url: 'https://example.com/mcp', name: 'Example', reason: 'Docs' },
    sseType: 'remote_mcp_request',
    waitingFor: 'remote_mcp',
  },
  {
    label: 'browser input',
    toolName: 'mcp__user-input__request_browser_input',
    input: { message: 'Please log in', requirements: ['Enter credentials'] },
    sseType: 'browser_input_request',
    waitingFor: 'browser_input',
  },
  {
    label: 'script run',
    toolName: 'mcp__user-input__request_script_run',
    input: { script: 'sw_vers', explanation: 'Check macOS version', scriptType: 'shell' },
    sseType: 'script_run_request',
    waitingFor: 'script_run',
  },
]

describe('pending user-input request lifecycle (characterization)', () => {
  const SESSION_ID = 'lifecycle-session-1'
  const AGENT_SLUG = 'lifecycle-agent'

  let mockClient: ReturnType<typeof createMockClient>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sseEvents: any[]
  let sseCleanup: () => void
  let originalE2eMock: string | undefined

  beforeEach(async () => {
    // Computer-use interception is platform-gated (darwin/win32 only) with an
    // explicit E2E escape hatch (message-persister.ts:4269). Set it so the
    // computer-use rows behave identically on Linux CI and macOS dev machines
    // — same pattern the main persister suite uses in its computer-use tests.
    originalE2eMock = process.env.E2E_MOCK
    process.env.E2E_MOCK = 'true'

    // Agent-scoped entries (reviews) are not dropped by unsubscribe — wipe the
    // registry so one test's review can't keep a later test's session awaiting.
    userInputRequestManager.reset()

    mockClient = createMockClient()
    await messagePersister.subscribeToSession(SESSION_ID, mockClient, SESSION_ID, AGENT_SLUG)
    // Requests park mid-turn: production always has markSessionActive before
    // any request event arrives, and the derived awaiting projection is gated
    // on an active turn (an inactive session is never awaiting).
    messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events: any[] = []
    sseCleanup = messagePersister.addSSEClient(SESSION_ID, (data) => {
      events.push(data)
    })
    sseEvents = events
  })

  afterEach(() => {
    if (originalE2eMock === undefined) delete process.env.E2E_MOCK
    else process.env.E2E_MOCK = originalE2eMock
    sseCleanup()
    messagePersister.unsubscribeFromSession(SESSION_ID)
    vi.clearAllMocks()
    mockCheckPermission.mockReturnValue('prompt_needed')
  })

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

  function sendToolResult(toolUseId: string) {
    mockClient._sendMessage({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: 'resolved',
          },
        ],
      },
    })
  }

  // ==========================================================================
  // Main-stream lifecycle contract — one row per standard kind
  // ==========================================================================

  describe.each(STANDARD_KINDS)(
    'main stream: $label',
    ({ toolName, input, sseType, waitingFor }) => {
      it('opens: broadcasts exactly one card, stores a replay entry, marks awaiting, notifies once', async () => {
        simulateToolUse(toolName, 'tool-open-1', input)

        const cards = sseEvents.filter((e) => e.type === sseType)
        expect(cards).toHaveLength(1)
        expect(cards[0].toolUseId).toBe('tool-open-1')

        expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)
        expect(messagePersister.hasSessionsAwaitingInputForAgent(AGENT_SLUG)).toBe(true)
        expect(
          messagePersister.getPendingInputRequests(SESSION_ID).map((r) => r.toolUseId)
        ).toContain('tool-open-1')

        await vi.waitFor(() => {
          expect(notificationManager.triggerSessionWaitingInput).toHaveBeenCalledTimes(1)
        })
        const call = vi.mocked(notificationManager.triggerSessionWaitingInput).mock.calls[0]
        expect(call.slice(0, 3)).toEqual([SESSION_ID, AGENT_SLUG, waitingFor])
      })

      it('resolves: the tool_result drops the replay entry and clears awaiting', () => {
        simulateToolUse(toolName, 'tool-resolve-1', input)
        expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

        sendToolResult('tool-resolve-1')

        expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
        expect(messagePersister.getPendingInputRequests(SESSION_ID)).toHaveLength(0)
      })

      it('parallel with a second request: awaiting survives until the LAST one resolves', () => {
        simulateToolUse(toolName, 'tool-par-1', input)
        // A second, different-kind blocking request in the same turn.
        simulateToolUse('mcp__user-input__request_secret', 'tool-par-2', {
          secretName: 'OTHER_KEY',
          reason: 'Second wait',
        })
        // Same-kind case degenerates to a single entry; skip the duplicate.
        if (toolName === 'mcp__user-input__request_secret') return

        expect(messagePersister.getPendingInputRequests(SESSION_ID)).toHaveLength(2)

        sendToolResult('tool-par-1')
        // Derived awaiting: the projection consults what is actually still
        // open, so answering the first request keeps the waiting light on
        // while the second card is parked. (This was the pinned parallel-
        // request split-brain before the flip: the imperative clear dropped
        // the bit on the first tool_result.)
        expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)
        expect(messagePersister.getPendingInputRequests(SESSION_ID)).toHaveLength(1)

        sendToolResult('tool-par-2')
        expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
        expect(messagePersister.getPendingInputRequests(SESSION_ID)).toHaveLength(0)
      })
    }
  )

  // ==========================================================================
  // Documented divergence: computer-use has route-driven clearing and
  // survives idle boundaries — the registry expresses this as a distinct
  // store label (storeForKind), no longer as a separate map
  // ==========================================================================

  describe('main stream: computer use (divergent clearing rules)', () => {
    const TOOL = 'mcp__computer-use__computer_click'

    it('opens into the computer-use store, NOT the input-request store', async () => {
      simulateToolUse(TOOL, 'cu-open-1', { x: 1, y: 2 })

      const cards = sseEvents.filter((e) => e.type === 'computer_use_request')
      expect(cards).toHaveLength(1)
      expect(cards[0].toolUseId).toBe('cu-open-1')
      expect(cards[0].autoApproved).toBe(false)

      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)
      expect(
        messagePersister.getPendingComputerUseRequests(SESSION_ID).map((r) => r.toolUseId)
      ).toContain('cu-open-1')
      expect(messagePersister.getPendingInputRequests(SESSION_ID)).toHaveLength(0)

      await vi.waitFor(() => {
        expect(notificationManager.triggerSessionWaitingInput).toHaveBeenCalledTimes(1)
      })
      const call = vi.mocked(notificationManager.triggerSessionWaitingInput).mock.calls[0]
      expect(call.slice(0, 3)).toEqual([SESSION_ID, AGENT_SLUG, 'computer_use'])
    })

    it('a tool_result alone does NOT drop the parked entry — and awaiting stays on with it', () => {
      simulateToolUse(TOOL, 'cu-clear-1', { x: 1, y: 2 })
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

      // The computer-use store is cleared only via the decision route's
      // explicit call, so the entry survives a stray tool_result. Derived
      // awaiting reads that store: card parked, light ON. (Before the flip
      // this was a pinned split-brain — the imperative clear dropped the bit
      // without consulting this store.)
      sendToolResult('cu-clear-1')
      expect(
        messagePersister.getPendingComputerUseRequests(SESSION_ID).map((r) => r.toolUseId)
      ).toContain('cu-clear-1')
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

      messagePersister.clearPendingComputerUseRequest(SESSION_ID, 'cu-clear-1')
      expect(messagePersister.getPendingComputerUseRequests(SESSION_ID)).toHaveLength(0)
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
    })

    it('the route clear flips awaiting and broadcasts when it was the last blocking wait', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const globalEvents: any[] = []
      const cleanup = messagePersister.addGlobalNotificationClient((data) => {
        globalEvents.push(data)
      })
      try {
        simulateToolUse(TOOL, 'cu-clear-2', { x: 1, y: 2 })
        expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

        // The route clear applies the shared waiting-light rule: with both
        // stores empty and no external blocker, the bit flips AND the wire
        // says input was provided — together, atomically. (Before the unified
        // dispatch change it broadcast without flipping the bit, leaving the
        // wire and the bit disagreeing until the tool_result landed.)
        messagePersister.clearPendingComputerUseRequest(SESSION_ID, 'cu-clear-2')
        expect(
          globalEvents.filter((e) => e.type === 'session_input_provided')
        ).toHaveLength(1)
        expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
      } finally {
        cleanup()
      }
    })

    it('the route clear defers while another input request is still parked', () => {
      simulateToolUse('mcp__user-input__request_secret', 'cu-mix-secret', {
        secretName: 'API_KEY',
        reason: 'Need it',
      })
      simulateToolUse(TOOL, 'cu-clear-3', { x: 1, y: 2 })
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

      // Clearing the computer-use entry must NOT flip awaiting: the secret
      // is still parked on the other store.
      messagePersister.clearPendingComputerUseRequest(SESSION_ID, 'cu-clear-3')
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)
      expect(messagePersister.getPendingComputerUseRequests(SESSION_ID)).toHaveLength(0)
    })
  })

  // ==========================================================================
  // Documented divergence: capability review clears early via its own door
  // ==========================================================================

  describe('main stream: capability review (early-clear lifecycle)', () => {
    beforeEach(() => {
      mockAgentCapabilities.subagents = 'allow'
      mockAgentCapabilities.workflows = 'review'
      vi.mocked(mockClient.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ grants: [] }),
      } as unknown as Response)
    })

    it('opens like a standard kind: card, replay entry, awaiting, one notification', async () => {
      simulateToolUse('Workflow', 'wf-lifecycle-1', { script: 'export const meta = {}' })

      await vi.waitFor(() => {
        expect(sseEvents.filter((e) => e.type === 'capability_review_request')).toHaveLength(1)
      })
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)
      expect(
        messagePersister.getPendingInputRequests(SESSION_ID).map((r) => r.toolUseId)
      ).toContain('wf-lifecycle-1')

      await vi.waitFor(() => {
        expect(notificationManager.triggerSessionWaitingInput).toHaveBeenCalledTimes(1)
      })
      const call = vi.mocked(notificationManager.triggerSessionWaitingInput).mock.calls[0]
      expect(call.slice(0, 3)).toEqual([SESSION_ID, AGENT_SLUG, 'capability_review_workflows'])
    })

    it('completeCapabilityReview drops the replay entry, broadcasts, and clears awaiting', async () => {
      simulateToolUse('Workflow', 'wf-lifecycle-2', { script: 'export const meta = {}' })
      await vi.waitFor(() => {
        expect(messagePersister.getPendingInputRequests(SESSION_ID)).toHaveLength(1)
      })

      messagePersister.completeCapabilityReview(SESSION_ID, 'wf-lifecycle-2')

      expect(messagePersister.getPendingInputRequests(SESSION_ID)).toHaveLength(0)
      expect(sseEvents.filter((e) => e.type === 'capability_review_resolved')).toHaveLength(1)
      // Derived awaiting: settling the review settles the wait. (Before the
      // flip this door emptied its store and broadcast but left the bit stuck
      // until later stream traffic cleared it — a pinned split-brain.)
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
    })
  })

  // ==========================================================================
  // Cross-store awaiting arithmetic: stream store + computer-use store +
  // agent-scoped reviews (the ReviewManager seam — an agent-scoped registry
  // entry). Awaiting must survive until the LAST wait across all three
  // resolves. There is no side-channel: whatever is open in the registry IS
  // the projection.
  // ==========================================================================

  describe('cross-store awaiting arithmetic', () => {
    // What ReviewManager.requestReview writes through: an agent-scoped
    // blocking entry (no sessionId — the proxied call has none).
    function parkAgentReview(id: string) {
      userInputRequestManager.register({
        id,
        kind: 'proxy_review',
        scope: { agentSlug: AGENT_SLUG },
        blocking: true,
        autoApproved: false,
        payload: { toolkit: 'slack' },
      })
      messagePersister.syncAgentSessionsAwaiting(AGENT_SLUG)
    }

    it('a parked agent-scoped review keeps awaiting alive through tool_results and the cu clear', () => {
      parkAgentReview('mix-review-1')

      simulateToolUse('mcp__user-input__request_secret', 'mix-secret-1', {
        secretName: 'API_KEY',
        reason: 'Need it',
      })
      simulateToolUse('mcp__computer-use__computer_click', 'mix-cu-1', { x: 1, y: 2 })
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

      // The secret resolves, but the cu entry AND the review are still open.
      sendToolResult('mix-secret-1')
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

      // The cu entry resolves, but the review is still open.
      messagePersister.clearPendingComputerUseRequest(SESSION_ID, 'mix-cu-1')
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

      // The review settles — nothing is open anymore.
      userInputRequestManager.resolve('mix-review-1', 'answered')
      messagePersister.syncAgentSessionsAwaiting(AGENT_SLUG)
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
    })

    it('the agent-wide sync cannot clear awaiting while a review remains open', () => {
      parkAgentReview('mix-review-2')
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

      // Before the derived flip, the agent-level clear door trusted its
      // caller to verify no reviews remained — a caller that forgot cleared
      // awaiting under a live review. The projection makes that impossible:
      // sync recomputes from the registry, and the review is still in it.
      messagePersister.syncAgentSessionsAwaiting(AGENT_SLUG)
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

      // A stray tool_result on the session doesn't drop it either.
      sendToolResult('unknown-tool-id')
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

      userInputRequestManager.resolve('mix-review-2', 'declined')
      messagePersister.syncAgentSessionsAwaiting(AGENT_SLUG)
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
    })
  })

  // ==========================================================================
  // Sidechain delivery matrix — the acceptance table for unified dispatch.
  //
  // Every kind must surface from BOTH sidechain delivery paths (subagent
  // stream events and complete assistant messages), exactly like the main
  // path: card broadcast + awaiting status. Before the unified dispatcher,
  // the `false` rows (secret, question, connected account, file, remote MCP)
  // hung silently — a subagent's ask parked forever in the container with no
  // card, no status, no notification. A new request kind added to the
  // dispatcher belongs in this table.
  // ==========================================================================

  interface SidechainCase {
    label: string
    toolName: string
    input: Record<string, unknown>
    sseType: string
    surfacesToday: boolean
  }

  const SIDECHAIN_MATRIX: SidechainCase[] = [
    {
      label: 'browser input',
      toolName: 'mcp__user-input__request_browser_input',
      input: { message: 'Log in', requirements: [] },
      sseType: 'browser_input_request',
      surfacesToday: true,
    },
    {
      label: 'script run',
      toolName: 'mcp__user-input__request_script_run',
      input: { script: 'sw_vers', explanation: 'Version', scriptType: 'shell' },
      sseType: 'script_run_request',
      surfacesToday: true,
    },
    {
      label: 'computer use',
      toolName: 'mcp__computer-use__computer_click',
      input: { x: 1, y: 2 },
      sseType: 'computer_use_request',
      surfacesToday: true,
    },
    {
      label: 'secret',
      toolName: 'mcp__user-input__request_secret',
      input: { secretName: 'API_KEY', reason: 'Need it' },
      sseType: 'secret_request',
      surfacesToday: true,
    },
    {
      label: 'question',
      toolName: 'AskUserQuestion',
      input: {
        questions: [{ question: 'Pick DB', header: 'DB', options: [], multiSelect: false }],
      },
      sseType: 'user_question_request',
      surfacesToday: true,
    },
    {
      label: 'connected account',
      toolName: 'mcp__user-input__request_connected_account',
      input: { toolkit: 'github', reason: 'Need access' },
      sseType: 'connected_account_request',
      surfacesToday: true,
    },
    {
      label: 'file',
      toolName: 'mcp__user-input__request_file',
      input: { description: 'Upload a CSV' },
      sseType: 'file_request',
      surfacesToday: true,
    },
    {
      label: 'remote MCP',
      toolName: 'mcp__user-input__request_remote_mcp',
      input: { url: 'https://example.com/mcp', name: 'Example', reason: 'Docs' },
      sseType: 'remote_mcp_request',
      surfacesToday: true,
    },
  ]

  describe.each(SIDECHAIN_MATRIX)(
    'sidechain: $label (surfaces today: $surfacesToday)',
    ({ toolName, input, sseType, surfacesToday }) => {
      function sendSidechainStreamToolUse(toolId: string, parentToolId = 'parent-task-1') {
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
        toolId: string,
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

      it('subagent stream events: card broadcast and awaiting match the matrix', () => {
        sendSidechainStreamToolUse('side-stream-1')

        const cards = sseEvents.filter((e) => e.type === sseType)
        expect(cards).toHaveLength(surfacesToday ? 1 : 0)
        expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(surfacesToday)
      })

      it('complete sidechain assistant message: card broadcast and awaiting match the matrix', () => {
        sendSidechainCompleteAssistantToolUse('side-complete-1')

        const cards = sseEvents.filter((e) => e.type === sseType)
        expect(cards).toHaveLength(surfacesToday ? 1 : 0)
        expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(surfacesToday)
      })
    }
  )

  // ==========================================================================
  // Sidechain dedupe + resolution semantics for dispatcher-surfaced kinds
  // ==========================================================================

  describe('sidechain dedupe and resolution', () => {
    function sendSidechainToolUse(
      toolName: string,
      toolId: string,
      input: Record<string, unknown>,
      parentToolId: string,
      via: 'stream' | 'complete'
    ) {
      if (via === 'complete') {
        mockClient._sendMessage({
          type: 'assistant',
          parent_tool_use_id: parentToolId,
          message: {
            content: [{ type: 'tool_use', id: toolId, name: toolName, input }],
          },
        })
        return
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const send = (event: any) =>
        mockClient._sendMessage({ type: 'stream_event', parent_tool_use_id: parentToolId, event })
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

    function sendSidechainToolResult(toolId: string, parentToolId: string) {
      mockClient._sendMessage({
        type: 'user',
        parent_tool_use_id: parentToolId,
        message: {
          content: [{ type: 'tool_result', tool_use_id: toolId, content: 'resolved' }],
        },
      })
    }

    it('first delivery wins: stream stop then complete-assistant with the same toolUseId emits ONE card', () => {
      const input = { secretName: 'DUP_KEY', reason: 'Dedupe check' }
      sendSidechainToolUse('mcp__user-input__request_secret', 'dup-1', input, 'parent-dup', 'stream')
      sendSidechainToolUse('mcp__user-input__request_secret', 'dup-1', input, 'parent-dup', 'complete')

      expect(sseEvents.filter((e) => e.type === 'secret_request')).toHaveLength(1)
      expect(messagePersister.getPendingInputRequests(SESSION_ID)).toHaveLength(1)
    })

    it('a sidechain tool_result resolves a dispatcher-surfaced kind: entry dropped, tool_result broadcast, awaiting cleared', () => {
      sendSidechainToolUse(
        'mcp__user-input__request_secret',
        'side-res-1',
        { secretName: 'SUB_KEY', reason: 'From a subagent' },
        'parent-res',
        'complete'
      )
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)
      sseEvents.length = 0

      sendSidechainToolResult('side-res-1', 'parent-res')

      expect(sseEvents.filter((e) => e.type === 'tool_result')).toHaveLength(1)
      expect(messagePersister.getPendingInputRequests(SESSION_ID)).toHaveLength(0)
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
    })

    it('the sidechain resolve applies the both-stores rule: a parked computer-use keeps awaiting on', () => {
      sendSidechainToolUse(
        'AskUserQuestion',
        'side-q-1',
        { questions: [{ question: 'Pick DB', header: 'DB', options: [], multiSelect: false }] },
        'parent-mix',
        'complete'
      )
      simulateToolUse('mcp__computer-use__computer_click', 'side-cu-1', { x: 1, y: 2 })
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

      sendSidechainToolResult('side-q-1', 'parent-mix')
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

      // Clearing the last computer-use entry now flips the light (shared rule).
      messagePersister.clearPendingComputerUseRequest(SESSION_ID, 'side-cu-1')
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
    })

    it('an auto-approved script replay entry does not keep awaiting on after the last real ask resolves', async () => {
      mockCheckPermission.mockReturnValue('granted')
      const fetchMock = vi.fn(() => Promise.resolve({ ok: true } as Response))
      vi.stubGlobal('fetch', fetchMock)
      try {
        sendSidechainToolUse(
          'mcp__user-input__request_script_run',
          'side-sr-auto',
          { script: 'sw_vers', explanation: 'Version', scriptType: 'shell' },
          'parent-auto',
          'complete'
        )
        expect(
          messagePersister
            .getPendingInputRequests(SESSION_ID)
            .some((r) => r.toolUseId === 'side-sr-auto' && r.autoApproved === true)
        ).toBe(true)

        mockCheckPermission.mockReturnValue('prompt_needed')
        sendSidechainToolUse(
          'mcp__user-input__request_secret',
          'side-real-1',
          { secretName: 'REAL_KEY', reason: 'A real ask' },
          'parent-auto',
          'complete'
        )
        expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

        // The auto-approved script's replay entry is still tracked, but it is
        // not a real wait — resolving the secret must clear awaiting.
        sendSidechainToolResult('side-real-1', 'parent-auto')
        expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('the sidechain resolve keeps awaiting on while a proxy/x-agent review is parked', () => {
      userInputRequestManager.register({
        id: 'side-review-1',
        kind: 'proxy_review',
        scope: { agentSlug: AGENT_SLUG },
        blocking: true,
        autoApproved: false,
        payload: { toolkit: 'slack' },
      })
      sendSidechainToolUse(
        'mcp__user-input__request_secret',
        'side-blk-1',
        { secretName: 'BLK_KEY', reason: 'Blocked resolve' },
        'parent-blk',
        'complete'
      )
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

      // The subagent's ask resolves, but the review is still parked — the
      // waiting light must stay on.
      sendSidechainToolResult('side-blk-1', 'parent-blk')
      expect(messagePersister.getPendingInputRequests(SESSION_ID)).toHaveLength(0)
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

      userInputRequestManager.resolve('side-review-1', 'answered')
      messagePersister.syncAgentSessionsAwaiting(AGENT_SLUG)
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
    })
  })

  // ==========================================================================
  // Shadow registry: every store mutation writes through to the
  // UserInputRequestManager, whose per-store view must mirror the legacy
  // stores exactly (the persister asserts this inline at every mutation —
  // storeMismatches must stay 0). Its derived awaiting projection is what the
  // persister's isSessionAwaitingInput now reports.
  // ==========================================================================

  describe('shadow registry equivalence', () => {
    const KIND_BY_SSE_TYPE: Record<string, string> = {
      secret_request: 'secret',
      user_question_request: 'question',
      connected_account_request: 'connected_account',
      file_request: 'file',
      remote_mcp_request: 'remote_mcp',
      browser_input_request: 'browser_input',
      script_run_request: 'script_run',
    }

    it('every standard kind registers a typed entry mirroring the replay store, and settles with it', async () => {
      for (const kindCase of STANDARD_KINDS) {
        const toolId = `shadow-${kindCase.sseType}`
        simulateToolUse(kindCase.toolName, toolId, kindCase.input)

        await vi.waitFor(() => {
          expect(
            userInputRequestManager.getOpenRequestsForSession(SESSION_ID).map((r) => r.id)
          ).toContain(toolId)
        })
        const entry = userInputRequestManager
          .getOpenRequestsForSession(SESSION_ID)
          .find((r) => r.id === toolId)!
        expect(entry.kind, kindCase.label).toBe(KIND_BY_SSE_TYPE[kindCase.sseType])
        expect(entry.scope).toEqual({ agentSlug: AGENT_SLUG, sessionId: SESSION_ID })

        // Exact mirror of the legacy replay store.
        expect(
          [...userInputRequestManager.getStoreIdsForSession(SESSION_ID, 'stream')].sort()
        ).toEqual(
          messagePersister
            .getPendingInputRequests(SESSION_ID)
            .map((r) => r.toolUseId)
            .sort()
        )

        sendToolResult(toolId)
        expect(
          userInputRequestManager.getOpenRequestsForSession(SESSION_ID).map((r) => r.id)
        ).not.toContain(toolId)
        expect(userInputRequestManager.stats.recentResolutions.at(-1)).toEqual({
          id: toolId,
          kind: KIND_BY_SSE_TYPE[kindCase.sseType],
          outcome: 'answered',
        })
      }
      expect(userInputRequestManager.stats.storeMismatches).toBe(0)
    })

    it('a stray main-path tool_result cannot evict the registry\'s computer-use entry (store-scoped resolve)', () => {
      simulateToolUse('mcp__computer-use__computer_click', 'shadow-cu-1', { x: 1, y: 2 })
      expect(userInputRequestManager.getStoreIdsForSession(SESSION_ID, 'computer_use')).toEqual([
        'shadow-cu-1',
      ])

      // Pinned divergence: the tool_result leaves the computer-use store
      // untouched. The registry mirrors the STORE, not the tool_result — if it
      // settled here, the inline parity assert would blow up this test.
      sendToolResult('shadow-cu-1')
      expect(userInputRequestManager.getStoreIdsForSession(SESSION_ID, 'computer_use')).toEqual([
        'shadow-cu-1',
      ])

      messagePersister.clearPendingComputerUseRequest(SESSION_ID, 'shadow-cu-1')
      expect(userInputRequestManager.getStoreIdsForSession(SESSION_ID, 'computer_use')).toEqual([])
      expect(userInputRequestManager.stats.recentResolutions.at(-1)).toEqual({
        id: 'shadow-cu-1',
        kind: 'computer_use',
        outcome: 'answered',
      })
      expect(userInputRequestManager.stats.storeMismatches).toBe(0)
    })

    it('parallel requests: the reported status tracks the projection across partial resolves', () => {
      simulateToolUse('mcp__user-input__request_secret', 'shadow-par-1', {
        secretName: 'API_KEY',
        reason: 'Need it',
      })
      simulateToolUse('AskUserQuestion', 'shadow-par-2', {
        questions: [{ question: 'Pick DB', header: 'DB', options: [], multiSelect: false }],
      })
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)
      expect(userInputRequestManager.isSessionAwaiting(SESSION_ID, AGENT_SLUG)).toBe(true)

      // The first tool_result settles one request; the second card is still
      // parked, so bit and projection both stay on — the persister's status
      // IS the projection now.
      sendToolResult('shadow-par-1')
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)
      expect(userInputRequestManager.isSessionAwaiting(SESSION_ID, AGENT_SLUG)).toBe(true)

      sendToolResult('shadow-par-2')
      expect(userInputRequestManager.isSessionAwaiting(SESSION_ID, AGENT_SLUG)).toBe(false)
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
      expect(userInputRequestManager.stats.storeMismatches).toBe(0)
    })

    it('capability review: complete settles the registry entry and the reported status together', async () => {
      mockAgentCapabilities.subagents = 'allow'
      mockAgentCapabilities.workflows = 'review'
      vi.mocked(mockClient.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ grants: [] }),
      } as unknown as Response)

      simulateToolUse('Workflow', 'shadow-cap-1', { script: 'export const meta = {}' })
      await vi.waitFor(() => {
        expect(
          userInputRequestManager.getOpenRequestsForSession(SESSION_ID).map((r) => r.id)
        ).toContain('shadow-cap-1')
      })
      expect(
        userInputRequestManager.getOpenRequestsForSession(SESSION_ID)[0].kind
      ).toBe('capability_review')

      messagePersister.completeCapabilityReview(SESSION_ID, 'shadow-cap-1')
      expect(userInputRequestManager.getOpenRequestsForSession(SESSION_ID)).toHaveLength(0)
      expect(userInputRequestManager.isSessionAwaiting(SESSION_ID, AGENT_SLUG)).toBe(false)
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
      expect(userInputRequestManager.stats.storeMismatches).toBe(0)
    })

    it('the direct-clear doors record the caller\'s actual outcome, not a blanket answered', async () => {
      // Capability review declined via the decision route's door.
      mockAgentCapabilities.subagents = 'allow'
      mockAgentCapabilities.workflows = 'review'
      vi.mocked(mockClient.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ grants: [] }),
      } as unknown as Response)
      simulateToolUse('Workflow', 'shadow-out-1', { script: 'export const meta = {}' })
      await vi.waitFor(() => {
        expect(
          userInputRequestManager.getOpenRequestsForSession(SESSION_ID).map((r) => r.id)
        ).toContain('shadow-out-1')
      })
      messagePersister.completeCapabilityReview(SESSION_ID, 'shadow-out-1', 'declined')
      expect(userInputRequestManager.stats.recentResolutions.at(-1)).toEqual({
        id: 'shadow-out-1',
        kind: 'capability_review',
        outcome: 'declined',
      })

      // Computer use denied, then a second one consumed by an execution failure.
      simulateToolUse('mcp__computer-use__computer_click', 'shadow-out-2', { x: 1, y: 2 })
      messagePersister.clearPendingComputerUseRequest(SESSION_ID, 'shadow-out-2', 'declined')
      expect(userInputRequestManager.stats.recentResolutions.at(-1)).toEqual({
        id: 'shadow-out-2',
        kind: 'computer_use',
        outcome: 'declined',
      })

      simulateToolUse('mcp__computer-use__computer_click', 'shadow-out-3', { x: 3, y: 4 })
      messagePersister.clearPendingComputerUseRequest(SESSION_ID, 'shadow-out-3', 'invalidated')
      expect(userInputRequestManager.stats.recentResolutions.at(-1)).toEqual({
        id: 'shadow-out-3',
        kind: 'computer_use',
        outcome: 'invalidated',
      })
      expect(userInputRequestManager.stats.storeMismatches).toBe(0)
    })

    it('unsubscribe drops every session-scoped registry entry as invalidated', () => {
      simulateToolUse('mcp__user-input__request_secret', 'shadow-drop-1', {
        secretName: 'API_KEY',
        reason: 'Need it',
      })
      simulateToolUse('mcp__computer-use__computer_click', 'shadow-drop-2', { x: 1, y: 2 })
      expect(userInputRequestManager.getOpenRequestsForSession(SESSION_ID)).toHaveLength(2)

      messagePersister.unsubscribeFromSession(SESSION_ID)
      expect(userInputRequestManager.getOpenRequestsForSession(SESSION_ID)).toHaveLength(0)
      expect(
        userInputRequestManager.stats.recentResolutions.slice(-2).map((r) => r.outcome)
      ).toEqual(['invalidated', 'invalidated'])
    })
  })

  // ==========================================================================
  // Turn-boundary and transport crossings: the awaiting projection must hold
  // where a request's lifetime crosses a result, a runtime-started turn, a
  // transport reattach, or a recovery→cancel sequence — the seams where the
  // cache and its source of truth can drift apart.
  // ==========================================================================

  describe('turn-boundary and transport crossings', () => {
    function parkAgentReview(id: string) {
      userInputRequestManager.register({
        id,
        kind: 'proxy_review',
        scope: { agentSlug: AGENT_SLUG },
        blocking: true,
        autoApproved: false,
        payload: { toolkit: 'slack' },
      })
      messagePersister.syncAgentSessionsAwaiting(AGENT_SLUG)
    }

    it('cancelAwaitingInput rejects recovered entries on the container despite the replay filter', async () => {
      messagePersister.recoverSessionAwaitingInput(SESSION_ID, AGENT_SLUG, [
        { toolUseId: 'rec-cancel-1', toolName: 'AskUserQuestion' },
      ])
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)
      // The replay filter hides the synthesized entry from reconnecting clients…
      expect(messagePersister.getPendingInputRequests(SESSION_ID)).toHaveLength(0)

      // …but a replacement message must still clean it up container-side: the
      // recovered ask is exactly the one whose container pending may still be
      // live, and a late answer must not land on the abandoned turn.
      await messagePersister.cancelAwaitingInput(SESSION_ID, AGENT_SLUG)

      const rejectedUrls = mockContainerClientFetch.mock.calls
        .map((call) => call[0])
        .filter((url): url is string => typeof url === 'string' && url.endsWith('/reject'))
      expect(rejectedUrls).toContain('/inputs/rec-cancel-1/reject')
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
    })

    it('a clean success mid-turn re-derives awaiting instead of blind-clearing it', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const globalEvents: any[] = []
      const cleanup = messagePersister.addGlobalNotificationClient((data) => {
        globalEvents.push(data)
      })
      try {
        // The runtime announces state-event authority: a result alone no
        // longer settles the session.
        mockClient._sendMessage({
          type: 'system',
          subtype: 'capabilities',
          session_state_events: true,
        })
        parkAgentReview('boundary-review-1')
        expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

        mockClient._sendMessage({ type: 'result', subtype: 'success', num_turns: 1 })

        // Still active (the runtime owns idle) and the review is still open —
        // the session keeps reading awaiting, and no falling edge fires.
        expect(messagePersister.isSessionActive(SESSION_ID)).toBe(true)
        expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)
        expect(globalEvents.filter((e) => e.type === 'session_input_provided')).toHaveLength(0)

        // The review settles → the falling edge fires now, not never.
        userInputRequestManager.resolve('boundary-review-1', 'answered')
        messagePersister.syncAgentSessionsAwaiting(AGENT_SLUG)
        expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
        expect(globalEvents.filter((e) => e.type === 'session_input_provided')).toHaveLength(1)
      } finally {
        cleanup()
      }
    })

    it('a runtime-started turn picks up an already-parked agent review', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const globalEvents: any[] = []
      const cleanup = messagePersister.addGlobalNotificationClient((data) => {
        globalEvents.push(data)
      })
      try {
        // End the current turn (result-driven idle — no authority announced).
        mockClient._sendMessage({ type: 'result', subtype: 'success', num_turns: 1 })
        expect(messagePersister.isSessionActive(SESSION_ID)).toBe(false)

        // A review parks while the session is idle: an inactive session never
        // reads awaiting.
        parkAgentReview('boundary-review-2')
        expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)

        // The runtime starts the next (queued) turn itself — no POST, no
        // markSessionActive. The self-heal must sync the projection too.
        mockClient._sendMessage({
          type: 'system',
          subtype: 'session_state_changed',
          state: 'running',
        })
        expect(messagePersister.isSessionActive(SESSION_ID)).toBe(true)
        expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)
        expect(globalEvents.filter((e) => e.type === 'session_awaiting_input')).toHaveLength(1)
      } finally {
        cleanup()
      }
    })

    it('a transport re-subscribe preserves parked requests, their registry entries, and replay', async () => {
      simulateToolUse('mcp__user-input__request_secret', 'resub-secret-1', {
        secretName: 'API_KEY',
        reason: 'Need it',
      })
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

      // Reattach the stream (reconnect of an in-flight session). Only the
      // transport may turn over — the wait itself is still parked.
      const secondClient = createMockClient()
      await messagePersister.subscribeToSession(SESSION_ID, secondClient, SESSION_ID, AGENT_SLUG)

      // Replay store, registry entry, and cache all still agree, so a later
      // sync must NOT clear the genuinely parked ask.
      expect(
        messagePersister.getPendingInputRequests(SESSION_ID).map((r) => r.toolUseId)
      ).toEqual(['resub-secret-1'])
      expect(
        userInputRequestManager.getOpenRequestsForSession(SESSION_ID).map((r) => r.id)
      ).toContain('resub-secret-1')
      messagePersister.syncAgentSessionsAwaiting(AGENT_SLUG)
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

      // The parked ask resolves over the NEW transport and settles normally.
      secondClient._sendMessage({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'resub-secret-1', content: 'resolved' },
          ],
        },
      })
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
      expect(messagePersister.getPendingInputRequests(SESSION_ID)).toHaveLength(0)
    })

    it('the markSessionIdle revert clears the awaiting cache an agent review had set', () => {
      parkAgentReview('boundary-review-3')
      // markSessionActive's trailing sync picks up the open review.
      messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

      // The optimistic send fails → revert. An inactive session is never
      // awaiting, review or not — the cache resets with isActive.
      messagePersister.markSessionIdle(SESSION_ID)
      expect(messagePersister.isSessionActive(SESSION_ID)).toBe(false)
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
    })
  })

  // ==========================================================================
  // Decision-route settle: a successful decision must settle its request
  // immediately. The transcript tool_result normally does the cleanup, but
  // parallel tool calls hold every sibling's result until the LAST one
  // resolves — without an explicit settle, the decided entry stays open, the
  // snapshot keeps serving it, a reload resurrects the card, and the stale
  // card can act on a request that was already declined.
  // ==========================================================================

  describe('decision settle under parallel tool calls', () => {
    it('completeInputRequest settles one of two parallel asks without waiting for its tool_result', () => {
      simulateToolUse('mcp__user-input__request_secret', 'par-secret-1', {
        secretName: 'API_KEY',
        reason: 'Need it',
      })
      simulateToolUse('AskUserQuestion', 'par-question-1', {
        questions: [{ question: 'Pick DB', header: 'DB', options: [], multiSelect: false }],
      })
      expect(userInputRequestManager.getOpenRequestsForSession(SESSION_ID)).toHaveLength(2)
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

      messagePersister.completeInputRequest(SESSION_ID, 'par-secret-1', 'declined')

      // Registry and replay store both drop the declined ask NOW — a reload
      // must not resurrect it. The surviving question keeps the light on.
      expect(
        userInputRequestManager.getOpenRequestsForSession(SESSION_ID).map((r) => r.id),
      ).toEqual(['par-question-1'])
      expect(messagePersister.getPendingInputRequests(SESSION_ID).map((r) => r.toolUseId)).toEqual(
        ['par-question-1'],
      )
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)
      expect(
        userInputRequestManager.stats.recentResolutions.find((r) => r.id === 'par-secret-1')
          ?.outcome,
      ).toBe('declined')

      // Other tabs drop the card off the same broadcast the tool_result path
      // emits.
      const toolResults = sseEvents.filter(
        (e) => e.type === 'tool_result' && e.toolUseId === 'par-secret-1',
      )
      expect(toolResults).toHaveLength(1)
      expect(toolResults[0].isError).toBe(true)

      // When the CLI finally releases the parallel siblings' results, the
      // already-settled ask is a no-op — no double resolution.
      sendToolResult('par-secret-1')
      expect(
        userInputRequestManager.stats.recentResolutions.filter((r) => r.id === 'par-secret-1'),
      ).toHaveLength(1)

      sendToolResult('par-question-1')
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
    })

    it('the settled outcome is stamped for the messages route until the turn boundary clears it', () => {
      // The transcript still shows the declined call as unresolved while its
      // sibling holds the results back — the messages route stamps this
      // outcome so history consumers see a completed call.
      simulateToolUse('mcp__user-input__request_secret', 'par-stamp-1', {
        secretName: 'API_KEY',
        reason: 'Need it',
      })
      messagePersister.completeInputRequest(SESSION_ID, 'par-stamp-1', 'declined')
      expect(messagePersister.getSettledInputRequests(SESSION_ID).get('par-stamp-1')).toBe(
        'declined',
      )

      // The turn boundary lands the real results in the transcript — the
      // stamp expires with it.
      mockClient._sendMessage({ type: 'result', subtype: 'success', num_turns: 1 })
      expect(messagePersister.getSettledInputRequests(SESSION_ID).size).toBe(0)
    })

    it('settling the last parked ask clears awaiting, and callers without a sessionId derive it', () => {
      simulateToolUse('mcp__user-input__request_secret', 'par-solo-1', {
        secretName: 'API_KEY',
        reason: 'Need it',
      })
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

      // Chat connectors know only the toolUseId — the registry entry's scope
      // supplies the session.
      messagePersister.completeInputRequest(undefined, 'par-solo-1', 'answered')

      expect(userInputRequestManager.getOpenRequestsForSession(SESSION_ID)).toHaveLength(0)
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
    })
  })

  // ==========================================================================
  // Dead-subagent invalidation: a subagent that terminates with a parked
  // request leaves an unanswerable card. Its registry entries are linked by
  // parentToolUseId at dispatch, and subagent completion invalidates them —
  // registry, replay store, container pending, and awaiting status together.
  // ==========================================================================

  describe('dead-subagent request invalidation', () => {
    function sendSidechainToolUse(parentToolId: string, toolId: string) {
      mockClient._sendMessage({
        type: 'assistant',
        parent_tool_use_id: parentToolId,
        message: {
          content: [
            {
              type: 'tool_use',
              id: toolId,
              name: 'mcp__user-input__request_browser_input',
              input: { message: 'Log in', requirements: [] },
            },
          ],
        },
      })
    }

    it('a subagent that dies with a parked request invalidates it everywhere', async () => {
      sendSidechainToolUse('parent-dead-1', 'side-orphan-1')
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)
      expect(userInputRequestManager.getOpenRequestsForSession(SESSION_ID)).toHaveLength(1)

      // The subagent finishes WITHOUT a tool_result for the parked ask
      // (killed, errored, or torn down) — sidechain 'result' is its terminal
      // frame. Nothing can answer the request anymore.
      mockClient._sendMessage({
        type: 'result',
        parent_tool_use_id: 'parent-dead-1',
        subtype: 'success',
      })

      expect(userInputRequestManager.getOpenRequestsForSession(SESSION_ID)).toHaveLength(0)
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
      expect(messagePersister.getPendingInputRequests(SESSION_ID)).toHaveLength(0)
      expect(
        userInputRequestManager.stats.recentResolutions.find((r) => r.id === 'side-orphan-1')
          ?.outcome,
      ).toBe('invalidated')
      // The unified wire tells clients the card is dead.
      const resolved = sseEvents.filter(
        (e) => e.type === 'user_request_resolved' && e.requestId === 'side-orphan-1',
      )
      expect(resolved).toHaveLength(1)
      expect(resolved[0].outcome).toBe('invalidated')
      // The container-side pending is rejected so a late click can't land.
      await vi.waitFor(() => {
        expect(
          mockContainerClientFetch.mock.calls.some(
            (c) => c[0] === '/inputs/side-orphan-1/reject',
          ),
        ).toBe(true)
      })
    })

    it('a dead subagent also invalidates its parked script_run approval', () => {
      // script_run is dispatched ADJACENT to the blocking-tool funnel (its own
      // handler call at the sidechain sites), so its parent threading is a
      // separate seam from the six funnel kinds — and unlike capability
      // reviews it has no container-side cancelled-frame cleanup to fall
      // back on.
      mockClient._sendMessage({
        type: 'assistant',
        parent_tool_use_id: 'parent-script-1',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'side-script-1',
              name: 'mcp__user-input__request_script_run',
              input: { script: 'sw_vers', explanation: 'Version', scriptType: 'shell' },
            },
          ],
        },
      })
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)
      expect(
        userInputRequestManager.getOpenRequestsForSession(SESSION_ID).map((r) => r.id),
      ).toEqual(['side-script-1'])

      mockClient._sendMessage({
        type: 'result',
        parent_tool_use_id: 'parent-script-1',
        subtype: 'success',
      })

      expect(userInputRequestManager.getOpenRequestsForSession(SESSION_ID)).toHaveLength(0)
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
      expect(
        userInputRequestManager.stats.recentResolutions.find((r) => r.id === 'side-script-1')
          ?.outcome,
      ).toBe('invalidated')
    })

    it("a sibling subagent's death leaves another subagent's parked request open", () => {
      sendSidechainToolUse('parent-alive-1', 'side-kept-1')
      sendSidechainToolUse('parent-dying-1', 'side-dropped-1')
      expect(userInputRequestManager.getOpenRequestsForSession(SESSION_ID)).toHaveLength(2)

      mockClient._sendMessage({
        type: 'result',
        parent_tool_use_id: 'parent-dying-1',
        subtype: 'success',
      })

      const open = userInputRequestManager.getOpenRequestsForSession(SESSION_ID)
      expect(open.map((r) => r.id)).toEqual(['side-kept-1'])
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)
    })

    it("a main-agent request has no parent linkage and survives subagent completions", () => {
      simulateToolUse('mcp__user-input__request_secret', 'main-secret-1', {
        secretName: 'API_KEY',
        reason: 'Need it',
      })
      mockClient._sendMessage({
        type: 'result',
        parent_tool_use_id: 'parent-unrelated-1',
        subtype: 'success',
      })
      expect(
        userInputRequestManager.getOpenRequestsForSession(SESSION_ID).map((r) => r.id),
      ).toEqual(['main-secret-1'])
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)
    })
  })

  // ==========================================================================
  // Unified wire: every registry transition broadcasts ONE typed event —
  // user_request_created / user_request_resolved — alongside the legacy
  // per-type events, to the global stream always and the session stream when
  // session-scoped. Whatever mutation path drives the transition, the wire
  // sees it: that is the property that makes silent settles impossible here.
  // ==========================================================================

  describe('unified wire broadcasts', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let globalEvents: any[]
    let globalCleanup: () => void

    beforeEach(() => {
      globalEvents = []
      globalCleanup = messagePersister.addGlobalNotificationClient((data) => {
        globalEvents.push(data)
      })
    })

    afterEach(() => {
      globalCleanup()
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createdFor = (events: any[], id: string) =>
      events.filter((e) => e.type === 'user_request_created' && e.request?.id === id)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolvedFor = (events: any[], id: string) =>
      events.filter((e) => e.type === 'user_request_resolved' && e.requestId === id)

    it('a stream kind emits created on BOTH streams and resolved on its tool_result', () => {
      simulateToolUse('mcp__user-input__request_secret', 'wire-secret-1', {
        secretName: 'API_KEY',
        reason: 'Need it',
      })

      const created = createdFor(globalEvents, 'wire-secret-1')
      expect(created).toHaveLength(1)
      expect(created[0].request.kind).toBe('secret')
      expect(created[0].request.scope).toEqual({ agentSlug: AGENT_SLUG, sessionId: SESSION_ID })
      expect(created[0].request.payload.secretName).toBe('API_KEY')
      expect(createdFor(sseEvents, 'wire-secret-1')).toHaveLength(1)

      sendToolResult('wire-secret-1')
      const resolved = resolvedFor(globalEvents, 'wire-secret-1')
      expect(resolved).toHaveLength(1)
      expect(resolved[0].outcome).toBe('answered')
      expect(resolved[0].kind).toBe('secret')
      expect(resolvedFor(sseEvents, 'wire-secret-1')).toHaveLength(1)
    })

    it('a turn boundary settles parked entries onto the wire (no silent clears)', () => {
      simulateToolUse('mcp__user-input__request_secret', 'wire-boundary-1', {
        secretName: 'API_KEY',
        reason: 'Need it',
      })
      // The idle boundary cancels the parked ask; the wire must say so.
      mockClient._sendMessage({ type: 'result', subtype: 'success', num_turns: 1 })
      const resolved = resolvedFor(globalEvents, 'wire-boundary-1')
      expect(resolved).toHaveLength(1)
      expect(resolved[0].outcome).toBe('cancelled')
    })

    it('wire events carry a top-level agentSlug — the global-stream ACL filter reads only that', () => {
      // notifications.ts filters global events by the TOP-LEVEL agentSlug and
      // forwards anything without one to every authenticated user. Nesting
      // the slug inside request.scope/scope would broadcast full request
      // payloads (secret names, scripts, review details) tenant-wide.
      simulateToolUse('mcp__user-input__request_secret', 'wire-acl-1', {
        secretName: 'API_KEY',
        reason: 'Need it',
      })
      const created = createdFor(globalEvents, 'wire-acl-1')
      expect(created).toHaveLength(1)
      expect(created[0].agentSlug).toBe(AGENT_SLUG)

      sendToolResult('wire-acl-1')
      const resolved = resolvedFor(globalEvents, 'wire-acl-1')
      expect(resolved).toHaveLength(1)
      expect(resolved[0].agentSlug).toBe(AGENT_SLUG)
    })

    it('an agent-scoped review emits on the global stream only (it has no session stream)', () => {
      userInputRequestManager.register({
        id: 'wire-review-1',
        kind: 'proxy_review',
        scope: { agentSlug: AGENT_SLUG },
        blocking: true,
        autoApproved: false,
        payload: { toolkit: 'slack' },
      })
      expect(createdFor(globalEvents, 'wire-review-1')).toHaveLength(1)
      expect(createdFor(sseEvents, 'wire-review-1')).toHaveLength(0)

      userInputRequestManager.resolve('wire-review-1', 'declined')
      const resolved = resolvedFor(globalEvents, 'wire-review-1')
      expect(resolved).toHaveLength(1)
      expect(resolved[0].outcome).toBe('declined')
    })

    it('a request without a verified agentSlug never reaches the global stream (fail closed)', () => {
      // The global-stream ACL filter forwards events without a top-level
      // agentSlug to EVERY authenticated user. The scope schema types the
      // slug as optional, so the broadcast boundary must fail closed rather
      // than trust that every registration path populated it. The session
      // stream still gets the event — its subscribers are AgentRead-gated.
      userInputRequestManager.register({
        id: 'wire-noslug-1',
        kind: 'secret',
        scope: { sessionId: SESSION_ID },
        blocking: true,
        autoApproved: false,
        payload: { secretName: 'K' },
      })
      // An empty-string slug is just as fail-open: the filter's truthiness
      // check skips it exactly like a missing one.
      userInputRequestManager.register({
        id: 'wire-noslug-2',
        kind: 'secret',
        scope: { agentSlug: '', sessionId: SESSION_ID },
        blocking: true,
        autoApproved: false,
        payload: { secretName: 'K2' },
      })

      expect(createdFor(globalEvents, 'wire-noslug-1')).toHaveLength(0)
      expect(createdFor(globalEvents, 'wire-noslug-2')).toHaveLength(0)
      expect(createdFor(sseEvents, 'wire-noslug-1')).toHaveLength(1)
      expect(createdFor(sseEvents, 'wire-noslug-2')).toHaveLength(1)

      userInputRequestManager.resolve('wire-noslug-1', 'answered')
      expect(resolvedFor(globalEvents, 'wire-noslug-1')).toHaveLength(0)
      expect(resolvedFor(sseEvents, 'wire-noslug-1')).toHaveLength(1)
    })

    it('recovery synthetics never hit the wire — the transcript renders those cards', () => {
      messagePersister.recoverSessionAwaitingInput(SESSION_ID, AGENT_SLUG, [
        { toolUseId: 'wire-recovered-1', toolName: 'AskUserQuestion' },
      ])
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)
      expect(createdFor(globalEvents, 'wire-recovered-1')).toHaveLength(0)
      expect(createdFor(sseEvents, 'wire-recovered-1')).toHaveLength(0)
    })

    it('the real registration upgrades a recovered synthetic and finally hits the wire', () => {
      // Recovery beat the stream event (the GET-messages read raced the
      // container stream). Without the upgrade, the payload-less stub blocks
      // the real registration forever: clients never receive a renderable
      // user_request_created and the snapshot serves a stub the card guards
      // drop.
      messagePersister.recoverSessionAwaitingInput(SESSION_ID, AGENT_SLUG, [
        { toolUseId: 'wire-upgrade-1', toolName: 'mcp__user-input__request_secret' },
      ])
      expect(createdFor(globalEvents, 'wire-upgrade-1')).toHaveLength(0)

      simulateToolUse('mcp__user-input__request_secret', 'wire-upgrade-1', {
        secretName: 'API_KEY',
        reason: 'Need it',
      })

      const created = createdFor(globalEvents, 'wire-upgrade-1')
      expect(created).toHaveLength(1)
      expect(created[0].request.payload.secretName).toBe('API_KEY')

      const entry = userInputRequestManager
        .getSnapshotForScope(AGENT_SLUG, SESSION_ID)
        .find((r) => r.id === 'wire-upgrade-1')
      expect((entry?.payload as { recovered?: boolean }).recovered).toBeUndefined()
      expect((entry?.payload as { secretName?: string }).secretName).toBe('API_KEY')
    })

    it('the snapshot a reconnecting client fetches matches the wire it missed', () => {
      simulateToolUse('mcp__user-input__request_secret', 'wire-snap-1', {
        secretName: 'API_KEY',
        reason: 'Need it',
      })
      userInputRequestManager.register({
        id: 'wire-snap-review',
        kind: 'proxy_review',
        scope: { agentSlug: AGENT_SLUG },
        blocking: true,
        autoApproved: false,
        payload: { toolkit: 'slack' },
      })

      const ids = userInputRequestManager
        .getSnapshotForScope(AGENT_SLUG, SESSION_ID)
        .map((r) => r.id)
        .sort()
      expect(ids).toEqual(['wire-snap-1', 'wire-snap-review'])

      userInputRequestManager.resolve('wire-snap-review', 'answered')
      sendToolResult('wire-snap-1')
      expect(userInputRequestManager.getSnapshotForScope(AGENT_SLUG, SESSION_ID)).toHaveLength(0)
    })
  })
})
