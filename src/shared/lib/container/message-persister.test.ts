import { isQueuedSessionSend } from './session-send-context'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ContainerClient, ContainerInfo, StreamMessage } from './types'
import { WebSocketServer } from 'ws'

// Mock external dependencies before importing

// The host tools are tested beside their handlers (src/shared/lib/host/tools);
// here they are the host's business. A tool call that reaches the real local
// host port gets this stand-in, so no test runs one against real services.
vi.mock('@shared/lib/host/tools', () => ({
  runHostTool: vi.fn(() => Promise.resolve({ status: 'resolved', value: '' })),
}))
vi.mock('@shared/lib/services/session-service', () => ({
  updateSessionMetadata: vi.fn(() => Promise.resolve()),
  getSessionMetadata: vi.fn(() => Promise.resolve(null)),
  finalizeAutomationStatus: vi.fn(() => Promise.resolve('updated')),
}))
const mockRecordSessionActivity = vi.fn()
const mockRecordProvisionalSessionActivity = vi.fn((_slug: string, _id: string, at: number) => ({
  recordedAtMs: at,
  previous: { mtimeMs: at - 60_000, size: 10 },
}))
const mockRevertSessionActivity = vi.fn()
vi.mock('@shared/lib/services/session-summary-cache', () => ({
  recordSessionActivity: (...args: unknown[]) => mockRecordSessionActivity(...args),
  recordProvisionalSessionActivity: (...args: unknown[]) =>
    mockRecordProvisionalSessionActivity(...(args as [string, string, number])),
  revertSessionActivity: (...args: unknown[]) => mockRevertSessionActivity(...args),
}))
const mockAppendInformationalEntry = vi.fn((..._args: unknown[]) => Promise.resolve())
vi.mock('@shared/lib/services/session-transcript-append', () => ({
  appendInformationalEntry: (...args: unknown[]) => mockAppendInformationalEntry(...args),
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
  getSessionJsonlPath: vi.fn(() => '/mock/sessions/test-session-1.jsonl'),
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
  computerUseMethodFromToolName: vi.fn((toolName: string) => {
    const suffix = toolName.replace('mcp__computer-use__computer_', '')
    return suffix === 'menu' ? 'menuClick' : suffix
  }),
  getRequiredPermissionLevel: vi.fn((method: string) => (
    ['apps', 'windows', 'status', 'displays', 'permissions'].includes(method)
      ? 'list_apps_windows'
      : 'use_application'
  )),
  resolveTargetApp: vi.fn(() => undefined),
  READ_ONLY_METHODS: new Set(['apps', 'windows', 'status', 'displays', 'permissions']),
  TIMED_GRANT_DURATION_MS: 15 * 60 * 1000,
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockFn = (...args: any[]) => any

// Read by modules the persister loads (PlatformLlmProvider, platform
// attribution): no platform member, an opaque access key.
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getStoredPlatformMemberId: () => null,
  getPlatformAccessToken: () => 'opaque_token',
  // Read by PlatformLlmProvider when it resolves the billing link for a provider error.
  getPlatformAuthStatus: () => ({ connected: false, orgId: null }),
}))

// Modules the persister loads import the database; no test here opens one.
vi.mock('@shared/lib/db', () => ({ db: {} }))
vi.mock('@shared/lib/db/schema', () => ({}))

// Mock container-host (used by resolveContainerInput / rejectContainerInput)
const mockContainerClientFetch = vi.fn<MockFn>(() => Promise.resolve({ ok: true }))
vi.mock('./container-host', async () => {
  const { hostFromManagerMock } = await import('@shared/lib/agent-actor/testing/host-from-manager-mock')
  return {
    containerHost: hostFromManagerMock({
      getClient: () => ({
        fetch: (...args: unknown[]) => mockContainerClientFetch(...args),
      }),
    }),
  }
})

// Import after mocks are set up
import { messagePersister, redactStreamedToolInput, sessionKeyOf, WaitForIdleTimeoutError } from './message-persister'
import { WorkflowJournalTailer } from './workflow-journal-tailer'
import { createInMemorySessionStore } from '@shared/lib/agent-actor/testing/in-memory-session-store'

// The registry attaches the real stores; these tests drive the persister
// alone, over in-memory stores kept per agent so a test can reach the one
// the persister will use.
const sessionStores = new Map<string, ReturnType<typeof createInMemorySessionStore>>()
function storeFor(slug: string): ReturnType<typeof createInMemorySessionStore> {
  let store = sessionStores.get(slug)
  if (!store) {
    store = createInMemorySessionStore(slug)
    sessionStores.set(slug, store)
  }
  return store
}
messagePersister.attachSessionStores(storeFor)
import { attachInMemoryAgentState } from '@shared/lib/agent-actor/testing/in-memory-agent-state'
// Likewise the actors' in-memory stores (requests, reviews, grants), which
// the persister routes to through the singletons.
attachInMemoryAgentState({ syncAwaiting: (slug) => messagePersister.syncAgentSessionsAwaiting(slug) })
import { notificationManager } from '@shared/lib/notifications/notification-manager'
import { globalFeed } from '@shared/lib/notifications/global-feed'
import { userInputRequestManager } from '@shared/lib/tools/requests/request-manager'
import * as toolRegistry from '@shared/lib/tools/registry'
import { finalizeAutomationStatus, getSessionMetadata, updateSessionMetadata } from '@shared/lib/services/session-service'
import { localHostPort } from '@shared/lib/host/local-host-port'
import type { HostCalls, HostPort, HostScriptOutput, HostToolResult } from '@shared/lib/agent-actor/host-port'

/**
 * A host port that records every call and answers the machine work and the
 * host tools itself (running a script, driving an app, a tool's outcome);
 * everything else goes to the real local handlers, over this file's mocked
 * services.
 */
function recordingHost(answers: {
  hostScript?: HostScriptOutput
  computerUse?: string | (() => Promise<string>)
  hostTool?: HostToolResult | (() => Promise<HostToolResult>)
}): { port: HostPort; calls: Array<[keyof HostCalls, unknown]> } {
  const calls: Array<[keyof HostCalls, unknown]> = []
  const call = async (name: keyof HostCalls, request: unknown): Promise<unknown> => {
    calls.push([name, request])
    if (name === 'computerUsePermissions') return null
    if (name === 'computerUse' && answers.computerUse !== undefined) {
      return typeof answers.computerUse === 'function' ? answers.computerUse() : answers.computerUse
    }
    if (name === 'hostScript' && answers.hostScript) return answers.hostScript
    if (name === 'hostTool' && answers.hostTool !== undefined) {
      return typeof answers.hostTool === 'function' ? answers.hostTool() : answers.hostTool
    }
    return localHostPort.call(name, request as never)
  }
  return {
    calls,
    port: { call: call as HostPort['call'], send: (name, event) => localHostPort.send(name, event) },
  }
}

describe('redactStreamedToolInput', () => {
  it('masks the secret in create/update_webhook_endpoint streamed input', () => {
    const input = '{"name":"gh","verification":{"algorithm":"hmac-sha256","secret":"whsec_supersecret","header":"x-sig"}}'
    // The stream carries the MCP-qualified name — that form MUST match, or
    // the redaction never fires on the real path. Bare names also work.
    for (const tool of [
      'mcp__user-input__create_webhook_endpoint',
      'mcp__user-input__update_webhook_endpoint',
      'create_webhook_endpoint',
      'update_webhook_endpoint',
    ]) {
      const out = redactStreamedToolInput(tool, input)
      expect(out).not.toContain('whsec_supersecret')
      expect(out).toContain('"secret":"***"')
      expect(out).toContain('"header":"x-sig"') // other fields untouched
    }
  })

  it('masks a value whose closing quote has not streamed yet', () => {
    const partial = '{"name":"gh","verification":{"secret":"whsec_partial'
    const out = redactStreamedToolInput('create_webhook_endpoint', partial)
    expect(out).not.toContain('whsec_partial')
    expect(out).toContain('"secret":"***')
  })

  it('leaves input for unrelated tools untouched', () => {
    const input = '{"secret":"not-a-webhook-secret"}'
    expect(redactStreamedToolInput('some_other_tool', input)).toBe(input)
    expect(redactStreamedToolInput('mcp__user-input__request_secret', input)).toBe(input)
    expect(redactStreamedToolInput(undefined, input)).toBe(input)
  })
})

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
    onFatalResult: vi.fn(() => 'settle'),
    observeUnexpectedDeath: vi.fn(async () => ({ action: 'settle' })),
    getRuntimeGenerationId: vi.fn(() => null),
  }

  return client as any
}

// Helper to collect SSE events from a session
function collectSSEEvents(agentSlug: string, sessionId: string): { events: any[]; cleanup: () => void } {
  const events: any[] = []
  const cleanup = messagePersister.addSSEClient(agentSlug, sessionId, (data) => {
    events.push(data)
  })
  return { events, cleanup }
}

// A turn's completion notification goes out once the transcript's end is
// known (an async stat); let that settle before asserting on it, either way.
const flushNotifications = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('MessagePersister', () => {
  const SESSION_ID = 'test-session-1'
  const AGENT_SLUG = 'test-agent'

  let mockClient: ReturnType<typeof createMockClient>
  let sseEvents: any[]
  let sseCleanup: () => void

  // One `user_request_created` per open request, carrying the registry
  // envelope — the only request wire there is.
  const requestCards = (kind: string) =>
    sseEvents.filter((e) => e.type === 'user_request_created' && e.request?.kind === kind)
  const openStreamRequestIds = () =>
    userInputRequestManager.getStoreIdsForSession(AGENT_SLUG, SESSION_ID, 'stream')

  beforeEach(async () => {
    mockClient = createMockClient()
    await messagePersister.subscribeToSession(AGENT_SLUG, SESSION_ID, mockClient, SESSION_ID)

    const sse = collectSSEEvents(AGENT_SLUG, SESSION_ID)
    sseEvents = sse.events
    sseCleanup = sse.cleanup
  })

  afterEach(() => {
    sseCleanup()
    messagePersister.unsubscribeFromSession(AGENT_SLUG, SESSION_ID)
    vi.clearAllMocks()
  })

  describe('replayable turn outcomes', () => {
    const snapshot = () => messagePersister.getSessionTurnOutcome(AGENT_SLUG, SESSION_ID)
    const emit = (content: Record<string, unknown>) => mockClient._sendMessage(content)
    const result = () => emit({ type: 'result', subtype: 'success', num_turns: 1, usage: {} })
    const idle = () => emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    const text = (value: string) => emit({ type: 'assistant', message: { id: 'answer', role: 'assistant', content: [{ type: 'text', text: value }] } })

    it('retains streamed text when no complete assistant frame was delivered', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      emit({ type: 'stream_event', event: { type: 'message_start' } })
      emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Invoice 42 was sent.' } } })
      result()
      expect(snapshot()).toMatchObject({ status: 'completed', responseText: 'Invoice 42 was sent.' })
    })

    it('records the existing idle decision and retains its text across reattachment', async () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      emit({ type: 'system', subtype: 'session_state_changed', state: 'running' })
      text('Invoice 42 was sent.')
      result()
      expect(snapshot()).toBeNull()
      idle()
      const completed = snapshot()
      expect(completed).toMatchObject({ status: 'completed', responseText: 'Invoice 42 was sent.' })
      await messagePersister.subscribeToSession(AGENT_SLUG, SESSION_ID, mockClient, SESSION_ID)
      expect(snapshot()).toEqual(completed)
      idle()
      expect(snapshot()).toEqual(completed)
    })

    it('records cancellation without changing the activity of surviving background work', async () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      text('Partial work.')
      emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg-task', task_type: 'local_bash' }] })
      await messagePersister.markSessionInterrupted(AGENT_SLUG, SESSION_ID, { processKept: true })
      expect(snapshot()).toMatchObject({ status: 'cancelled', responseText: 'Partial work.' })
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
      expect(sseEvents.findLast(e => e.type === 'session_waiting_background').turnOutcome.status).toBe('cancelled')
    })

    it('retains the latest partial side effect on an error before its assistant frame', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      text('Preparing the invoice.')
      emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'partial' } } })
      emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Invoice 42 was sent.' } } })
      emit({ type: 'result', subtype: 'error_during_execution', errors: ['Receipt upload failed.'] })
      expect(snapshot()).toMatchObject({ status: 'failed', responseText: 'Invoice 42 was sent.' })
      idle()
      expect(snapshot()?.status).toBe('failed')
    })
  })

  describe('turn boundaries are made by their emitters, not by the fan-out', () => {
    const emit = (content: Record<string, unknown>) => mockClient._sendMessage(content)
    const askQuestion = (id: string) => {
      emit({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id, name: 'AskUserQuestion' } } })
      emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: JSON.stringify({ questions: [{ question: 'Which?' }] }) } } })
      emit({ type: 'stream_event', event: { type: 'content_block_stop' } })
    }

    it('fans a broadcast boundary-shaped event out unchanged, touching no state', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      askQuestion('q-open')
      expect(openStreamRequestIds()).toEqual(['q-open'])

      const idle = { type: 'session_idle', isActive: false, outcome: 'completed' }
      messagePersister.broadcastSessionEvent(AGENT_SLUG, SESSION_ID, idle)
      messagePersister.broadcastSessionEvent(AGENT_SLUG, SESSION_ID, { type: 'session_active', isActive: true })
      messagePersister.broadcastSessionEvent(AGENT_SLUG, SESSION_ID, { type: 'stream_delta', text: 'not the answer' })

      expect(sseEvents).toContainEqual(idle)
      expect(messagePersister.getSessionTurnOutcome(AGENT_SLUG, SESSION_ID)).toBeNull()
      expect(openStreamRequestIds()).toEqual(['q-open'])
      expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(true)
    })

    it('puts the requests a new message supersedes on the stream before its session_active', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      askQuestion('q-superseded')
      sseEvents.length = 0

      // A queued message is a boundary for parked asks too.
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)

      const types = sseEvents.map((e) => e.type)
      expect(types.indexOf('user_request_resolved')).toBeGreaterThanOrEqual(0)
      expect(types.indexOf('user_request_resolved')).toBeLessThan(types.indexOf('session_active'))
      expect(sseEvents.find((e) => e.type === 'user_request_resolved')).toMatchObject({
        requestId: 'q-superseded',
        outcome: 'superseded',
      })
      expect(openStreamRequestIds()).toEqual([])
    })

    it('puts the requests an ended turn cancels on the stream before its session_idle, which carries the outcome', () => {
      // The runtime owns idle, so the result alone does not end the turn.
      emit({ type: 'system', subtype: 'capabilities', session_state_events: true })
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      emit({ type: 'assistant', message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } })
      askQuestion('q-cancelled')
      emit({ type: 'result', subtype: 'success', num_turns: 1, usage: {} })
      sseEvents.length = 0

      emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })

      const types = sseEvents.map((e) => e.type)
      expect(types.indexOf('user_request_resolved')).toBeLessThan(types.indexOf('session_idle'))
      const idle = sseEvents.find((e) => e.type === 'session_idle')
      expect(idle.turnOutcome).toEqual(messagePersister.getSessionTurnOutcome(AGENT_SLUG, SESSION_ID))
      expect(idle.turnOutcome).toMatchObject({ status: 'completed', responseText: 'Done.' })
    })

    it('starts the streamed reply context over at each response, and only at a new turn', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      emit({ type: 'stream_event', event: { type: 'message_start' } })
      emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'first ' } } })
      // A queued message joins the response in progress.
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'reply' } } })
      emit({ type: 'result', subtype: 'error_during_execution', errors: ['boom'] })
      expect(messagePersister.getSessionTurnOutcome(AGENT_SLUG, SESSION_ID)).toMatchObject({
        status: 'failed',
        responseText: 'first reply',
      })
    })
  })

  describe('session summary activity', () => {
    it('records complete top-level transcript frames with their source timestamp', () => {
      const timestamp = new Date('2026-08-07T18:00:00.000Z')

      mockClient._messageCallback!({
        type: 'message',
        content: { type: 'assistant', message: { role: 'assistant', content: 'done' } },
        timestamp,
        sessionId: SESSION_ID,
      })

      expect(mockRecordSessionActivity).toHaveBeenCalledWith(expect.objectContaining({ slug: AGENT_SLUG }), SESSION_ID, timestamp)
    })

    it('records the session as active the moment a message is sent to it', () => {
      // The CLI appends the user entry as the turn starts but the SDK never
      // echoes it, so without this the session would keep its old place in
      // every cache-backed list until the first complete assistant frame.
      vi.useFakeTimers({ now: new Date('2026-08-07T18:30:00.000Z') })
      try {
        messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      } finally {
        vi.useRealTimers()
      }

      expect(mockRecordProvisionalSessionActivity).toHaveBeenCalledTimes(1)
      expect(mockRecordProvisionalSessionActivity).toHaveBeenCalledWith(
        expect.objectContaining({ slug: AGENT_SLUG }),
        SESSION_ID,
        Date.parse('2026-08-07T18:30:00.000Z'),
      )
    })

    it('re-marking an active session for a queued message records again', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)

      expect(mockRecordProvisionalSessionActivity).toHaveBeenCalledTimes(2)
    })

    it('reverts the send record when the send is rolled back before reaching the container', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      const mark = mockRecordProvisionalSessionActivity.mock.results[0]!.value

      messagePersister.markSessionIdle(AGENT_SLUG, SESSION_ID)

      expect(mockRevertSessionActivity).toHaveBeenCalledTimes(1)
      expect(mockRevertSessionActivity).toHaveBeenCalledWith(expect.objectContaining({ slug: AGENT_SLUG }), SESSION_ID, mark)
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
    })

    it('does not revert once the container has answered the send', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      mockClient._messageCallback!({
        type: 'message',
        content: { type: 'assistant', message: { role: 'assistant', content: 'working' } },
        timestamp: new Date('2026-08-07T18:31:00.000Z'),
        sessionId: SESSION_ID,
      })

      messagePersister.markSessionIdle(AGENT_SLUG, SESSION_ID)

      expect(mockRevertSessionActivity).not.toHaveBeenCalled()
    })

    it('ignores replayed catch-up frames whose host timestamp is arrival time', () => {
      // On the wire, SDK result frames carry no timestamp field, so the host
      // stamps Date.now() at arrival — a reconnect replay recorded here would
      // fabricate recency for a session that did nothing.
      mockClient._messageCallback!({
        type: 'message',
        content: { type: 'result', subtype: 'success', replayed: true },
        timestamp: new Date('2026-08-07T17:00:00.000Z'),
        sessionId: SESSION_ID,
      })

      expect(mockRecordSessionActivity).not.toHaveBeenCalled()
    })

    it('refreshes a session that finished while detached from its transcript mtime, not the replay time', async () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      mockRecordSessionActivity.mockClear()
      const transcriptStat = vi.spyOn(storeFor(AGENT_SLUG).files, 'stat')
        .mockResolvedValueOnce({ kind: 'file', mtimeMs: 1_754_600_000_000, size: 4096 })

      mockClient._messageCallback!({
        type: 'message',
        content: { type: 'result', subtype: 'success', replayed: true },
        timestamp: new Date('2026-08-07T20:00:00.000Z'),
        sessionId: SESSION_ID,
      })
      await vi.waitFor(() => expect(mockRecordSessionActivity).toHaveBeenCalled())

      expect(transcriptStat).toHaveBeenCalledWith(expect.stringContaining(`${SESSION_ID}.jsonl`))
      expect(mockRecordSessionActivity).toHaveBeenCalledWith(expect.objectContaining({ slug: AGENT_SLUG }), SESSION_ID, 1_754_600_000_000)
    })

    it('does not attribute a sidechain transcript frame to the parent session', () => {
      mockClient._messageCallback!({
        type: 'message',
        content: { type: 'assistant', parent_tool_use_id: 'tool-1' },
        timestamp: new Date('2026-08-07T19:00:00.000Z'),
        sessionId: SESSION_ID,
      })

      expect(mockRecordSessionActivity).not.toHaveBeenCalled()
    })
  })

  describe('completion notification response selection', () => {
    it('passes only the newest merged textual assistant response at authoritative idle', async () => {
      vi.spyOn(storeFor(AGENT_SLUG).files, 'stat').mockResolvedValueOnce({ kind: 'file', size: 12_345, mtimeMs: 0 })
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      mockClient._sendMessage({
        type: 'system',
        subtype: 'capabilities',
        session_state_events: true,
      })
      mockClient._sendMessage({
        type: 'assistant',
        uuid: 'working-entry',
        message: {
          id: 'msg-working',
          content: [{ type: 'text', text: 'I am still working.' }],
        },
      })
      // A new late frame for that older message ID also merges into its
      // original UI bubble; arrival order must not make it the final answer.
      mockClient._sendMessage({
        type: 'assistant',
        uuid: 'working-late-tool-entry',
        message: {
          id: 'msg-working',
          content: [
            { type: 'tool_use', id: 'tool-late', name: 'Read', input: {} },
          ],
        },
      })
      mockClient._sendMessage({
        type: 'assistant',
        uuid: 'final-thinking-entry',
        message: {
          id: 'msg-final',
          content: [{ type: 'thinking', thinking: 'Hidden reasoning' }],
        },
      })
      mockClient._sendMessage({
        type: 'assistant',
        uuid: 'final-text-entry-1',
        message: {
          id: 'msg-final',
          content: [{ type: 'text', text: 'Final ' }],
        },
      })
      mockClient._sendMessage({
        type: 'assistant',
        uuid: 'final-tool-entry',
        message: {
          id: 'msg-final',
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
          ],
        },
      })
      mockClient._sendMessage({
        type: 'assistant',
        uuid: 'final-text-entry-2',
        message: {
          id: 'msg-final',
          content: [{ type: 'text', text: 'answer.' }],
        },
      })
      mockClient._sendMessage({
        type: 'assistant',
        uuid: 'working-late-after-final',
        message: {
          id: 'msg-working',
          content: [
            { type: 'tool_use', id: 'tool-latest', name: 'Read', input: {} },
          ],
        },
      })
      // Replaying an older group after the final group must not roll the
      // candidate backward either; transcript UUID dedupe is turn-wide.
      mockClient._sendMessage({
        type: 'assistant',
        uuid: 'working-entry',
        replayed: true,
        message: {
          id: 'msg-working',
          content: [{ type: 'text', text: 'I am still working.' }],
        },
      })
      // A reattached CLI can replay a persisted frame verbatim. The UI
      // deduplicates by UUID, so the notification source must do the same.
      mockClient._sendMessage({
        type: 'assistant',
        uuid: 'final-text-entry-2',
        replayed: true,
        message: {
          id: 'msg-final',
          content: [{ type: 'text', text: 'answer.' }],
        },
      })
      mockClient._sendMessage({
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1 },
      })

      await flushNotifications()
      expect(notificationManager.triggerSessionComplete).not.toHaveBeenCalled()
      mockClient._sendMessage({
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
      })

      await flushNotifications()
      const call = vi.mocked(notificationManager.triggerSessionComplete).mock.calls.at(-1)
      expect(call?.slice(0, 2)).toEqual([SESSION_ID, AGENT_SLUG])
      expect(call?.[2]?.responseText).toBe('Final answer.')
      expect(call?.[2]?.responseTranscriptEndOffset).toBe(12_345)
    })

    it('ignores the synthetic "No response requested." placeholder as a response candidate', async () => {
      vi.spyOn(storeFor(AGENT_SLUG).files, 'stat').mockResolvedValueOnce({ kind: 'file', size: 12_345, mtimeMs: 0 })
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      mockClient._sendMessage({
        type: 'system',
        subtype: 'capabilities',
        session_state_events: true,
      })
      mockClient._sendMessage({
        type: 'assistant',
        uuid: 'real-entry',
        message: {
          id: 'msg-real',
          content: [{ type: 'text', text: 'Real answer.' }],
        },
      })
      // The CLI's stand-in after an interrupt: a newer assistant message id,
      // but nothing the model said. It must not replace the real answer.
      mockClient._sendMessage({
        type: 'assistant',
        uuid: 'synthetic-entry',
        isApiErrorMessage: false,
        message: {
          id: 'msg-synthetic',
          model: '<synthetic>',
          content: [{ type: 'text', text: 'No response requested.' }],
        },
      })
      mockClient._sendMessage({
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
      mockClient._sendMessage({
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
      })

      await flushNotifications()
      const call = vi.mocked(notificationManager.triggerSessionComplete).mock.calls.at(-1)
      expect(call?.[2]?.responseText).toBe('Real answer.')
    })

    const finishTurn = () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      mockClient._sendMessage({
        type: 'assistant',
        uuid: 'final-entry',
        message: {
          id: 'msg-final',
          content: [{ type: 'text', text: 'Finished.' }],
        },
      })
      mockClient._sendMessage({
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    }

    it('bounds the completion by where the transcript ended when the turn did', async () => {
      let resolveStat: ((value: { kind: 'file'; size: number; mtimeMs: number }) => void) | undefined
      vi.spyOn(storeFor(AGENT_SLUG).files, 'stat').mockImplementationOnce(
        () => new Promise((resolve) => {
          resolveStat = resolve
        }),
      )
      finishTurn()
      // Read at the turn's end; sent once known.
      await flushNotifications()
      expect(notificationManager.triggerSessionComplete).not.toHaveBeenCalled()
      resolveStat?.({ kind: 'file', size: 99, mtimeMs: 0 })
      await vi.waitFor(() => expect(notificationManager.triggerSessionComplete).toHaveBeenCalledTimes(1))
      expect(vi.mocked(notificationManager.triggerSessionComplete).mock.calls[0]).toEqual([
        SESSION_ID,
        AGENT_SLUG,
        { responseText: 'Finished.', responseTranscriptEndOffset: 99 },
      ])
    })

    it('does not hold the completion for a transcript stat that never answers', async () => {
      vi.useFakeTimers()
      try {
        vi.spyOn(storeFor(AGENT_SLUG).files, 'stat').mockImplementationOnce(() => new Promise(() => {}))
        finishTurn()
        await vi.advanceTimersByTimeAsync(1000)
        expect(notificationManager.triggerSessionComplete).toHaveBeenCalledWith(SESSION_ID, AGENT_SLUG, {
          responseText: 'Finished.',
          responseTranscriptEndOffset: null,
        })
      } finally {
        vi.useRealTimers()
      }
    })

    it('announces a session\'s turns in the order they ended, whichever transcript read finishes first', async () => {
      const finishTurnWith = (answer: string, id: string) => {
        messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
        mockClient._sendMessage({ type: 'assistant', uuid: `${id}-entry`, message: { id: `msg-${id}`, content: [{ type: 'text', text: answer }] } })
        mockClient._sendMessage({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } })
      }
      let resolveFirst: ((value: { kind: 'file'; size: number; mtimeMs: number }) => void) | undefined
      vi.spyOn(storeFor(AGENT_SLUG).files, 'stat')
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveFirst = resolve
        }))
        .mockImplementationOnce(async () => ({ kind: 'file', size: 200, mtimeMs: 0 }))

      finishTurnWith('First answer.', 'first')
      finishTurnWith('Second answer.', 'second')
      await flushNotifications()
      // The second turn's read is done, but the first turn has not been announced yet.
      expect(notificationManager.triggerSessionComplete).not.toHaveBeenCalled()

      resolveFirst?.({ kind: 'file', size: 100, mtimeMs: 0 })
      await vi.waitFor(() => expect(notificationManager.triggerSessionComplete).toHaveBeenCalledTimes(2))
      expect(vi.mocked(notificationManager.triggerSessionComplete).mock.calls.map((call) => call[2])).toEqual([
        { responseText: 'First answer.', responseTranscriptEndOffset: 100 },
        { responseText: 'Second answer.', responseTranscriptEndOffset: 200 },
      ])
      // The session's queue is let go once it has sent everything.
      await vi.waitFor(() => expect((messagePersister as any).completionSends.size).toBe(0))
    })

    it('does not reuse working text when the newest assistant item is tool-only', async () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      mockClient._sendMessage({
        type: 'assistant',
        uuid: 'working-entry',
        message: {
          id: 'msg-working',
          content: [{ type: 'text', text: 'Earlier working note.' }],
        },
      })
      mockClient._sendMessage({
        type: 'assistant',
        uuid: 'tool-only-entry',
        message: {
          id: 'msg-tool-only',
          content: [
            { type: 'tool_use', id: 'tool-2', name: 'Read', input: {} },
          ],
        },
      })
      mockClient._sendMessage({
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1 },
      })

      await flushNotifications()
      expect(notificationManager.triggerSessionComplete).toHaveBeenCalledWith(
        SESSION_ID,
        AGENT_SLUG,
        {
          responseText: '',
          responseTranscriptEndOffset: null,
        },
      )
    })

    it('does not reuse the prior answer when a queued turn produces no assistant item', async () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      mockClient._sendMessage({
        type: 'system',
        subtype: 'capabilities',
        session_state_events: true,
      })
      mockClient._sendMessage({
        type: 'assistant',
        uuid: 'turn-a-answer',
        message: {
          id: 'msg-turn-a',
          content: [{ type: 'text', text: 'Answer for the first request.' }],
        },
      })

      // The second request is queued before turn A's result. It then ends with
      // no assistant frame (for example, a prompt hook blocks it).
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      mockClient._sendMessage({
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
      // A delayed frame for turn A must still merge into turn A in the UI; it
      // cannot resurrect A as turn B's notification response.
      mockClient._sendMessage({
        type: 'assistant',
        uuid: 'turn-a-late-frame',
        message: {
          id: 'msg-turn-a',
          content: [{ type: 'text', text: 'Stale turn-A text.' }],
        },
      })
      mockClient._sendMessage({
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      })
      mockClient._sendMessage({
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
      })

      await flushNotifications()
      expect(notificationManager.triggerSessionComplete).toHaveBeenCalledTimes(1)
      expect(notificationManager.triggerSessionComplete).toHaveBeenCalledWith(
        SESSION_ID,
        AGENT_SLUG,
        { responseText: '', responseTranscriptEndOffset: null },
      )
    })

    it.each([
      {
        label: 'resume',
        result: {
          type: 'result',
          subtype: 'resume',
          is_error: false,
          num_turns: 1,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        label: 'graceful interrupt',
        result: {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          terminal_reason: 'aborted_tools',
          num_turns: 1,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
    ])('does not consume the queued-turn guard on $label results', ({ result }) => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      mockClient._sendMessage({
        type: 'system',
        subtype: 'capabilities',
        session_state_events: true,
      })
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)

      mockClient._sendMessage(result)

      const state = (messagePersister as any).streamingStates.get(sessionKeyOf(AGENT_SLUG, SESSION_ID))
      expect(state.queuedTurnCount).toBe(1)
      expect(state.resetAssistantBeforeNextTurnOutput).toBe(false)

      mockClient._sendMessage({
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1 },
      })

      expect(state.queuedTurnCount).toBe(0)
      expect(state.resetAssistantBeforeNextTurnOutput).toBe(true)
    })

    it('settles a self-healed running event followed by idle without a new result', async () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      mockClient._sendMessage({
        type: 'system',
        subtype: 'capabilities',
        session_state_events: true,
      })
      mockClient._sendMessage({
        type: 'assistant',
        uuid: 'completed-answer',
        message: {
          id: 'msg-completed',
          content: [{ type: 'text', text: 'Completed.' }],
        },
      })
      mockClient._sendMessage({
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
      mockClient._sendMessage({
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
      })
      await flushNotifications()
      vi.mocked(notificationManager.triggerSessionComplete).mockClear()

      mockClient._sendMessage({
        type: 'system',
        subtype: 'session_state_changed',
        state: 'running',
      })
      mockClient._sendMessage({
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
      })

      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
      await flushNotifications()
      expect(notificationManager.triggerSessionComplete).toHaveBeenCalledTimes(1)
      expect(notificationManager.triggerSessionComplete).toHaveBeenCalledWith(
        SESSION_ID,
        AGENT_SLUG,
        { responseText: '', responseTranscriptEndOffset: null },
      )
    })

    it('does not notify for a modern success-subtype error result', async () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      mockClient._sendMessage({
        type: 'system',
        subtype: 'capabilities',
        session_state_events: true,
      })
      mockClient._sendMessage({
        type: 'result',
        subtype: 'success',
        is_error: true,
        terminal_reason: 'api_error',
        errors: ['provider failed'],
        num_turns: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      })
      mockClient._sendMessage({
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
      })

      await flushNotifications()
      expect(notificationManager.triggerSessionComplete).not.toHaveBeenCalled()
    })

    it('does not notify when a legacy turn exits for resume', async () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      mockClient._sendMessage({
        type: 'assistant',
        uuid: 'resume-answer',
        message: {
          id: 'msg-resume',
          content: [{ type: 'text', text: 'Pausing for resume.' }],
        },
      })
      mockClient._sendMessage({
        type: 'result',
        subtype: 'resume',
        is_error: false,
        num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1 },
      })

      await flushNotifications()
      expect(notificationManager.triggerSessionComplete).not.toHaveBeenCalled()
    })
  })

  // ============================================================================
  // Informational banners (hook feedback, e.g. UserPromptSubmit blocks)
  // ============================================================================

  describe('informational system messages', () => {
    it('persists a warning banner to the transcript and broadcasts messages_updated', async () => {
      mockClient._sendMessage({
        type: 'system',
        subtype: 'informational',
        uuid: 'info-uuid-1',
        content: 'UserPromptSubmit operation blocked by hook:\nCircuit breaker\n\nOriginal prompt: hello',
        level: 'warning',
        prevent_continuation: true,
      })

      expect(mockAppendInformationalEntry).toHaveBeenCalledWith(expect.objectContaining({ slug: AGENT_SLUG }), SESSION_ID, {
        uuid: 'info-uuid-1',
        content: 'UserPromptSubmit operation blocked by hook:\nCircuit breaker\n\nOriginal prompt: hello',
        level: 'warning',
      })
      await vi.waitFor(() => {
        expect(sseEvents).toContainEqual({ type: 'messages_updated' })
      })
    })

    it('persists a blocking banner even without a warning level', async () => {
      mockClient._sendMessage({
        type: 'system',
        subtype: 'informational',
        uuid: 'info-uuid-2',
        content: 'Operation blocked by hook',
        prevent_continuation: true,
      })

      expect(mockAppendInformationalEntry).toHaveBeenCalledTimes(1)
    })

    it('ignores info-level chatter (non-blocking status lines)', () => {
      mockClient._sendMessage({
        type: 'system',
        subtype: 'informational',
        uuid: 'info-uuid-3',
        content: 'Loaded 3 skills',
        level: 'info',
      })

      expect(mockAppendInformationalEntry).not.toHaveBeenCalled()
      expect(sseEvents).not.toContainEqual({ type: 'messages_updated' })
    })

    it('ignores warning banners with no content', () => {
      mockClient._sendMessage({
        type: 'system',
        subtype: 'informational',
        uuid: 'info-uuid-4',
        level: 'warning',
      })

      expect(mockAppendInformationalEntry).not.toHaveBeenCalled()
    })
  })

  // ============================================================================
  // Late-join replay (turn ended before the WebSocket attached)
  // ============================================================================

  describe('late-join replayed frames', () => {
    const sendCapabilities = () =>
      mockClient._sendMessage({ type: 'system', subtype: 'capabilities', session_state_events: true })

    it('settles a session whose blocked first turn ended before the socket attached', async () => {
      // The wedge signature: the route marked the session active, but no live
      // turn frames ever arrived (they fired into the WS attach gap).
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      sseEvents.length = 0
      sendCapabilities()

      mockClient._sendMessage({
        type: 'system',
        subtype: 'informational',
        uuid: 'replay-info-1',
        content: 'Operation stopped by hook: no hey allowed',
        level: 'warning',
        prevent_continuation: true,
        replayed: true,
      })
      mockClient._sendMessage({
        type: 'result', subtype: 'success', is_error: false, duration_ms: 20, num_turns: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        replayed: true,
      })
      mockClient._sendMessage({
        type: 'system', subtype: 'session_state_changed', state: 'idle', replayed: true,
      })

      expect(mockAppendInformationalEntry).toHaveBeenCalledTimes(1)
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
      expect(sseEvents.some((e) => e.type === 'session_idle')).toBe(true)
    })

    it.each([
      { isChatIntegrationSession: true },
      { isScheduledExecution: true },
      { isWebhookExecution: true },
      { invokedByAgentSlug: 'caller' },
    ])('finishes attachment before releasing a missed completed turn (%j)', async (metadata) => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      vi.mocked(getSessionMetadata).mockResolvedValue(metadata as never)
      const subscribe = vi.mocked(mockClient.subscribeToStream).getMockImplementation()!
      let finishReplay!: () => void
      vi.mocked(mockClient.subscribeToStream).mockImplementationOnce((...args) => ({
        ...subscribe(...args),
        ready: new Promise<void>(resolve => { finishReplay = resolve }),
      }))
      const subscription = messagePersister.subscribeToSession(AGENT_SLUG, SESSION_ID, mockClient, SESSION_ID)
      try {
        await new Promise(resolve => setTimeout(resolve, 0))
        sendCapabilities()
        mockClient._sendMessage({ type: 'result', subtype: 'success', is_error: false, replayed: true })
        mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle', replayed: true })
        expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
        expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(true)
        finishReplay()
        await subscription
        expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(false)
      } finally {
        finishReplay()
        await subscription
        vi.mocked(getSessionMetadata).mockResolvedValue(null)
      }
    })

    it('ignores replayed frames when the live copies were already processed', () => {
      // A full live turn settles the session…
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      sendCapabilities()
      mockClient._sendMessage({
        type: 'result', subtype: 'success', is_error: false, duration_ms: 100, num_turns: 1,
        usage: { input_tokens: 0, output_tokens: 0 },
      })
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
      sseEvents.length = 0
      vi.clearAllMocks()

      // …then a reconnect replays the same terminal frames: all ignored.
      mockClient._sendMessage({
        type: 'system', subtype: 'informational', uuid: 'replay-info-2',
        content: 'Operation stopped by hook: x', level: 'warning', replayed: true,
      })
      mockClient._sendMessage({
        type: 'result', subtype: 'success', is_error: false, duration_ms: 20, num_turns: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        replayed: true,
      })
      mockClient._sendMessage({
        type: 'system', subtype: 'session_state_changed', state: 'idle', replayed: true,
      })

      expect(mockAppendInformationalEntry).not.toHaveBeenCalled()
      expect(sseEvents.filter((e) => e.type === 'session_idle')).toHaveLength(0)
      expect(sseEvents.filter((e) => e.type === 'turn_output_complete')).toHaveLength(0)
    })
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

    it("learns the subagent's agentId from the frame's agent_id (SDK 0.3.292+)", () => {
      sseEvents.length = 0
      mockClient._sendMessage({
        type: 'assistant',
        parent_tool_use_id: 'tool-agent-id',
        agent_id: 'a1b2c3d4e5f6a7b8c',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Sidechain text' }] },
      })

      const withAgentId = sseEvents.filter(
        (e) => e.type === 'subagent_updated' && e.parentToolId === 'tool-agent-id' && e.agentId
      )
      expect(withAgentId.length).toBeGreaterThanOrEqual(1)
      expect(withAgentId.every((e) => e.agentId === 'a1b2c3d4e5f6a7b8c')).toBe(true)
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

      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'msg-thinking-1' } },
      })
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      })
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me ' } },
      })
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'consider.' } },
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
      expect(starts[0].thinkingId).toBe('msg-thinking-1:0')
      expect(deltas.map(d => d.text)).toEqual(['Let me ', 'consider.'])
      expect(deltas.map(d => d.thinkingId)).toEqual(['msg-thinking-1:0', 'msg-thinking-1:0'])
      expect(stops).toHaveLength(1)
      expect(stops[0].thinkingId).toBe('msg-thinking-1:0')
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

    it('leaves "compacting" via getSessionActivity when compaction completes (no stale "Compacting…")', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID) // active → 'working'
      mockClient._sendMessage({ type: 'system', subtype: 'status', status: 'compacting', session_id: SESSION_ID, uuid: 's1' })
      expect(messagePersister.getSessionActivity(AGENT_SLUG, SESSION_ID)).toBe('compacting')

      // The compact-summary user message clears isCompacting (state.isCompacting was true).
      mockClient._sendMessage({ type: 'user', session_id: SESSION_ID, uuid: 'summary-1' })

      // The pull projection must immediately leave 'compacting' (the tick re-reads it).
      expect(messagePersister.getSessionActivity(AGENT_SLUG, SESSION_ID)).toBe('working')
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
    it('broadcasts lifecycle events for a background subagent launched inside a Skill', () => {
      mockClient._sendMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'skill-tool', name: 'Skill' },
        },
      })
      mockClient._sendMessage({ type: 'stream_event', event: { type: 'content_block_stop' } })
      mockClient._sendMessage({
        type: 'stream_event',
        parent_tool_use_id: 'skill-tool',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'nested-agent-tool', name: 'Agent' },
        },
      })
      mockClient._sendMessage({
        type: 'stream_event',
        parent_tool_use_id: 'skill-tool',
        event: {
          type: 'content_block_delta',
          delta: {
            type: 'input_json_delta',
            partial_json: '{"subagent_type":"code-reviewer"}',
          },
        },
      })
      mockClient._sendMessage({
        type: 'stream_event',
        parent_tool_use_id: 'skill-tool',
        event: { type: 'content_block_stop' },
      })
      sseEvents.length = 0

      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_started',
        parent_tool_use_id: 'skill-tool',
        task_id: 'nested-agent-id',
        tool_use_id: 'nested-agent-tool',
        task_type: 'local_agent',
        subagent_type: 'code-reviewer',
        description: 'Review the changes',
      })
      mockClient._sendMessage({
        type: 'user',
        parent_tool_use_id: 'skill-tool',
        tool_use_result: {
          status: 'async_launched',
          isAsync: true,
          agentId: 'nested-agent-id',
        },
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'nested-agent-tool',
            content: 'Agent launched successfully. agentId: nested-agent-id',
          }],
        },
      })
      expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID)).toEqual([
        expect.objectContaining({
          taskId: 'nested-agent-id',
          isSubagent: true,
        }),
      ])

      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_progress',
        parent_tool_use_id: 'skill-tool',
        task_id: 'nested-agent-id',
        tool_use_id: 'nested-agent-tool',
        subagent_type: 'code-reviewer',
        summary: 'Inspecting tests',
        usage: { total_tokens: 100, tool_uses: 2, duration_ms: 500 },
        last_tool_name: 'Read',
      })
      mockClient._sendMessage({
        type: 'stream_event',
        parent_tool_use_id: 'nested-agent-tool',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'tool_use',
            id: 'webhook-tool',
            name: 'mcp__user-input__create_webhook_endpoint',
          },
        },
      })
      mockClient._sendMessage({
        type: 'stream_event',
        parent_tool_use_id: 'nested-agent-tool',
        event: {
          type: 'content_block_delta',
          delta: {
            type: 'input_json_delta',
            partial_json: '{"verification":{"secret":"whsec_supersecret","header":"x-sig"}}',
          },
        },
      })
      const activeSubagents = messagePersister.getActiveSubagents(AGENT_SLUG, SESSION_ID)
      expect(activeSubagents).toEqual([
        expect.objectContaining({
          parentToolId: 'nested-agent-tool',
          agentId: 'nested-agent-id',
          subagentType: 'code-reviewer',
          description: 'Review the changes',
          progressSummary: 'Inspecting tests',
          usage: { total_tokens: 100, tool_uses: 2, duration_ms: 500 },
          lastToolName: 'Read',
          streamingToolUse: expect.objectContaining({
            id: 'webhook-tool',
            name: 'mcp__user-input__create_webhook_endpoint',
          }),
        }),
      ])
      expect(activeSubagents[0].streamingToolUse?.partialInput).not.toContain('whsec_supersecret')
      expect(activeSubagents[0].streamingToolUse?.partialInput).toContain('"secret":"***"')

      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_notification',
        parent_tool_use_id: 'skill-tool',
        task_id: 'nested-agent-id',
        tool_use_id: 'nested-agent-tool',
        status: 'completed',
        summary: 'Review complete',
      })

      expect(sseEvents.filter(e => e.type === 'subagent_started')).toEqual([
        expect.objectContaining({
          parentToolId: 'nested-agent-tool',
          agentId: 'nested-agent-id',
          subagentType: 'code-reviewer',
          description: 'Review the changes',
        }),
      ])
      expect(sseEvents.filter(e => e.type === 'subagent_progress')).toEqual([
        expect.objectContaining({
          parentToolId: 'nested-agent-tool',
          summary: 'Inspecting tests',
        }),
      ])
      expect(sseEvents.filter(e => e.type === 'subagent_completed')).toEqual([
        expect.objectContaining({
          parentToolId: 'nested-agent-tool',
          agentId: 'nested-agent-id',
          resultText: 'Review complete',
        }),
      ])
      expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID)).toHaveLength(0)
      expect(messagePersister.getActiveSubagents(AGENT_SLUG, SESSION_ID)).toEqual([
        expect.objectContaining({
          parentToolId: 'nested-agent-tool',
          status: 'completed',
        }),
      ])

      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      expect(messagePersister.getActiveSubagents(AGENT_SLUG, SESSION_ID)).toHaveLength(0)
    })

    it('completes a foreground subagent from its Skill sidechain tool result', () => {
      mockClient._sendMessage({
        type: 'assistant',
        parent_tool_use_id: 'skill-tool',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'foreground-agent-tool',
            name: 'Agent',
            input: { subagent_type: 'Explore', description: 'Inspect files' },
          }],
        },
      })
      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_started',
        parent_tool_use_id: 'skill-tool',
        task_id: 'foreground-agent-id',
        tool_use_id: 'foreground-agent-tool',
        task_type: 'local_agent',
        subagent_type: 'Explore',
        description: 'Inspect files',
      })
      sseEvents.length = 0

      mockClient._sendMessage({
        type: 'user',
        parent_tool_use_id: 'skill-tool',
        tool_use_result: { status: 'completed', agentId: 'foreground-agent-id' },
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'foreground-agent-tool',
            content: 'Inspection complete',
          }],
        },
      })

      expect(sseEvents.filter(e => e.type === 'subagent_completed')).toEqual([
        expect.objectContaining({
          parentToolId: 'foreground-agent-tool',
          agentId: 'foreground-agent-id',
          resultText: 'Inspection complete',
        }),
      ])
      expect(messagePersister.getActiveSubagents(AGENT_SLUG, SESSION_ID)).toEqual([
        expect.objectContaining({
          parentToolId: 'foreground-agent-tool',
          status: 'completed',
        }),
      ])
    })

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
      // subagent — the second must not double-fire.
      mockClient._sendMessage({
        type: 'system', subtype: 'task_updated', task_id: 'bgsub', patch: { status: 'completed' },
      })
      mockClient._sendMessage({
        type: 'system', subtype: 'task_notification', task_id: 'bgsub', tool_use_id: 'bg-tool', status: 'completed',
      })
      expect(sseEvents.filter(e => e.type === 'subagent_completed')).toHaveLength(1)
    })

    it('does not let a completed background run shadow a resumed run completion', () => {
      startBackgroundSubagent()
      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'bgsub',
        patch: { status: 'completed' },
      })
      sseEvents.length = 0

      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_started',
        task_id: 'bgsub',
        tool_use_id: 'send-tool',
        task_type: 'local_agent',
        subagent_type: 'general-purpose',
        description: 'Resume background agent',
      })
      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'bgsub',
        patch: { status: 'completed' },
      })

      expect(sseEvents.filter(e => e.type === 'subagent_completed')).toEqual([
        expect.objectContaining({
          parentToolId: 'send-tool',
          agentId: 'bgsub',
        }),
      ])
    })

    it('treats a fork launch as background though it carries no run_in_background', () => {
      // CLI 2.1.302+ forks always run in the background; their Agent input
      // names subagent_type "fork" and nothing else marks them.
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'fork-tool', name: 'Agent' } },
      })
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"subagent_type":"fork","description":"fork probe","prompt":"echo"}' } },
      })
      mockClient._sendMessage({ type: 'stream_event', event: { type: 'content_block_stop' } })
      mockClient._sendMessage({
        type: 'system', subtype: 'task_started', task_id: 'forksub', tool_use_id: 'fork-tool',
        task_type: 'local_agent', subagent_type: 'fork', description: 'fork probe',
      })
      sseEvents.length = 0

      mockClient._sendMessage({
        type: 'system', subtype: 'task_notification', task_id: 'forksub', tool_use_id: 'fork-tool', status: 'completed',
      })
      expect(sseEvents.filter(e => e.type === 'subagent_completed')).toEqual([
        expect.objectContaining({ parentToolId: 'fork-tool', agentId: 'forksub' }),
      ])
    })

    it('completes an errored background launch instead of treating it as an async ack', () => {
      // The streamed run_in_background input is only a hint. If the launch is
      // rejected before it gets an async_launched result (for example by a
      // capability-review gate), the error tool_result is terminal and must
      // clean up both the subagent entry and its parked child requests.
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'blocked-bg-tool', name: 'Agent' } },
      })
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"subagent_type":"general-purpose","run_in_background":true}' } },
      })
      mockClient._sendMessage({ type: 'stream_event', event: { type: 'content_block_stop' } })
      userInputRequestManager.register({
        id: 'blocked-bg-child-request',
        kind: 'question',
        scope: { sessionId: SESSION_ID, agentSlug: AGENT_SLUG },
        blocking: true,
        autoApproved: false,
        parentToolUseId: 'blocked-bg-tool',
        payload: { questions: [] },
      })
      sseEvents.length = 0

      try {
        mockClient._sendMessage({
          type: 'user',
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: 'blocked-bg-tool',
              content: 'Agent launch blocked by policy',
              is_error: true,
            }],
          },
        })

        expect(sseEvents.filter(e => e.type === 'subagent_completed')).toHaveLength(1)
        expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID)).toHaveLength(0)
        expect(userInputRequestManager.getOpenRequest('blocked-bg-child-request')).toBeNull()
      } finally {
        userInputRequestManager.resolve('blocked-bg-child-request', 'cancelled')
      }
    })

    it('keeps a SendMessage-resumed subagent running until its task completes', () => {
      // Real Claude Code 2.1.219 order:
      // Agent completes → SendMessage → background_tasks_changed → task_started
      // (same agentId, new SendMessage tool_use_id) → SendMessage ack → terminal task events.
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'agent-tool', name: 'Agent' } },
      })
      mockClient._sendMessage({ type: 'stream_event', event: { type: 'content_block_stop' } })
      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_started',
        task_id: 'agent-resumed',
        tool_use_id: 'agent-tool',
        subagent_type: 'general-purpose',
        task_type: 'local_agent',
        description: 'Lifecycle probe',
      })
      mockClient._sendMessage({
        type: 'user',
        tool_use_result: { status: 'completed', agentId: 'agent-resumed' },
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'agent-tool', content: 'FIRST_DONE' }],
        },
      })

      sseEvents.length = 0
      mockClient._sendMessage({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'agent-resumed', task_type: 'local_agent', description: 'Lifecycle probe' }],
      })
      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_started',
        task_id: 'agent-resumed',
        tool_use_id: 'send-tool',
        subagent_type: 'general-purpose',
        task_type: 'local_agent',
        description: 'Lifecycle probe',
      })
      mockClient._sendMessage({
        type: 'user',
        tool_use_result: {
          success: true,
          resumedAgentId: 'agent-resumed',
          message: 'Agent resumed from transcript in the background.',
        },
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'send-tool',
            content: '{"success":true,"resumedAgentId":"agent-resumed"}',
          }],
        },
      })

      expect(sseEvents.filter(e => e.type === 'subagent_completed')).toHaveLength(0)
      expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID)).toEqual([
        expect.objectContaining({ taskId: 'agent-resumed', isSubagent: true }),
      ])

      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'agent-resumed',
        patch: { status: 'completed' },
      })
      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'agent-resumed',
        tool_use_id: 'send-tool',
        status: 'completed',
        summary: 'SECOND_DONE',
      })

      const completed = sseEvents.filter(e => e.type === 'subagent_completed')
      expect(completed).toHaveLength(1)
      expect(completed[0]).toEqual(expect.objectContaining({
        parentToolId: 'send-tool',
        agentId: 'agent-resumed',
      }))
    })

    it('stops a running workflow journal tailer when the session is unsubscribed', () => {
      const stop = vi.spyOn(WorkflowJournalTailer.prototype, 'stop')
      try {
        mockClient._sendMessage({
          type: 'system', subtype: 'task_started', task_type: 'local_workflow',
          task_id: 'wf-unsubscribe', tool_use_id: 'wf-tool-unsubscribe', workflow_name: 'demo',
        })
        mockClient._sendMessage({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'wf-tool-unsubscribe', content: 'Run ID: wf_unsubscribe' }],
          },
          tool_use_result: {
            status: 'async_launched', taskType: 'local_workflow', taskId: 'wf-unsubscribe', runId: 'wf_unsubscribe',
          },
        })

        expect(stop).not.toHaveBeenCalled()
        messagePersister.unsubscribeFromSession(AGENT_SLUG, SESSION_ID)
        expect(stop).toHaveBeenCalledOnce()
      } finally {
        stop.mockRestore()
      }
    })

    // A dynamic workflow (task_type 'local_workflow') must get the same treatment as a
    // backgrounded Bash command: registered as a background task, surfaced via
    // session_waiting_background, and NOT phantom-cleared/finalized when the SDK fires a
    // premature turn-end idle while it is still running. (Synthetic — mirrors the real
    // background-bash-premature-idle capture shape; replace with a real workflow capture
    // fixture when one is available.)
    it('treats a local_workflow as a background task and survives a premature idle', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      // Make session_state_changed the idle authority (matches the container handshake).
      mockClient._sendMessage({ type: 'system', subtype: 'capabilities', session_state_events: true })
      sseEvents.length = 0

      // Workflow launches mid-turn → registered as a background task. The real runId
      // (wf_…) is NOT the task_id, so workflow_started does NOT fire yet.
      mockClient._sendMessage({
        type: 'system', subtype: 'task_started', task_type: 'local_workflow',
        task_id: 'wf1', tool_use_id: 'wf-tool', workflow_name: 'demo', description: 'demo workflow',
      })
      expect(sseEvents.filter(e => e.type === 'background_task_started' && e.taskId === 'wf1')).toHaveLength(1)
      expect(sseEvents.filter(e => e.type === 'workflow_started')).toHaveLength(0)

      // The Workflow tool result (next message) carries the real on-disk runId → NOW the
      // drawer gets the runId↔tool link + live tailing starts.
      mockClient._sendMessage({
        type: 'user',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'wf-tool', content: 'Run ID: wf_demo-123', is_error: false }],
        },
        tool_use_result: { status: 'async_launched', taskType: 'local_workflow', taskId: 'wf1', runId: 'wf_demo-123' },
      })
      expect(sseEvents.filter(e => e.type === 'workflow_started' && e.runId === 'wf_demo-123' && e.toolUseId === 'wf-tool' && e.name === 'demo')).toHaveLength(1)

      // A task_progress with a workflow_progress[] snapshot → forwarded as workflow_progress,
      // keyed by the resolved runId, with mapped per-agent state + usage.
      sseEvents.length = 0
      mockClient._sendMessage({
        type: 'system', subtype: 'task_progress', task_id: 'wf1', tool_use_id: 'wf-tool',
        usage: { total_tokens: 100, tool_uses: 2, duration_ms: 5000 },
        workflow_progress: [
          { type: 'workflow_phase', index: 1, title: 'Wait' },
          { type: 'workflow_agent', agentId: 'ag1', label: 'agent-A', phaseTitle: 'Wait', model: 'claude-sonnet-5', promptPreview: 'Wait for the results', state: 'progress', tokens: 50, toolCalls: 1, lastToolName: 'Bash', lastToolSummary: 'sleep 40' },
          { type: 'workflow_agent', agentId: 'ag2', label: 'agent-B', phaseTitle: 'Wait', state: 'done', tokens: 60, toolCalls: 0 },
        ],
      })
      const wp = sseEvents.filter(e => e.type === 'workflow_progress' && e.runId === 'wf_demo-123')
      expect(wp).toHaveLength(1)
      expect(wp[0].usage).toEqual({ totalTokens: 100, toolUses: 2, durationMs: 5000 })
      expect(wp[0].agents).toHaveLength(2) // phase entries filtered out
      expect(wp[0].agents[0]).toMatchObject({ agentId: 'ag1', label: 'agent-A', phase: 'Wait', model: 'claude-sonnet-5', prompt: 'Wait for the results', state: 'progress', tokens: 50, toolCalls: 1, lastTool: 'sleep 40' })
      expect(wp[0].agents[1]).toMatchObject({ agentId: 'ag2', state: 'done', lastTool: null })

      // Launch turn ends, but the workflow keeps running in the background.
      mockClient._sendMessage({
        type: 'result', subtype: 'success', is_error: false, duration_ms: 100, num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
      expect(sseEvents.some(e => e.type === 'session_waiting_background')).toBe(true)

      // Premature idle while the workflow is still running → must stay waiting-background.
      sseEvents.length = 0
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
      expect(sseEvents.some(e => e.type === 'session_idle')).toBe(false)
      expect(sseEvents.some(e => e.type === 'background_task_completed')).toBe(false)
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)

      // Workflow settles → its terminal clears the background task exactly once.
      mockClient._sendMessage({
        type: 'system', subtype: 'task_notification', task_id: 'wf1', tool_use_id: 'wf-tool', status: 'completed',
      })
      expect(sseEvents.filter(e => e.type === 'background_task_completed' && e.taskId === 'wf1')).toHaveLength(1)
      // …and the workflow-specific terminal (keyed by the real runId) so the drawer marks it done.
      expect(sseEvents.filter(e => e.type === 'workflow_completed' && e.runId === 'wf_demo-123')).toHaveLength(1)

      // The subsequent, truly-settled idle finalizes the session.
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
      expect(sseEvents.some(e => e.type === 'session_idle')).toBe(true)
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
      await messagePersister.markSessionInterrupted(AGENT_SLUG, SESSION_ID)

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
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)

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
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      await messagePersister.markSessionInterrupted(AGENT_SLUG, SESSION_ID)

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

    it('registers a remote_mcp request on tool_use completion', () => {
      sseEvents.length = 0

      simulateRemoteMcpToolUse('mcp-tool-1', {
        url: 'https://mcp.example.com/mcp',
        name: 'Example MCP',
        reason: 'Need weather data',
      })

      const mcpRequests = requestCards('remote_mcp')
      expect(mcpRequests).toHaveLength(1)
      expect(mcpRequests[0].request.id).toBe('mcp-tool-1')
      expect(mcpRequests[0].request.scope.agentSlug).toBe(AGENT_SLUG)
      expect(mcpRequests[0].request.payload).toMatchObject({
        url: 'https://mcp.example.com/mcp',
        name: 'Example MCP',
        reason: 'Need weather data',
      })
    })

    it('registers a remote_mcp request with only url (name and reason optional)', () => {
      sseEvents.length = 0

      simulateRemoteMcpToolUse('mcp-tool-2', {
        url: 'https://other.mcp.io/api',
      })

      const mcpRequests = requestCards('remote_mcp')
      expect(mcpRequests).toHaveLength(1)
      expect(mcpRequests[0].request.payload.url).toBe('https://other.mcp.io/api')
      expect(mcpRequests[0].request.payload.name).toBeUndefined()
      expect(mcpRequests[0].request.payload.reason).toBeUndefined()
    })

    it('registers nothing for invalid JSON input', () => {
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

      const mcpRequests = requestCards('remote_mcp')
      expect(mcpRequests).toHaveLength(0)
    })

    it('registers nothing when url is missing', () => {
      sseEvents.length = 0

      simulateRemoteMcpToolUse('mcp-no-url', { name: 'No URL MCP' })

      const mcpRequests = requestCards('remote_mcp')
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
        expect.objectContaining({ kind: 'remote_mcp' })
      )
    })

    it('still broadcasts tool_use_ready alongside the registration', () => {
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
  // markSessionIdle (optimistic-active revert)
  // ============================================================================

  describe('withSessionSend', () => {
    const emitResult = (subtype = 'success') => mockClient._sendMessage({
      type: 'result', subtype, is_error: subtype !== 'success', num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    const emitIdle = () => mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    const send = (delivery: () => Promise<void>) =>
      messagePersister.withSessionSend(AGENT_SLUG, SESSION_ID, mockClient, delivery)

    beforeEach(() => {
      mockClient._sendMessage({ type: 'system', subtype: 'capabilities', session_state_events: true, process_instance: 'process-1' })
    })

    it('keeps queued automation delivery on the running connection and isolates the context by session', async () => {
      await send(async () => {
        expect(isQueuedSessionSend(AGENT_SLUG, SESSION_ID)).toBe(false)
      })
      await send(async () => {
        expect(isQueuedSessionSend(AGENT_SLUG, SESSION_ID)).toBe(true)
        expect(isQueuedSessionSend(AGENT_SLUG, 'other-session')).toBe(false)
        expect(isQueuedSessionSend('other-agent', SESSION_ID)).toBe(false)
      })
      expect(isQueuedSessionSend(AGENT_SLUG, SESSION_ID)).toBe(false)
    })

    it.each(['before', 'after'] as const)('preserves an active turn when its final idle arrives %s a follow-up fails', async (timing) => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'running' })
      emitResult()
      await expect(send(async () => {
        if (timing === 'before') emitIdle()
        throw new Error('HTTP 429')
      })).rejects.toThrow('HTTP 429')
      if (timing === 'after') {
        expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
        emitIdle()
      }
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
      expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(1)
      await flushNotifications()
      expect(notificationManager.triggerSessionComplete).toHaveBeenCalledOnce()
    })

    it('preserves a newer terminal result received during a failed follow-up', async () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      emitResult()
      await expect(send(async () => {
        emitResult('error_during_execution')
        emitIdle()
        throw new Error('send failed')
      })).rejects.toThrow('send failed')
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
      await flushNotifications()
      expect(notificationManager.triggerSessionComplete).not.toHaveBeenCalled()
      expect(sseEvents.filter(e => e.type === 'session_error')).toHaveLength(1)
    })

    it('restores background waiting and settles when the last background task is stopped', async () => {
      vi.useFakeTimers()
      try {
        messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
        mockClient._sendMessage({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg-task' }] })
        emitResult()
        emitIdle()
        await expect(send(async () => { throw new Error('send failed') })).rejects.toThrow('send failed')
        expect(messagePersister.isSessionWaitingBackground(AGENT_SLUG, SESSION_ID)).toBe(true)
        mockClient._sendMessage({ type: 'system', subtype: 'task_notification', task_id: 'bg-task', status: 'stopped' })
        await vi.advanceTimersByTimeAsync(1500)
        expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('preserves the stopped-task grace when a follow-up fails', async () => {
      vi.useFakeTimers()
      try {
        messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
        mockClient._sendMessage({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg-task' }] })
        emitResult()
        emitIdle()
        mockClient._sendMessage({ type: 'system', subtype: 'task_notification', task_id: 'bg-task', status: 'stopped' })
        await expect(send(async () => { throw new Error('send failed') })).rejects.toThrow('send failed')
        expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
        await vi.advanceTimersByTimeAsync(1500)
        expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('cleans up a rejected reconnect without activating or sending', async () => {
      messagePersister.unsubscribeFromSession(AGENT_SLUG, SESSION_ID)
      const unsubscribe = vi.fn()
      vi.mocked(mockClient.subscribeToStream).mockReturnValueOnce({
        unsubscribe, ready: Promise.reject(new Error('reconnect failed')),
      })
      const delivery = vi.fn(async () => {})
      await expect(send(delivery)).rejects.toThrow('reconnect failed')
      expect(delivery).not.toHaveBeenCalled()
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
      expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(false)
      expect(unsubscribe).toHaveBeenCalledOnce()
    })

    it('rolls back an unaccepted fresh send and its provisional recency', async () => {
      await expect(send(async () => { throw new Error('send failed') })).rejects.toThrow('send failed')
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
      expect(mockRevertSessionActivity).toHaveBeenCalledOnce()
    })

    it.each(['assistant', 'stream_event'])('does not roll back accepted %s output after a failed HTTP response', async (type) => {
      await expect(send(async () => {
        mockClient._sendMessage(type === 'assistant'
          ? { type, message: { role: 'assistant', content: 'Already running' } }
          : { type, event: { type: 'message_start', message: { id: 'new-message' } } })
        throw new Error('response lost')
      })).rejects.toThrow('response lost')
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
      expect(mockRevertSessionActivity).not.toHaveBeenCalled()
      emitResult()
      emitIdle()
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
    })

    it('rolls back overlapping failed deliveries without inheriting provisional activity', async () => {
      let rejectFirst!: (error: Error) => void
      const first = send(() => new Promise<void>((_resolve, reject) => { rejectFirst = reject }))
      const secondDelivery = vi.fn(async () => { throw new Error('second failed') })
      const second = send(secondDelivery)
      expect(secondDelivery).not.toHaveBeenCalled()
      const failures = Promise.all([
        expect(first).rejects.toThrow('first failed'),
        expect(second).rejects.toThrow('second failed'),
      ])
      rejectFirst(new Error('first failed'))
      await failures
      expect(secondDelivery).toHaveBeenCalledOnce()
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
      expect(mockRevertSessionActivity).toHaveBeenCalledTimes(2)
    })

    it('leaves a turn owned by recovery active when delivery fails', async () => {
      await expect(send(async () => {
        messagePersister.snapshotMidTurnSessions(AGENT_SLUG)
        throw new Error('connection lost during recovery')
      })).rejects.toThrow('connection lost during recovery')
      expect(messagePersister.isSessionRecovering(AGENT_SLUG, SESSION_ID)).toBe(true)
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
      expect(mockRevertSessionActivity).not.toHaveBeenCalled()
    })

    it('does not roll back a newer send when an older delivery fails', async () => {
      await expect(send(async () => {
        messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
        throw new Error('older send failed')
      })).rejects.toThrow('older send failed')
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
      expect(mockRevertSessionActivity).not.toHaveBeenCalled()
    })

    it.each([
      { isScheduledExecution: true },
      { isWebhookExecution: true },
      { isChatIntegrationSession: true },
      { invokedByAgentSlug: 'caller' },
    ])('releases an unpromoted automation only after delivery and settlement (%j)', async (metadata) => {
      vi.mocked(getSessionMetadata).mockResolvedValue(metadata as never)
      try {
        await messagePersister.subscribeToSession(AGENT_SLUG, SESSION_ID, mockClient, SESSION_ID)
        await send(async () => {
          emitResult()
          emitIdle()
          expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(true)
        })
        expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
        expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(false)
      } finally {
        vi.mocked(getSessionMetadata).mockResolvedValue(null)
      }
    })

    it('remembers eviction during a failed send and releases its idle transport', async () => {
      vi.mocked(getSessionMetadata).mockResolvedValue({ isChatIntegrationSession: true } as never)
      try {
        await messagePersister.subscribeToSession(AGENT_SLUG, SESSION_ID, mockClient, SESSION_ID)
        await expect(send(async () => {
          mockClient._sendMessage({ type: 'system', subtype: 'process_evicted', process_instance: 'process-1' })
          expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(true)
          throw new Error('send failed')
        })).rejects.toThrow('send failed')
        expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(false)
      } finally {
        vi.mocked(getSessionMetadata).mockResolvedValue(null)
      }
    })

    it.each([
      { isChatIntegrationSession: true },
      { isScheduledExecution: true },
      { isWebhookExecution: true },
      { invokedByAgentSlug: 'caller' },
    ])('keeps the new reply subscribed when terminal replay arrives after WebSocket open (%j)', async (metadata) => {
      // Exercise the real client's readiness contract: the server opens the
      // socket and sends capabilities, then delays its replay and acknowledgement.
      const { BaseContainerClient } = await import('./base-container-client')
      const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
      await new Promise<void>(resolve => server.once('listening', resolve))
      const address = server.address() as { port: number }
      class ReplayClient extends BaseContainerClient {
        protected getRunnerCommand() { return 'docker' }
        async getInfoFromRuntime(): Promise<ContainerInfo> {
          return { status: 'running', port: address.port }
        }
        getHostAuthHeaders() { return {} }
      }
      const client = new ReplayClient({ agentId: AGENT_SLUG })
      const socketConnected = new Promise<import('ws').WebSocket>(resolve => {
        server.once('connection', socket => {
          socket.send(JSON.stringify({ type: 'system', subtype: 'capabilities', session_state_events: true, process_instance: 'process-1' }))
          resolve(socket)
        })
      })
      const capabilitiesReceived = new Promise<void>(resolve => client.once('message', () => resolve()))
      let acceptDelivery!: () => void
      const deliveryAccepted = new Promise<void>(resolve => { acceptDelivery = resolve })
      let sendStarted!: () => void
      const deliveryStarted = new Promise<void>(resolve => { sendStarted = resolve })
      let pendingSend: Promise<void> | undefined
      vi.mocked(getSessionMetadata).mockResolvedValue(metadata as never)
      try {
        await messagePersister.subscribeToSession(AGENT_SLUG, SESSION_ID, mockClient, SESSION_ID)
        await send(async () => { emitResult(); emitIdle() })
        expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(false)
        const idleEventsBefore = sseEvents.filter(e => e.type === 'session_idle').length
        pendingSend = messagePersister.withSessionSend(AGENT_SLUG, SESSION_ID, client, async () => {
          sendStarted()
          await deliveryAccepted
        })
        const socket = await socketConnected
        await capabilitiesReceived
        const replayReceived = new Promise<void>(resolve => {
          const onMessage = (_id: string, message: { type: string }) => {
            if (message.type === 'status') {
              client.off('message', onMessage)
              resolve()
            }
          }
          client.on('message', onMessage)
        })
        socket.send(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, replayed: true }))
        socket.send(JSON.stringify({ type: 'system', subtype: 'session_state_changed', state: 'idle', replayed: true }))
        socket.send(JSON.stringify({ type: 'status', data: { message: 'Connected to session stream' } }))
        await replayReceived
        await deliveryStarted
        acceptDelivery()
        await pendingSend
        expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(true)
        expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
        expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(idleEventsBefore)

        const replyReceived = new Promise<void>(resolve => {
          const onMessage = (_id: string, message: { state?: string }) => {
            if (message.state === 'idle') {
              client.off('message', onMessage)
              resolve()
            }
          }
          client.on('message', onMessage)
        })
        socket.send(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'The new reply' } }))
        socket.send(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }))
        socket.send(JSON.stringify({ type: 'system', subtype: 'session_state_changed', state: 'idle' }))
        await replyReceived
        await flushNotifications()
        expect(notificationManager.triggerSessionComplete).toHaveBeenLastCalledWith(SESSION_ID, AGENT_SLUG,
          expect.objectContaining({ responseText: 'The new reply' }))
        expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(false)
      } finally {
        acceptDelivery()
        messagePersister.unsubscribeFromSession(AGENT_SLUG, SESSION_ID)
        await pendingSend?.catch(() => {})
        for (const socket of server.clients) socket.terminate()
        await new Promise<void>(resolve => server.close(() => resolve()))
        vi.mocked(getSessionMetadata).mockResolvedValue(null)
      }
    })

    it.each(['explicit', 'automatic'])('waits for an %s attachment already in progress before sending', async (mode) => {
      const subscribe = vi.mocked(mockClient.subscribeToStream).getMockImplementation()!
      let finishReplay!: () => void
      vi.mocked(mockClient.subscribeToStream).mockImplementationOnce((...args) => ({
        ...subscribe(...args),
        ready: new Promise<void>(resolve => { finishReplay = resolve }),
      }))
      let subscription: Promise<void> | undefined
      if (mode === 'explicit') {
        subscription = messagePersister.subscribeToSession(AGENT_SLUG, SESSION_ID, mockClient, SESSION_ID)
      } else {
        vi.mocked(mockClient.getSession).mockResolvedValueOnce({ isRunning: true } as never)
        mockClient._sendMessage({ type: 'connection_closed' })
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      const delivery = vi.fn(async () => {})
      const pendingSend = send(delivery)
      try {
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(delivery).not.toHaveBeenCalled()
      } finally {
        finishReplay()
        await Promise.all([subscription, pendingSend])
      }
      expect(delivery).toHaveBeenCalledOnce()
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
    })

    it('reconnects before activating a new turn and ignores the previous terminal replay', async () => {
      vi.mocked(getSessionMetadata).mockResolvedValue({ isChatIntegrationSession: true } as never)
      try {
        await messagePersister.subscribeToSession(AGENT_SLUG, SESSION_ID, mockClient, SESSION_ID)
        await send(async () => { emitResult(); emitIdle() })
        expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(false)
        const subscribe = vi.mocked(mockClient.subscribeToStream).getMockImplementation()!
        vi.mocked(mockClient.subscribeToStream).mockImplementationOnce((...args) => {
          const subscription = subscribe(...args)
          return { ...subscription, ready: Promise.resolve().then(() => {
            mockClient._sendMessage({ type: 'result', subtype: 'success', is_error: false, replayed: true })
            mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle', replayed: true })
          }) }
        })
        const idleEventsBefore = sseEvents.filter(e => e.type === 'session_idle').length
        await send(async () => {
          expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(true)
          expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
          expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(idleEventsBefore)
        })
      } finally {
        vi.mocked(getSessionMetadata).mockResolvedValue(null)
      }
    })
  })

  describe('provisional recovery activity', () => {
    it('reverts a silent cold attachment even when subscribing recreates the streaming state', async () => {
      messagePersister.unsubscribeFromSession(AGENT_SLUG, SESSION_ID)
      const revert = messagePersister.markSessionProvisionallyActive(AGENT_SLUG, SESSION_ID)
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
      await messagePersister.subscribeToSession(AGENT_SLUG, SESSION_ID, mockClient, SESSION_ID)
      mockClient._sendMessage({ type: 'system', subtype: 'capabilities', session_state_events: true, process_instance: 'cold-process' })
      revert()
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
    })

    it('preserves a real running turn even if the pending-inclusive generation is unchanged', () => {
      const revert = messagePersister.markSessionProvisionallyActive(AGENT_SLUG, SESSION_ID)
      const before = messagePersister.getTurnGeneration(AGENT_SLUG, SESSION_ID)
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'running' })
      expect(messagePersister.getTurnGeneration(AGENT_SLUG, SESSION_ID)).toBe(before)
      revert()
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
    })

    it.each(['send', 'output', 'result'] as const)('preserves a new %s during attachment', kind => {
      const revert = messagePersister.markSessionProvisionallyActive(AGENT_SLUG, SESSION_ID)
      if (kind === 'send') messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      else if (kind === 'output') mockClient._sendMessage({ type: 'assistant', message: { role: 'assistant', content: 'still running' } })
      else {
        mockClient._sendMessage({ type: 'system', subtype: 'capabilities', session_state_events: true })
        mockClient._sendMessage({ type: 'result', subtype: 'success', replayed: true, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } })
      }
      revert()
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
    })

    it('does not emit a second completion after terminal replay', () => {
      const revert = messagePersister.markSessionProvisionallyActive(AGENT_SLUG, SESSION_ID)
      mockClient._sendMessage({ type: 'result', subtype: 'success', num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } })
      revert()
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
      expect(sseEvents.filter(event => event.type === 'session_idle')).toHaveLength(1)
    })
  })

  describe('markSessionIdle', () => {
    it('flips an active session back to idle and broadcasts session_idle', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
      sseEvents.length = 0

      messagePersister.markSessionIdle(AGENT_SLUG, SESSION_ID)

      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
      expect(sseEvents.filter((e) => e.type === 'session_idle')).toHaveLength(1)
    })

    it('is a no-op on an already-idle session', () => {
      sseEvents.length = 0

      messagePersister.markSessionIdle(AGENT_SLUG, SESSION_ID)

      expect(sseEvents).toHaveLength(0)
    })
  })

  // ============================================================================
  // Host tool dispatch (the tools themselves: src/shared/lib/host/tools)
  // ============================================================================

  describe('host tool dispatch', () => {
    function streamToolUse(toolName: string, toolId: string, partialJson: string[], parentToolUseId?: string) {
      const frame = parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}
      mockClient._sendMessage({
        type: 'stream_event',
        ...frame,
        event: { type: 'content_block_start', content_block: { type: 'tool_use', id: toolId, name: toolName } },
      })
      for (const partial_json of partialJson) {
        mockClient._sendMessage({
          type: 'stream_event',
          ...frame,
          event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json } },
        })
      }
    }

    function stopToolUse(parentToolUseId?: string) {
      const frame = parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}
      mockClient._sendMessage({ type: 'stream_event', ...frame, event: { type: 'content_block_stop' } })
    }

    function simulateToolUse(toolName: string, toolId: string, input: Record<string, unknown>, parentToolUseId?: string) {
      streamToolUse(toolName, toolId, [JSON.stringify(input)], parentToolUseId)
      stopToolUse(parentToolUseId)
    }

    let host: ReturnType<typeof recordingHost>
    const hostToolCalls = () => host.calls.filter(([name]) => name === 'hostTool')
    // What the persister sent to the container's pending input for this call.
    const inputCalls = (toolUseId: string) =>
      mockContainerClientFetch.mock.calls.filter(([path]) => String(path).startsWith(`/inputs/${toolUseId}/`))
    const post = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

    function attach(answer: HostToolResult | (() => Promise<HostToolResult>)) {
      host = recordingHost({ hostTool: answer })
      messagePersister.attachHost(host.port)
    }

    afterEach(() => {
      messagePersister.attachHost(localHostPort)
      mockContainerClientFetch.mockImplementation(() => Promise.resolve({ ok: true }))
    })

    it('hands a finished tool call to the host with its bare name and raw streamed input', async () => {
      attach({ status: 'resolved', value: 'Scheduled.' })
      const secretInput = '{"name":"gh","prompt":"Handle it","verification":{"secret":"whsec_supersecret"}}'

      // The input streams in pieces; nothing goes to the host until the block ends.
      streamToolUse('mcp__user-input__create_webhook_endpoint', 'tool-host-1', [secretInput.slice(0, 40), secretInput.slice(40)])
      expect(hostToolCalls()).toEqual([])
      stopToolUse()

      // All of it, as streamed: the redaction is for the session stream, not the tool.
      expect(JSON.stringify(sseEvents)).not.toContain('whsec_supersecret')
      expect(hostToolCalls()).toEqual([
        ['hostTool', {
          agentSlug: AGENT_SLUG,
          sessionId: SESSION_ID,
          toolUseId: 'tool-host-1',
          toolName: 'create_webhook_endpoint',
          input: secretInput,
        }],
      ])
      await vi.waitFor(() => expect(inputCalls('tool-host-1')).toHaveLength(1))
    })

    it('rejects the pending input with the reason when the host rejects', async () => {
      attach({ status: 'rejected', reason: 'Missing required fields: wakeTime and note are required' })

      simulateToolUse('mcp__user-input__schedule_resume', 'tool-host-reject', { note: 'A note' })

      await vi.waitFor(() => expect(inputCalls('tool-host-reject')).toHaveLength(1))
      expect(inputCalls('tool-host-reject')).toEqual([
        ['/inputs/tool-host-reject/reject', post({ reason: 'Missing required fields: wakeTime and note are required' })],
      ])
    })

    it("puts the result's session events on the session stream, in order, before resolving the input with its value", async () => {
      const sessionEvents = [
        { type: 'scheduled_task_created', toolUseId: 'tool-host-resolve', taskId: 'wake_1', scheduleType: 'at', agentSlug: AGENT_SLUG },
        { type: 'session_updated' },
      ]
      attach({ status: 'resolved', value: 'Scheduled this session to auto-resume.', sessionEvents })
      const hostEventTypes = new Set(sessionEvents.map((e) => e.type))
      let streamedBeforeResolve: unknown[] | undefined
      mockContainerClientFetch.mockImplementation((path: string) => {
        if (path.endsWith('/resolve')) streamedBeforeResolve = sseEvents.filter((e) => hostEventTypes.has(e.type))
        return Promise.resolve({ ok: true })
      })
      sseEvents.length = 0

      simulateToolUse('mcp__user-input__schedule_resume', 'tool-host-resolve', { wakeTime: 'at tomorrow 9am', note: 'Check back' })

      await vi.waitFor(() => expect(inputCalls('tool-host-resolve')).toHaveLength(1))
      expect(inputCalls('tool-host-resolve')).toEqual([
        ['/inputs/tool-host-resolve/resolve', post({ value: 'Scheduled this session to auto-resume.' })],
      ])
      expect(streamedBeforeResolve).toEqual(sessionEvents)
      expect(sseEvents.filter((e) => hostEventTypes.has(e.type))).toEqual(sessionEvents)
    })

    it('only logs a result it could not deliver: a saved schedule is never reported as failed', async () => {
      // Rejecting now would tell the agent the schedule failed, and it would
      // retry into a duplicate recurring task.
      attach({ status: 'resolved', value: 'Scheduled recurring task "Daily report" (ID: task_new_id).' })
      const deliveryError = new Error('container unreachable')
      mockContainerClientFetch.mockImplementation((path: string) =>
        path.endsWith('/resolve') ? Promise.reject(deliveryError) : Promise.resolve({ ok: true }),
      )
      const consoleError = vi.spyOn(console, 'error')

      try {
        simulateToolUse('mcp__user-input__schedule_task', 'tool-host-undelivered', {
          scheduleType: 'cron',
          scheduleExpression: '0 9 * * 1-5',
          prompt: 'Send the daily report',
        })

        await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith(
          '[MessagePersister] schedule_task succeeded but its result was not delivered:',
          deliveryError,
        ))
        expect(inputCalls('tool-host-undelivered')).toEqual([
          ['/inputs/tool-host-undelivered/resolve', expect.objectContaining({ method: 'POST' })],
        ])
      } finally {
        consoleError.mockRestore()
      }
    })

    it('rejects the pending input when the host call itself fails', async () => {
      attach(() => Promise.reject(new Error('host unreachable')))

      simulateToolUse('mcp__user-input__cancel_trigger', 'tool-host-throws', { trigger_id: 'trigger_1' })

      await vi.waitFor(() => expect(inputCalls('tool-host-throws')).toHaveLength(1))
      expect(inputCalls('tool-host-throws')).toEqual([
        ['/inputs/tool-host-throws/reject', post({ reason: 'Failed to run cancel_trigger: host unreachable' })],
      ])
    })

    it('never hands the host a tool it does not run', async () => {
      attach({ status: 'resolved', value: 'should not be asked' })
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)

      // A user-input tool the container parks for the user, and a same-named
      // tool from another MCP server.
      simulateToolUse('mcp__user-input__request_secret', 'tool-not-host-1', { secretName: 'API_KEY' })
      simulateToolUse('mcp__other-server__schedule_task', 'tool-not-host-2', { scheduleType: 'cron' })
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(hostToolCalls()).toEqual([])
      expect(inputCalls('tool-not-host-1')).toEqual([])
      expect(inputCalls('tool-not-host-2')).toEqual([])
      // The secret request is the user's to answer, as before.
      expect(openStreamRequestIds()).toContain('tool-not-host-1')
    })

    it('dispatches host tools from the main stream only, never from a subagent frame', async () => {
      attach({ status: 'resolved', value: 'should not be asked' })

      simulateToolUse('mcp__user-input__schedule_task', 'tool-sub-host', {
        scheduleType: 'cron',
        scheduleExpression: '0 9 * * 1-5',
        prompt: 'Send the daily report',
      }, 'agent-tool-1')
      await new Promise((resolve) => setTimeout(resolve, 0))

      // The subagent's stream saw the finished call; the host never did.
      expect(sseEvents.filter((e) => e.type === 'subagent_tool_use_ready')).toEqual([
        expect.objectContaining({ parentToolId: 'agent-tool-1', toolId: 'tool-sub-host', toolName: 'mcp__user-input__schedule_task' }),
      ])
      expect(hostToolCalls()).toEqual([])
      expect(inputCalls('tool-sub-host')).toEqual([])
    })
  })

  // ============================================================================
  // Slash command handling
  // ============================================================================

  describe('slash commands', () => {
    it('getSlashCommands returns empty array for unknown session', () => {
      expect(messagePersister.getSlashCommands(AGENT_SLUG, 'nonexistent')).toEqual([])
    })

    it('getSlashCommands returns empty array initially', () => {
      expect(messagePersister.getSlashCommands(AGENT_SLUG, SESSION_ID)).toEqual([])
    })

    it('setSlashCommands stores and getSlashCommands retrieves', () => {
      const commands = [
        { name: 'compact', description: 'Clear history', argumentHint: '<instructions>' },
        { name: 'review', description: 'Review code', argumentHint: '' },
      ]
      messagePersister.setSlashCommands(AGENT_SLUG, SESSION_ID, commands)
      expect(messagePersister.getSlashCommands(AGENT_SLUG, SESSION_ID)).toEqual(commands)
    })

    it('setSlashCommands is a no-op for unknown session', () => {
      // Should not throw
      messagePersister.setSlashCommands(AGENT_SLUG, 'nonexistent', [
        { name: 'test', description: '', argumentHint: '' },
      ])
      expect(messagePersister.getSlashCommands(AGENT_SLUG, 'nonexistent')).toEqual([])
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
      const stored = messagePersister.getSlashCommands(AGENT_SLUG, SESSION_ID)
      expect(stored).toHaveLength(3)
      expect(stored[0].name).toBe('compact')
    })

    it('uses init slugs without losing rich command details', () => {
      // Pre-set rich commands (e.g. legacy metadata or a container HTTP response)
      const richCommands = [
        { name: 'Order Canvas Print', description: 'Order a framed canvas', argumentHint: '<image>' },
      ]
      messagePersister.setSlashCommands(AGENT_SLUG, SESSION_ID, richCommands)

      sseEvents.length = 0

      // Init event arrives with plain string names
      mockClient._sendMessage({
        type: 'system',
        subtype: 'init',
        session_id: 'claude-session-1',
        slash_commands: ['order-canvas-print', 'review'],
      })

      const stored = messagePersister.getSlashCommands(AGENT_SLUG, SESSION_ID)
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
      messagePersister.setSlashCommands(AGENT_SLUG, SESSION_ID, commands)

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
      mockClient._sendMessage({
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
    beforeEach(() => {
      // Requests park mid-turn: production always has markSessionActive before
      // a request event arrives, and the derived awaiting projection is gated
      // on an active turn (an inactive session is never awaiting).
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
    })

    // Helper to collect global notification events
    function collectGlobalEvents(): { events: any[]; cleanup: () => void } {
      const events: any[] = []
      const cleanup = globalFeed.subscribe((data) => {
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
      expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(false)
    })

    it('sets isAwaitingInput after request_secret tool fires', () => {
      simulateToolUse('mcp__user-input__request_secret', 'tool-1', {
        secretName: 'API_KEY',
        reason: 'Need it',
      })

      expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(true)
    })

    it('preserves initial-turn active and awaiting flags across stream subscription', async () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      simulateToolUse('mcp__user-input__request_secret', 'tool-1', {
        secretName: 'API_KEY',
        reason: 'Need it',
      })

      await messagePersister.subscribeToSession(AGENT_SLUG, SESSION_ID, mockClient, SESSION_ID)

      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
      expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(true)
      expect(messagePersister.hasSessionsAwaitingInputForAgent(AGENT_SLUG)).toBe(true)
    })

    it('recovers awaiting input for an active session from persisted request fallback', () => {
      const { events: globalEvents, cleanup: globalCleanup } = collectGlobalEvents()

      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      messagePersister.recoverSessionAwaitingInput(AGENT_SLUG, SESSION_ID, [
        { toolUseId: 'recovered-1', toolName: 'mcp__user-input__request_secret' },
      ])

      expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(true)
      expect(messagePersister.hasSessionsAwaitingInputForAgent(AGENT_SLUG)).toBe(true)

      const awaitingEvents = globalEvents.filter(e => e.type === 'session_awaiting_input')
      expect(awaitingEvents).toHaveLength(1)
      expect(awaitingEvents[0].sessionId).toBe(SESSION_ID)
      expect(awaitingEvents[0].agentSlug).toBe(AGENT_SLUG)

      // Recovered entries carry no payload, so no card event goes out for
      // them; clients render the card from the transcript instead.
      expect(requestCards('question')).toHaveLength(0)

      // Its tool_result settles the recovered wait like any other request.
      mockClient._sendMessage({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'recovered-1', content: 'secret-value' },
          ],
        },
      })
      expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(false)

      globalCleanup()
    })

    it('dispatches and recovers request tools by their registered kind, including aliases', () => {
      const originalLookup = toolRegistry.getToolDefinition
      const definition = originalLookup('mcp__user-input__request_secret')
      const lookup = vi.spyOn(toolRegistry, 'getToolDefinition').mockImplementation((name) =>
        name === 'SecretAlias' ? definition : originalLookup(name),
      )
      try {
        simulateToolUse('SecretAlias', 'alias-live', { secretName: 'API_KEY' })
        expect(requestCards('secret')).toHaveLength(1)
        expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(true)

        messagePersister.recoverSessionAwaitingInput(AGENT_SLUG, SESSION_ID, [
          { toolUseId: 'alias-recovered', toolName: 'SecretAlias' },
        ])
        expect(userInputRequestManager.getOpenRequest('alias-recovered', AGENT_SLUG)).toMatchObject({
          kind: 'secret', payload: { recovered: true },
        })
      } finally {
        lookup.mockRestore()
      }
    })

    it('does not recover script approvals or delivery tools as unconditional waits', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      messagePersister.recoverSessionAwaitingInput(AGENT_SLUG, SESSION_ID, [
        { toolUseId: 'script-recovery', toolName: 'mcp__user-input__request_script_run' },
        { toolUseId: 'file-recovery', toolName: 'mcp__user-input__deliver_file' },
      ])
      expect(userInputRequestManager.getOpenRequest('script-recovery', AGENT_SLUG)).toBeNull()
      expect(userInputRequestManager.getOpenRequest('file-recovery', AGENT_SLUG)).toBeNull()
      expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(false)
    })

    it('does not recover awaiting input for an inactive session', () => {
      // A session with no active turn (here: no streaming state at all — the
      // post-restart shape this fallback exists for) must not be recovered.
      messagePersister.recoverSessionAwaitingInput(AGENT_SLUG, 'inactive-session-1', [
        { toolUseId: 'recovered-2', toolName: 'mcp__user-input__request_secret' },
      ])

      expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, 'inactive-session-1')).toBe(false)
    })

    it('sets isAwaitingInput after AskUserQuestion tool fires', () => {
      simulateToolUse('AskUserQuestion', 'tool-1', {
        questions: [{ question: 'Pick DB', header: 'DB', options: [], multiSelect: false }],
      })

      expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(true)
    })

    it('sets isAwaitingInput after request_connected_account tool fires', () => {
      simulateToolUse('mcp__user-input__request_connected_account', 'tool-1', {
        toolkit: 'github',
        reason: 'Need access',
      })

      expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(true)
    })

    it('sets isAwaitingInput after request_file tool fires', () => {
      simulateToolUse('mcp__user-input__request_file', 'tool-1', {
        description: 'Upload a CSV',
      })

      expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(true)
    })

    it('sets isAwaitingInput after request_remote_mcp tool fires', () => {
      simulateToolUse('mcp__user-input__request_remote_mcp', 'tool-1', {
        url: 'https://example.com/mcp',
      })

      expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(true)
    })

    it('sets isAwaitingInput after request_browser_input tool fires', () => {
      simulateToolUse('mcp__user-input__request_browser_input', 'tool-1', {
        message: 'Please log in',
        requirements: ['Enter credentials'],
      })

      expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(true)
    })

    // A background subagent's request_browser_input must flip the SAME awaiting
    // flag the main agent's does: the in-chat card is renderer-local state, but
    // the sidebar/header orange dot reads the persister's isAwaitingInput. A
    // request surfaced only as a card leaves the agent labeled "working" while
    // it is actually blocked on the user.
    describe('subagent-originated browser input requests', () => {
      function sendSidechainStreamEvent(event: any, parentToolId = 'agent-tool-1') {
        mockClient._sendMessage({
          type: 'stream_event',
          parent_tool_use_id: parentToolId,
          event,
        })
      }

      it('sets isAwaitingInput when a subagent streams request_browser_input', () => {
        sendSidechainStreamEvent({
          type: 'content_block_start',
          content_block: {
            type: 'tool_use',
            id: 'sub-tool-1',
            name: 'mcp__user-input__request_browser_input',
          },
        })
        sendSidechainStreamEvent({
          type: 'content_block_delta',
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify({
              message: 'Log in to GitHub.',
              requirements: ['Complete 2FA'],
            }),
          },
        })
        sendSidechainStreamEvent({ type: 'content_block_stop' })

        // The card fires either way — the status flag is the fix target.
        const cards = requestCards('browser_input')
        expect(cards).toHaveLength(1)
        expect(cards[0].request.id).toBe('sub-tool-1')
        expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(true)
      })

      it('sets isAwaitingInput when a subagent complete assistant message carries request_browser_input', () => {
        const { events: globalEvents, cleanup } = collectGlobalEvents()

        mockClient._sendMessage({
          type: 'assistant',
          parent_tool_use_id: 'agent-tool-2',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'sub-tool-2',
                name: 'mcp__user-input__request_browser_input',
                input: { message: 'Log in to GitHub.', requirements: [] },
              },
            ],
          },
        })

        expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(true)
        const awaiting = globalEvents.filter(e => e.type === 'session_awaiting_input')
        expect(awaiting).toHaveLength(1)
        expect(awaiting[0].sessionId).toBe(SESSION_ID)

        cleanup()
      })

      // The resolve side of the same asymmetry: a subagent's tool_result comes
      // back on the SIDECHAIN (parent_tool_use_id set), which never reaches the
      // main-path 'user' handler that clears isAwaitingInput and drops the
      // replayable card. After the user clicks Complete, the subagent resumes —
      // the UI must stop saying "needs input" and must not replay a stale card.
      function sendSidechainBrowserInputRequest(parentToolId: string, subToolId: string) {
        mockClient._sendMessage({
          type: 'assistant',
          parent_tool_use_id: parentToolId,
          message: {
            content: [
              {
                type: 'tool_use',
                id: subToolId,
                name: 'mcp__user-input__request_browser_input',
                input: { message: 'Log in to GitHub.', requirements: [] },
              },
            ],
          },
        })
      }

      it('clears awaiting state and settles the request when the sidechain tool_result arrives', () => {
        const { events: globalEvents, cleanup } = collectGlobalEvents()

        sendSidechainBrowserInputRequest('agent-tool-3', 'sub-tool-3')
        expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(true)
        expect(openStreamRequestIds()).toHaveLength(1)

        sseEvents.length = 0

        mockClient._sendMessage({
          type: 'user',
          parent_tool_use_id: 'agent-tool-3',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'sub-tool-3',
                content: 'User has completed the requested browser interaction.',
              },
            ],
          },
        })

        expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(false)
        expect(openStreamRequestIds()).toHaveLength(0)
        // Same broadcast the main path uses — other windows drop their card copy off it
        const results = sseEvents.filter(e => e.type === 'tool_result')
        expect(results).toHaveLength(1)
        expect(results[0].toolUseId).toBe('sub-tool-3')
        expect(globalEvents.filter(e => e.type === 'session_input_provided')).toHaveLength(1)

        cleanup()
      })

      it('does not clear awaiting state on unrelated sidechain tool results', () => {
        sendSidechainBrowserInputRequest('agent-tool-4', 'sub-tool-4')

        // An ordinary subagent tool result (e.g. Bash) while the request is open
        mockClient._sendMessage({
          type: 'user',
          parent_tool_use_id: 'agent-tool-4',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'other-tool-9', content: 'file listing' },
            ],
          },
        })

        expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(true)
        expect(openStreamRequestIds()).toHaveLength(1)
      })

      it('keeps awaiting when another input request is still open after the sidechain result', () => {
        // Main-agent question open in parallel with the subagent's browser input
        simulateToolUse('AskUserQuestion', 'main-q-1', {
          questions: [{ question: 'Pick DB', header: 'DB', options: [], multiSelect: false }],
        })
        sendSidechainBrowserInputRequest('agent-tool-5', 'sub-tool-5')
        expect(openStreamRequestIds()).toHaveLength(2)

        // Only the subagent's request resolves
        mockClient._sendMessage({
          type: 'user',
          parent_tool_use_id: 'agent-tool-5',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'sub-tool-5', content: 'done' },
            ],
          },
        })

        expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(true)
        expect(openStreamRequestIds()).toEqual(['main-q-1'])
      })
    })

    it('does NOT set isAwaitingInput for schedule_task tool', () => {
      simulateToolUse('mcp__user-input__schedule_task', 'tool-1', {
        scheduleType: 'at',
        scheduleExpression: '2026-03-20T10:00:00Z',
        prompt: 'Do something',
      })

      expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(false)
    })

    it('does NOT set isAwaitingInput for deliver_file tool', () => {
      simulateToolUse('mcp__user-input__deliver_file', 'tool-1', {
        filePath: '/tmp/output.csv',
        description: 'Results',
      })

      expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(false)
    })

    it('does NOT set isAwaitingInput for non-user-input tools', () => {
      simulateToolUse('Bash', 'tool-1', { command: 'ls' })

      expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(false)
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
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)

      simulateToolUse('mcp__user-input__request_secret', 'tool-1', { secretName: 'KEY' })
      expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(true)

      // Simulate tool result arriving as a user message
      mockClient._sendMessage({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'secret-value' },
          ],
        },
      })

      expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(false)
    })

    it('keeps isAwaitingInput on tool result while a parked review is open', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)

      // A parked proxy/x-agent review keeps the agent awaiting even as an
      // unrelated tool result lands. The review lives outside the stream maps
      // as an agent-scoped registry entry — exactly what ReviewManager writes
      // through on requestReview.
      // The registry singleton is shared across tests; resolve in finally so a
      // failing assertion can't leak this review into later tests.
      userInputRequestManager.register({
        id: 'blocker-review-1',
        kind: 'proxy_review',
        scope: { agentSlug: AGENT_SLUG },
        blocking: true,
        autoApproved: false,
        payload: { toolkit: 'slack' },
      })

      try {
        simulateToolUse('mcp__user-input__request_secret', 'tool-1', { secretName: 'KEY' })
        expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(true)

        // User answers the secret; its tool result arrives while the review is still up.
        mockClient._sendMessage({
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'tool-1', content: 'secret-value' },
            ],
          },
        })

        // Must stay awaiting — the review is still open.
        expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(true)

        // Once the review resolves, the agent-wide sync settles the session.
        userInputRequestManager.resolve('blocker-review-1', 'answered')
        messagePersister.syncAgentSessionsAwaiting(AGENT_SLUG)
        expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(false)
      } finally {
        userInputRequestManager.resolve('blocker-review-1', 'cancelled')
      }
    })

    it('broadcasts session_input_provided globally when input is received', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)

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
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)

      simulateToolUse('mcp__user-input__request_secret', 'tool-1', { secretName: 'KEY' })
      expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(true)

      // Simulate session completing
      mockClient._sendMessage({
        type: 'result',
        subtype: 'success',
      })

      expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(false)
    })

    it('clears isAwaitingInput when session is interrupted', async () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)

      simulateToolUse('mcp__user-input__request_secret', 'tool-1', { secretName: 'KEY' })
      expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(true)

      await messagePersister.markSessionInterrupted(AGENT_SLUG, SESSION_ID)

      expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(false)
    })

    it('clears isAwaitingInput when new user message starts (markSessionActive)', () => {
      simulateToolUse('mcp__user-input__request_secret', 'tool-1', { secretName: 'KEY' })
      expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(true)

      // New message starts a new turn
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)

      expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(false)
    })

    it('returns false for unknown session IDs', () => {
      expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, 'nonexistent-session')).toBe(false)
    })

    // ------------------------------------------------------------------
    // cancelAwaitingInput: when a new message arrives while the session is
    // awaiting input, cancel the pending request(s) so the message isn't
    // queued behind a blocked tool (the deadlock). EVERY cancel interrupts
    // first — aborting the parked query so it can't resume into a filler
    // reply — then cleanup-rejects each pending id (the reason is never read
    // by the model, since the turn was already aborted).
    // ------------------------------------------------------------------
    describe('cancelAwaitingInput', () => {
      const rejectCallFor = (toolUseId: string) =>
        mockContainerClientFetch.mock.calls.find((c) => c[0] === `/inputs/${toolUseId}/reject`)
      const interruptCall = () =>
        mockContainerClientFetch.mock.calls.find((c) => c[0] === `/sessions/${SESSION_ID}/interrupt`)

      it('interrupts a top-level AskUserQuestion BEFORE cleanup-rejecting it (aborted turn cannot resume into a filler reply)', async () => {
        messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
        simulateToolUse('AskUserQuestion', 'q-1', {
          questions: [{ question: 'Pick DB', header: 'DB', options: [], multiSelect: false }],
        })
        expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(true)
        mockContainerClientFetch.mockClear()

        await messagePersister.cancelAwaitingInput(AGENT_SLUG, SESSION_ID)

        const calls = mockContainerClientFetch.mock.calls
        const interruptIdx = calls.findIndex((c) => c[0] === `/sessions/${SESSION_ID}/interrupt`)
        const rejectIdx = calls.findIndex((c) => c[0] === `/inputs/q-1/reject`)
        // Top-level now interrupts too, and the interrupt must land BEFORE the reject:
        // rejecting first would resume the parked turn and let the model emit a filler
        // ("Go ahead") that the next message then anchors to.
        expect(interruptIdx).toBeGreaterThanOrEqual(0)
        expect(rejectIdx).toBeGreaterThan(interruptIdx)
        // markSessionInterrupted ran, clearing the awaiting state.
        expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(false)
      })

      it('rejects AND interrupts for a subagent browser_input request', async () => {
        messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
        simulateToolUse('mcp__user-input__request_browser_input', 'bi-1', {
          message: 'Please log in',
          requirements: ['Enter credentials'],
        })
        expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(true)
        mockContainerClientFetch.mockClear()

        await messagePersister.cancelAwaitingInput(AGENT_SLUG, SESSION_ID)

        expect(rejectCallFor('bi-1')).toBeDefined()
        expect(interruptCall()).toBeDefined()
        // The interrupt path marks the session interrupted (awaiting cleared).
        expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(false)
      })

      it('sweeps the pending computer-use entries and interrupts', async () => {
        vi.stubEnv('E2E_MOCK', 'true') // skip the host platform gate so the request goes pending
        try {
          messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
          simulateToolUse('mcp__computer-use__computer_click', 'cu-1', { ref: 'win:1' })
          expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(true)
          expect(messagePersister.getPendingComputerUseRequests(AGENT_SLUG, SESSION_ID)).toHaveLength(1)
          mockContainerClientFetch.mockClear()

          await messagePersister.cancelAwaitingInput(AGENT_SLUG, SESSION_ID)

          expect(rejectCallFor('cu-1')).toBeDefined()
          expect(interruptCall()).toBeDefined()
          // Host-side computer_use bookkeeping is cleared too (session_idle only clears
          // pendingInputRequests), so a reconnect can't replay a phantom approval card.
          expect(messagePersister.getPendingComputerUseRequests(AGENT_SLUG, SESSION_ID)).toHaveLength(0)
        } finally {
          vi.unstubAllEnvs()
        }
      })

      it('rejects every pending request when several are open', async () => {
        messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
        simulateToolUse('mcp__user-input__request_secret', 's-1', { secretName: 'KEY1' })
        simulateToolUse('mcp__user-input__request_file', 'f-1', { description: 'CSV' })
        mockContainerClientFetch.mockClear()

        await messagePersister.cancelAwaitingInput(AGENT_SLUG, SESSION_ID)

        expect(rejectCallFor('s-1')).toBeDefined()
        expect(rejectCallFor('f-1')).toBeDefined()
      })

      it('is a no-op when the session is not awaiting input', async () => {
        messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
        mockContainerClientFetch.mockClear()

        await messagePersister.cancelAwaitingInput(AGENT_SLUG, SESSION_ID)

        expect(mockContainerClientFetch).not.toHaveBeenCalled()
      })

      function startBackgroundTask(taskId: string) {
        mockClient._sendMessage({
          type: 'user',
          tool_use_result: { backgroundTaskId: taskId },
          message: { content: [{ type: 'tool_result', tool_use_id: `tool-${taskId}`, content: 'Running' }] },
        })
      }

      function answerInterruptWith(processKept: boolean) {
        mockContainerClientFetch.mockImplementation((route: string) =>
          Promise.resolve(
            route === `/sessions/${SESSION_ID}/interrupt`
              ? { ok: true, json: async () => ({ success: true, processKept }) }
              : { ok: true },
          ),
        )
      }

      it('keeps background tasks when the container kept the process across the interrupt', async () => {
        // A new message while a question is pending stops only the turn: the
        // container's background tasks live on, so the host keeps their rows.
        messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
        startBackgroundTask('bg-1')
        simulateToolUse('AskUserQuestion', 'q-bg', {
          questions: [{ question: 'Pick DB', header: 'DB', options: [], multiSelect: false }],
        })
        mockContainerClientFetch.mockClear()
        answerInterruptWith(true)
        try {
          await messagePersister.cancelAwaitingInput(AGENT_SLUG, SESSION_ID)
        } finally {
          mockContainerClientFetch.mockImplementation(() => Promise.resolve({ ok: true }))
        }

        expect(interruptCall()?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ scope: 'turn' }) })
        expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(false)
        expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID).map((t) => t.taskId)).toEqual(['bg-1'])
        expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
      })

      it('spares a task only the runtime listed, like any other tracked task', async () => {
        // A subagent launched it, so no launch signal registered it — but the
        // runtime's snapshot does, which gives it a row and a per-task stop.
        // A turn stop leaves it running instead of escalating to a full stop.
        messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
        mockClient._sendMessage({
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: [{ task_id: 'nested-1', task_type: 'local_bash', description: 'Serve local assets' }],
        })
        simulateToolUse('AskUserQuestion', 'q-untracked', {
          questions: [{ question: 'Pick DB', header: 'DB', options: [], multiSelect: false }],
        })
        mockContainerClientFetch.mockClear()
        answerInterruptWith(true)
        try {
          await messagePersister.cancelAwaitingInput(AGENT_SLUG, SESSION_ID)
        } finally {
          mockContainerClientFetch.mockImplementation(() => Promise.resolve({ ok: true }))
        }

        expect(interruptCall()?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ scope: 'turn' }) })
        expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID).map((t) => t.taskId)).toEqual(['nested-1'])
        expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
      })

      it('stops everything when the only open work is ambient', async () => {
        // Ambient tasks (housekeeping, live-update watchers) are hidden from
        // clients, so there is no row to stop them from: a turn stop would
        // leave the session pinned. The cancel asks for the full stop.
        messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
        mockClient._sendMessage({
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: [{ task_id: 'watcher', task_type: 'local_bash', description: 'Watch for updates', ambient: true }],
        })
        simulateToolUse('AskUserQuestion', 'q-ambient', {
          questions: [{ question: 'Pick DB', header: 'DB', options: [], multiSelect: false }],
        })
        mockContainerClientFetch.mockClear()
        answerInterruptWith(false)
        try {
          await messagePersister.cancelAwaitingInput(AGENT_SLUG, SESSION_ID)
        } finally {
          mockContainerClientFetch.mockImplementation(() => Promise.resolve({ ok: true }))
        }

        expect(interruptCall()?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ scope: 'all' }) })
        expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
      })

      it('drops background tasks when the container had to restart the process', async () => {
        messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
        startBackgroundTask('bg-1')
        simulateToolUse('AskUserQuestion', 'q-restart', {
          questions: [{ question: 'Pick DB', header: 'DB', options: [], multiSelect: false }],
        })
        answerInterruptWith(false)
        try {
          await messagePersister.cancelAwaitingInput(AGENT_SLUG, SESSION_ID)
        } finally {
          mockContainerClientFetch.mockImplementation(() => Promise.resolve({ ok: true }))
        }

        expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID)).toEqual([])
        expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
      })

      it('swallows reject/interrupt failures so a best-effort cancel never throws', async () => {
        messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
        simulateToolUse('mcp__user-input__request_browser_input', 'bi-err', {
          message: 'Please log in',
          requirements: ['Enter credentials'],
        })
        expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(true)
        mockContainerClientFetch.mockClear()
        mockContainerClientFetch.mockRejectedValue(new Error('container unreachable'))
        try {
          // Must resolve, not reject — a failed cancel must never block the incoming message.
          await expect(messagePersister.cancelAwaitingInput(AGENT_SLUG, SESSION_ID)).resolves.toBeUndefined()
          // Both container calls were attempted (and rejected): the interrupt + the cleanup reject.
          expect(rejectCallFor('bi-err')).toBeDefined()
          expect(interruptCall()).toBeDefined()
          // The interrupt fetch rejected, but markSessionInterrupted runs right after the swallowed
          // interrupt, so the cancel still clears the awaiting state.
          expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(false)
        } finally {
          mockContainerClientFetch.mockImplementation(() => Promise.resolve({ ok: true }))
        }
      })
    })
  })

  // ============================================================================
  // getSessionActivity
  // ============================================================================

  describe('getSessionActivity', () => {
    it('projects the streaming-state flags onto an activity label', () => {
      // helper sets the three lifecycle flags on the session's streaming state
      const setFlags = (a: boolean, aw: boolean, s: boolean) => {
        const st = (messagePersister as any).streamingStates.get(sessionKeyOf(AGENT_SLUG, SESSION_ID))
        st.isActive = a; st.isAwaitingInput = aw; st.isStreaming = s
      }
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID) // ensures a state exists

      setFlags(true, false, false);  expect(messagePersister.getSessionActivity(AGENT_SLUG, SESSION_ID)).toBe('working')   // nothing more specific
      setFlags(true, false, true);   expect(messagePersister.getSessionActivity(AGENT_SLUG, SESSION_ID)).toBe('streaming') // assistant text owns the surface
      setFlags(true, true, false);   expect(messagePersister.getSessionActivity(AGENT_SLUG, SESSION_ID)).toBe('awaiting')  // waiting on the user
      setFlags(false, false, false); expect(messagePersister.getSessionActivity(AGENT_SLUG, SESSION_ID)).toBe('idle')      // not active
    })

    it('honors the busy precedence (compacting > retrying > thinking > streaming), even with isStreaming set', () => {
      // isStreaming stale-true throughout (the api_retry-mid-stream case): the busy
      // states must still win, so chat shows "Compacting…/Retrying…/Thinking…" like the
      // app rather than dishonestly yielding to 'streaming'. As each clears, the next
      // down the ladder shows, and once all clear, streamed text owns the surface.
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      const st = (messagePersister as any).streamingStates.get(sessionKeyOf(AGENT_SLUG, SESSION_ID))
      st.isActive = true; st.isAwaitingInput = false; st.currentToolUse = null
      st.isStreaming = true

      st.isCompacting = true; st.isRetrying = true; st.currentThinking = true
      expect(messagePersister.getSessionActivity(AGENT_SLUG, SESSION_ID)).toBe('compacting')
      st.isCompacting = false
      expect(messagePersister.getSessionActivity(AGENT_SLUG, SESSION_ID)).toBe('retrying')
      st.isRetrying = false
      expect(messagePersister.getSessionActivity(AGENT_SLUG, SESSION_ID)).toBe('thinking')
      st.currentThinking = false
      expect(messagePersister.getSessionActivity(AGENT_SLUG, SESSION_ID)).toBe('streaming')
    })

    it('a new turn (markSessionActive) clears a stale isCompacting/currentThinking from an abnormally-ended prior turn', () => {
      // The desktop app resets these on session_active/idle/error; chat must too, or a
      // turn that ended mid-compaction (error/interrupt before the compact summary)
      // wedges the next turn's label to "Compacting…". The state object is reused across turns.
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      const st = (messagePersister as any).streamingStates.get(sessionKeyOf(AGENT_SLUG, SESSION_ID))
      st.isActive = false; st.isCompacting = true; st.currentThinking = true; st.isRetrying = true

      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID) // next user message
      expect(st.isCompacting).toBe(false)
      expect(st.currentThinking).toBe(false)
      expect(st.isRetrying).toBe(false)
      expect(messagePersister.getSessionActivity(AGENT_SLUG, SESSION_ID)).toBe('working')
    })

    it('keeps a running turn intact when a queued message re-marks an ALREADY-active session', () => {
      // Queueing a message mid-turn accepts it into the RUNNING turn — it is not a
      // turn boundary, so everything that turn is still doing survives. Driven with
      // the real frames, since the bug was that markSessionActive wiped exactly the
      // state those frames had just established. (SUP-736)
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      mockClient._sendMessage({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1' } } })
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      })
      mockClient._sendMessage({
        type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 5, session_id: SESSION_ID, uuid: 'r1',
      })
      mockClient._sendMessage({
        type: 'system', subtype: 'status', status: 'compacting', session_id: SESSION_ID, uuid: 's1',
      })
      expect(messagePersister.getSessionActivity(AGENT_SLUG, SESSION_ID)).toBe('compacting')
      sseEvents.length = 0

      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID) // queued mid-turn

      // The app is told which of the two meanings this session_active carries.
      expect(sseEvents.find(e => e.type === 'session_active')).toMatchObject({ queuedMidTurn: true })
      // Chat's label walks back down the real ladder as each state ends, instead of
      // dropping straight to "Working…" the moment the message was queued.
      const st = (messagePersister as any).streamingStates.get(sessionKeyOf(AGENT_SLUG, SESSION_ID))
      expect(messagePersister.getSessionActivity(AGENT_SLUG, SESSION_ID)).toBe('compacting')
      st.isCompacting = false
      expect(messagePersister.getSessionActivity(AGENT_SLUG, SESSION_ID)).toBe('retrying')
      st.isRetrying = false
      expect(messagePersister.getSessionActivity(AGENT_SLUG, SESSION_ID)).toBe('thinking')

      // And the open thinking block still closes under the id the app opened it
      // with — a nulled message id/block index would have re-keyed it to undefined.
      mockClient._sendMessage({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
      expect(sseEvents.find(e => e.type === 'thinking_stop')).toMatchObject({ thinkingId: 'msg_1:0' })
    })

    it('is idle for an unknown session', () => {
      expect(messagePersister.getSessionActivity(AGENT_SLUG, 'nope')).toBe('idle')
    })
  })

  // ============================================================================
  // Capability review lifecycle
  // ============================================================================

  describe('capability review lifecycle', () => {
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

    beforeEach(() => {
      mockAgentCapabilities.subagents = 'allow'
      mockAgentCapabilities.workflows = 'review'
      // Grant lookup on the container: default to "no persisted grants".
      vi.mocked(mockClient.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ grants: [] }),
      } as unknown as Response)
    })

    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

    it('registers a review card clients can render', async () => {
      simulateToolUse('Workflow', 'wf-1', { script: 'export const meta = {}' })

      await vi.waitFor(() => {
        expect(requestCards('capability_review')).toHaveLength(1)
      })
      expect(requestCards('capability_review')[0].request).toMatchObject({
        id: 'wf-1',
        payload: { capability: 'workflows' },
      })
      expect(openStreamRequestIds()).toContain('wf-1')
    })

    it('completeCapabilityReview settles the entry immediately and notifies live clients', async () => {
      simulateToolUse('Workflow', 'wf-1', { script: 'export const meta = {}' })
      await vi.waitFor(() => {
        expect(openStreamRequestIds()).toHaveLength(1)
      })

      // The decision route calls this on approve AND reject. Waiting for the
      // launched Workflow's tool_result would leave the card up for the whole
      // (possibly minutes-long) run.
      messagePersister.completeCapabilityReview(AGENT_SLUG, SESSION_ID, 'wf-1')

      expect(openStreamRequestIds()).toHaveLength(0)
      const resolved = sseEvents.filter(e => e.type === 'user_request_resolved')
      expect(resolved).toHaveLength(1)
      expect(resolved[0]).toMatchObject({ requestId: 'wf-1' })
    })

    it('a session-scope grant in the host mirror suppresses review cards without a container query', async () => {
      messagePersister.grantSessionCapability(AGENT_SLUG, SESSION_ID, 'workflows')
      simulateToolUse('Workflow', 'wf-2', { script: 'export const meta = {}' })

      await flush()
      expect(requestCards('capability_review')).toHaveLength(0)
      expect(mockClient.fetch).not.toHaveBeenCalled()
    })

    it('consults the container-persisted grants when the host mirror is cold', async () => {
      // Fresh host process, live granted session: the container reports the
      // grant, so no phantom card — and the mirror is repopulated for next time.
      vi.mocked(mockClient.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ grants: ['workflows'] }),
      } as unknown as Response)

      simulateToolUse('Workflow', 'wf-3', { script: 'export const meta = {}' })

      await vi.waitFor(() => {
        expect(messagePersister.hasSessionCapabilityGrant(AGENT_SLUG, SESSION_ID, 'workflows')).toBe(true)
      })
      expect(requestCards('capability_review')).toHaveLength(0)
    })

    it('still shows the card when the grant lookup fails', async () => {
      vi.mocked(mockClient.fetch).mockRejectedValue(new Error('container gone'))

      simulateToolUse('Workflow', 'wf-4', { script: 'export const meta = {}' })

      await vi.waitFor(() => {
        expect(requestCards('capability_review')).toHaveLength(1)
      })
    })

    it('subagent launches under allow policy broadcast nothing', async () => {
      simulateToolUse('Task', 'task-1', { prompt: 'go', subagent_type: 'Explore' })

      await flush()
      expect(requestCards('capability_review')).toHaveLength(0)
      expect(mockClient.fetch).not.toHaveBeenCalled()
    })

    it('a cancellation racing ahead of the grant lookup suppresses the card entirely', async () => {
      // handleCapabilityReviewTool awaits the container grant lookup before
      // storing/broadcasting the card. A capability_review_cancelled frame
      // landing during that await must tombstone the id — otherwise the
      // handler resurrects an unanswerable card and re-marks the session
      // awaiting input after its own cancellation.
      let releaseLookup!: (value: unknown) => void
      vi.mocked(mockClient.fetch).mockReturnValue(
        new Promise((resolve) => { releaseLookup = resolve }) as never
      )

      simulateToolUse('Workflow', 'wf-race', { script: 'export const meta = {}' })
      await flush()
      mockClient._sendMessage({
        type: 'capability_review_cancelled',
        toolUseId: 'wf-race',
        capability: 'workflows',
      })
      await flush()

      releaseLookup({ ok: true, json: async () => ({ grants: [] }) })
      await flush()
      await flush()

      expect(requestCards('capability_review')).toHaveLength(0)
      expect(openStreamRequestIds()).toHaveLength(0)

      // The tombstone is consumed — a later review with a fresh id is unaffected.
      vi.mocked(mockClient.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ grants: [] }),
      } as unknown as Response)
      simulateToolUse('Workflow', 'wf-after-race', { script: 'export const meta = {}' })
      await vi.waitFor(() => {
        expect(requestCards('capability_review')).toHaveLength(1)
      })
      expect(requestCards('capability_review')[0].request).toMatchObject({
        id: 'wf-after-race',
      })
    })

    it('a container cancellation frame closes the card like a decision does', async () => {
      // The container's gate hook emits this when the CLI abandons the parked
      // hook (per-hook timeout or turn abort) — no decision can ever land, so
      // the card must not linger for live clients or reconnect replay.
      simulateToolUse('Workflow', 'wf-5', { script: 'export const meta = {}' })
      await vi.waitFor(() => {
        expect(openStreamRequestIds()).toHaveLength(1)
      })

      mockClient._sendMessage({
        type: 'capability_review_cancelled',
        toolUseId: 'wf-5',
        capability: 'workflows',
      })

      await vi.waitFor(() => {
        expect(openStreamRequestIds()).toHaveLength(0)
      })
      const resolved = sseEvents.filter(e => e.type === 'user_request_resolved')
      expect(resolved).toHaveLength(1)
      expect(resolved[0]).toMatchObject({ requestId: 'wf-5' })
    })
  })

  // ============================================================================
  // Automated session promotion
  // ============================================================================

  describe('automated session promotion', () => {
    beforeEach(() => {
      // Promotion fires on the awaiting rising edge, which requires an active
      // turn — as in production, where the automated send marks active first.
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
    })

    function collectGlobalEvents(): { events: any[]; cleanup: () => void } {
      const events: any[] = []
      const cleanup = globalFeed.subscribe((data) => {
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
          expect.objectContaining({ slug: AGENT_SLUG }),
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
          expect.objectContaining({ slug: AGENT_SLUG }),
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
          expect.objectContaining({ slug: AGENT_SLUG }),
          SESSION_ID,
          { promotedToInteractive: true },
        )
      })
    })

    it('promotes an x-agent session when user input is requested', async () => {
      vi.mocked(getSessionMetadata).mockResolvedValueOnce({
        invokedByAgentSlug: 'caller-agent',
      })

      simulateToolUse('AskUserQuestion', 'tool-1', {
        questions: [{ question: 'Pick?', header: 'Q', options: [], multiSelect: false }],
      })

      await vi.waitFor(() => {
        expect(updateSessionMetadata).toHaveBeenCalledWith(
          expect.objectContaining({ slug: AGENT_SLUG }),
          SESSION_ID,
          { promotedToInteractive: true },
        )
      })
    })

    // Args-keyed metadata mock for the two broadcast tests below. A
    // mockResolvedValueOnce is consumed by ANY caller — this suite has
    // fire-and-forget promotes still in flight from earlier tests (CI's
    // slower interleaving even surfaced one carrying TRANSPOSED ids), and a
    // stray both eats a queued Once and pollutes an unfiltered event capture.
    // Keying on the exact (agentSlug, sessionId) pair keeps strays on the
    // null path. mockImplementation survives clearAllMocks, so restore the
    // suite default afterwards.
    function withHiddenScheduledMetadata(agentSlug: string, sessionId: string): () => void {
      vi.mocked(getSessionMetadata).mockImplementation((store, id) =>
        Promise.resolve(
          store.slug === agentSlug && id === sessionId
            ? ({ isScheduledExecution: true, scheduledTaskId: 'task-1' } as never)
            : null,
        ),
      )
      return () => {
        vi.mocked(getSessionMetadata).mockImplementation(() => Promise.resolve(null))
      }
    }

    it('a direct promote of a non-awaiting session broadcasts session_updated, not an awaiting assertion', async () => {
      // A dedicated id pair: ambient stray promotes target SESSION_ID /
      // AGENT_SLUG, so a unique pair makes this test hermetic no matter what
      // is still in flight — no streaming state exists for it, which is
      // exactly the settled shape the else-branch broadcast covers.
      const PROMOTE_SESSION = 'direct-promote-session'
      const PROMOTE_AGENT = 'direct-promote-agent'
      const restoreMetadata = withHiddenScheduledMetadata(PROMOTE_AGENT, PROMOTE_SESSION)
      const { events, cleanup } = collectGlobalEvents()

      try {
        // The human-message route (agents.ts) promotes before delivery, usually
        // on a session that is NOT awaiting. Clients echo session_awaiting_input
        // into their caches as STATE (working + orange dot), so that promote
        // must send the assertion-free refetch nudge instead.
        await messagePersister.promoteAutomatedSession(PROMOTE_AGENT, PROMOTE_SESSION)

        const forSession = (e: { sessionId?: string; agentSlug?: string }) =>
          e.sessionId === PROMOTE_SESSION || e.agentSlug === PROMOTE_AGENT
        expect(events.filter((e) => e.type === 'session_awaiting_input' && forSession(e))).toHaveLength(0)
        const updated = events.filter((e) => e.type === 'session_updated' && forSession(e))
        expect(updated).toHaveLength(1)
        expect(updated[0]).toMatchObject({ sessionId: PROMOTE_SESSION, agentSlug: PROMOTE_AGENT })
      } finally {
        cleanup()
        restoreMetadata()
      }
    })

    it('a promote on the awaiting rising edge still asserts session_awaiting_input', async () => {
      const restoreMetadata = withHiddenScheduledMetadata(AGENT_SLUG, SESSION_ID)
      const { events, cleanup } = collectGlobalEvents()

      simulateToolUse('mcp__user-input__request_secret', 'tool-1', { secretName: 'KEY' })

      await vi.waitFor(() => {
        expect(updateSessionMetadata).toHaveBeenCalledWith(
          expect.objectContaining({ slug: AGENT_SLUG }),
          SESSION_ID,
          { promotedToInteractive: true },
        )
      })
      // The session genuinely awaits here, so the state assertion is correct.
      const forSession = (e: { sessionId?: string }) => e.sessionId === SESSION_ID
      expect(
        events.filter((e) => e.type === 'session_awaiting_input' && forSession(e)).length,
      ).toBeGreaterThanOrEqual(1)
      expect(events.filter((e) => e.type === 'session_updated' && forSession(e))).toHaveLength(0)
      cleanup()
      restoreMetadata()
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
  })

  describe('automation outcome metadata', () => {
    // Guard rules (regular session, promoted legacy session, already-final
    // outcome) live inside finalizeAutomationStatus and are covered by
    // session-service.metadata.test.ts against real files. Here we cover the
    // wiring: result → status mapping, and the not-automation caching that
    // spares interactive sessions repeat metadata reads.
    beforeEach(() => {
      vi.mocked(finalizeAutomationStatus).mockResolvedValue('updated')
    })

    function sendResult(isError: boolean) {
      mockClient._sendMessage(isError ? {
        type: 'result',
        subtype: 'error_during_execution',
        error: 'Execution failed',
        is_error: true,
        duration_ms: 100,
        num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 0 },
      } : {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 100,
        num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    }

    it('finalizes a successful result as succeeded once the session settles (legacy result-driven idle)', async () => {
      // No state-events authority and no background work: the result itself
      // settles the session, so success persists in the same flow.
      sendResult(false)

      await vi.waitFor(() => {
        expect(finalizeAutomationStatus).toHaveBeenCalledWith(
          expect.objectContaining({ slug: AGENT_SLUG }),
          SESSION_ID,
          'succeeded',
        )
      })
    })

    it('defers success past open background work and persists only at the settled idle', async () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      mockClient._sendMessage({ type: 'system', subtype: 'capabilities', session_state_events: true })
      mockClient._sendMessage({
        type: 'system', subtype: 'task_started', task_type: 'local_workflow',
        task_id: 'bg1', tool_use_id: 'bg-tool', workflow_name: 'demo', description: 'demo workflow',
      })

      // The turn's result is a clean success, but the background task keeps
      // the session running — the outcome must NOT be finalized yet, or a
      // later failure could never correct it.
      sendResult(false)
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(finalizeAutomationStatus).not.toHaveBeenCalled()

      // Premature turn-end idle while the task still runs: still not settled.
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(finalizeAutomationStatus).not.toHaveBeenCalled()

      // Task settles, then the truly-settled idle persists the success.
      mockClient._sendMessage({
        type: 'system', subtype: 'task_notification', task_id: 'bg1', tool_use_id: 'bg-tool', status: 'completed',
      })
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })

      await vi.waitFor(() => {
        expect(finalizeAutomationStatus).toHaveBeenCalledWith(
          expect.objectContaining({ slug: AGENT_SLUG }),
          SESSION_ID,
          'succeeded',
        )
      })
      expect(finalizeAutomationStatus).toHaveBeenCalledTimes(1)
    })

    it('lets a later failure win over an earlier unsettled success', async () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      mockClient._sendMessage({ type: 'system', subtype: 'capabilities', session_state_events: true })

      // First (merged-turn) result succeeds but the runtime never goes idle —
      // a queued message continues the turn.
      sendResult(false)
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(finalizeAutomationStatus).not.toHaveBeenCalled()

      // The continuation fails: the failure is terminal immediately.
      sendResult(true)
      await vi.waitFor(() => {
        expect(finalizeAutomationStatus).toHaveBeenCalledWith(
          expect.objectContaining({ slug: AGENT_SLUG }),
          SESSION_ID,
          'failed',
        )
      })

      // The settling idle must not resurrect the stale success.
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(finalizeAutomationStatus).toHaveBeenCalledTimes(1)
    })

    it('finalizes an errored result as failed', async () => {
      sendResult(true)

      await vi.waitFor(() => {
        expect(finalizeAutomationStatus).toHaveBeenCalledWith(
          expect.objectContaining({ slug: AGENT_SLUG }),
          SESSION_ID,
          'failed',
        )
      })
    })

    it('stops asking after a session is known not to be an automation session', async () => {
      vi.mocked(finalizeAutomationStatus).mockResolvedValue('not-automation')

      sendResult(false)
      await vi.waitFor(() => {
        expect(finalizeAutomationStatus).toHaveBeenCalledTimes(1)
      })

      sendResult(false)
      // A second turn's result must not trigger another metadata read.
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(finalizeAutomationStatus).toHaveBeenCalledTimes(1)
    })

    it('does not finalize on a gracefully interrupted turn', async () => {
      // Error-shaped but terminal_reason marks a deliberate stop; a
      // container-internal restart continues the turn, so the automation's
      // real outcome is still pending.
      mockClient._sendMessage({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        terminal_reason: 'aborted_tools',
        duration_ms: 100,
        num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 0 },
      })

      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(finalizeAutomationStatus).not.toHaveBeenCalled()
    })

    it('keeps consulting the metadata while the session is an automation session', async () => {
      vi.mocked(finalizeAutomationStatus).mockResolvedValue('updated')

      sendResult(false)
      await vi.waitFor(() => {
        expect(finalizeAutomationStatus).toHaveBeenCalledTimes(1)
      })

      sendResult(true)
      await vi.waitFor(() => {
        expect(finalizeAutomationStatus).toHaveBeenCalledTimes(2)
      })
    })
  })

  describe('automation stream release on settle (SUP-572)', () => {
    // A leaked stream per cron/webhook run holds a runtime-container WebSocket
    // open forever (keepalives defeat idle cuts); runtimes that cap concurrent
    // connections per container then block new sessions. The persister must
    // release the stream once an unpromoted automation session truly settles.

    afterEach(() => {
      // mockResolvedValue survives clearAllMocks — restore the suite default.
      vi.mocked(getSessionMetadata).mockImplementation(() => Promise.resolve(null))
    })

    // Re-subscribe AFTER pointing the metadata mock at the desired session
    // shape, then let the async subscribe-time resolution land.
    async function resubscribeWithMetadata(meta: Record<string, unknown> | null) {
      vi.mocked(getSessionMetadata).mockResolvedValue(meta as never)
      await messagePersister.subscribeToSession(AGENT_SLUG, SESSION_ID, mockClient, SESSION_ID)
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    function settleSession() {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      // State-events authority: the runtime's own idle proves the queue drained.
      mockClient._sendMessage({ type: 'system', subtype: 'capabilities', session_state_events: true })
      mockClient._sendMessage({
        type: 'result', subtype: 'success', is_error: false, duration_ms: 100, num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    }

    it('releases the stream when a scheduled session settles', async () => {
      await resubscribeWithMetadata({ isScheduledExecution: true, scheduledTaskId: 'task-1' })

      settleSession()

      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
      expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(false)
      const lastSubscription = vi.mocked(mockClient.subscribeToStream).mock.results.at(-1)!
        .value as { unsubscribe: ReturnType<typeof vi.fn> }
      expect(lastSubscription.unsubscribe).toHaveBeenCalled()
    })

    it('releases the stream when a scheduled session settles with an error', async () => {
      await resubscribeWithMetadata({ isScheduledExecution: true, scheduledTaskId: 'task-1' })

      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      mockClient._sendMessage({ type: 'system', subtype: 'capabilities', session_state_events: true })
      mockClient._sendMessage({
        type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 100, num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 0 },
      })
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })

      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
      expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(false)
    })

    it('releases the stream when a webhook session settles', async () => {
      await resubscribeWithMetadata({ isWebhookExecution: true, webhookTriggerId: 'trigger-1' })

      settleSession()

      expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(false)
    })

    it('releases the stream when an x-agent session settles', async () => {
      await resubscribeWithMetadata({ invokedByAgentSlug: 'caller-agent' })

      settleSession()

      expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(false)
    })

    function announceProcess(processInstance = 'process-1') {
      mockClient._sendMessage({
        type: 'system', subtype: 'capabilities', session_state_events: true,
        process_instance: processInstance,
      })
    }

    function evictProcess(processInstance = 'process-1') {
      mockClient._sendMessage({ type: 'system', subtype: 'process_evicted', process_instance: processInstance })
    }

    it.each([{ isChatIntegrationSession: true }, { isAgentIntegrationSession: true }])('releases only an integration transport when its turn settles (%j)', async metadata => {
      await resubscribeWithMetadata(metadata)
      announceProcess()
      const teardown = vi.spyOn(messagePersister, 'unsubscribeFromSession')
      const recovery = vi.fn()
      messagePersister.setUnexpectedDeathCallback(recovery)
      settleSession()
      expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(false)
      expect(teardown).not.toHaveBeenCalled()
      expect(recovery).not.toHaveBeenCalled()
      const subscription = vi.mocked(mockClient.subscribeToStream).mock.results.at(-1)!.value
      expect(subscription.unsubscribe).toHaveBeenCalledTimes(1)
      teardown.mockRestore()
      messagePersister.setUnexpectedDeathCallback(null)
    })

    it.each([null, { isChatIntegrationSession: true, promotedToInteractive: true }])(
      'retains interactive or promoted streams on eviction (%j)', async (metadata) => {
        await resubscribeWithMetadata(metadata)
        announceProcess()
        settleSession()
        evictProcess()
        expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(true)
      },
    )

    it('does not detach for an older process or a new turn racing eviction', async () => {
      await resubscribeWithMetadata({ isChatIntegrationSession: true })
      announceProcess()
      evictProcess('older-process')
      expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(true)
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      evictProcess()
      expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(true)
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
    })

    it.each(['isAwaitingInput', 'isRecovering'] as const)('retains a chat transport while %s', async (hold) => {
      await resubscribeWithMetadata({ isChatIntegrationSession: true })
      announceProcess()
      const states = (messagePersister as unknown as {
        streamingStates: Map<string, { isAwaitingInput: boolean; isRecovering: boolean }>
      }).streamingStates
      states.get(sessionKeyOf(AGENT_SLUG, SESSION_ID))![hold] = true
      evictProcess()
      expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(true)
    })

    it('retains a chat transport with background work even if foreground is idle', async () => {
      await resubscribeWithMetadata({ isChatIntegrationSession: true })
      announceProcess()
      mockClient._sendMessage({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'background-task' }] })
      evictProcess()
      expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(true)
    })

    it('retains an evicted chat stream after promotion', async () => {
      await resubscribeWithMetadata({ isChatIntegrationSession: true })
      announceProcess()
      await messagePersister.promoteAutomatedSession(AGENT_SLUG, SESSION_ID)
      evictProcess()
      expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(true)
    })

    it('releases chat transports on repeated settlement and receives output after reconnect', async () => {
      await resubscribeWithMetadata({ isChatIntegrationSession: true })
      const events: unknown[] = []
      const removeListener = messagePersister.addSSEClient(AGENT_SLUG, SESSION_ID, (event) => events.push(event))
      for (let cycle = 0; cycle < 12; cycle++) {
        announceProcess(`process-${cycle}`)
        settleSession()
        evictProcess(`process-${cycle}`)
        expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(false)
        messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
        await messagePersister.subscribeToSession(AGENT_SLUG, SESSION_ID, mockClient, SESSION_ID)
        expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
        expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(true)
        mockClient._sendMessage({ type: 'system', subtype: 'init', slash_commands: [] })
        expect(events.at(-1)).toMatchObject({ type: 'stream_start' })
      }
      removeListener()
    })

    it('keeps the stream for an interactive session', async () => {
      await resubscribeWithMetadata(null)

      settleSession()

      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
      expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(true)
    })

    it('keeps the stream for a promoted automation session', async () => {
      await resubscribeWithMetadata({ isScheduledExecution: true, promotedToInteractive: true })

      settleSession()

      expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(true)
    })

    it('keeps the stream when a scheduled session is promoted mid-run', async () => {
      await resubscribeWithMetadata({ isScheduledExecution: true, scheduledTaskId: 'task-1' })

      await messagePersister.promoteAutomatedSession(AGENT_SLUG, SESSION_ID)

      settleSession()

      expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(true)
    })

    it('does not let a stale subscribe-time metadata read undo a promotion', async () => {
      const unpromoted = { isScheduledExecution: true, scheduledTaskId: 'task-1' }
      let resolveSubscribeMeta: ((value: typeof unpromoted) => void) | undefined
      let metaCalls = 0
      vi.mocked(getSessionMetadata).mockImplementation(() => {
        metaCalls += 1
        if (metaCalls === 1) {
          return new Promise((resolve) => { resolveSubscribeMeta = resolve })
        }
        return Promise.resolve(unpromoted as never)
      })

      await messagePersister.subscribeToSession(AGENT_SLUG, SESSION_ID, mockClient, SESSION_ID)
      await messagePersister.promoteAutomatedSession(AGENT_SLUG, SESSION_ID)
      resolveSubscribeMeta!(unpromoted)
      await new Promise((resolve) => setTimeout(resolve, 0))

      settleSession()

      expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(true)
    })

    it('does not release on a legacy result-driven idle (no state-events authority)', async () => {
      // Without the runtime's own idle event there is no proof the container's
      // message queue is drained — a queued message could still start a turn
      // on this stream, so the release must not fire.
      await resubscribeWithMetadata({ isScheduledExecution: true, scheduledTaskId: 'task-1' })

      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      mockClient._sendMessage({
        type: 'result', subtype: 'success', is_error: false, duration_ms: 100, num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1 },
      })

      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
      expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(true)
    })

    it('releases when automation metadata resolves after the turn already settled', async () => {
      let resolveMetadata!: (value: never) => void
      vi.mocked(getSessionMetadata).mockImplementationOnce(() => new Promise(resolve => { resolveMetadata = resolve }))
      await messagePersister.subscribeToSession(AGENT_SLUG, SESSION_ID, mockClient, SESSION_ID)
      settleSession()
      expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(true)
      resolveMetadata({ invokedByAgentSlug: 'caller' } as never)
      await vi.waitFor(() => expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(false))
    })

    it('does not use an older idle as settlement for a newer error result', async () => {
      settleSession()
      let resolveMetadata!: (value: never) => void
      vi.mocked(getSessionMetadata).mockImplementationOnce(() => new Promise(resolve => { resolveMetadata = resolve }))
      await messagePersister.subscribeToSession(AGENT_SLUG, SESSION_ID, mockClient, SESSION_ID)
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      mockClient._sendMessage({ type: 'result', subtype: 'error_during_execution', is_error: true })
      resolveMetadata({ isChatIntegrationSession: true } as never)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(true)
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
      expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(false)
    })

    it.each([
      { isScheduledExecution: true }, { isWebhookExecution: true },
      { isChatIntegrationSession: true }, { invokedByAgentSlug: 'caller' },
    ])('retains every promoted automation category (%j)', async (metadata) => {
      await resubscribeWithMetadata({ ...metadata, promotedToInteractive: true })
      announceProcess()
      settleSession()
      evictProcess()
      expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(true)
    })

    it('a released session re-subscribes cleanly for a later wake', async () => {
      await resubscribeWithMetadata({ isScheduledExecution: true, scheduledTaskId: 'task-1' })
      settleSession()
      expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(false)

      // The wake path checks isSubscribed and re-subscribes on demand.
      await messagePersister.subscribeToSession(AGENT_SLUG, SESSION_ID, mockClient, SESSION_ID)
      expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(true)

      // And the resumed run releases again at its own settle.
      await new Promise((resolve) => setTimeout(resolve, 0))
      settleSession()
      expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(false)
    })
  })

  // ============================================================================
  // Script run request detection
  // ============================================================================

  describe('Script run request detection', () => {
    beforeEach(() => {
      // Awaiting is derived and gated on an active turn — mark active as the
      // real message send would before any request event arrives.
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
    })

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

    it('registers a script_run with autoApproved:false when permission needed', () => {
      mockCheckPermission.mockReturnValue('prompt_needed')
      sseEvents.length = 0

      simulateToolUse('mcp__user-input__request_script_run', 'tool-sr-1', {
        script: 'sw_vers',
        explanation: 'Check macOS version',
        scriptType: 'shell',
      })

      const scriptEvents = requestCards('script_run')
      expect(scriptEvents).toHaveLength(1)
      expect(scriptEvents[0].request).toMatchObject({
        id: 'tool-sr-1',
        autoApproved: false,
        scope: { agentSlug: AGENT_SLUG, sessionId: SESSION_ID },
        payload: {
          script: 'sw_vers',
          explanation: 'Check macOS version',
          scriptType: 'shell',
        },
      })
    })

    it('auto-executes AND registers with autoApproved:true when use_host_shell granted', async () => {
      const { notificationManager } = await import('@shared/lib/notifications/notification-manager')
      mockCheckPermission.mockReturnValue('granted')
      sseEvents.length = 0
      const host = recordingHost({ hostScript: { exitCode: 0, stdout: 'ProductName: macOS', stderr: '' } })
      messagePersister.attachHost(host.port)
      const triggerSpy = vi.mocked(notificationManager.triggerSessionWaitingInput)
      triggerSpy.mockClear()

      try {
        simulateToolUse('mcp__user-input__request_script_run', 'tool-sr-granted', {
          script: 'sw_vers',
          explanation: 'Check macOS version',
          scriptType: 'shell',
        })

        // Still registered, flagged auto-approved so the UI suppresses its prompt.
        const scriptEvents = requestCards('script_run')
        expect(scriptEvents).toHaveLength(1)
        expect(scriptEvents[0].request).toMatchObject({
          id: 'tool-sr-granted',
          autoApproved: true,
        })

        // No "user attention required" notification when auto-approved.
        expect(triggerSpy).not.toHaveBeenCalled()

        // The host runs the script; its output goes to the container's pending input.
        await vi.waitFor(() => expect(openStreamRequestIds()).not.toContain('tool-sr-granted'))
        expect(host.calls).toEqual([['hostScript', { script: 'sw_vers', scriptType: 'shell' }]])
        expect(mockContainerClientFetch).toHaveBeenCalledWith('/inputs/tool-sr-granted/resolve', expect.objectContaining({
          body: JSON.stringify({ value: 'Exit code: 0\n\nstdout:\nProductName: macOS' }),
        }))
        // Nobody was shown the request, so no tab is told it settled.
        expect(sseEvents.filter((e) => e.type === 'tool_result')).toHaveLength(0)
      } finally {
        messagePersister.attachHost(localHostPort)
      }
    })

    it('registers a script_run even without prior permission (prompts user)', () => {
      mockCheckPermission.mockReturnValue('prompt_needed')
      sseEvents.length = 0

      simulateToolUse('mcp__user-input__request_script_run', 'tool-sr-2', {
        script: 'sw_vers',
        explanation: 'Check version',
        scriptType: 'shell',
      })

      // Should reach the client for approval (no cached permission → prompt user)
      const scriptEvents = requestCards('script_run')
      expect(scriptEvents).toHaveLength(1)
    })

    it('registers nothing when script is missing from input', () => {
      mockCheckPermission.mockReturnValue('prompt_needed')
      sseEvents.length = 0

      simulateToolUse('mcp__user-input__request_script_run', 'tool-sr-4', {
        explanation: 'Check version',
        scriptType: 'shell',
      })

      const scriptEvents = requestCards('script_run')
      expect(scriptEvents).toHaveLength(0)
    })

    it('registers nothing when scriptType is missing', () => {
      mockCheckPermission.mockReturnValue('prompt_needed')
      sseEvents.length = 0

      simulateToolUse('mcp__user-input__request_script_run', 'tool-sr-5', {
        script: 'sw_vers',
        explanation: 'Check version',
      })

      const scriptEvents = requestCards('script_run')
      expect(scriptEvents).toHaveLength(0)
    })

    it('sets isAwaitingInput after request_script_run tool fires (prompt path)', () => {
      mockCheckPermission.mockReturnValue('prompt_needed')

      simulateToolUse('mcp__user-input__request_script_run', 'tool-sr-6', {
        script: 'sw_vers',
        explanation: 'Check version',
        scriptType: 'shell',
      })

      expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(true)
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
      expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(false)
      vi.unstubAllGlobals()
    })
  })

  // ============================================================================
  // Computer use request detection
  // ============================================================================

  describe('Computer use request detection', () => {
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

    it('auto-executes AND registers with autoApproved:true when computer-use permission is granted', async () => {
      const { notificationManager } = await import('@shared/lib/notifications/notification-manager')
      const originalE2eMock = process.env.E2E_MOCK
      process.env.E2E_MOCK = 'true'
      mockCheckPermission.mockReturnValue('granted')
      sseEvents.length = 0
      const host = recordingHost({ computerUse: 'Calculator, Finder' })
      messagePersister.attachHost(host.port)
      const triggerSpy = vi.mocked(notificationManager.triggerSessionWaitingInput)
      triggerSpy.mockClear()

      try {
        simulateToolUse('mcp__computer-use__computer_apps', 'tool-cu-granted', {
          includeHidden: false,
        })

        await vi.waitFor(() => {
          expect(mockContainerClientFetch).toHaveBeenCalledWith('/inputs/tool-cu-granted/resolve', expect.objectContaining({
            body: JSON.stringify({ value: 'Calculator, Finder' }),
          }))
        })
        expect(host.calls).toEqual([
          ['computerUsePermissions', {}],
          ['computerUse', { method: 'apps', params: { includeHidden: false } }],
        ])

        const computerUseEvents = requestCards('computer_use')
        expect(computerUseEvents).toHaveLength(1)
        expect(computerUseEvents[0].request).toMatchObject({
          id: 'tool-cu-granted',
          autoApproved: true,
          scope: { agentSlug: AGENT_SLUG, sessionId: SESSION_ID },
          payload: {
            method: 'apps',
            params: { includeHidden: false },
            permissionLevel: 'list_apps_windows',
          },
        })

        expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(false)
        expect(messagePersister.getPendingComputerUseRequests(AGENT_SLUG, SESSION_ID)).toHaveLength(0)
        expect(triggerSpy).not.toHaveBeenCalled()
        // Settled once the result was delivered.
        expect(userInputRequestManager.getOpenRequest('tool-cu-granted', AGENT_SLUG)).toBeNull()
      } finally {
        if (originalE2eMock === undefined) delete process.env.E2E_MOCK
        else process.env.E2E_MOCK = originalE2eMock
        messagePersister.attachHost(localHostPort)
      }
    })

    it('runs an auto-approved command once when its tool call is delivered twice', async () => {
      const originalE2eMock = process.env.E2E_MOCK
      process.env.E2E_MOCK = 'true'
      mockCheckPermission.mockReturnValue('granted')
      let finishCommand!: (output: string) => void
      const host = recordingHost({
        computerUse: () => new Promise<string>((resolve) => {
          finishCommand = resolve
        }),
      })
      messagePersister.attachHost(host.port)
      try {
        // A subagent's tool call arrives on its stream events and again in its
        // complete message; the second delivery finds the first run holding it.
        simulateToolUse('mcp__computer-use__computer_click', 'tool-cu-twice', { ref: '@b1' })
        simulateToolUse('mcp__computer-use__computer_click', 'tool-cu-twice', { ref: '@b1' })
        await vi.waitFor(() => expect(host.calls.filter(([name]) => name === 'computerUse')).toHaveLength(1))
        finishCommand('clicked')
        await vi.waitFor(() => expect(userInputRequestManager.getOpenRequest('tool-cu-twice', AGENT_SLUG)).toBeNull())
        expect(host.calls.filter(([name]) => name === 'computerUse')).toHaveLength(1)
        expect(mockContainerClientFetch.mock.calls.filter(([path]) => String(path).includes('tool-cu-twice'))).toEqual([
          ['/inputs/tool-cu-twice/resolve', expect.objectContaining({ body: JSON.stringify({ value: 'clicked' }) })],
        ])
      } finally {
        if (originalE2eMock === undefined) delete process.env.E2E_MOCK
        else process.env.E2E_MOCK = originalE2eMock
        messagePersister.attachHost(localHostPort)
      }
    })

    it('registers the auto-approved request so the decision gate can let the auto-execute through', async () => {
      // The /computer-use route only acts on requests the registry holds open.
      // Auto-approved requests are executed via that same route (the _auto
      // session), so they must be registered too — flagged autoApproved so no
      // projection treats them as a user-facing wait, and kept out of the
      // legacy replay so a reconnecting client never renders an approval card
      // for a command that is already executing.
      const originalE2eMock = process.env.E2E_MOCK
      process.env.E2E_MOCK = 'true'
      mockCheckPermission.mockReturnValue('granted')
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true } as Response)))

      try {
        simulateToolUse('mcp__computer-use__computer_apps', 'tool-cu-granted-reg', {
          includeHidden: false,
        })

        await vi.waitFor(() => {
          const open = userInputRequestManager.getOpenRequest('tool-cu-granted-reg')
          expect(open).toMatchObject({
            kind: 'computer_use',
            blocking: true,
            autoApproved: true,
            scope: { agentSlug: AGENT_SLUG, sessionId: SESSION_ID },
          })
        })

        expect(messagePersister.getPendingComputerUseRequests(AGENT_SLUG, SESSION_ID)).toHaveLength(0)
        expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(false)
      } finally {
        if (originalE2eMock === undefined) delete process.env.E2E_MOCK
        else process.env.E2E_MOCK = originalE2eMock
        vi.unstubAllGlobals()
      }
    })
  })

  // ============================================================================
  // API error code tracking (apiErrorCode in session_error)
  // ============================================================================

  describe('API error code tracking', () => {
    it('captures error code from assistant message and includes it in session_error', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
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

    it('classifies a success-subtype result with is_error as an error turn (modern shape)', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      sseEvents.length = 0

      // The modern SDK dead-turn shape: subtype stays 'success', the error is
      // signaled via is_error + terminal_reason, and the human-readable
      // explanation lives in `result` (see sdk206-error-turn-invalid-model).
      mockClient._sendMessage({
        type: 'result',
        subtype: 'success',
        is_error: true,
        terminal_reason: 'api_error',
        api_error_status: 404,
        result: 'The selected model does not exist.',
        duration_ms: 100,
        num_turns: 1,
        usage: { input_tokens: 0, output_tokens: 0 },
      })

      const errorEvents = sseEvents.filter(e => e.type === 'session_error')
      expect(errorEvents).toHaveLength(1)
      expect(errorEvents[0].error).toBe('The selected model does not exist.')
      expect(errorEvents[0].terminalReason).toBe('api_error')
      expect(errorEvents[0].apiErrorStatus).toBe(404)
      expect(errorEvents[0].apiErrorCode).toBeNull()
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
    })

    it('broadcasts session_error with null apiErrorCode when no assistant error preceded', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
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
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)

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
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
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
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)

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

    it('broadcasts stream_delta when a finished answer never streamed', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      sseEvents.length = 0

      mockClient._sendMessage({
        type: 'assistant',
        uuid: 'answer-1',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'check the inbox' },
            { type: 'text', text: 'Yes — got your email.' },
          ],
        },
      })

      const deltas = sseEvents.filter(e => e.type === 'stream_delta')
      expect(deltas).toHaveLength(1)
      expect(deltas[0].text).toBe('Yes — got your email.')
    })

    it('does not repeat stream_delta when the answer already streamed', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Yes — got your email.' } },
      })
      sseEvents.length = 0

      mockClient._sendMessage({
        type: 'assistant',
        uuid: 'answer-2',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Yes — got your email.' }] },
      })

      expect(sseEvents.filter(e => e.type === 'stream_delta')).toHaveLength(0)
    })

    it('broadcasts stream_delta with apiErrorCode when no text was streaming', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
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
  // waitForIdle — sync x-agent invoke race protection
  // ============================================================================

  describe('waitForIdle', () => {
    const WAIT_SESSION = 'wait-session'

    afterEach(() => {
      messagePersister.unsubscribeFromSession(AGENT_SLUG, WAIT_SESSION)
    })

    it('rejects with "session never became active" when state never appears (requireActiveFirst default)', async () => {
      await expect(
        messagePersister.waitForIdle(AGENT_SLUG, WAIT_SESSION, { observeMs: 100 }),
      ).rejects.toThrow(/never became active/)
    })

    it('resolves immediately for missing state when requireActiveFirst=false', async () => {
      await expect(
        messagePersister.waitForIdle(AGENT_SLUG, WAIT_SESSION, { requireActiveFirst: false }),
      ).resolves.toBeUndefined()
    })

    it('rejects with "aborted" when the abort signal fires mid-wait', async () => {
      // Caller cancellation (e.g. HTTP client disconnect) must propagate through
      // waitForIdle so we don't keep polling after no one's listening.
      messagePersister.markSessionActive(AGENT_SLUG, WAIT_SESSION)
      const ctrl = new AbortController()
      const promise = messagePersister.waitForIdle(AGENT_SLUG, WAIT_SESSION, { signal: ctrl.signal })
      setTimeout(() => ctrl.abort(), 30)
      await expect(promise).rejects.toThrow(/aborted/)
    })

    it('rejects synchronously when signal is already aborted', async () => {
      messagePersister.markSessionActive(AGENT_SLUG, WAIT_SESSION)
      const ctrl = new AbortController()
      ctrl.abort()
      await expect(
        messagePersister.waitForIdle(AGENT_SLUG, WAIT_SESSION, { signal: ctrl.signal }),
      ).rejects.toThrow(/aborted/)
    })

    it('rejects with timeout when an active session never goes idle', async () => {
      // Once the session is active, observeMs no longer applies — timeoutMs is
      // the stop-gap. Verifies the timeout branch (not the never-active branch).
      messagePersister.markSessionActive(AGENT_SLUG, WAIT_SESSION)
      const err: unknown = await messagePersister
        .waitForIdle(AGENT_SLUG, WAIT_SESSION, { timeoutMs: 200 })
        .then(() => null, (e: unknown) => e)
      expect(err).toBeInstanceOf(WaitForIdleTimeoutError)
      // The x-agent routes distinguish timeout from other failures by error
      // NAME (their tests mock this module wholesale, so instanceof is out).
      // If this name changes, sync invoke stops promoting to async on timeout.
      expect((err as Error).name).toBe('WaitForIdleTimeoutError')
      expect((err as Error).message).toMatch(/timeout after 200ms/)
    })

    it('resolves once an active session goes idle (and preserves isActive across subscribe)', async () => {
      // Mirror the x-agent sync-invoke pattern: markSessionActive *before* subscribe
      messagePersister.markSessionActive(AGENT_SLUG, WAIT_SESSION)
      const client = createMockClient()
      await messagePersister.subscribeToSession(AGENT_SLUG, WAIT_SESSION, client, WAIT_SESSION)
      // Without preservation, isActive would have been wiped here and waitForIdle
      // would reject "never became active" instead of waiting for the result event.
      expect(messagePersister.isSessionActive(AGENT_SLUG, WAIT_SESSION)).toBe(true)

      const promise = messagePersister.waitForIdle(AGENT_SLUG, WAIT_SESSION, { observeMs: 1000 })
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
      messagePersister.unsubscribeFromSession(AGENT_SLUG, PRESERVE_SESSION)
    })

    it('preserves isActive=true from prior state when (re-)subscribing', async () => {
      // Caller marks active before subscribing (x-agent sync invoke pattern)
      messagePersister.markSessionActive(AGENT_SLUG, PRESERVE_SESSION)
      expect(messagePersister.isSessionActive(AGENT_SLUG, PRESERVE_SESSION)).toBe(true)

      const client = createMockClient()
      await messagePersister.subscribeToSession(AGENT_SLUG, PRESERVE_SESSION, client, PRESERVE_SESSION)

      // Without preservation, isActive would be reset to false here
      expect(messagePersister.isSessionActive(AGENT_SLUG, PRESERVE_SESSION)).toBe(true)
    })

    it('defaults isActive=false when subscribing fresh (no prior state)', async () => {
      const client = createMockClient()
      await messagePersister.subscribeToSession(AGENT_SLUG, PRESERVE_SESSION, client, PRESERVE_SESSION)
      expect(messagePersister.isSessionActive(AGENT_SLUG, PRESERVE_SESSION)).toBe(false)
    })

    it('concurrent subscribeToSession calls share the in-flight subscription (no double-init)', async () => {
      const client = createMockClient()
      const subscribeSpy = client.subscribeToStream as ReturnType<typeof vi.fn>
      // Fire two concurrent subscribes for the same session before either resolves
      const p1 = messagePersister.subscribeToSession(AGENT_SLUG, PRESERVE_SESSION, client, PRESERVE_SESSION)
      const p2 = messagePersister.subscribeToSession(AGENT_SLUG, PRESERVE_SESSION, client, PRESERVE_SESSION)
      await Promise.all([p1, p2])
      // Underlying transport subscription must only happen once
      expect(subscribeSpy).toHaveBeenCalledTimes(1)
    })
  })

  // ============================================================================
  // Stop that spares background tasks (the container kept the CLI process)
  // ============================================================================

  describe('stopping the turn while background tasks run', () => {
    function startBackgroundTask(taskId: string) {
      mockClient._sendMessage({
        type: 'user',
        tool_use_result: { backgroundTaskId: taskId },
        message: { content: [{ type: 'tool_result', tool_use_id: `tool-${taskId}`, content: 'Running' }] },
      })
    }

    it('keeps background tasks and the session active when the process was kept', async () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      startBackgroundTask('bg-1')
      sseEvents.length = 0

      await messagePersister.markSessionInterrupted(AGENT_SLUG, SESSION_ID, { processKept: true })

      expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID).map((t) => t.taskId)).toEqual(['bg-1'])
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
      const waiting = sseEvents.filter((e) => e.type === 'session_waiting_background')
      expect(waiting).toHaveLength(1)
      expect(waiting[0]).toMatchObject({ interrupted: true, backgroundTaskCount: 1 })
      expect(waiting[0].backgroundTasks.map((t: { taskId: string }) => t.taskId)).toEqual(['bg-1'])
      expect(sseEvents.some((e) => e.type === 'session_idle')).toBe(false)
    })

    it('settles to idle when the process was kept but nothing runs in the background', async () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      sseEvents.length = 0

      await messagePersister.markSessionInterrupted(AGENT_SLUG, SESSION_ID, { processKept: true })

      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
      expect(sseEvents.filter((e) => e.type === 'session_idle')).toHaveLength(1)
      expect(sseEvents.some((e) => e.type === 'session_waiting_background')).toBe(false)
    })

    it('drops background tasks when the process was replaced', async () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      startBackgroundTask('bg-1')
      sseEvents.length = 0

      await messagePersister.markSessionInterrupted(AGENT_SLUG, SESSION_ID)

      expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID)).toEqual([])
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
      expect(sseEvents.filter((e) => e.type === 'session_idle')).toHaveLength(1)
    })

    it('retires a spared task on its stopped notification after the stop', async () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      startBackgroundTask('bg-1')
      await messagePersister.markSessionInterrupted(AGENT_SLUG, SESSION_ID, { processKept: true })
      sseEvents.length = 0

      // The CLI's answer to stop_task.
      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'bg-1',
        status: 'stopped',
        summary: 'Stopped by user',
      })

      expect(sseEvents.filter((e) => e.type === 'background_task_completed' && e.taskId === 'bg-1')).toHaveLength(1)
      expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID)).toEqual([])
    })

    it('settles the session when the last spared task is stopped while the runtime is parked', async () => {
      // Seen on the real CLI: after stop_task it emits background_tasks_changed,
      // task_updated and task_notification(stopped) and nothing else — no
      // wake turn, no second idle.
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      startBackgroundTask('bg-1')
      mockClient._sendMessage({ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'aborted_streaming' })
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
      await messagePersister.markSessionInterrupted(AGENT_SLUG, SESSION_ID, { processKept: true })
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
      sseEvents.length = 0

      vi.useFakeTimers()
      try {
        mockClient._sendMessage({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
        mockClient._sendMessage({ type: 'system', subtype: 'task_updated', task_id: 'bg-1', patch: { status: 'killed' } })
        mockClient._sendMessage({ type: 'system', subtype: 'task_notification', task_id: 'bg-1', status: 'stopped', summary: '' })

        expect(sseEvents.filter((e) => e.type === 'background_task_completed' && e.taskId === 'bg-1')).toHaveLength(1)
        // Not yet: a stopped subagent's wake turn gets a moment to show up.
        expect(sseEvents.filter((e) => e.type === 'session_idle')).toHaveLength(0)
        vi.advanceTimersByTime(1600)
      } finally {
        vi.useRealTimers()
      }

      expect(sseEvents.filter((e) => e.type === 'session_idle')).toHaveLength(1)
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
    })

    it('leaves the settle to the runtime when the stopped task wakes the agent', async () => {
      // A stopped subagent still wakes the agent (running → result → idle);
      // settling first would flap the session idle → active → idle.
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      startBackgroundTask('agent-1')
      mockClient._sendMessage({ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'aborted_streaming' })
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
      await messagePersister.markSessionInterrupted(AGENT_SLUG, SESSION_ID, { processKept: true })
      sseEvents.length = 0

      vi.useFakeTimers()
      try {
        mockClient._sendMessage({ type: 'system', subtype: 'task_notification', task_id: 'agent-1', status: 'stopped', summary: '' })
        mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'running' })
        vi.advanceTimersByTime(1600)
      } finally {
        vi.useRealTimers()
      }

      expect(sseEvents.filter((e) => e.type === 'session_idle')).toHaveLength(0)
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
    })

    it('does not settle on a completed task — the runtime wakes the agent for it', async () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      startBackgroundTask('bg-1')
      mockClient._sendMessage({ type: 'result', subtype: 'success' })
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
      sseEvents.length = 0

      mockClient._sendMessage({ type: 'system', subtype: 'task_notification', task_id: 'bg-1', status: 'completed', summary: 'done' })

      expect(sseEvents.filter((e) => e.type === 'session_idle')).toHaveLength(0)
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
    })

    it('treats a stopped task_updated as terminal too', async () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      startBackgroundTask('bg-1')
      sseEvents.length = 0

      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'bg-1',
        patch: { status: 'stopped' },
      })

      expect(sseEvents.filter((e) => e.type === 'background_task_completed' && e.taskId === 'bg-1')).toHaveLength(1)
    })

    it('skips the stopped turn’s stale content but lets the wake turn through', async () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      startBackgroundTask('bg-1')
      await messagePersister.markSessionInterrupted(AGENT_SLUG, SESSION_ID, { processKept: true })
      sseEvents.length = 0

      const textDelta = () => mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'late words' } },
      })

      // Still in the pipe from the aborted turn: dropped.
      textDelta()
      expect(sseEvents.some((e) => e.type === 'stream_delta')).toBe(false)

      // The task settles and the runtime wakes the agent for it.
      mockClient._sendMessage({ type: 'system', subtype: 'task_updated', task_id: 'bg-1', patch: { status: 'completed' } })
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'running' })
      textDelta()

      expect(sseEvents.some((e) => e.type === 'stream_delta')).toBe(true)
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
    })

    const runtime = (state: 'idle' | 'running') =>
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state })
    const abortedResult = () =>
      mockClient._sendMessage({ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'aborted_streaming' })
    const lateDelta = (text: string) =>
      mockClient._sendMessage({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })

    it('leaves a wake turn alone when it started while the stop was in flight', async () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      runtime('running')
      startBackgroundTask('bg-1')
      const turnGenerationBefore = messagePersister.getTurnGeneration(AGENT_SLUG, SESSION_ID)

      // The container answers the interrupt only after the stopped turn's
      // result; in that window the last task settles and wakes the agent.
      abortedResult()
      runtime('idle')
      mockClient._sendMessage({ type: 'system', subtype: 'task_updated', task_id: 'bg-1', patch: { status: 'completed' } })
      runtime('running')
      sseEvents.length = 0

      await messagePersister.markSessionInterrupted(AGENT_SLUG, SESSION_ID, { processKept: true, turnGenerationBefore })

      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
      expect(sseEvents.some((e) => e.type === 'session_idle' || e.type === 'session_waiting_background')).toBe(false)
      lateDelta('the task finished')
      expect(sseEvents.some((e) => e.type === 'stream_delta')).toBe(true)
    })

    it('leaves a wake turn alone when the stop was a no-op between turns', async () => {
      // Parked on background work: the container has no turn to stop and
      // answers at once, but a task can still settle and wake the agent
      // before that answer is acted on. No result is involved at all.
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      runtime('running')
      startBackgroundTask('bg-1')
      mockClient._sendMessage({ type: 'result', subtype: 'success', is_error: false })
      runtime('idle')
      const turnGenerationBefore = messagePersister.getTurnGeneration(AGENT_SLUG, SESSION_ID)

      mockClient._sendMessage({ type: 'system', subtype: 'task_updated', task_id: 'bg-1', patch: { status: 'completed' } })
      runtime('running')
      sseEvents.length = 0

      await messagePersister.markSessionInterrupted(AGENT_SLUG, SESSION_ID, { processKept: true, turnGenerationBefore })

      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
      expect(sseEvents.some((e) => e.type === 'session_idle' || e.type === 'session_waiting_background')).toBe(false)
      lateDelta('the task finished')
      expect(sseEvents.some((e) => e.type === 'stream_delta')).toBe(true)
    })

    it('settles the stopped turn when the stop returns before its idle frame', async () => {
      // The aborted result is in, the idle that follows it is not yet: the
      // runtime still reads running, but no new turn has started.
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      runtime('running')
      const turnGenerationBefore = messagePersister.getTurnGeneration(AGENT_SLUG, SESSION_ID)
      abortedResult()
      sseEvents.length = 0

      await messagePersister.markSessionInterrupted(AGENT_SLUG, SESSION_ID, { processKept: true, turnGenerationBefore })

      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
      expect(sseEvents.filter((e) => e.type === 'session_idle')).toHaveLength(1)
    })

    it('does not mistake the stopped turn’s own late running frame for a new turn', async () => {
      // Stop pressed in the send → running window: the turn being stopped
      // announces itself only after the generation was read.
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      const turnGenerationBefore = messagePersister.getTurnGeneration(AGENT_SLUG, SESSION_ID)
      runtime('running')
      abortedResult()
      runtime('idle')
      sseEvents.length = 0

      await messagePersister.markSessionInterrupted(AGENT_SLUG, SESSION_ID, { processKept: true, turnGenerationBefore })

      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
      expect(sseEvents.filter((e) => e.type === 'session_idle')).toHaveLength(1)
    })

    it('still clears the stopped turn when the runtime has not moved on', async () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      startBackgroundTask('bg-1')
      runtime('running')
      const turnGenerationBefore = messagePersister.getTurnGeneration(AGENT_SLUG, SESSION_ID)
      sseEvents.length = 0

      await messagePersister.markSessionInterrupted(AGENT_SLUG, SESSION_ID, { processKept: true, turnGenerationBefore })

      expect(sseEvents.filter((e) => e.type === 'session_waiting_background')).toHaveLength(1)
      lateDelta('late words')
      expect(sseEvents.some((e) => e.type === 'stream_delta')).toBe(false)
    })

    it('lets a spared background subagent raise an input request after the stop', async () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      for (const toolId of ['task-fg', 'task-bg']) {
        mockClient._sendMessage({
          type: 'stream_event',
          event: { type: 'content_block_start', content_block: { type: 'tool_use', id: toolId, name: 'Agent' } },
        })
        mockClient._sendMessage({ type: 'stream_event', event: { type: 'content_block_stop' } })
      }
      mockClient._sendMessage({
        type: 'user',
        tool_use_result: { status: 'async_launched', agentId: 'agent-bg' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'task-bg', content: 'Launched' }] },
      })
      await messagePersister.markSessionInterrupted(AGENT_SLUG, SESSION_ID, { processKept: true })
      sseEvents.length = 0

      const browserInputFrom = (parentToolId: string, toolId: string) =>
        mockClient._sendMessage({
          type: 'assistant',
          parent_tool_use_id: parentToolId,
          message: {
            content: [{
              type: 'tool_use',
              id: toolId,
              name: 'mcp__user-input__request_browser_input',
              input: { message: 'Log in to GitHub.', requirements: [] },
            }],
          },
        })

      // The foreground subagent died with the turn: its late frame is stale.
      browserInputFrom('task-fg', 'sub-fg-1')
      expect(requestCards('browser_input')).toHaveLength(0)
      expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(false)

      // The background one is still running and now needs the user.
      browserInputFrom('task-bg', 'sub-bg-1')
      const cards = requestCards('browser_input')
      expect(cards).toHaveLength(1)
      expect(cards[0].request.id).toBe('sub-bg-1')
      expect(messagePersister.isSessionAwaitingInput(AGENT_SLUG, SESSION_ID)).toBe(true)
    })

    it('tells a late-joining client whether the turn output ended or is still running alongside a task', async () => {
      // A task launched mid-turn does not make the session "waiting on
      // background work": the turn is still streaming. Only the turn's end
      // does, and the next turn (a send or a wake) undoes it.
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      startBackgroundTask('bg-1')
      expect(messagePersister.isSessionWaitingBackground(AGENT_SLUG, SESSION_ID)).toBe(false)

      mockClient._sendMessage({ type: 'result', subtype: 'success', is_error: false })
      expect(messagePersister.isSessionWaitingBackground(AGENT_SLUG, SESSION_ID)).toBe(true)

      runtime('running')
      expect(messagePersister.isSessionWaitingBackground(AGENT_SLUG, SESSION_ID)).toBe(false)

      mockClient._sendMessage({ type: 'result', subtype: 'success', is_error: false })
      expect(messagePersister.isSessionWaitingBackground(AGENT_SLUG, SESSION_ID)).toBe(true)
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      expect(messagePersister.isSessionWaitingBackground(AGENT_SLUG, SESSION_ID)).toBe(false)

      // A soft stop that spares the task ends the turn the same way.
      await messagePersister.markSessionInterrupted(AGENT_SLUG, SESSION_ID, { processKept: true })
      expect(messagePersister.isSessionWaitingBackground(AGENT_SLUG, SESSION_ID)).toBe(true)
    })

    it('keeps a background subagent but drops the foreground one', async () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      for (const toolId of ['task-fg', 'task-bg']) {
        mockClient._sendMessage({
          type: 'stream_event',
          event: { type: 'content_block_start', content_block: { type: 'tool_use', id: toolId, name: 'Agent' } },
        })
        mockClient._sendMessage({ type: 'stream_event', event: { type: 'content_block_stop' } })
      }
      // The background launch acknowledges immediately; the foreground one is
      // still running its blocking call.
      mockClient._sendMessage({
        type: 'user',
        tool_use_result: { status: 'async_launched', agentId: 'agent-bg' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'task-bg', content: 'Launched' }] },
      })
      expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID)).toMatchObject([{ taskId: 'agent-bg', isSubagent: true }])

      await messagePersister.markSessionInterrupted(AGENT_SLUG, SESSION_ID, { processKept: true })
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'running' })
      sseEvents.length = 0

      // The foreground subagent died with the turn: its late result is not a completion.
      mockClient._sendMessage({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'task-fg', content: 'done' }] },
      })
      expect(sseEvents.filter((e) => e.type === 'subagent_completed')).toHaveLength(0)

      // The background subagent is still tracked and settles through its task signal.
      mockClient._sendMessage({ type: 'system', subtype: 'task_updated', task_id: 'agent-bg', patch: { status: 'stopped' } })
      expect(sseEvents.filter((e) => e.type === 'subagent_completed')).toHaveLength(1)
      expect(sseEvents.filter((e) => e.type === 'background_task_completed' && e.taskId === 'agent-bg')).toHaveLength(1)
    })
  })

  // ============================================================================
  // Background Bash task tracking
  // ============================================================================

  describe('background Bash task tracking', () => {
    it('detects backgroundTaskId from tool_use_result and broadcasts start event', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
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
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)

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
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
    })

    it('broadcasts session_waiting_background instead of session_idle when bg tasks pending', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)

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
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)

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
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)

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

      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
      expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(1)
    })

    it('clears background task on task_updated completed (busy-completion path) and goes idle', () => {
      // Regression: when a backgrounded task settles while the agent is still busy
      // (a foreground tool was in flight), the SDK delivers the completion as a
      // `task_updated` patch rather than a matching `task_notification`. The persister
      // must clear it from that signal or the session stays pinned in
      // session_waiting_background forever. See background-bash-busy-completion fixture.
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)

      mockClient._sendMessage({
        type: 'user',
        tool_use_result: { backgroundTaskId: 'bg-busy' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
      })

      // Agent turn ends with the bg task still pending → stays active.
      mockClient._sendMessage({ type: 'result', subtype: 'success' })
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)

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
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
      expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(1)
      expect(sseEvents.filter(e => e.type === 'session_waiting_background')).toHaveLength(0)
    })

    it('ignores task_updated for non-terminal status or untracked task', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
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
      expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID).map(t => t.taskId)).toContain('bg-x')
    })

    it('session_state_changed idle keeps a still-running bg task tracked (no premature phantom-clear)', () => {
      // Regression (ac23bdd8): a backgrounded Bash command (task_type=local_bash) is
      // still running at turn-end. The SDK fires session_state_changed:idle at turn-end
      // ANYWAY — it re-fires 'running' + a terminal task signal when the command
      // actually finishes. The idle handler must NOT treat the still-running task as a
      // phantom: clearing it + finalizing here drops the indicator and un-gates
      // auto-sleep mid-job (the exact failure run_in_background prevents). It must keep
      // the task tracked, keep the session active, and surface waiting-on-background.
      // activeBackgroundTasks only ever holds local_bash tasks, and those always get a
      // later terminal signal — so the old "missed signal → phantom" premise never
      // holds. See the background-bash-premature-idle replay fixture (real capture).
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      mockClient._sendMessage({
        type: 'user',
        tool_use_result: { backgroundTaskId: 'bg-running' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
      })
      // Turn ends with the task still tracked → session stays active (waiting).
      mockClient._sendMessage({ type: 'result', subtype: 'success' })
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)

      sseEvents.length = 0

      // Turn-end idle arrives WHILE the bash is still running.
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })

      // Not cleared, not finalized — surfaced as waiting-on-background instead.
      expect(sseEvents.filter(e => e.type === 'background_task_completed')).toHaveLength(0)
      expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID).map(t => t.taskId)).toContain('bg-running')
      expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(0)
      expect(sseEvents.filter(e => e.type === 'session_waiting_background')).toHaveLength(1)
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)

      // The real terminal signal (task_updated{completed}) then clears it...
      sseEvents.length = 0
      mockClient._sendMessage({
        type: 'system', subtype: 'task_updated', task_id: 'bg-running', patch: { status: 'completed' },
      })
      expect(sseEvents.filter(e => e.type === 'background_task_completed').map(e => e.taskId)).toContain('bg-running')
      expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID)).toHaveLength(0)

      // ...and the subsequent, truly-settled idle finalizes the session.
      sseEvents.length = 0
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
      expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(1)
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
    })

    it('backstop: session_state_changed idle is a no-op with no pending tasks (no spurious idle)', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      sseEvents.length = 0
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
      expect(sseEvents.filter(e => e.type === 'background_task_completed')).toHaveLength(0)
      expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(0)
    })

    it('sends the whole live list with every frame that changes it', () => {
      // Clients replace their copy with it, so a frame one of them missed
      // cannot leave a stale row (or Stop-dialog entry) behind.
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      sseEvents.length = 0
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
      mockClient._sendMessage({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'bg-1' }, { task_id: 'bg-2', task_type: 'local_bash', description: 'Watch the build' }],
      })
      mockClient._sendMessage({ type: 'result', subtype: 'success' })
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
      mockClient._sendMessage({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg-2' }] })

      const ids = (e: Record<string, unknown>) => (e.backgroundTasks as Array<{ taskId: string }>).map(t => t.taskId)
      const listFrames = sseEvents.filter(e =>
        ['background_task_started', 'background_task_updated', 'background_task_completed', 'session_waiting_background'].includes(e.type as string))
      expect(listFrames.map(e => [e.type, ids(e)])).toEqual([
        ['background_task_started', ['bg-1']],
        ['background_task_started', ['bg-1', 'bg-2']],
        ['background_task_updated', ['bg-1', 'bg-2']],
        // Once when the turn's output ends, again when the runtime reports idle.
        ['session_waiting_background', ['bg-1', 'bg-2']],
        ['session_waiting_background', ['bg-1', 'bg-2']],
        ['background_task_completed', ['bg-2']],
      ])
      expect(listFrames[2].backgroundTasks).toEqual([
        expect.objectContaining({ taskId: 'bg-1' }),
        expect.objectContaining({ taskId: 'bg-2', taskType: 'local_bash', description: 'Watch the build' }),
      ])
    })

    it('backstop: session_state_changed running does not clear pending tasks', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      mockClient._sendMessage({
        type: 'user',
        tool_use_result: { backgroundTaskId: 'bg-keep' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
      })
      sseEvents.length = 0
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'running' })
      expect(sseEvents.filter(e => e.type === 'background_task_completed')).toHaveLength(0)
      expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID).map(t => t.taskId)).toContain('bg-keep')
    })

    it('background_tasks_changed self-heals a task whose terminal signal never arrives', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      mockClient._sendMessage({
        type: 'user',
        tool_use_result: { backgroundTaskId: 'bg-lost' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
      })
      mockClient._sendMessage({ type: 'result', subtype: 'success' })
      sseEvents.length = 0

      // The SDK's snapshot no longer lists the task — it finished, but the
      // per-task terminal signal is (in this scenario) lost. Without the
      // snapshot the task would pin the session in waiting-background forever.
      mockClient._sendMessage({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
      expect(sseEvents.filter(e => e.type === 'background_task_completed').map(e => e.taskId)).toEqual(['bg-lost'])
      expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID)).toHaveLength(0)

      // A late terminal signal for the already-cleared task no-ops.
      sseEvents.length = 0
      mockClient._sendMessage({
        type: 'system', subtype: 'task_updated', task_id: 'bg-lost', patch: { status: 'completed' },
      })
      expect(sseEvents.filter(e => e.type === 'background_task_completed')).toHaveLength(0)

      // The settled idle now finalizes.
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
      expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(1)
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
    })

    it('background_tasks_changed announcing an unregistered task blocks idle (union gate)', () => {
      // The snapshot LEADS per-task signals: it can announce a task before the
      // registration metadata (task_started / tool-result) arrives. An idle in
      // that window must not finalize even though the incremental map is empty.
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      // Mid-turn: the SDK announces the task (registration metadata not seen).
      mockClient._sendMessage({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'bg-early', task_type: 'local_bash', description: 'Sleep' }],
      })
      mockClient._sendMessage({ type: 'result', subtype: 'success' })
      sseEvents.length = 0

      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
      expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(0)
      const waiting = sseEvents.filter(e => e.type === 'session_waiting_background')
      expect(waiting).toHaveLength(1)
      expect(waiting[0].backgroundTaskCount).toBe(1)
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)

      // The task finishes: empty snapshot, then the settled idle finalizes.
      sseEvents.length = 0
      mockClient._sendMessage({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
      expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(1)
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
    })

    // ------------------------------------------------------------------
    // Work no launch signal of ours registered. A background Bash command a
    // SUBAGENT launches returns its tool result on the sidechain, which
    // registers nothing — only the runtime's snapshot lists it. Seen in prod
    // (2026-09-09): a subagent started a local asset server that never
    // exited, and the session sat in waiting-background with an empty task
    // list and nothing to stop. The snapshot now registers every task it
    // lists, so the row, the Stop dialog entry and the per-task stop exist.
    describe('snapshot-only background work (subagent-launched tasks)', () => {
      // The runtime's snapshot is the full live set, so a launch alongside
      // other open work lists every id (the self-heal retires what it omits).
      function launchFromSubagent(taskId: string, liveTaskIds: string[] = [taskId]) {
        mockClient._sendMessage({
          type: 'user',
          parent_tool_use_id: 'agent-tool-1',
          tool_use_result: { backgroundTaskId: taskId },
          message: { content: [{ type: 'tool_result', tool_use_id: `sub-tool-${taskId}`, content: 'Running' }] },
        })
        mockClient._sendMessage({
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: liveTaskIds.map((id) => ({ task_id: id, task_type: 'local_bash', description: 'Serve local assets' })),
        })
      }

      it('lists the task, labelled from the snapshot, while the session waits on it', () => {
        messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
        sseEvents.length = 0
        launchFromSubagent('nested-1')
        expect(sseEvents.filter(e => e.type === 'background_task_started')).toEqual([
          expect.objectContaining({ taskId: 'nested-1', taskType: 'local_bash', description: 'Serve local assets' }),
        ])

        // The subagent finishes; the lead's turn ends; the runtime reports idle.
        mockClient._sendMessage({ type: 'result', subtype: 'success' })
        sseEvents.length = 0
        mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })

        expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(0)
        expect(sseEvents.filter(e => e.type === 'session_waiting_background')).toHaveLength(1)
        expect(messagePersister.isSessionWaitingBackground(AGENT_SLUG, SESSION_ID)).toBe(true)
        // What the UI (and the connected snapshot) get: the task, by name.
        expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID)).toEqual([
          expect.objectContaining({ taskId: 'nested-1', taskType: 'local_bash', description: 'Serve local assets' }),
        ])
        expect(messagePersister.hasOnlyUntrackedBackgroundWork(AGENT_SLUG, SESSION_ID)).toBe(false)
      })

      it('lists it alongside a task the lead launched', () => {
        messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
        mockClient._sendMessage({
          type: 'user',
          tool_use_result: { backgroundTaskId: 'bg-main' },
          message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
        })
        launchFromSubagent('nested-1', ['bg-main', 'nested-1'])

        expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID).map(t => t.taskId)).toEqual(['bg-main', 'nested-1'])
      })

      it('merges the snapshot into a task a launch signal registered first, without a second start', () => {
        messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
        sseEvents.length = 0
        mockClient._sendMessage({
          type: 'user',
          tool_use_result: { backgroundTaskId: 'bg-main' },
          message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
        })
        mockClient._sendMessage({
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: [{ task_id: 'bg-main', task_type: 'local_bash', description: 'Run the dev server' }],
        })
        // A repeat of the same level changes nothing and says nothing.
        mockClient._sendMessage({
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: [{ task_id: 'bg-main', task_type: 'local_bash', description: 'Run the dev server' }],
        })

        expect(sseEvents.filter(e => e.type === 'background_task_started').map(e => e.taskId)).toEqual(['bg-main'])
        expect(sseEvents.filter(e => e.type === 'background_task_updated')).toEqual([
          expect.objectContaining({ taskId: 'bg-main', taskType: 'local_bash', description: 'Run the dev server' }),
        ])
        expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID)).toEqual([
          expect.objectContaining({ taskId: 'bg-main', description: 'Run the dev server' }),
        ])
      })

      it('keeps ambient tasks out of the client list, including when the flag flips', () => {
        // SDK >= 0.3.284 marks housekeeping tasks and live-update watchers
        // `ambient`: "hosts should exclude them from activity indicators".
        const level = (tasks: Array<{ task_id: string; ambient?: boolean }>) => mockClient._sendMessage({
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: tasks.map((t) => ({ task_type: 'local_bash', description: `Task ${t.task_id}`, ...t })),
        })
        const shown = () => messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID).map(t => t.taskId)
        const frames = () => sseEvents
          .filter(e => typeof e.type === 'string' && e.type.startsWith('background_task_'))
          .map(e => [e.type, e.taskId])

        messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
        sseEvents.length = 0
        level([{ task_id: 'watcher', ambient: true }, { task_id: 'server' }])
        expect(shown()).toEqual(['server'])
        expect(frames()).toEqual([['background_task_started', 'server']])

        expect(messagePersister.hasOnlyUntrackedBackgroundWork(AGENT_SLUG, SESSION_ID)).toBe(false)

        // Still live work: the session waits on it rather than settling —
        // and with nothing left to show, a stop must escalate to reach it.
        mockClient._sendMessage({ type: 'result', subtype: 'success' })
        level([{ task_id: 'watcher', ambient: true }])
        mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
        expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
        expect(messagePersister.hasOnlyUntrackedBackgroundWork(AGENT_SLUG, SESSION_ID)).toBe(true)

        // Flips: to activity (the flag may simply be absent) and back.
        sseEvents.length = 0
        level([{ task_id: 'watcher' }])
        expect(shown()).toEqual(['watcher'])
        level([{ task_id: 'watcher', ambient: true }])
        expect(shown()).toEqual([])
        // Its end is not news to clients once it is ambient again.
        level([])
        expect(frames()).toEqual([
          ['background_task_started', 'watcher'],
          ['background_task_completed', 'watcher'],
        ])
      })

      it('clears once the task is stopped', () => {
        messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
        launchFromSubagent('nested-1')
        mockClient._sendMessage({ type: 'result', subtype: 'success' })
        mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })

        // The per-task stop route's answer retires the id from both sides.
        sseEvents.length = 0
        mockClient._sendMessage({
          type: 'system', subtype: 'task_notification', task_id: 'nested-1', tool_use_id: 'sub-tool-nested-1', status: 'stopped',
        })
        expect(sseEvents.filter(e => e.type === 'background_task_completed').map(e => e.taskId)).toEqual(['nested-1'])
        expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID)).toEqual([])
      })

      it('a full stop settles the session', async () => {
        // markSessionInterrupted with processKept false is what a scope 'all'
        // stop produces: the snapshot is dropped and the session goes idle.
        messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
        launchFromSubagent('nested-1')
        mockClient._sendMessage({ type: 'result', subtype: 'success' })
        mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })

        // The turn-scoped stop (process kept) spares the task...
        sseEvents.length = 0
        await messagePersister.markSessionInterrupted(AGENT_SLUG, SESSION_ID, { processKept: true })
        expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
        expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(0)

        // ...and the full stop settles it.
        sseEvents.length = 0
        await messagePersister.markSessionInterrupted(AGENT_SLUG, SESSION_ID, { processKept: false })
        expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
        expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(1)
      })
    })

    // ------------------------------------------------------------------
    // The level set must drain from BOTH directions. `background_tasks_changed`
    // is a level signal the SDK only re-emits on a membership CHANGE, and it
    // emits nothing at all when a fresh CLI process starts. So any id that
    // enters the snapshot and never leaves it pins the session in
    // waiting-background forever: every later session_state_changed:'idle'
    // takes the waiting branch instead of finalizing, and nothing — not a
    // terminal per-task signal, not Stop, not a re-subscribe — ever clears it.
    // These cover the three ways prod sessions got stuck that way.
    // ------------------------------------------------------------------

    // A background subagent as the wire delivers it: the SDK announces the
    // task (level + task_started), then the Agent tool's async-launch ack.
    function launchBackgroundAgent(agentId: string) {
      mockClient._sendMessage({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: agentId, task_type: 'local_agent', description: 'Verify policies' }],
      })
      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_started',
        task_id: agentId,
        tool_use_id: `tool-${agentId}`,
        task_type: 'local_agent',
        description: 'Verify policies',
      })
      mockClient._sendMessage({
        type: 'user',
        tool_use_result: { status: 'async_launched', isAsync: true, agentId },
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: `tool-${agentId}`,
            content: 'Async agent launched successfully.',
          }],
        },
      })
    }

    it('a failed task drains the snapshot when the removal frame never arrives', () => {
      // Mirror image of the self-heal test above: there the per-task terminal
      // signal was lost and the snapshot rescued the session; here the snapshot's
      // removal frame is the one that never comes. A task that ended outright
      // (stopped, failed, killed) retires from both sides on its own signal.
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      launchBackgroundAgent('agent-bg-1')
      expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID).map(t => t.taskId)).toEqual(['agent-bg-1'])

      // Turn ends while it runs → waiting, as designed.
      mockClient._sendMessage({ type: 'result', subtype: 'success' })
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)

      sseEvents.length = 0

      // The subagent fails. Its terminal signal arrives; the removal snapshot does not.
      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'agent-bg-1',
        tool_use_id: 'tool-agent-bg-1',
        status: 'failed',
        summary: 'Agent failed',
      })
      expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID)).toHaveLength(0)

      // The wake turn's result + idle must now finalize the session.
      mockClient._sendMessage({ type: 'result', subtype: 'success' })
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })

      expect(sseEvents.filter(e => e.type === 'session_waiting_background')).toHaveLength(0)
      expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(1)
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
    })

    it('a completed subagent the SDK still lists stays a tracked task until the snapshot drops it', () => {
      // Seen in prod (2026-09-29): a background subagent notified `completed`
      // ("stopped with background work of its own still running") while the
      // dev servers it started kept it a live task — the SDK kept listing it
      // and stop_task still found it. Retiring it on the notification removed
      // it from the rows and the Stop dialog while the snapshot kept the
      // session pinned "working" on nothing anyone could see.
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      launchBackgroundAgent('agent-bg-1')
      mockClient._sendMessage({ type: 'result', subtype: 'success' })
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })

      sseEvents.length = 0
      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'agent-bg-1',
        tool_use_id: 'tool-agent-bg-1',
        status: 'completed',
        summary: 'Agent finished; its dev server is still running',
      })

      // Its own turn is done — the subagent row completes — but the task stays
      // open, so the Stop dialog can still name it.
      expect(sseEvents.filter(e => e.type === 'subagent_completed')).toHaveLength(1)
      expect(sseEvents.filter(e => e.type === 'background_task_completed')).toHaveLength(0)
      expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID).map(t => t.taskId)).toEqual(['agent-bg-1'])
      expect(messagePersister.hasOnlyUntrackedBackgroundWork(AGENT_SLUG, SESSION_ID)).toBe(false)

      // The wake turn ends with the task still live: still waiting.
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'running' })
      mockClient._sendMessage({ type: 'result', subtype: 'success' })
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
      expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(0)
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)

      // The SDK drops it when its background work ends; the session settles.
      sseEvents.length = 0
      mockClient._sendMessage({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
      expect(sseEvents.filter(e => e.type === 'background_task_completed').map(e => e.taskId)).toEqual(['agent-bg-1'])
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'running' })
      mockClient._sendMessage({ type: 'result', subtype: 'success' })
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
      expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(1)
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
    })

    it('a completed task the SDK no longer lists retires on its notification', () => {
      // The normal order: the snapshot drops the task, then the notification lands.
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      launchBackgroundAgent('agent-bg-1')
      mockClient._sendMessage({ type: 'result', subtype: 'success' })
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })

      mockClient._sendMessage({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
      sseEvents.length = 0
      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'agent-bg-1',
        tool_use_id: 'tool-agent-bg-1',
        status: 'completed',
      })
      expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID)).toHaveLength(0)
      expect(messagePersister.hasOnlyUntrackedBackgroundWork(AGENT_SLUG, SESSION_ID)).toBe(false)
    })

    it('Stop drains the snapshot so later turns still settle', () => {
      // The user hits Stop while a background task is live. The process is
      // replaced, so no terminal signal or removal snapshot will EVER arrive for
      // that id. If Stop clears only the incremental map, every subsequent turn
      // in the session ends in waiting-background instead of idle — the session
      // reads "Working…" at the end of every turn, permanently.
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      mockClient._sendMessage({
        type: 'user',
        tool_use_result: { backgroundTaskId: 'bg-download' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
      })
      mockClient._sendMessage({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'bg-download', task_type: 'local_bash', description: 'yt-dlp' }],
      })

      return messagePersister.markSessionInterrupted(AGENT_SLUG, SESSION_ID).then(() => {
        expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID)).toHaveLength(0)

        // A brand-new turn, with no background work at all.
        messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
        sseEvents.length = 0
        mockClient._sendMessage({ type: 'result', subtype: 'success' })
        mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })

        expect(sseEvents.filter(e => e.type === 'session_waiting_background')).toHaveLength(0)
        expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(1)
        expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
      })
    })

    it('process_restarted drops the snapshot from the dead process', () => {
      // The level set is per-process and a fresh CLI emits nothing at startup,
      // so ids from the previous process can never be retired by the SDK. The
      // container announces the replacement (idle eviction + --resume, crash,
      // MCP-injection restart) and the host must reset to the empty set.
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      mockClient._sendMessage({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'bg-doomed', task_type: 'local_bash', description: 'Sleep' }],
      })
      mockClient._sendMessage({ type: 'result', subtype: 'success' })
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)

      // The CLI process is replaced; its background tasks died with it.
      mockClient._sendMessage({ type: 'system', subtype: 'process_restarted' })

      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      sseEvents.length = 0
      mockClient._sendMessage({ type: 'result', subtype: 'success' })
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })

      expect(sseEvents.filter(e => e.type === 'session_waiting_background')).toHaveLength(0)
      expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(1)
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
    })

    it('a capabilities handshake naming a new process instance drops the stale snapshot', () => {
      // The cold-resume path: the CLI is replaced while nothing is attached
      // (idle eviction + --resume, container restart), so the live
      // process_restarted broadcast reaches nobody — it fires before the
      // session is published and before the socket subscribes. The host state
      // survives that reconnect, so the handshake has to carry the process
      // identity and the host has to notice it changed.
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      mockClient._sendMessage({
        type: 'system', subtype: 'capabilities', session_state_events: true, process_instance: 'proc-1',
      })
      mockClient._sendMessage({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'bg-orphan', task_type: 'local_bash', description: 'Sleep' }],
      })
      mockClient._sendMessage({ type: 'result', subtype: 'success' })
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)

      // Reconnect after the process was replaced behind our back.
      mockClient._sendMessage({
        type: 'system', subtype: 'capabilities', session_state_events: true, process_instance: 'proc-2',
      })

      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      sseEvents.length = 0
      mockClient._sendMessage({ type: 'result', subtype: 'success' })
      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })

      expect(sseEvents.filter(e => e.type === 'session_waiting_background')).toHaveLength(0)
      expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(1)
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
    })

    it('a reattach to the SAME process instance keeps running tasks tracked', () => {
      // The other direction, and the reason this keys on identity rather than
      // "saw a handshake": an SSE/WebSocket reattach mid-job is the same live
      // CLI with the same tasks still running. Resetting there would drop the
      // indicator and un-gate auto-sleep on real work.
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      mockClient._sendMessage({
        type: 'system', subtype: 'capabilities', session_state_events: true, process_instance: 'proc-1',
      })
      mockClient._sendMessage({
        type: 'user',
        tool_use_result: { backgroundTaskId: 'bg-live' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
      })
      mockClient._sendMessage({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'bg-live', task_type: 'local_bash', description: 'yt-dlp' }],
      })
      mockClient._sendMessage({ type: 'result', subtype: 'success' })

      sseEvents.length = 0
      // Transport reattach: same process, same handshake identity.
      mockClient._sendMessage({
        type: 'system', subtype: 'capabilities', session_state_events: true, process_instance: 'proc-1',
      })

      expect(sseEvents.filter(e => e.type === 'background_task_completed')).toHaveLength(0)
      expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID).map(t => t.taskId)).toContain('bg-live')

      mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
      expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(0)
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
    })

    it('keeps process identity in sync across an interrupt-driven restart', () => {
      // The interrupt path restarts the query (claude-code.ts "Restarting query
      // after interrupt"), which mints a new process instance. But the host
      // drops every non-result frame while isInterrupted is set, so that
      // announcement was being swallowed — leaving the recorded identity one
      // process behind the container. The NEXT reattach then reads a changed
      // name and mistakes it for a restart, dropping background tasks that are
      // genuinely running: a live indicator lost and auto-sleep un-gated
      // mid-job, the exact failure the union gate exists to prevent.
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      mockClient._sendMessage({
        type: 'system', subtype: 'capabilities', session_state_events: true, process_instance: 'proc-A',
      })

      return messagePersister.markSessionInterrupted(AGENT_SLUG, SESSION_ID).then(() => {
        // The container restarts the CLI in response, while we're still flagged
        // interrupted.
        mockClient._sendMessage({
          type: 'system', subtype: 'process_restarted', process_instance: 'proc-B',
        })

        // New turn on the new process, with real background work.
        messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
        mockClient._sendMessage({
          type: 'user',
          tool_use_result: { backgroundTaskId: 'bg-live' },
          message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
        })
        mockClient._sendMessage({
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: [{ task_id: 'bg-live', task_type: 'local_bash', description: 'yt-dlp' }],
        })
        mockClient._sendMessage({ type: 'result', subtype: 'success' })

        sseEvents.length = 0
        // A transport reattach. Same process as the one running bg-live, so
        // nothing may be dropped.
        mockClient._sendMessage({
          type: 'system', subtype: 'capabilities', session_state_events: true, process_instance: 'proc-B',
        })

        expect(sseEvents.filter(e => e.type === 'background_task_completed')).toHaveLength(0)
        expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID).map(t => t.taskId)).toContain('bg-live')

        mockClient._sendMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
        expect(sseEvents.filter(e => e.type === 'session_idle')).toHaveLength(0)
        expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
      })
    })

    it('forwards command_lifecycle frames to SSE and drops malformed ones', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      sseEvents.length = 0

      mockClient._sendMessage({ type: 'command_lifecycle', command_uuid: 'u1', state: 'queued' })
      mockClient._sendMessage({ type: 'command_lifecycle', command_uuid: 'u1', state: 'discarded' })
      // Unknown future states must flow through, not be filtered here.
      mockClient._sendMessage({ type: 'command_lifecycle', command_uuid: 'u2', state: 'some_future_state' })
      // No uuid → nothing downstream can act; dropped.
      mockClient._sendMessage({ type: 'command_lifecycle', state: 'discarded' })

      const forwarded = sseEvents.filter(e => e.type === 'command_lifecycle')
      expect(forwarded).toEqual([
        { type: 'command_lifecycle', commandUuid: 'u1', state: 'queued' },
        { type: 'command_lifecycle', commandUuid: 'u1', state: 'discarded' },
        { type: 'command_lifecycle', commandUuid: 'u2', state: 'some_future_state' },
      ])
    })

    it('ignores a malformed background_tasks_changed frame instead of clearing running tasks', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      mockClient._sendMessage({
        type: 'user',
        tool_use_result: { backgroundTaskId: 'bg-safe' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
      })
      sseEvents.length = 0

      // tasks is not an array / an element is missing task_id — acting on a
      // partial parse could clear a still-running task, so the frame must be
      // ignored outright.
      mockClient._sendMessage({ type: 'system', subtype: 'background_tasks_changed', tasks: 'garbage' })
      mockClient._sendMessage({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ nope: true }] })

      expect(sseEvents.filter(e => e.type === 'background_task_completed')).toHaveLength(0)
      expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID).map(t => t.taskId)).toContain('bg-safe')
    })

    it('tracks multiple concurrent background tasks', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)

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

      expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID)).toHaveLength(2)

      // Complete first task via system message
      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_completed',
        task_id: 'bg-1',
        status: 'completed',
      })

      expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID)).toHaveLength(1)
      expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID)[0].taskId).toBe('bg-2')
    })

    it('clears background tasks on session interrupt', async () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)

      mockClient._sendMessage({
        type: 'user',
        tool_use_result: { backgroundTaskId: 'bg-1' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
      })

      expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID)).toHaveLength(1)

      await messagePersister.markSessionInterrupted(AGENT_SLUG, SESSION_ID)

      expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID)).toHaveLength(0)
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
    })

    it('does not duplicate background task on repeated tool_use_result', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)

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

      expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID)).toHaveLength(1)
    })

    it('preserves background tasks across re-subscribe', async () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)

      mockClient._sendMessage({
        type: 'user',
        tool_use_result: { backgroundTaskId: 'bg-persist' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
      })

      expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID)).toHaveLength(1)

      // Re-subscribe (simulates reconnection)
      const newClient = createMockClient()
      await messagePersister.subscribeToSession(AGENT_SLUG, SESSION_ID, newClient, SESSION_ID)

      expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID)).toHaveLength(1)
      expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)

      // Clean up the new subscription
      messagePersister.unsubscribeFromSession(AGENT_SLUG, SESSION_ID)
    })

    it('returns empty array for unknown session', () => {
      expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, 'nonexistent')).toEqual([])
    })

    it('ignores system messages with task_id that do not match active bg tasks', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)

      mockClient._sendMessage({
        type: 'user',
        tool_use_result: { backgroundTaskId: 'bg-real' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
      })

      expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID)).toHaveLength(1)

      // System message with non-matching task_id
      mockClient._sendMessage({
        type: 'system',
        subtype: 'task_completed',
        task_id: 'bg-nonexistent',
        status: 'completed',
      })

      // Should NOT have cleared our task
      expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID)).toHaveLength(1)
    })

    it('also detects snake_case background_task_id', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      sseEvents.length = 0

      mockClient._sendMessage({
        type: 'user',
        tool_use_result: { background_task_id: 'snake-1' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Running' }] },
      })

      expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID)).toHaveLength(1)
      expect(messagePersister.getActiveBackgroundTasks(AGENT_SLUG, SESSION_ID)[0].taskId).toBe('snake-1')
    })
  })

  // ============================================================================
  // session_activity emission
  // ============================================================================

  describe('activity projection (pull)', () => {
    // The persister no longer pushes session_activity (deleted with the push
    // machinery in the pull-projection refactor); getSessionActivity is the sole
    // source of truth and must never broadcast a session_activity SSE event.
    it('does not broadcast session_activity on markSessionActive', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
      expect(sseEvents.filter((e) => e.type === 'session_activity')).toHaveLength(0)
      expect(messagePersister.getSessionActivity(AGENT_SLUG, SESSION_ID)).toBe('working')
    })

    // Iddo (review): message_start must NOT optimistically project 'streaming' before
    // the first content block's type is known. A message that opens directly with a
    // tool call (no preamble text) would otherwise flip streaming→working here, and
    // reconcileIndicator turns that non-busy→busy flip into stopWorking()+startWorking()
    // — Slack removes+re-adds its reaction and iMessage blinks the typing bubble, once
    // per tool-first assistant message in an agentic turn. 'streaming' is deferred to the
    // first text token instead.
    it('keeps a tool-first message on "working" without flipping through "streaming"', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID) // active → 'working'

      mockClient._sendMessage({ type: 'stream_event', event: { type: 'message_start' } })
      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: 'Bash' } },
      })

      expect(messagePersister.getSessionActivity(AGENT_SLUG, SESSION_ID)).toBe('working')
    })

    it('projects "streaming" only when real text starts (first text_delta), not at message_start', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID) // active → 'working'
      mockClient._sendMessage({ type: 'stream_event', event: { type: 'message_start' } })
      // No content yet: the agent is honestly 'working', not optimistically 'streaming'.
      expect(messagePersister.getSessionActivity(AGENT_SLUG, SESSION_ID)).toBe('working')

      mockClient._sendMessage({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
      })
      // The first token yields the reply surface to the streamed text.
      expect(messagePersister.getSessionActivity(AGENT_SLUG, SESSION_ID)).toBe('streaming')
    })

    // Regression: a mid-stream error must NOT emit a spurious busy activity right
    // before settling. The terminal transition has to settle in a SINGLE non-busy
    // emit reflecting the final state — an intermediate "isActive still true,
    // streaming just cleared" snapshot would briefly read 'working' and race
    // connectors (Slack's async reaction add/remove) into a stuck indicator.
    it('broadcasts no session_activity and settles to idle on a mid-stream error result', () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID) // active → 'working'
      mockClient._sendMessage({ type: 'stream_event', event: { type: 'message_start' } })
      mockClient._sendMessage({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } }) // → 'streaming'

      mockClient._sendMessage({ type: 'result', subtype: 'error', error: 'boom' })

      expect(sseEvents.filter(e => e.type === 'session_activity')).toHaveLength(0)
      expect(messagePersister.getSessionActivity(AGENT_SLUG, SESSION_ID)).toBe('idle')
    })

    // Same invariant for the connection-closed → markSessionInactive terminal
    // path: finalizeIdle's single non-busy emit covers the settle; clearing
    // streaming/awaiting must not emit a busy activity first.
    it('broadcasts no session_activity and settles to idle when markSessionInactive finalizes a streaming session', async () => {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID) // active → 'working'
      mockClient._sendMessage({ type: 'stream_event', event: { type: 'message_start' } })
      mockClient._sendMessage({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } }) // → 'streaming'

      // Default mock getSession() resolves null → handleConnectionClosed marks inactive.
      mockClient._messageCallback!({
        type: 'connection_closed',
        content: { type: 'connection_closed' },
        timestamp: new Date(),
        sessionId: SESSION_ID,
      })
      // Let getSession().then(...) settle.
      await new Promise((r) => setTimeout(r, 0))

      expect(sseEvents.filter(e => e.type === 'session_activity')).toHaveLength(0)
      expect(messagePersister.getSessionActivity(AGENT_SLUG, SESSION_ID)).toBe('idle')
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
    messagePersister.unsubscribeFromSession(AGENT_SLUG, SESSION_ID)
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
      await messagePersister.subscribeToSession(AGENT_SLUG, SESSION_ID, client, SESSION_ID)
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)

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

// ============================================================================
// connection lost mid-turn → session_error (not a silent session_idle)
// ============================================================================
//
// When the runtime vanishes while a turn is in flight (container crash, guest
// OOM kill, VM death), the WebSocket closes and markSessionInactive settles the
// session. Settling with session_idle presents as the agent just stopping with
// no explanation — the terminal broadcast must be session_error instead.

describe('MessagePersister connection lost mid-turn', () => {
  const SESSION_ID = 'mid-turn-death-session'
  const AGENT_SLUG = 'mid-turn-death-agent'

  let mockClient: ReturnType<typeof createMockClient>
  let sseEvents: any[]
  let sseCleanup: () => void

  const dropConnection = async () => {
    mockClient._messageCallback!({
      type: 'connection_closed',
      content: { type: 'connection_closed' },
      timestamp: new Date(),
      sessionId: SESSION_ID,
    })
    // Let handleConnectionClosed's getSession().then(...) settle
    // (the default mock getSession resolves null → markSessionInactive).
    await new Promise((r) => setTimeout(r, 0))
  }

  beforeEach(async () => {
    mockClient = createMockClient()
    await messagePersister.subscribeToSession(AGENT_SLUG, SESSION_ID, mockClient, SESSION_ID)
    const sse = collectSSEEvents(AGENT_SLUG, SESSION_ID)
    sseEvents = sse.events
    sseCleanup = sse.cleanup
  })

  afterEach(() => {
    sseCleanup()
    messagePersister.unsubscribeFromSession(AGENT_SLUG, SESSION_ID)
    vi.clearAllMocks()
  })

  it('broadcasts session_error (not session_idle) when the connection drops mid-turn', async () => {
    messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
    sseEvents.length = 0

    await dropConnection()

    const errors = sseEvents.filter((e) => e.type === 'session_error')
    expect(errors).toHaveLength(1)
    expect(errors[0].error).toMatch(/stopped unexpectedly/i)
    expect(errors[0].error).toMatch(/out of memory/i)
    expect(errors[0].terminalReason).toBe('connection_lost')
    expect(errors[0].isActive).toBe(false)
    expect(sseEvents.filter((e) => e.type === 'session_idle')).toHaveLength(0)
    // The session still settles: no longer active, activity reads idle.
    expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
    expect(messagePersister.getSessionActivity(AGENT_SLUG, SESSION_ID)).toBe('idle')
  })

  it('also announces the mid-turn death on the global stream (sidebar/notifications)', async () => {
    const globalEvents: any[] = []
    const removeGlobal = globalFeed.subscribe((data) => {
      globalEvents.push(data)
    })
    try {
      messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)

      await dropConnection()

      const errors = globalEvents.filter((e) => e.type === 'session_error')
      expect(errors).toHaveLength(1)
      expect(errors[0].sessionId).toBe(SESSION_ID)
      expect(errors[0].agentSlug).toBe(AGENT_SLUG)
      expect(errors[0].terminalReason).toBe('connection_lost')
    } finally {
      removeGlobal()
    }
  })

  it('settles quietly with session_idle when the connection drops while idle', async () => {
    // No active turn — e.g. the container auto-slept between turns.
    sseEvents.length = 0

    await dropConnection()

    expect(sseEvents.filter((e) => e.type === 'session_error')).toHaveLength(0)
    expect(sseEvents.filter((e) => e.type === 'session_idle')).toHaveLength(1)
  })

  it('does not report an error when the connection drops after a user interrupt', async () => {
    messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
    await messagePersister.markSessionInterrupted(AGENT_SLUG, SESSION_ID)
    sseEvents.length = 0

    await dropConnection()

    expect(sseEvents.filter((e) => e.type === 'session_error')).toHaveLength(0)
  })
})

describe('MessagePersister mid-turn recovery snapshot', () => {
  const SESSION_ID = 'recover-session'
  const AGENT_SLUG = 'recover-agent'
  let mockClient: ReturnType<typeof createMockClient>

  beforeEach(async () => {
    mockClient = createMockClient()
    await messagePersister.subscribeToSession(AGENT_SLUG, SESSION_ID, mockClient, SESSION_ID)
  })

  afterEach(() => {
    messagePersister.unsubscribeFromSession(AGENT_SLUG, SESSION_ID)
    vi.clearAllMocks()
  })

  it('snapshots active sessions and skips session_error while they are recovering', () => {
    messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
    expect(messagePersister.snapshotMidTurnSessions(AGENT_SLUG)).toEqual([SESSION_ID])
    expect(messagePersister.isSessionRecovering(AGENT_SLUG, SESSION_ID)).toBe(true)
    expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)

    messagePersister.markAllSessionsInactiveForAgent(AGENT_SLUG)
    expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
    expect(messagePersister.isSessionRecovering(AGENT_SLUG, SESSION_ID)).toBe(true)
  })

  it('snapshots only the requested session ids', async () => {
    const otherId = 'recover-session-2'
    await messagePersister.subscribeToSession(AGENT_SLUG, otherId, mockClient, otherId)
    messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
    messagePersister.markSessionActive(AGENT_SLUG, otherId)

    expect(messagePersister.snapshotMidTurnSessions(AGENT_SLUG, [SESSION_ID])).toEqual([SESSION_ID])
    expect(messagePersister.isSessionRecovering(AGENT_SLUG, SESSION_ID)).toBe(true)
    expect(messagePersister.isSessionRecovering(AGENT_SLUG, otherId)).toBe(false)

    messagePersister.unsubscribeFromSession(AGENT_SLUG, otherId)
  })

  it('settles recovering sessions when the agent is stopped', () => {
    messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
    messagePersister.snapshotMidTurnSessions(AGENT_SLUG)
    messagePersister.markAllSessionsInactiveForAgent(AGENT_SLUG, { settleRecovering: true })
    expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
    expect(messagePersister.isSessionRecovering(AGENT_SLUG, SESSION_ID)).toBe(false)
  })

  it('does not snapshot idle or interrupted sessions', async () => {
    expect(messagePersister.snapshotMidTurnSessions(AGENT_SLUG)).toEqual([])
    messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
    await messagePersister.markSessionInterrupted(AGENT_SLUG, SESSION_ID)
    expect(messagePersister.snapshotMidTurnSessions(AGENT_SLUG)).toEqual([])
  })

  it('coalesces user text while recovering and keeps each message uuid', () => {
    messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
    messagePersister.snapshotMidTurnSessions(AGENT_SLUG)
    expect(messagePersister.coalesceIfRecovering(AGENT_SLUG, SESSION_ID, { uuid: 'u1', text: 'first' })).toBe(true)
    expect(messagePersister.coalesceIfRecovering(AGENT_SLUG, SESSION_ID, { uuid: 'u2', text: 'second' })).toBe(true)
    expect(messagePersister.takeCoalescedUserMessages(AGENT_SLUG, SESSION_ID)).toEqual([
      { uuid: 'u1', text: 'first' },
      { uuid: 'u2', text: 'second' },
    ])
    expect(messagePersister.coalesceIfRecovering(AGENT_SLUG, 'other', { uuid: 'u3', text: 'nope' })).toBe(false)
  })

  it('drops a coalesced user message by uuid', () => {
    messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
    messagePersister.snapshotMidTurnSessions(AGENT_SLUG)
    messagePersister.coalesceIfRecovering(AGENT_SLUG, SESSION_ID, { uuid: 'u1', text: 'first' })
    messagePersister.coalesceIfRecovering(AGENT_SLUG, SESSION_ID, { uuid: 'u2', text: 'second' })
    expect(messagePersister.dropCoalescedUserMessage(AGENT_SLUG, SESSION_ID, 'u1')).toBe(true)
    expect(messagePersister.takeCoalescedUserMessages(AGENT_SLUG, SESSION_ID)).toEqual([{ uuid: 'u2', text: 'second' }])
  })

  it('does not log coalesced message content when settling', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
    messagePersister.snapshotMidTurnSessions(AGENT_SLUG)
    messagePersister.coalesceIfRecovering(AGENT_SLUG, SESSION_ID, { uuid: 'u1', text: 'secret user text' })
    messagePersister.settleRecoveringSessions(AGENT_SLUG, [SESSION_ID])
    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls.flat().join(' ')).not.toContain('secret user text')
    warn.mockRestore()
  })

  it('settles recovering sessions as connection_lost and writes automation status', () => {
    messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
    messagePersister.snapshotMidTurnSessions(AGENT_SLUG)
    messagePersister.settleRecoveringSessions(AGENT_SLUG, [SESSION_ID])
    expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
    expect(messagePersister.isSessionRecovering(AGENT_SLUG, SESSION_ID)).toBe(false)
    expect(finalizeAutomationStatus).toHaveBeenCalledWith(expect.objectContaining({ slug: AGENT_SLUG }), SESSION_ID, 'failed')
  })

  it('defers a fatal SIGKILL result to unexpected-death recovery', async () => {
    const onDeath = vi.fn()
    messagePersister.setUnexpectedDeathCallback(onDeath)
    mockClient.onFatalResult = vi.fn(() => 'defer_for_recovery' as const)
    messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)

    mockClient._sendMessage({
      type: 'result',
      subtype: 'error',
      fatal: true,
      error: 'The agent process was killed due to running out of memory.',
    })

    expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
    expect(messagePersister.isSessionRecovering(AGENT_SLUG, SESSION_ID)).toBe(false)
    expect(onDeath).toHaveBeenCalledWith(AGENT_SLUG)
    expect(messagePersister.consumeLastFatal(AGENT_SLUG)).toBe('oom_sigkill')
    messagePersister.setUnexpectedDeathCallback(null)
  })

  it('does not snapshot a fatal SIGKILL when no recovery callback is registered', async () => {
    messagePersister.setUnexpectedDeathCallback(null)
    mockClient.onFatalResult = vi.fn(() => 'defer_for_recovery' as const)
    messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)

    mockClient._sendMessage({
      type: 'result',
      subtype: 'error',
      fatal: true,
      error: 'The agent process was killed due to running out of memory.',
    })

    expect(messagePersister.isSessionRecovering(AGENT_SLUG, SESSION_ID)).toBe(false)
    expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(false)
  })

  it('does not settle mid-turn on connection_closed when recovery is registered', async () => {
    const otherId = 'recover-session-2'
    const otherClient = createMockClient()
    await messagePersister.subscribeToSession(AGENT_SLUG, otherId, otherClient, otherId)
    const onDeath = vi.fn()
    messagePersister.setUnexpectedDeathCallback(onDeath)
    messagePersister.markSessionActive(AGENT_SLUG, SESSION_ID)
    messagePersister.markSessionActive(AGENT_SLUG, otherId)

    mockClient._messageCallback!({
      type: 'connection_closed',
      content: { type: 'connection_closed' },
      timestamp: new Date(),
      sessionId: SESSION_ID,
    })
    await new Promise((r) => setTimeout(r, 0))

    expect(onDeath).toHaveBeenCalledWith(AGENT_SLUG, SESSION_ID)
    expect(onDeath).toHaveBeenCalledTimes(1)
    expect(messagePersister.isSessionActive(AGENT_SLUG, SESSION_ID)).toBe(true)
    expect(messagePersister.isSessionActive(AGENT_SLUG, otherId)).toBe(true)
    expect(messagePersister.isSessionRecovering(AGENT_SLUG, SESSION_ID)).toBe(false)
    expect(messagePersister.isSessionRecovering(AGENT_SLUG, otherId)).toBe(false)
    // Dead transport is detached so recovery's isSubscribed gate resubscribes.
    expect(messagePersister.isSubscribed(AGENT_SLUG, SESSION_ID)).toBe(false)
    expect(messagePersister.isSubscribed(AGENT_SLUG, otherId)).toBe(true)
    messagePersister.setUnexpectedDeathCallback(null)
    messagePersister.unsubscribeFromSession(AGENT_SLUG, otherId)
  })
})

// ===========================================================================
// Cross-agent isolation of the process-global session registries.
//
// Every map in this class is keyed by session id, and a session id is drawn
// from a namespace that spans all agents. These tests pin the property that
// keying has to deliver: work done on one agent's session is never observable
// on another agent's.
//
// The agent-scoped queries below (`getActiveSessionIdsForAgent`,
// `hasActiveSessionsForAgent`, `markAllSessionsInactiveForAgent`,
// `snapshotMidTurnSessions`) are the recovery and container-lifecycle paths —
// the ones where a re-keying mistake would show up as a session that silently
// fails to resume rather than as a crash. They already take an agentSlug, so
// these assertions do not depend on how the maps are keyed underneath.
// ===========================================================================
describe('cross-agent isolation', () => {
  const AGENT_A = 'agent-alpha'
  const AGENT_B = 'agent-beta'
  const SESSION_A1 = 'alpha-session-1'
  const SESSION_A2 = 'alpha-session-2'
  const SESSION_B1 = 'beta-session-1'

  let clientA1: ReturnType<typeof createMockClient>
  let clientA2: ReturnType<typeof createMockClient>
  let clientB1: ReturnType<typeof createMockClient>

  beforeEach(async () => {
    clientA1 = createMockClient()
    clientA2 = createMockClient()
    clientB1 = createMockClient()
    await messagePersister.subscribeToSession(AGENT_A, SESSION_A1, clientA1, SESSION_A1)
    await messagePersister.subscribeToSession(AGENT_A, SESSION_A2, clientA2, SESSION_A2)
    await messagePersister.subscribeToSession(AGENT_B, SESSION_B1, clientB1, SESSION_B1)
  })

  afterEach(() => {
    for (const id of [SESSION_A1, SESSION_A2, SESSION_B1]) {
      messagePersister.unsubscribeFromSession(id === SESSION_B1 ? AGENT_B : AGENT_A, id)
    }
    vi.clearAllMocks()
  })

  describe('agent-scoped queries', () => {
    it('reports active sessions only for the agent that owns them', () => {
      messagePersister.markSessionActive(AGENT_A, SESSION_A1)
      messagePersister.markSessionActive(AGENT_B, SESSION_B1)

      expect(messagePersister.getActiveSessionIdsForAgent(AGENT_A)).toEqual([SESSION_A1])
      expect(messagePersister.getActiveSessionIdsForAgent(AGENT_B)).toEqual([SESSION_B1])
      expect(messagePersister.hasActiveSessionsForAgent(AGENT_A)).toBe(true)
      expect(messagePersister.hasActiveSessionsForAgent(AGENT_B)).toBe(true)
      expect(messagePersister.hasActiveSessionsForAgent('agent-with-nothing')).toBe(false)
    })

    it('reports awaiting-input only for the agent that owns the session', () => {
      messagePersister.markSessionActive(AGENT_A, SESSION_A1)

      expect(messagePersister.hasSessionsAwaitingInputForAgent(AGENT_B)).toBe(false)
    })

    it('stopping one agent’s container leaves the other agent’s sessions alone', () => {
      messagePersister.markSessionActive(AGENT_A, SESSION_A1)
      messagePersister.markSessionActive(AGENT_A, SESSION_A2)
      messagePersister.markSessionActive(AGENT_B, SESSION_B1)

      messagePersister.markAllSessionsInactiveForAgent(AGENT_A)

      expect(messagePersister.isSessionActive(AGENT_A, SESSION_A1)).toBe(false)
      expect(messagePersister.isSessionActive(AGENT_A, SESSION_A2)).toBe(false)
      expect(messagePersister.isSessionActive(AGENT_B, SESSION_B1)).toBe(true)
      expect(messagePersister.isSubscribed(AGENT_B, SESSION_B1)).toBe(true)
    })

    it('snapshots mid-turn sessions only for the named agent', () => {
      messagePersister.markSessionActive(AGENT_A, SESSION_A1)
      messagePersister.markSessionActive(AGENT_B, SESSION_B1)

      expect(messagePersister.snapshotMidTurnSessions(AGENT_A)).toEqual([SESSION_A1])
      expect(messagePersister.isSessionRecovering(AGENT_B, SESSION_B1)).toBe(false)
    })

    it('honours the restrict list within an agent', () => {
      messagePersister.markSessionActive(AGENT_A, SESSION_A1)
      messagePersister.markSessionActive(AGENT_A, SESSION_A2)

      expect(messagePersister.snapshotMidTurnSessions(AGENT_A, [SESSION_A2])).toEqual([SESSION_A2])
      expect(messagePersister.isSessionRecovering(AGENT_A, SESSION_A1)).toBe(false)
      expect(messagePersister.isSessionRecovering(AGENT_A, SESSION_A2)).toBe(true)
    })

    it('never snapshots another agent’s session even when it is named in the restrict list', () => {
      messagePersister.markSessionActive(AGENT_A, SESSION_A1)
      messagePersister.markSessionActive(AGENT_B, SESSION_B1)

      expect(messagePersister.snapshotMidTurnSessions(AGENT_A, [SESSION_B1])).toEqual([])
      expect(messagePersister.isSessionRecovering(AGENT_B, SESSION_B1)).toBe(false)
    })
  })

  describe('per-session state does not bleed', () => {
    it('delivers SSE events only to the subscribers of that session', () => {
      const a1 = collectSSEEvents(AGENT_A, SESSION_A1)
      const b1 = collectSSEEvents(AGENT_B, SESSION_B1)
      try {
        messagePersister.broadcastSessionEvent(AGENT_B, SESSION_B1, { type: 'user_typing' })

        expect(b1.events).toContainEqual(expect.objectContaining({ type: 'user_typing' }))
        expect(a1.events).toEqual([])
      } finally {
        a1.cleanup()
        b1.cleanup()
      }
    })

    it('interrupting one session does not settle another agent’s session', async () => {
      messagePersister.markSessionActive(AGENT_A, SESSION_A1)
      messagePersister.markSessionActive(AGENT_B, SESSION_B1)

      await messagePersister.markSessionInterrupted(AGENT_A, SESSION_A1)

      expect(messagePersister.isSessionActive(AGENT_A, SESSION_A1)).toBe(false)
      expect(messagePersister.isSessionActive(AGENT_B, SESSION_B1)).toBe(true)
    })

    it('unsubscribing one session leaves the other agent’s subscription intact', () => {
      messagePersister.unsubscribeFromSession(AGENT_A, SESSION_A1)

      expect(messagePersister.isSubscribed(AGENT_A, SESSION_A1)).toBe(false)
      expect(messagePersister.isSubscribed(AGENT_B, SESSION_B1)).toBe(true)
    })

    it('keeps slash commands per session', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messagePersister.setSlashCommands(AGENT_A, SESSION_A1, [{ name: 'alpha-only' }] as any)

      expect(messagePersister.getSlashCommands(AGENT_A, SESSION_A1)).toEqual([{ name: 'alpha-only' }])
      expect(messagePersister.getSlashCommands(AGENT_B, SESSION_B1)).toEqual([])
    })

    it('keeps capability grants per session', () => {
      messagePersister.grantSessionCapability(AGENT_A, SESSION_A1, 'subagents')

      expect(messagePersister.hasSessionCapabilityGrant(AGENT_A, SESSION_A1, 'subagents')).toBe(true)
      expect(messagePersister.hasSessionCapabilityGrant(AGENT_B, SESSION_B1, 'subagents')).toBe(false)
    })

    it('attributes a streamed frame to the agent that owns the session', () => {
      const timestamp = new Date('2026-08-30T10:00:00.000Z')

      clientB1._messageCallback!({
        type: 'message',
        content: { type: 'assistant', message: { role: 'assistant', content: 'from beta' } },
        timestamp,
        sessionId: SESSION_B1,
      })

      expect(mockRecordSessionActivity).toHaveBeenCalledWith(expect.objectContaining({ slug: AGENT_B }), SESSION_B1, timestamp)
      expect(mockRecordSessionActivity).not.toHaveBeenCalledWith(expect.objectContaining({ slug: AGENT_A }), SESSION_B1, timestamp)
    })
  })
})
