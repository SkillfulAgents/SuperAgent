/**
 * What a finished tool call sets in motion on the host's side (`ToolCalls`,
 * through the session): user-input requests and the session's waiting state,
 * capability reviews, host tools, host scripts, computer use, and deliver_file.
 *
 * The sessions are real (`attachLiveSessionsHarness`), fed frame by frame
 * through a stream client. What they ask of the host (host tools, scripts,
 * computer use, notifications, the global feed) is read off the recording
 * host port, and what they post to the container's pending inputs off the
 * runtime double's `containerFetch`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@shared/lib/services/session-service', () => ({
  updateSessionMetadata: vi.fn(() => Promise.resolve()),
  getSessionMetadata: vi.fn(() => Promise.resolve(null)),
  finalizeAutomationStatus: vi.fn(() => Promise.resolve('updated')),
}))
const mockAgentCapabilities: Record<'subagents' | 'workflows', 'allow' | 'review' | 'block'> = {
  subagents: 'allow',
  workflows: 'review',
}
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({}),
  getAgentCapabilitySettings: () => ({ ...mockAgentCapabilities }),
  getModelCatalogSettings: () => ({}),
  VALID_SCRIPT_TYPES: {
    darwin: ['applescript', 'shell'],
    linux: ['shell'],
    win32: ['powershell'],
  },
}))

import { attachLiveSessionsHarness, createStreamClient, type StreamClient } from '../testing/live-sessions-harness'
import type { HostToolResult } from '../host-port'
import { userInputRequestManager } from '@shared/lib/tools/requests/request-manager'
import * as toolRegistry from '@shared/lib/tools/registry'

const SESSION_ID = 'test-session-1'
const AGENT_SLUG = 'test-agent'

// The machine has every macOS permission computer use needs.
const live = attachLiveSessionsHarness({ answers: { computerUsePermissions: null } })
const sessions = (slug: string = AGENT_SLUG) => live.sessions(slug)

let mockClient: StreamClient
let sseEvents: any[]
let sseCleanup: () => void

// One `user_request_created` per open request, carrying the registry
// envelope — the only request wire there is.
const requestCards = (kind: string) =>
  sseEvents.filter((e) => e.type === 'user_request_created' && e.request?.kind === kind)
const openStreamRequestIds = () =>
  userInputRequestManager.getStoreIdsForSession(AGENT_SLUG, SESSION_ID, 'stream')

/** The global feed from now on, as a subscriber that joined now would see it. */
function collectGlobalEvents(): () => any[] {
  const start = live.host.sends.length
  return () => live.host.sends.slice(start).filter(([name]) => name === 'global').map(([, event]) => event)
}

/** The notifications asking the user to answer a request. */
const waitingInputNotifications = () =>
  live.host.sent('notification').filter((n) => n.kind === 'session_waiting_input')

/** The agent holds a grant for every computer-use level and the host shell. */
const grantComputerUse = () => vi.spyOn(live.agents.get(AGENT_SLUG).computerUse, 'check').mockReturnValue('granted')

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
  live.runtime.containerFetch.mockReset()
  for (const name of ['hostTool', 'hostScript', 'computerUse'] as const) live.host.answer(name, undefined)
  vi.clearAllMocks()
})

// ============================================================================
// deliver_file tool-result correlation (ELECTRON-39)
// ============================================================================

describe('deliver_file tool_result_ready', () => {
  function streamDeliverFileToolUse(filePath: string, description?: string) {
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'deliver-1', name: 'mcp__user-input__deliver_file' },
      },
    })
    const input = JSON.stringify(description ? { filePath, description } : { filePath })
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: input } },
    })
    mockClient.emit({ type: 'stream_event', event: { type: 'content_block_stop' } })
  }

  it('broadcasts tool_result_ready with the validated path on a successful result', () => {
    streamDeliverFileToolUse('/workspace/out.txt', 'a report')
    sseEvents.length = 0

    mockClient.emit({
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

    mockClient.emit({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'deliver-1', content: 'not found', is_error: true }] },
    })

    const ready = sseEvents.filter(e => e.type === 'tool_result_ready')
    expect(ready).toHaveLength(1)
    expect(ready[0].isError).toBe(true)
  })

  it('does not broadcast tool_result_ready for an untracked tool_result', () => {
    mockClient.emit({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'other-tool', content: 'result' }] },
    })

    const ready = sseEvents.filter(e => e.type === 'tool_result_ready')
    expect(ready).toHaveLength(0)
  })

  it('does not re-broadcast tool_result_ready for a duplicate tool_result', () => {
    streamDeliverFileToolUse('/workspace/out.txt')

    const sendResult = () => mockClient.emit({
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
// Remote MCP request tool handling
// ============================================================================

describe('remote MCP request tool handling', () => {
  // Helper to simulate a complete tool_use block for request_remote_mcp
  function simulateRemoteMcpToolUse(toolId: string, input: Record<string, unknown>) {
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: toolId, name: 'mcp__user-input__request_remote_mcp' },
      },
    })
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
      },
    })
    mockClient.emit({
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

    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'mcp-bad', name: 'mcp__user-input__request_remote_mcp' },
      },
    })
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: 'not valid json{{{' },
      },
    })
    mockClient.emit({
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

  // The session always fires the trigger; the renderer's notification
  // gate decides whether to actually show the OS popup (it knows focus,
  // per-user viewing, and the `notifyWhenUnfocused` toggle). An SSE
  // viewer being attached does NOT suppress the trigger here.
  it('triggers notification regardless of whether viewers are attached', async () => {
    sseEvents.length = 0
    live.host.sends.length = 0

    // SSE client IS attached — trigger should still fire.
    simulateRemoteMcpToolUse('mcp-notify', {
      url: 'https://mcp.example.com/mcp',
    })

    expect(waitingInputNotifications()).toContainEqual({
      kind: 'session_waiting_input',
      sessionId: SESSION_ID,
      agentSlug: AGENT_SLUG,
      request: expect.objectContaining({ kind: 'remote_mcp' }),
    })
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
// Host tool dispatch (the tools themselves: src/shared/lib/host/tools)
// ============================================================================

describe('host tool dispatch', () => {
  function streamToolUse(toolName: string, toolId: string, partialJson: string[], parentToolUseId?: string) {
    const frame = parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}
    mockClient.emit({
      type: 'stream_event',
      ...frame,
      event: { type: 'content_block_start', content_block: { type: 'tool_use', id: toolId, name: toolName } },
    })
    for (const partial_json of partialJson) {
      mockClient.emit({
        type: 'stream_event',
        ...frame,
        event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json } },
      })
    }
  }

  function stopToolUse(parentToolUseId?: string) {
    const frame = parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}
    mockClient.emit({ type: 'stream_event', ...frame, event: { type: 'content_block_stop' } })
  }

  function simulateToolUse(toolName: string, toolId: string, input: Record<string, unknown>, parentToolUseId?: string) {
    streamToolUse(toolName, toolId, [JSON.stringify(input)], parentToolUseId)
    stopToolUse(parentToolUseId)
  }

  const hostToolCalls = () => live.host.calls.filter(([name]) => name === 'hostTool')
  // What the session sent to the container's pending input for this call.
  const inputCalls = (toolUseId: string) =>
    live.runtime.containerFetch.mock.calls.filter(([path]) => String(path).startsWith(`/inputs/${toolUseId}/`))
  const post = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  function attach(answer: HostToolResult | (() => Promise<HostToolResult>)) {
    live.host.answer('hostTool', answer)
  }

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
    live.runtime.containerFetch.mockImplementation((path: string) => {
      if (path.endsWith('/resolve')) streamedBeforeResolve = sseEvents.filter((e) => hostEventTypes.has(e.type))
      return Promise.resolve(new Response('{}'))
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
    live.runtime.containerFetch.mockImplementation((path: string) =>
      path.endsWith('/resolve') ? Promise.reject(deliveryError) : Promise.resolve(new Response('{}')),
    )
    const consoleError = vi.spyOn(console, 'error')

    try {
      simulateToolUse('mcp__user-input__schedule_task', 'tool-host-undelivered', {
        scheduleType: 'cron',
        scheduleExpression: '0 9 * * 1-5',
        prompt: 'Send the daily report',
      })

      await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith(
        '[LiveSession] schedule_task succeeded but its result was not delivered:',
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
    sessions().markActive(SESSION_ID)

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
// Awaiting input status tracking
// ============================================================================

describe('awaiting input status tracking', () => {
  beforeEach(() => {
    // Requests park mid-turn: production always has markSessionActive before
    // a request event arrives, and the derived awaiting projection is gated
    // on an active turn (an inactive session is never awaiting).
    sessions().markActive(SESSION_ID)
  })

  // Helper to simulate a complete tool_use block
  function simulateToolUse(toolName: string, toolId: string, input: Record<string, unknown>) {
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: toolId, name: toolName },
      },
    })
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
      },
    })
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    })
  }

  it('isSessionAwaitingInput returns false initially', () => {
    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
  })

  it('sets isAwaitingInput after request_secret tool fires', () => {
    simulateToolUse('mcp__user-input__request_secret', 'tool-1', {
      secretName: 'API_KEY',
      reason: 'Need it',
    })

    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
  })

  it('preserves initial-turn active and awaiting flags across stream subscription', async () => {
    sessions().markActive(SESSION_ID)
    simulateToolUse('mcp__user-input__request_secret', 'tool-1', {
      secretName: 'API_KEY',
      reason: 'Need it',
    })

    await sessions().subscribe(SESSION_ID, mockClient, SESSION_ID)

    expect(sessions().isActive(SESSION_ID)).toBe(true)
    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
    expect(sessions().hasAwaitingInput()).toBe(true)
  })

  it('recovers awaiting input for an active session from persisted request fallback', () => {
    const globalEvents = collectGlobalEvents()

    sessions().markActive(SESSION_ID)
    sessions().recoverAwaitingInput(SESSION_ID, [
      { toolUseId: 'recovered-1', toolName: 'mcp__user-input__request_secret' },
    ])

    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
    expect(sessions().hasAwaitingInput()).toBe(true)

    const awaitingEvents = globalEvents().filter(e => e.type === 'session_awaiting_input')
    expect(awaitingEvents).toHaveLength(1)
    expect(awaitingEvents[0].sessionId).toBe(SESSION_ID)
    expect(awaitingEvents[0].agentSlug).toBe(AGENT_SLUG)

    // Recovered entries carry no payload, so no card event goes out for
    // them; clients render the card from the transcript instead.
    expect(requestCards('question')).toHaveLength(0)

    // Its tool_result settles the recovered wait like any other request.
    mockClient.emit({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'recovered-1', content: 'secret-value' },
        ],
      },
    })
    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
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
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)

      sessions().recoverAwaitingInput(SESSION_ID, [
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
    sessions().markActive(SESSION_ID)
    sessions().recoverAwaitingInput(SESSION_ID, [
      { toolUseId: 'script-recovery', toolName: 'mcp__user-input__request_script_run' },
      { toolUseId: 'file-recovery', toolName: 'mcp__user-input__deliver_file' },
    ])
    expect(userInputRequestManager.getOpenRequest('script-recovery', AGENT_SLUG)).toBeNull()
    expect(userInputRequestManager.getOpenRequest('file-recovery', AGENT_SLUG)).toBeNull()
    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
  })

  it('does not recover awaiting input for an inactive session', () => {
    // A session with no active turn (here: no streaming state at all — the
    // post-restart shape this fallback exists for) must not be recovered.
    sessions().recoverAwaitingInput('inactive-session-1', [
      { toolUseId: 'recovered-2', toolName: 'mcp__user-input__request_secret' },
    ])

    expect(sessions().isAwaitingInput('inactive-session-1')).toBe(false)
  })

  it('sets isAwaitingInput after AskUserQuestion tool fires', () => {
    simulateToolUse('AskUserQuestion', 'tool-1', {
      questions: [{ question: 'Pick DB', header: 'DB', options: [], multiSelect: false }],
    })

    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
  })

  it('sets isAwaitingInput after request_connected_account tool fires', () => {
    simulateToolUse('mcp__user-input__request_connected_account', 'tool-1', {
      toolkit: 'github',
      reason: 'Need access',
    })

    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
  })

  it('sets isAwaitingInput after request_file tool fires', () => {
    simulateToolUse('mcp__user-input__request_file', 'tool-1', {
      description: 'Upload a CSV',
    })

    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
  })

  it('sets isAwaitingInput after request_remote_mcp tool fires', () => {
    simulateToolUse('mcp__user-input__request_remote_mcp', 'tool-1', {
      url: 'https://example.com/mcp',
    })

    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
  })

  it('sets isAwaitingInput after request_browser_input tool fires', () => {
    simulateToolUse('mcp__user-input__request_browser_input', 'tool-1', {
      message: 'Please log in',
      requirements: ['Enter credentials'],
    })

    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
  })

  // A background subagent's request_browser_input must flip the SAME awaiting
  // flag the main agent's does: the in-chat card is renderer-local state, but
  // the sidebar/header orange dot reads the session's isAwaitingInput. A
  // request surfaced only as a card leaves the agent labeled "working" while
  // it is actually blocked on the user.
  describe('subagent-originated browser input requests', () => {
    function sendSidechainStreamEvent(event: any, parentToolId = 'agent-tool-1') {
      mockClient.emit({
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
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
    })

    it('sets isAwaitingInput when a subagent complete assistant message carries request_browser_input', () => {
      const globalEvents = collectGlobalEvents()

      mockClient.emit({
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

      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
      const awaiting = globalEvents().filter(e => e.type === 'session_awaiting_input')
      expect(awaiting).toHaveLength(1)
      expect(awaiting[0].sessionId).toBe(SESSION_ID)
    })

    // The resolve side of the same asymmetry: a subagent's tool_result comes
    // back on the SIDECHAIN (parent_tool_use_id set), which never reaches the
    // main-path 'user' handler that clears isAwaitingInput and drops the
    // replayable card. After the user clicks Complete, the subagent resumes —
    // the UI must stop saying "needs input" and must not replay a stale card.
    function sendSidechainBrowserInputRequest(parentToolId: string, subToolId: string) {
      mockClient.emit({
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
      const globalEvents = collectGlobalEvents()

      sendSidechainBrowserInputRequest('agent-tool-3', 'sub-tool-3')
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
      expect(openStreamRequestIds()).toHaveLength(1)

      sseEvents.length = 0

      mockClient.emit({
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

      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
      expect(openStreamRequestIds()).toHaveLength(0)
      // Same broadcast the main path uses — other windows drop their card copy off it
      const results = sseEvents.filter(e => e.type === 'tool_result')
      expect(results).toHaveLength(1)
      expect(results[0].toolUseId).toBe('sub-tool-3')
      expect(globalEvents().filter(e => e.type === 'session_input_provided')).toHaveLength(1)
    })

    it('does not clear awaiting state on unrelated sidechain tool results', () => {
      sendSidechainBrowserInputRequest('agent-tool-4', 'sub-tool-4')

      // An ordinary subagent tool result (e.g. Bash) while the request is open
      mockClient.emit({
        type: 'user',
        parent_tool_use_id: 'agent-tool-4',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'other-tool-9', content: 'file listing' },
          ],
        },
      })

      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
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
      mockClient.emit({
        type: 'user',
        parent_tool_use_id: 'agent-tool-5',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'sub-tool-5', content: 'done' },
          ],
        },
      })

      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
      expect(openStreamRequestIds()).toEqual(['main-q-1'])
    })
  })

  it('does NOT set isAwaitingInput for schedule_task tool', () => {
    // A host tool: the host runs it, and nobody is asked.
    live.host.answer('hostTool', { status: 'resolved', value: 'Scheduled.' })
    simulateToolUse('mcp__user-input__schedule_task', 'tool-1', {
      scheduleType: 'at',
      scheduleExpression: '2026-03-20T10:00:00Z',
      prompt: 'Do something',
    })

    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
  })

  it('does NOT set isAwaitingInput for deliver_file tool', () => {
    simulateToolUse('mcp__user-input__deliver_file', 'tool-1', {
      filePath: '/tmp/output.csv',
      description: 'Results',
    })

    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
  })

  it('does NOT set isAwaitingInput for non-user-input tools', () => {
    simulateToolUse('Bash', 'tool-1', { command: 'ls' })

    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
  })

  it('broadcasts session_awaiting_input globally when status transitions', () => {
    const globalEvents = collectGlobalEvents()

    simulateToolUse('mcp__user-input__request_secret', 'tool-1', {
      secretName: 'KEY',
    })

    const awaitingEvents = globalEvents().filter(e => e.type === 'session_awaiting_input')
    expect(awaitingEvents).toHaveLength(1)
    expect(awaitingEvents[0].sessionId).toBe(SESSION_ID)
    expect(awaitingEvents[0].agentSlug).toBe(AGENT_SLUG)
  })

  it('does not double-broadcast when already awaiting input', () => {
    const globalEvents = collectGlobalEvents()

    // Fire two user-input tools in sequence
    simulateToolUse('mcp__user-input__request_secret', 'tool-1', { secretName: 'KEY1' })
    simulateToolUse('mcp__user-input__request_file', 'tool-2', { description: 'CSV' })

    const awaitingEvents = globalEvents().filter(e => e.type === 'session_awaiting_input')
    // Should only broadcast once (first transition)
    expect(awaitingEvents).toHaveLength(1)
  })

  it('clears isAwaitingInput when tool result arrives (user message)', () => {
    sessions().markActive(SESSION_ID)

    simulateToolUse('mcp__user-input__request_secret', 'tool-1', { secretName: 'KEY' })
    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)

    // Simulate tool result arriving as a user message
    mockClient.emit({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'secret-value' },
        ],
      },
    })

    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
  })

  it('keeps isAwaitingInput on tool result while a parked review is open', () => {
    sessions().markActive(SESSION_ID)

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
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)

      // User answers the secret; its tool result arrives while the review is still up.
      mockClient.emit({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'secret-value' },
          ],
        },
      })

      // Must stay awaiting — the review is still open.
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)

      // Once the review resolves, the agent-wide sync settles the session.
      userInputRequestManager.resolve('blocker-review-1', 'answered')
      sessions().syncAwaiting()
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
    } finally {
      userInputRequestManager.resolve('blocker-review-1', 'cancelled')
    }
  })

  it('broadcasts session_input_provided globally when input is received', () => {
    sessions().markActive(SESSION_ID)

    simulateToolUse('mcp__user-input__request_secret', 'tool-1', { secretName: 'KEY' })

    const globalEvents = collectGlobalEvents()

    // Simulate tool result
    mockClient.emit({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'value' },
        ],
      },
    })

    const providedEvents = globalEvents().filter(e => e.type === 'session_input_provided')
    expect(providedEvents).toHaveLength(1)
    expect(providedEvents[0].sessionId).toBe(SESSION_ID)
    expect(providedEvents[0].agentSlug).toBe(AGENT_SLUG)
  })

  it('clears isAwaitingInput when session goes idle (result event)', () => {
    sessions().markActive(SESSION_ID)

    simulateToolUse('mcp__user-input__request_secret', 'tool-1', { secretName: 'KEY' })
    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)

    // Simulate session completing
    mockClient.emit({
      type: 'result',
      subtype: 'success',
    })

    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
  })

  it('clears isAwaitingInput when session is interrupted', async () => {
    sessions().markActive(SESSION_ID)

    simulateToolUse('mcp__user-input__request_secret', 'tool-1', { secretName: 'KEY' })
    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)

    sessions().markInterrupted(SESSION_ID)

    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
  })

  it('clears isAwaitingInput when new user message starts (markSessionActive)', () => {
    simulateToolUse('mcp__user-input__request_secret', 'tool-1', { secretName: 'KEY' })
    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)

    // New message starts a new turn
    sessions().markActive(SESSION_ID)

    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
  })

  it('returns false for unknown session IDs', () => {
    expect(sessions().isAwaitingInput('nonexistent-session')).toBe(false)
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
      live.runtime.containerFetch.mock.calls.find((c) => c[0] === `/inputs/${toolUseId}/reject`)
    const interruptCall = () =>
      live.runtime.containerFetch.mock.calls.find((c) => c[0] === `/sessions/${SESSION_ID}/interrupt`)

    it('interrupts a top-level AskUserQuestion BEFORE cleanup-rejecting it (aborted turn cannot resume into a filler reply)', async () => {
      sessions().markActive(SESSION_ID)
      simulateToolUse('AskUserQuestion', 'q-1', {
        questions: [{ question: 'Pick DB', header: 'DB', options: [], multiSelect: false }],
      })
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
      live.runtime.containerFetch.mockClear()

      await sessions().cancelAwaitingInput(SESSION_ID)

      const calls = live.runtime.containerFetch.mock.calls
      const interruptIdx = calls.findIndex((c) => c[0] === `/sessions/${SESSION_ID}/interrupt`)
      const rejectIdx = calls.findIndex((c) => c[0] === `/inputs/q-1/reject`)
      // Top-level now interrupts too, and the interrupt must land BEFORE the reject:
      // rejecting first would resume the parked turn and let the model emit a filler
      // ("Go ahead") that the next message then anchors to.
      expect(interruptIdx).toBeGreaterThanOrEqual(0)
      expect(rejectIdx).toBeGreaterThan(interruptIdx)
      // markSessionInterrupted ran, clearing the awaiting state.
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
    })

    it('rejects AND interrupts for a subagent browser_input request', async () => {
      sessions().markActive(SESSION_ID)
      simulateToolUse('mcp__user-input__request_browser_input', 'bi-1', {
        message: 'Please log in',
        requirements: ['Enter credentials'],
      })
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
      live.runtime.containerFetch.mockClear()

      await sessions().cancelAwaitingInput(SESSION_ID)

      expect(rejectCallFor('bi-1')).toBeDefined()
      expect(interruptCall()).toBeDefined()
      // The interrupt path marks the session interrupted (awaiting cleared).
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
    })

    it('sweeps the pending computer-use entries and interrupts', async () => {
      vi.stubEnv('E2E_MOCK', 'true') // skip the host platform gate so the request goes pending
      try {
        sessions().markActive(SESSION_ID)
        simulateToolUse('mcp__computer-use__computer_click', 'cu-1', { ref: 'win:1' })
        expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
        expect(sessions().pendingComputerUse(SESSION_ID)).toHaveLength(1)
        live.runtime.containerFetch.mockClear()

        await sessions().cancelAwaitingInput(SESSION_ID)

        expect(rejectCallFor('cu-1')).toBeDefined()
        expect(interruptCall()).toBeDefined()
        // Host-side computer_use bookkeeping is cleared too (session_idle only clears
        // pendingInputRequests), so a reconnect can't replay a phantom approval card.
        expect(sessions().pendingComputerUse(SESSION_ID)).toHaveLength(0)
      } finally {
        vi.unstubAllEnvs()
      }
    })

    it('rejects every pending request when several are open', async () => {
      sessions().markActive(SESSION_ID)
      simulateToolUse('mcp__user-input__request_secret', 's-1', { secretName: 'KEY1' })
      simulateToolUse('mcp__user-input__request_file', 'f-1', { description: 'CSV' })
      live.runtime.containerFetch.mockClear()

      await sessions().cancelAwaitingInput(SESSION_ID)

      expect(rejectCallFor('s-1')).toBeDefined()
      expect(rejectCallFor('f-1')).toBeDefined()
    })

    it('is a no-op when the session is not awaiting input', async () => {
      sessions().markActive(SESSION_ID)
      live.runtime.containerFetch.mockClear()

      await sessions().cancelAwaitingInput(SESSION_ID)

      expect(live.runtime.containerFetch).not.toHaveBeenCalled()
    })

    function startBackgroundTask(taskId: string) {
      mockClient.emit({
        type: 'user',
        tool_use_result: { backgroundTaskId: taskId },
        message: { content: [{ type: 'tool_result', tool_use_id: `tool-${taskId}`, content: 'Running' }] },
      })
    }

    function answerInterruptWith(processKept: boolean) {
      live.runtime.containerFetch.mockImplementation((route: string) =>
        Promise.resolve(
          route === `/sessions/${SESSION_ID}/interrupt`
            ? new Response(JSON.stringify({ success: true, processKept }))
            : new Response('{}'),
        ),
      )
    }

    it('keeps background tasks when the container kept the process across the interrupt', async () => {
      // A new message while a question is pending stops only the turn: the
      // container's background tasks live on, so the host keeps their rows.
      sessions().markActive(SESSION_ID)
      startBackgroundTask('bg-1')
      simulateToolUse('AskUserQuestion', 'q-bg', {
        questions: [{ question: 'Pick DB', header: 'DB', options: [], multiSelect: false }],
      })
      live.runtime.containerFetch.mockClear()
      answerInterruptWith(true)
      try {
        await sessions().cancelAwaitingInput(SESSION_ID)
      } finally {
        live.runtime.containerFetch.mockImplementation(() => Promise.resolve(new Response('{}')))
      }

      expect(interruptCall()?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ scope: 'turn' }) })
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
      expect(sessions().backgroundTasks(SESSION_ID).map((t) => t.taskId)).toEqual(['bg-1'])
      expect(sessions().isActive(SESSION_ID)).toBe(true)
    })

    it('spares a task only the runtime listed, like any other tracked task', async () => {
      // A subagent launched it, so no launch signal registered it — but the
      // runtime's snapshot does, which gives it a row and a per-task stop.
      // A turn stop leaves it running instead of escalating to a full stop.
      sessions().markActive(SESSION_ID)
      mockClient.emit({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'nested-1', task_type: 'local_bash', description: 'Serve local assets' }],
      })
      simulateToolUse('AskUserQuestion', 'q-untracked', {
        questions: [{ question: 'Pick DB', header: 'DB', options: [], multiSelect: false }],
      })
      live.runtime.containerFetch.mockClear()
      answerInterruptWith(true)
      try {
        await sessions().cancelAwaitingInput(SESSION_ID)
      } finally {
        live.runtime.containerFetch.mockImplementation(() => Promise.resolve(new Response('{}')))
      }

      expect(interruptCall()?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ scope: 'turn' }) })
      expect(sessions().backgroundTasks(SESSION_ID).map((t) => t.taskId)).toEqual(['nested-1'])
      expect(sessions().isActive(SESSION_ID)).toBe(true)
    })

    it('stops everything when the only open work is ambient', async () => {
      // Ambient tasks (housekeeping, live-update watchers) are hidden from
      // clients, so there is no row to stop them from: a turn stop would
      // leave the session pinned. The cancel asks for the full stop.
      sessions().markActive(SESSION_ID)
      mockClient.emit({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'watcher', task_type: 'local_bash', description: 'Watch for updates', ambient: true }],
      })
      simulateToolUse('AskUserQuestion', 'q-ambient', {
        questions: [{ question: 'Pick DB', header: 'DB', options: [], multiSelect: false }],
      })
      live.runtime.containerFetch.mockClear()
      answerInterruptWith(false)
      try {
        await sessions().cancelAwaitingInput(SESSION_ID)
      } finally {
        live.runtime.containerFetch.mockImplementation(() => Promise.resolve(new Response('{}')))
      }

      expect(interruptCall()?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ scope: 'all' }) })
      expect(sessions().isActive(SESSION_ID)).toBe(false)
    })

    it('drops background tasks when the container had to restart the process', async () => {
      sessions().markActive(SESSION_ID)
      startBackgroundTask('bg-1')
      simulateToolUse('AskUserQuestion', 'q-restart', {
        questions: [{ question: 'Pick DB', header: 'DB', options: [], multiSelect: false }],
      })
      answerInterruptWith(false)
      try {
        await sessions().cancelAwaitingInput(SESSION_ID)
      } finally {
        live.runtime.containerFetch.mockImplementation(() => Promise.resolve(new Response('{}')))
      }

      expect(sessions().backgroundTasks(SESSION_ID)).toEqual([])
      expect(sessions().isActive(SESSION_ID)).toBe(false)
    })

    it('swallows reject/interrupt failures so a best-effort cancel never throws', async () => {
      sessions().markActive(SESSION_ID)
      simulateToolUse('mcp__user-input__request_browser_input', 'bi-err', {
        message: 'Please log in',
        requirements: ['Enter credentials'],
      })
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
      live.runtime.containerFetch.mockClear()
      live.runtime.containerFetch.mockRejectedValue(new Error('container unreachable'))
      try {
        // Must resolve, not reject — a failed cancel must never block the incoming message.
        await expect(sessions().cancelAwaitingInput(SESSION_ID)).resolves.toBeUndefined()
        // Both container calls were attempted (and rejected): the interrupt + the cleanup reject.
        expect(rejectCallFor('bi-err')).toBeDefined()
        expect(interruptCall()).toBeDefined()
        // The interrupt fetch rejected, but markSessionInterrupted runs right after the swallowed
        // interrupt, so the cancel still clears the awaiting state.
        expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
      } finally {
        live.runtime.containerFetch.mockImplementation(() => Promise.resolve(new Response('{}')))
      }
    })
  })
})

// ============================================================================
// Capability review lifecycle
// ============================================================================

describe('capability review lifecycle', () => {
  function simulateToolUse(toolName: string, toolId: string, input: Record<string, unknown>) {
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: toolId, name: toolName },
      },
    })
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
      },
    })
    mockClient.emit({
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
    sessions().completeCapabilityReview(SESSION_ID, 'wf-1')

    expect(openStreamRequestIds()).toHaveLength(0)
    const resolved = sseEvents.filter(e => e.type === 'user_request_resolved')
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({ requestId: 'wf-1' })
  })

  it('a session-scope grant in the host mirror suppresses review cards without a container query', async () => {
    sessions().grantCapability(SESSION_ID, 'workflows')
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
      expect(sessions().capabilityGranted(SESSION_ID, 'workflows')).toBe(true)
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
    mockClient.emit({
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

  describe('when the stream reattaches while the grant lookup runs', () => {
    let releaseLookup!: (value: unknown) => void
    beforeEach(() => {
      vi.mocked(mockClient.fetch).mockReturnValue(
        new Promise((resolve) => { releaseLookup = resolve }) as never
      )
    })
    const reattach = () => sessions().subscribe(SESSION_ID, mockClient, SESSION_ID)

    it('a cancellation landing on the new attachment still suppresses the card', async () => {
      simulateToolUse('Workflow', 'wf-overtaken', { script: 'export const meta = {}' })
      await flush()
      await reattach()
      mockClient.emit({ type: 'capability_review_cancelled', toolUseId: 'wf-overtaken', capability: 'workflows' })

      releaseLookup({ ok: true, json: async () => ({ grants: [] }) })
      await flush()
      await flush()

      expect(requestCards('capability_review')).toHaveLength(0)
      expect(openStreamRequestIds()).toHaveLength(0)
    })

    it('the card it registers marks the live session waiting, not the one it replaced', async () => {
      sessions().markActive(SESSION_ID)
      simulateToolUse('Workflow', 'wf-carried', { script: 'export const meta = {}' })
      await flush()
      await reattach()

      releaseLookup({ ok: true, json: async () => ({ grants: [] }) })
      await vi.waitFor(() => expect(openStreamRequestIds()).toEqual(['wf-carried']))

      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
      expect(sessions().activity(SESSION_ID)).toBe('awaiting')
      // Settling it is a falling edge the live state hears.
      sessions().completeCapabilityReview(SESSION_ID, 'wf-carried')
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
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

    mockClient.emit({
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
// Script run request detection
// ============================================================================

describe('Script run request detection', () => {
  beforeEach(() => {
    // Awaiting is derived and gated on an active turn — mark active as the
    // real message send would before any request event arrives.
    sessions().markActive(SESSION_ID)
  })

  // Use existing simulateToolUse helper (already defined above in awaiting input tests)
  // Re-define locally since the other is scoped to that describe block
  function simulateToolUse(toolName: string, toolId: string, input: Record<string, unknown>) {
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: toolId, name: toolName },
      },
    })
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
      },
    })
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    })
  }

  it('registers a script_run with autoApproved:false when permission needed', () => {
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
    grantComputerUse()
    sseEvents.length = 0
    live.host.answer('hostScript', { exitCode: 0, stdout: 'ProductName: macOS', stderr: '' })

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
    expect(waitingInputNotifications()).toEqual([])

    // The host runs the script; its output goes to the container's pending input.
    await vi.waitFor(() => expect(openStreamRequestIds()).not.toContain('tool-sr-granted'))
    expect(live.host.calls).toEqual([['hostScript', { script: 'sw_vers', scriptType: 'shell' }]])
    expect(live.runtime.containerFetch).toHaveBeenCalledWith('/inputs/tool-sr-granted/resolve', expect.objectContaining({
      body: JSON.stringify({ value: 'Exit code: 0\n\nstdout:\nProductName: macOS' }),
    }))
    // Nobody was shown the request, so no tab is told it settled.
    expect(sseEvents.filter((e) => e.type === 'tool_result')).toHaveLength(0)
  })

  it('registers a script_run even without prior permission (prompts user)', () => {
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
    sseEvents.length = 0

    simulateToolUse('mcp__user-input__request_script_run', 'tool-sr-4', {
      explanation: 'Check version',
      scriptType: 'shell',
    })

    const scriptEvents = requestCards('script_run')
    expect(scriptEvents).toHaveLength(0)
  })

  it('registers nothing when scriptType is missing', () => {
    sseEvents.length = 0

    simulateToolUse('mcp__user-input__request_script_run', 'tool-sr-5', {
      script: 'sw_vers',
      explanation: 'Check version',
    })

    const scriptEvents = requestCards('script_run')
    expect(scriptEvents).toHaveLength(0)
  })

  it('sets isAwaitingInput after request_script_run tool fires (prompt path)', () => {
    simulateToolUse('mcp__user-input__request_script_run', 'tool-sr-6', {
      script: 'sw_vers',
      explanation: 'Check version',
      scriptType: 'shell',
    })

    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
  })

  it('does NOT set isAwaitingInput when use_host_shell is auto-approved', () => {
    grantComputerUse()
    live.host.answer('hostScript', { exitCode: 0, stdout: '', stderr: '' })

    simulateToolUse('mcp__user-input__request_script_run', 'tool-sr-auto-status', {
      script: 'sw_vers',
      explanation: 'Check version',
      scriptType: 'shell',
    })

    // Auto-approved scripts must not flip the global awaiting-input flag — that's
    // what drives the orange agent-status indicator.
    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
  })
})

// ============================================================================
// Computer use request detection
// ============================================================================

describe('Computer use request detection', () => {
  function simulateToolUse(toolName: string, toolId: string, input: Record<string, unknown>) {
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: toolId, name: toolName },
      },
    })
    mockClient.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
      },
    })
    mockClient.emit({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    })
  }

  it('auto-executes AND registers with autoApproved:true when computer-use permission is granted', async () => {
    const originalE2eMock = process.env.E2E_MOCK
    process.env.E2E_MOCK = 'true'
    grantComputerUse()
    sseEvents.length = 0
    live.host.answer('computerUse', 'Calculator, Finder')

    try {
      simulateToolUse('mcp__computer-use__computer_apps', 'tool-cu-granted', {
        includeHidden: false,
      })

      await vi.waitFor(() => {
        expect(live.runtime.containerFetch).toHaveBeenCalledWith('/inputs/tool-cu-granted/resolve', expect.objectContaining({
          body: JSON.stringify({ value: 'Calculator, Finder' }),
        }))
      })
      expect(live.host.calls).toEqual([
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

      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
      expect(sessions().pendingComputerUse(SESSION_ID)).toHaveLength(0)
      expect(waitingInputNotifications()).toEqual([])
      // Settled once the result was delivered.
      expect(userInputRequestManager.getOpenRequest('tool-cu-granted', AGENT_SLUG)).toBeNull()
    } finally {
      if (originalE2eMock === undefined) delete process.env.E2E_MOCK
      else process.env.E2E_MOCK = originalE2eMock
    }
  })

  it('runs an auto-approved command once when its tool call is delivered twice', async () => {
    const originalE2eMock = process.env.E2E_MOCK
    process.env.E2E_MOCK = 'true'
    grantComputerUse()
    let finishCommand!: (output: string) => void
    live.host.answer('computerUse', () => new Promise<string>((resolve) => {
      finishCommand = resolve
    }))
    try {
      // A subagent's tool call arrives on its stream events and again in its
      // complete message; the second delivery finds the first run holding it.
      simulateToolUse('mcp__computer-use__computer_click', 'tool-cu-twice', { ref: '@b1' })
      simulateToolUse('mcp__computer-use__computer_click', 'tool-cu-twice', { ref: '@b1' })
      await vi.waitFor(() => expect(live.host.calls.filter(([name]) => name === 'computerUse')).toHaveLength(1))
      finishCommand('clicked')
      await vi.waitFor(() => expect(userInputRequestManager.getOpenRequest('tool-cu-twice', AGENT_SLUG)).toBeNull())
      expect(live.host.calls.filter(([name]) => name === 'computerUse')).toHaveLength(1)
      expect(live.runtime.containerFetch.mock.calls.filter(([path]) => String(path).includes('tool-cu-twice'))).toEqual([
        ['/inputs/tool-cu-twice/resolve', expect.objectContaining({ body: JSON.stringify({ value: 'clicked' }) })],
      ])
    } finally {
      if (originalE2eMock === undefined) delete process.env.E2E_MOCK
      else process.env.E2E_MOCK = originalE2eMock
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
    grantComputerUse()
    live.host.answer('computerUse', '[mock] apps executed successfully')

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

      expect(sessions().pendingComputerUse(SESSION_ID)).toHaveLength(0)
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
    } finally {
      if (originalE2eMock === undefined) delete process.env.E2E_MOCK
      else process.env.E2E_MOCK = originalE2eMock
    }
  })
})
