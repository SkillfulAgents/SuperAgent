/**
 * Characterization suite for the pending user-input request lifecycle.
 *
 * Every user-facing request kind must satisfy the same contract on the main
 * stream path: open → broadcast exactly one request card → mark the session
 * awaiting → notify exactly once → resolve → drop the replay entry → clear
 * awaiting only when it was the last blocking wait.
 *
 * This file pins CURRENT behavior — including the known divergences it
 * documents inline (computer-use's separate store, capability review's early
 * clear, and the sidechain kinds that do not surface at all today). The
 * sidechain matrix at the bottom is the acceptance table for the unified
 * dispatch work: entries marked `surfacesToday: false` are the live gap where
 * a subagent's request hangs silently, and that work flips them to true.
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

    mockClient = createMockClient()
    await messagePersister.subscribeToSession(SESSION_ID, mockClient, SESSION_ID, AGENT_SLUG)

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
        // KNOWN SPLIT-BRAIN (pinned, not desired): the main-path user-message
        // handler clears awaiting without consulting the stream shelves — it
        // only defers to external review blockers. The second request's
        // replay entry is still parked (the card stack still shows it), but
        // the sidebar/header bit already reads "not waiting". Derived
        // awaiting state flips this expectation to `true`.
        expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
        expect(messagePersister.getPendingInputRequests(SESSION_ID)).toHaveLength(1)

        sendToolResult('tool-par-2')
        expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
        expect(messagePersister.getPendingInputRequests(SESSION_ID)).toHaveLength(0)
      })
    }
  )

  // ==========================================================================
  // Documented divergence: computer-use lives in a separate store with
  // route-driven clearing (the two-shelf split this suite exists to pin down)
  // ==========================================================================

  describe('main stream: computer use (divergent two-store lifecycle)', () => {
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

    it('a tool_result alone does NOT drop the parked entry, yet it DOES clear awaiting', () => {
      simulateToolUse(TOOL, 'cu-clear-1', { x: 1, y: 2 })
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

      // KNOWN SPLIT-BRAIN (pinned, not desired): the computer-use shelf is
      // cleared only via the decision route's explicit call, so the entry
      // survives the tool_result — but the main-path user-message handler
      // still clears the awaiting bit without consulting this shelf. Card
      // parked, light off. Derived awaiting state flips the second
      // expectation to `true`.
      sendToolResult('cu-clear-1')
      expect(
        messagePersister.getPendingComputerUseRequests(SESSION_ID).map((r) => r.toolUseId)
      ).toContain('cu-clear-1')
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)

      messagePersister.clearPendingComputerUseRequest(SESSION_ID, 'cu-clear-1')
      expect(messagePersister.getPendingComputerUseRequests(SESSION_ID)).toHaveLength(0)
    })

    it('the route clear broadcasts session_input_provided but never flips the awaiting bit itself', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const globalEvents: any[] = []
      const cleanup = messagePersister.addGlobalNotificationClient((data) => {
        globalEvents.push(data)
      })
      try {
        simulateToolUse(TOOL, 'cu-clear-2', { x: 1, y: 2 })
        expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

        // KNOWN SPLIT-BRAIN (pinned, not desired): clearPendingComputerUseRequest
        // broadcasts session_input_provided when its own shelf empties, but by
        // design leaves isAwaitingInput to "the tool result arriving in the
        // stream" — so the wire says input was provided while the bit still
        // says awaiting. Consumers reading the bit and consumers reading the
        // event disagree until the tool_result lands.
        messagePersister.clearPendingComputerUseRequest(SESSION_ID, 'cu-clear-2')
        expect(
          globalEvents.filter((e) => e.type === 'session_input_provided')
        ).toHaveLength(1)
        expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)
      } finally {
        cleanup()
      }
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

    it('completeCapabilityReview drops the replay entry and broadcasts, but never flips the awaiting bit', async () => {
      simulateToolUse('Workflow', 'wf-lifecycle-2', { script: 'export const meta = {}' })
      await vi.waitFor(() => {
        expect(messagePersister.getPendingInputRequests(SESSION_ID)).toHaveLength(1)
      })

      messagePersister.completeCapabilityReview(SESSION_ID, 'wf-lifecycle-2')

      expect(messagePersister.getPendingInputRequests(SESSION_ID)).toHaveLength(0)
      expect(sseEvents.filter((e) => e.type === 'capability_review_resolved')).toHaveLength(1)
      // KNOWN SPLIT-BRAIN (pinned, not desired): like the computer-use route
      // clear, this door empties its shelf and broadcasts but leaves the
      // awaiting bit set — it stays true until later stream traffic (the
      // launched tool's own lifecycle) clears it.
      expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)
    })
  })

  // ==========================================================================
  // Cross-shelf awaiting arithmetic: input store + computer-use store +
  // external blocker source (the ReviewManager seam). Awaiting must survive
  // until the LAST wait across all three resolves.
  // ==========================================================================

  describe('cross-shelf awaiting arithmetic', () => {
    it('a held external blocker keeps awaiting alive through tool_results; the agent door releases it', () => {
      let blockerHeld = true
      const unregister = messagePersister.registerAwaitingBlockerSource(
        (agentSlug) => agentSlug === AGENT_SLUG && blockerHeld
      )

      try {
        simulateToolUse('mcp__user-input__request_secret', 'mix-secret-1', {
          secretName: 'API_KEY',
          reason: 'Need it',
        })
        simulateToolUse('mcp__computer-use__computer_click', 'mix-cu-1', { x: 1, y: 2 })
        expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

        // The user-message clear defers to a held external blocker — this is
        // the ONLY thing that saves the awaiting bit here: the still-parked
        // computer-use entry would not (see the split-brain pins above).
        sendToolResult('mix-secret-1')
        expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

        // The computer-use route clear never flips the bit, so awaiting
        // survives it too (broadcast fires, bit untouched).
        messagePersister.clearPendingComputerUseRequest(SESSION_ID, 'mix-cu-1')
        expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

        // Once the blocker releases, the agent-level door clears it: both
        // stream shelves are empty by now.
        blockerHeld = false
        messagePersister.clearAwaitingInputForAgentIfUnblocked(AGENT_SLUG)
        expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
      } finally {
        unregister()
      }
    })

    it('the agent-level door checks stream shelves only — external blockers are the CALLER\'s contract', () => {
      let blockerHeld = true
      const unregister = messagePersister.registerAwaitingBlockerSource(
        (agentSlug) => agentSlug === AGENT_SLUG && blockerHeld
      )

      try {
        messagePersister.markAwaitingInput(SESSION_ID)
        expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

        // A held user-message clear defers to the blocker source…
        sendToolResult('unknown-tool-id')
        expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

        // …but clearAwaitingInputForAgentIfUnblocked does NOT consult
        // external blocker sources. Its documented contract is that the
        // caller (ReviewManager) verifies no reviews remain before calling.
        // Pinned: a caller that forgets this check clears awaiting while a
        // review is still parked — nothing in the persister stops it.
        messagePersister.clearAwaitingInputForAgentIfUnblocked(AGENT_SLUG)
        expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)

        blockerHeld = false
      } finally {
        unregister()
      }
    })
  })

  // ==========================================================================
  // Sidechain delivery matrix — the acceptance table for unified dispatch.
  //
  // `surfacesToday: false` rows document the LIVE GAP: a subagent calling
  // that tool parks forever in the container while the host surfaces nothing
  // — no card, no awaiting status, no notification. The unified-dispatch
  // change is expected to flip every row to true; each false row here is a
  // deliberate red-flag pin, not desired behavior.
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
      surfacesToday: false,
    },
    {
      label: 'question',
      toolName: 'AskUserQuestion',
      input: {
        questions: [{ question: 'Pick DB', header: 'DB', options: [], multiSelect: false }],
      },
      sseType: 'user_question_request',
      surfacesToday: false,
    },
    {
      label: 'connected account',
      toolName: 'mcp__user-input__request_connected_account',
      input: { toolkit: 'github', reason: 'Need access' },
      sseType: 'connected_account_request',
      surfacesToday: false,
    },
    {
      label: 'file',
      toolName: 'mcp__user-input__request_file',
      input: { description: 'Upload a CSV' },
      sseType: 'file_request',
      surfacesToday: false,
    },
    {
      label: 'remote MCP',
      toolName: 'mcp__user-input__request_remote_mcp',
      input: { url: 'https://example.com/mcp', name: 'Example', reason: 'Docs' },
      sseType: 'remote_mcp_request',
      surfacesToday: false,
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
})
