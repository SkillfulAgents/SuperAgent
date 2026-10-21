/**
 * Characterization suite for the pending user-input request lifecycle, as an
 * agent's live sessions run it.
 *
 * Every user-facing request kind must satisfy the same contract on the main
 * stream path: open → broadcast exactly one request card → mark the session
 * awaiting → notify exactly once → resolve → drop the replay entry → clear
 * awaiting only when it was the last blocking wait.
 *
 * This file pins CURRENT behavior. The awaiting status is DERIVED from the
 * agent's request store: the split-brains this suite originally pinned as
 * known-wrong — the first of two parallel requests dropping the waiting
 * light, the computer-use and capability-review clear doors leaving the bit
 * stuck — are fixed, and their tests assert the correct arithmetic. The
 * sidechain matrix is the acceptance table for the unified dispatcher: every
 * kind must surface from every delivery path. Rows were `surfacesToday: false`
 * before the dispatcher landed — those kinds hung silently when a subagent
 * called them.
 *
 * The sessions are real (`attachLiveSessionsHarness`); what they hand the
 * host (the global feed, notifications) is read off the recording host port,
 * and what they post to the container off the runtime double.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The frames and host events the assertions pick fields from.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Frame = any

vi.mock('@shared/lib/services/session-service', () => ({
  updateSessionMetadata: vi.fn(() => Promise.resolve()),
  getSessionMetadata: vi.fn(() => Promise.resolve(null)),
  finalizeAutomationStatus: vi.fn(() => Promise.resolve('updated')),
}))
vi.mock('@shared/lib/services/session-summary-cache', () => ({
  recordSessionActivity: vi.fn(),
  recordProvisionalSessionActivity: vi.fn(() => ({ recordedAtMs: 0, previous: null })),
  revertSessionActivity: vi.fn(),
}))
vi.mock('@shared/lib/services/session-transcript-append', () => ({
  appendInformationalEntry: vi.fn(() => Promise.resolve()),
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

import { attachLiveSessionsHarness, createStreamClient, type StreamClient } from '../testing/live-sessions-harness'
import { userInputRequestManager } from '@shared/lib/tools/requests/request-manager'

// An auto-approved script runs on the host: it answers like a script that ran.
const live = attachLiveSessionsHarness({
  answers: { hostScript: { exitCode: 0, stdout: 'ProductVersion: 15.0', stderr: '' } },
})

/** The global feed from now on, as a subscriber that joined now would see it. */
function globalFeedFromNow(): () => Frame[] {
  const start = live.host.sends.length
  return () => live.host.sends.slice(start).filter(([name]) => name === 'global').map(([, event]) => event)
}

interface RequestKindCase {
  label: string
  toolName: string
  input: Record<string, unknown>
  kind: string
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
    kind: 'secret',
    waitingFor: 'secret',
  },
  {
    label: 'question',
    toolName: 'AskUserQuestion',
    input: {
      questions: [{ question: 'Pick DB', header: 'DB', options: [], multiSelect: false }],
    },
    kind: 'question',
    waitingFor: 'question',
  },
  {
    label: 'connected account',
    toolName: 'mcp__user-input__request_connected_account',
    input: { toolkit: 'github', reason: 'Need access' },
    kind: 'connected_account',
    waitingFor: 'connected_account',
  },
  {
    label: 'file',
    toolName: 'mcp__user-input__request_file',
    input: { description: 'Upload a CSV' },
    kind: 'file',
    waitingFor: 'file',
  },
  {
    label: 'remote MCP',
    toolName: 'mcp__user-input__request_remote_mcp',
    input: { url: 'https://example.com/mcp', name: 'Example', reason: 'Docs' },
    kind: 'remote_mcp',
    waitingFor: 'remote_mcp',
  },
  {
    label: 'browser input',
    toolName: 'mcp__user-input__request_browser_input',
    input: { message: 'Please log in', requirements: ['Enter credentials'] },
    kind: 'browser_input',
    waitingFor: 'browser_input',
  },
  {
    label: 'script run',
    toolName: 'mcp__user-input__request_script_run',
    input: { script: 'sw_vers', explanation: 'Check macOS version', scriptType: 'shell' },
    kind: 'script_run',
    waitingFor: 'script_run',
  },
]

describe('pending user-input request lifecycle (characterization)', () => {
  const SESSION_ID = 'lifecycle-session-1'
  const AGENT_SLUG = 'lifecycle-agent'
  const sessions = () => live.sessions(AGENT_SLUG)

  let client: StreamClient
  let sseEvents: Frame[]
  let sseCleanup: () => void
  let originalE2eMock: string | undefined

  beforeEach(async () => {
    // Computer-use interception is platform-gated (darwin/win32 only) with an
    // explicit E2E escape hatch (tool-calls.ts, `computerUse`). Set it so the
    // computer-use rows behave identically on Linux CI and macOS dev machines.
    originalE2eMock = process.env.E2E_MOCK
    process.env.E2E_MOCK = 'true'

    client = createStreamClient()
    await sessions().subscribe(SESSION_ID, client, SESSION_ID)
    // Requests park mid-turn: production always has markActive before any
    // request event arrives, and the derived awaiting projection is gated on
    // an active turn (an inactive session is never awaiting).
    sessions().markActive(SESSION_ID)

    const collected = live.collect(AGENT_SLUG, SESSION_ID)
    sseEvents = collected.events
    sseCleanup = collected.stop
  })

  afterEach(() => {
    if (originalE2eMock === undefined) delete process.env.E2E_MOCK
    else process.env.E2E_MOCK = originalE2eMock
    sseCleanup()
    sessions().unsubscribe(SESSION_ID)
    // Agent-scoped entries (reviews) are not dropped by unsubscribe — release
    // the agent's state so one test's review can't keep a later test's
    // session awaiting.
    live.reset()
    vi.clearAllMocks()
  })

  // The unified wire is the only card wire: one `user_request_created` per
  // open request, carrying the registry envelope.
  const cardsFor = (kind: string) =>
    sseEvents.filter((e) => e.type === 'user_request_created' && e.request?.kind === kind)
  const openStreamRequestIds = () =>
    userInputRequestManager.getStoreIdsForSession(AGENT_SLUG, SESSION_ID, 'stream')
  const waitingInputNotifications = () =>
    live.host.sent('notification').filter((n) => n.kind === 'session_waiting_input')

  function simulateToolUse(toolName: string, toolId: string, input: Record<string, unknown>) {
    client.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: toolId, name: toolName },
      },
    })
    client.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
      },
    })
    client.emit({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    })
  }

  function sendToolResult(toolUseId: string) {
    client.emit({
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
    ({ toolName, input, kind, waitingFor }) => {
      it('opens: broadcasts exactly one card, stores a replay entry, marks awaiting, notifies once', () => {
        simulateToolUse(toolName, 'tool-open-1', input)

        const cards = cardsFor(kind)
        expect(cards).toHaveLength(1)
        expect(cards[0].request.id).toBe('tool-open-1')

        expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
        expect(sessions().hasAwaitingInput()).toBe(true)
        expect(openStreamRequestIds()).toContain('tool-open-1')

        expect(waitingInputNotifications()).toEqual([
          {
            kind: 'session_waiting_input',
            agentSlug: AGENT_SLUG,
            sessionId: SESSION_ID,
            request: { kind: waitingFor, payload: cards[0].request.payload },
          },
        ])
      })

      it('resolves: the tool_result drops the replay entry and clears awaiting', () => {
        simulateToolUse(toolName, 'tool-resolve-1', input)
        expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)

        sendToolResult('tool-resolve-1')

        expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
        expect(openStreamRequestIds()).toHaveLength(0)
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

        expect(openStreamRequestIds()).toHaveLength(2)

        sendToolResult('tool-par-1')
        // Derived awaiting: the projection consults what is actually still
        // open, so answering the first request keeps the waiting light on
        // while the second card is parked. (This was the pinned parallel-
        // request split-brain before the flip: the imperative clear dropped
        // the bit on the first tool_result.)
        expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
        expect(openStreamRequestIds()).toHaveLength(1)

        sendToolResult('tool-par-2')
        expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
        expect(openStreamRequestIds()).toHaveLength(0)
      })
    }
  )

  it('attaches host-probed browser context to a browser input request', async () => {
    vi.mocked(client.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ url: 'https://example.com/login' }),
    } as unknown as Response)

    simulateToolUse(
      'mcp__user-input__request_browser_input',
      'tool-browser-context',
      { message: 'Please log in', requirements: ['Enter credentials'] },
    )

    await vi.waitFor(() => {
      expect(userInputRequestManager.getOpenRequest('tool-browser-context')?.payload)
        .toMatchObject({
          browserContext: {
            url: 'https://example.com/login',
            capturedAt: expect.any(Number),
          },
        })
    })
    expect(client.fetch).toHaveBeenCalledWith(
      `/browser/credential-context?sessionId=${SESSION_ID}`,
    )
  })

  // ==========================================================================
  // Documented divergence: computer-use has route-driven clearing and
  // survives idle boundaries — the request store expresses this as a
  // distinct store label, not as a separate map
  // ==========================================================================

  describe('main stream: computer use (divergent clearing rules)', () => {
    const TOOL = 'mcp__computer-use__computer_click'

    it('opens into the computer-use store, NOT the input-request store', () => {
      simulateToolUse(TOOL, 'cu-open-1', { x: 1, y: 2 })

      const cards = cardsFor('computer_use')
      expect(cards).toHaveLength(1)
      expect(cards[0].request.id).toBe('cu-open-1')
      expect(cards[0].request.autoApproved).toBe(false)

      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
      expect(sessions().pendingComputerUse(SESSION_ID).map((r) => r.toolUseId)).toContain('cu-open-1')
      expect(openStreamRequestIds()).toHaveLength(0)

      expect(waitingInputNotifications()).toEqual([
        expect.objectContaining({
          agentSlug: AGENT_SLUG,
          sessionId: SESSION_ID,
          request: expect.objectContaining({ kind: 'computer_use' }),
        }),
      ])
    })

    it('a tool_result alone does NOT drop the parked entry — and awaiting stays on with it', () => {
      simulateToolUse(TOOL, 'cu-clear-1', { x: 1, y: 2 })
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)

      // The computer-use store is cleared only via the decision route's
      // explicit call, so the entry survives a stray tool_result. Derived
      // awaiting reads that store: card parked, light ON. (Before the flip
      // this was a pinned split-brain — the imperative clear dropped the bit
      // without consulting this store.)
      sendToolResult('cu-clear-1')
      expect(sessions().pendingComputerUse(SESSION_ID).map((r) => r.toolUseId)).toContain('cu-clear-1')
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)

      sessions().clearComputerUseRequest(SESSION_ID, 'cu-clear-1')
      expect(sessions().pendingComputerUse(SESSION_ID)).toHaveLength(0)
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
    })

    it('the route clear flips awaiting and broadcasts when it was the last blocking wait', () => {
      const globalEvents = globalFeedFromNow()
      simulateToolUse(TOOL, 'cu-clear-2', { x: 1, y: 2 })
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)

      // The route clear applies the shared waiting-light rule: with both
      // stores empty and no external blocker, the bit flips AND the wire
      // says input was provided — together, atomically. (Before the unified
      // dispatch change it broadcast without flipping the bit, leaving the
      // wire and the bit disagreeing until the tool_result landed.)
      sessions().clearComputerUseRequest(SESSION_ID, 'cu-clear-2')
      expect(globalEvents().filter((e) => e.type === 'session_input_provided')).toHaveLength(1)
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
    })

    it('the route clear defers while another input request is still parked', () => {
      simulateToolUse('mcp__user-input__request_secret', 'cu-mix-secret', {
        secretName: 'API_KEY',
        reason: 'Need it',
      })
      simulateToolUse(TOOL, 'cu-clear-3', { x: 1, y: 2 })
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)

      // Clearing the computer-use entry must NOT flip awaiting: the secret
      // is still parked on the other store.
      sessions().clearComputerUseRequest(SESSION_ID, 'cu-clear-3')
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
      expect(sessions().pendingComputerUse(SESSION_ID)).toHaveLength(0)
    })
  })

  // ==========================================================================
  // Documented divergence: capability review clears early via its own door
  // ==========================================================================

  describe('main stream: capability review (early-clear lifecycle)', () => {
    beforeEach(() => {
      mockAgentCapabilities.subagents = 'allow'
      mockAgentCapabilities.workflows = 'review'
      vi.mocked(client.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ grants: [] }),
      } as unknown as Response)
    })

    it('opens like a standard kind: card, replay entry, awaiting, one notification', async () => {
      simulateToolUse('Workflow', 'wf-lifecycle-1', { script: 'export const meta = {}' })

      await vi.waitFor(() => {
        expect(cardsFor('capability_review')).toHaveLength(1)
      })
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
      expect(openStreamRequestIds()).toContain('wf-lifecycle-1')

      expect(waitingInputNotifications()).toEqual([
        expect.objectContaining({
          agentSlug: AGENT_SLUG,
          sessionId: SESSION_ID,
          request: expect.objectContaining({
            kind: 'capability_review',
            payload: expect.objectContaining({ capability: 'workflows' }),
          }),
        }),
      ])
    })

    it('completeCapabilityReview settles the entry, announces it, and clears awaiting', async () => {
      simulateToolUse('Workflow', 'wf-lifecycle-2', { script: 'export const meta = {}' })
      await vi.waitFor(() => {
        expect(openStreamRequestIds()).toHaveLength(1)
      })

      sessions().completeCapabilityReview(SESSION_ID, 'wf-lifecycle-2')

      expect(openStreamRequestIds()).toHaveLength(0)
      expect(
        sseEvents.filter(
          (e) => e.type === 'user_request_resolved' && e.requestId === 'wf-lifecycle-2',
        ),
      ).toHaveLength(1)
      // Derived awaiting: settling the review settles the wait. (Before the
      // flip this door emptied its store and broadcast but left the bit stuck
      // until later stream traffic cleared it — a pinned split-brain.)
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
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
      sessions().syncAwaiting()
    }

    it('a parked agent-scoped review keeps awaiting alive through tool_results and the cu clear', () => {
      parkAgentReview('mix-review-1')

      simulateToolUse('mcp__user-input__request_secret', 'mix-secret-1', {
        secretName: 'API_KEY',
        reason: 'Need it',
      })
      simulateToolUse('mcp__computer-use__computer_click', 'mix-cu-1', { x: 1, y: 2 })
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)

      // The secret resolves, but the cu entry AND the review are still open.
      sendToolResult('mix-secret-1')
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)

      // The cu entry resolves, but the review is still open.
      sessions().clearComputerUseRequest(SESSION_ID, 'mix-cu-1')
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)

      // The review settles — nothing is open anymore.
      userInputRequestManager.resolve('mix-review-1', 'answered')
      sessions().syncAwaiting()
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
    })

    it('the agent-wide sync cannot clear awaiting while a review remains open', () => {
      parkAgentReview('mix-review-2')
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)

      // Before the derived flip, the agent-level clear door trusted its
      // caller to verify no reviews remained — a caller that forgot cleared
      // awaiting under a live review. The projection makes that impossible:
      // sync recomputes from the registry, and the review is still in it.
      sessions().syncAwaiting()
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)

      // A stray tool_result on the session doesn't drop it either.
      sendToolResult('unknown-tool-id')
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)

      userInputRequestManager.resolve('mix-review-2', 'declined')
      sessions().syncAwaiting()
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
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
    kind: string
    surfacesToday: boolean
  }

  const SIDECHAIN_MATRIX: SidechainCase[] = [
    {
      label: 'browser input',
      toolName: 'mcp__user-input__request_browser_input',
      input: { message: 'Log in', requirements: [] },
      kind: 'browser_input',
      surfacesToday: true,
    },
    {
      label: 'script run',
      toolName: 'mcp__user-input__request_script_run',
      input: { script: 'sw_vers', explanation: 'Version', scriptType: 'shell' },
      kind: 'script_run',
      surfacesToday: true,
    },
    {
      label: 'computer use',
      toolName: 'mcp__computer-use__computer_click',
      input: { x: 1, y: 2 },
      kind: 'computer_use',
      surfacesToday: true,
    },
    {
      label: 'secret',
      toolName: 'mcp__user-input__request_secret',
      input: { secretName: 'API_KEY', reason: 'Need it' },
      kind: 'secret',
      surfacesToday: true,
    },
    {
      label: 'question',
      toolName: 'AskUserQuestion',
      input: {
        questions: [{ question: 'Pick DB', header: 'DB', options: [], multiSelect: false }],
      },
      kind: 'question',
      surfacesToday: true,
    },
    {
      label: 'connected account',
      toolName: 'mcp__user-input__request_connected_account',
      input: { toolkit: 'github', reason: 'Need access' },
      kind: 'connected_account',
      surfacesToday: true,
    },
    {
      label: 'file',
      toolName: 'mcp__user-input__request_file',
      input: { description: 'Upload a CSV' },
      kind: 'file',
      surfacesToday: true,
    },
    {
      label: 'remote MCP',
      toolName: 'mcp__user-input__request_remote_mcp',
      input: { url: 'https://example.com/mcp', name: 'Example', reason: 'Docs' },
      kind: 'remote_mcp',
      surfacesToday: true,
    },
  ]

  describe.each(SIDECHAIN_MATRIX)(
    'sidechain: $label (surfaces today: $surfacesToday)',
    ({ toolName, input, kind, surfacesToday }) => {
      function sendSidechainStreamToolUse(toolId: string, parentToolId = 'parent-task-1') {
        const send = (event: Frame) =>
          client.emit({
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
        client.emit({
          type: 'assistant',
          parent_tool_use_id: parentToolId,
          message: {
            content: [{ type: 'tool_use', id: toolId, name: toolName, input }],
          },
        })
      }

      it('subagent stream events: card broadcast and awaiting match the matrix', () => {
        sendSidechainStreamToolUse('side-stream-1')

        const cards = cardsFor(kind)
        expect(cards).toHaveLength(surfacesToday ? 1 : 0)
        expect(sessions().isAwaitingInput(SESSION_ID)).toBe(surfacesToday)
      })

      it('complete sidechain assistant message: card broadcast and awaiting match the matrix', () => {
        sendSidechainCompleteAssistantToolUse('side-complete-1')

        const cards = cardsFor(kind)
        expect(cards).toHaveLength(surfacesToday ? 1 : 0)
        expect(sessions().isAwaitingInput(SESSION_ID)).toBe(surfacesToday)
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
        client.emit({
          type: 'assistant',
          parent_tool_use_id: parentToolId,
          message: {
            content: [{ type: 'tool_use', id: toolId, name: toolName, input }],
          },
        })
        return
      }
      const send = (event: Frame) =>
        client.emit({ type: 'stream_event', parent_tool_use_id: parentToolId, event })
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
      client.emit({
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

      expect(cardsFor('secret')).toHaveLength(1)
      expect(openStreamRequestIds()).toHaveLength(1)
    })

    it('a sidechain tool_result resolves a dispatcher-surfaced kind: entry dropped, tool_result broadcast, awaiting cleared', () => {
      sendSidechainToolUse(
        'mcp__user-input__request_secret',
        'side-res-1',
        { secretName: 'SUB_KEY', reason: 'From a subagent' },
        'parent-res',
        'complete'
      )
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
      sseEvents.length = 0

      sendSidechainToolResult('side-res-1', 'parent-res')

      expect(sseEvents.filter((e) => e.type === 'tool_result')).toHaveLength(1)
      expect(openStreamRequestIds()).toHaveLength(0)
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
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
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)

      sendSidechainToolResult('side-q-1', 'parent-mix')
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)

      // Clearing the last computer-use entry now flips the light (shared rule).
      sessions().clearComputerUseRequest(SESSION_ID, 'side-cu-1')
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
    })

    it('an auto-approved script replay entry does not keep awaiting on after the last real ask resolves', () => {
      // A use_host_shell grant covers the script: it runs at once.
      const check = vi.spyOn(live.agents.get(AGENT_SLUG).computerUse, 'check').mockReturnValue('granted')
      sendSidechainToolUse(
        'mcp__user-input__request_script_run',
        'side-sr-auto',
        { script: 'sw_vers', explanation: 'Version', scriptType: 'shell' },
        'parent-auto',
        'complete'
      )
      expect(
        userInputRequestManager
          .getOpenRequestsForSession(AGENT_SLUG, SESSION_ID)
          .some((r) => r.id === 'side-sr-auto' && r.autoApproved === true)
      ).toBe(true)

      check.mockReturnValue('prompt_needed')
      sendSidechainToolUse(
        'mcp__user-input__request_secret',
        'side-real-1',
        { secretName: 'REAL_KEY', reason: 'A real ask' },
        'parent-auto',
        'complete'
      )
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)

      // The auto-approved script's replay entry is still tracked, but it is
      // not a real wait — resolving the secret must clear awaiting.
      sendSidechainToolResult('side-real-1', 'parent-auto')
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
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
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)

      // The subagent's ask resolves, but the review is still parked — the
      // waiting light must stay on.
      sendSidechainToolResult('side-blk-1', 'parent-blk')
      expect(openStreamRequestIds()).toHaveLength(0)
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)

      userInputRequestManager.resolve('side-review-1', 'answered')
      sessions().syncAwaiting()
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
    })
  })

  // ==========================================================================
  // The registry is the store: every kind lands in it as a typed envelope with
  // the right store label, and its derived projection is what the sessions'
  // isAwaitingInput reports.
  // ==========================================================================

  describe('registry entries', () => {
    it('every standard kind registers a typed entry and settles with its tool_result', async () => {
      for (const kindCase of STANDARD_KINDS) {
        const toolId = `shadow-${kindCase.kind}`
        simulateToolUse(kindCase.toolName, toolId, kindCase.input)

        await vi.waitFor(() => {
          expect(
            userInputRequestManager.getOpenRequestsForSession(AGENT_SLUG, SESSION_ID).map((r) => r.id)
          ).toContain(toolId)
        })
        const entry = userInputRequestManager
          .getOpenRequestsForSession(AGENT_SLUG, SESSION_ID)
          .find((r) => r.id === toolId)!
        expect(entry.kind, kindCase.label).toBe(kindCase.kind)
        expect(entry.scope).toEqual({ agentSlug: AGENT_SLUG, sessionId: SESSION_ID })

        expect(openStreamRequestIds()).toEqual([toolId])

        sendToolResult(toolId)
        expect(
          userInputRequestManager.getOpenRequestsForSession(AGENT_SLUG, SESSION_ID).map((r) => r.id)
        ).not.toContain(toolId)
        expect(userInputRequestManager.stats.recentResolutions.at(-1)).toMatchObject({
          id: toolId,
          kind: kindCase.kind,
          outcome: 'answered',
        })
      }
      expect(userInputRequestManager.stats.mismatches).toBe(0)
    })

    it('a stray main-path tool_result cannot evict the registry\'s computer-use entry (store-scoped resolve)', () => {
      simulateToolUse('mcp__computer-use__computer_click', 'shadow-cu-1', { x: 1, y: 2 })
      expect(userInputRequestManager.getStoreIdsForSession(AGENT_SLUG, SESSION_ID, 'computer_use')).toEqual([
        'shadow-cu-1',
      ])

      // Pinned divergence: the tool_result leaves the computer-use store
      // untouched. The registry mirrors the STORE, not the tool_result.
      sendToolResult('shadow-cu-1')
      expect(userInputRequestManager.getStoreIdsForSession(AGENT_SLUG, SESSION_ID, 'computer_use')).toEqual([
        'shadow-cu-1',
      ])

      sessions().clearComputerUseRequest(SESSION_ID, 'shadow-cu-1')
      expect(userInputRequestManager.getStoreIdsForSession(AGENT_SLUG, SESSION_ID, 'computer_use')).toEqual([])
      expect(userInputRequestManager.stats.recentResolutions.at(-1)).toMatchObject({
        id: 'shadow-cu-1',
        kind: 'computer_use',
        outcome: 'answered',
      })
      expect(userInputRequestManager.stats.mismatches).toBe(0)
    })

    it('parallel requests: the reported status tracks the projection across partial resolves', () => {
      simulateToolUse('mcp__user-input__request_secret', 'shadow-par-1', {
        secretName: 'API_KEY',
        reason: 'Need it',
      })
      simulateToolUse('AskUserQuestion', 'shadow-par-2', {
        questions: [{ question: 'Pick DB', header: 'DB', options: [], multiSelect: false }],
      })
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
      expect(userInputRequestManager.isSessionAwaiting(AGENT_SLUG, SESSION_ID)).toBe(true)

      // The first tool_result settles one request; the second card is still
      // parked, so bit and projection both stay on — the session's status
      // IS the projection.
      sendToolResult('shadow-par-1')
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
      expect(userInputRequestManager.isSessionAwaiting(AGENT_SLUG, SESSION_ID)).toBe(true)

      sendToolResult('shadow-par-2')
      expect(userInputRequestManager.isSessionAwaiting(AGENT_SLUG, SESSION_ID)).toBe(false)
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
      expect(userInputRequestManager.stats.mismatches).toBe(0)
    })

    it('capability review: complete settles the registry entry and the reported status together', async () => {
      mockAgentCapabilities.subagents = 'allow'
      mockAgentCapabilities.workflows = 'review'
      vi.mocked(client.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ grants: [] }),
      } as unknown as Response)

      simulateToolUse('Workflow', 'shadow-cap-1', { script: 'export const meta = {}' })
      await vi.waitFor(() => {
        expect(
          userInputRequestManager.getOpenRequestsForSession(AGENT_SLUG, SESSION_ID).map((r) => r.id)
        ).toContain('shadow-cap-1')
      })
      expect(
        userInputRequestManager.getOpenRequestsForSession(AGENT_SLUG, SESSION_ID)[0].kind
      ).toBe('capability_review')

      sessions().completeCapabilityReview(SESSION_ID, 'shadow-cap-1')
      expect(userInputRequestManager.getOpenRequestsForSession(AGENT_SLUG, SESSION_ID)).toHaveLength(0)
      expect(userInputRequestManager.isSessionAwaiting(AGENT_SLUG, SESSION_ID)).toBe(false)
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
      expect(userInputRequestManager.stats.mismatches).toBe(0)
    })

    it('the direct-clear doors record the caller\'s actual outcome, not a blanket answered', async () => {
      // Capability review declined via the decision route's door.
      mockAgentCapabilities.subagents = 'allow'
      mockAgentCapabilities.workflows = 'review'
      vi.mocked(client.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ grants: [] }),
      } as unknown as Response)
      simulateToolUse('Workflow', 'shadow-out-1', { script: 'export const meta = {}' })
      await vi.waitFor(() => {
        expect(
          userInputRequestManager.getOpenRequestsForSession(AGENT_SLUG, SESSION_ID).map((r) => r.id)
        ).toContain('shadow-out-1')
      })
      sessions().completeCapabilityReview(SESSION_ID, 'shadow-out-1', 'declined')
      expect(userInputRequestManager.stats.recentResolutions.at(-1)).toMatchObject({
        id: 'shadow-out-1',
        kind: 'capability_review',
        outcome: 'declined',
      })

      // Computer use denied, then a second one consumed by an execution failure.
      simulateToolUse('mcp__computer-use__computer_click', 'shadow-out-2', { x: 1, y: 2 })
      sessions().clearComputerUseRequest(SESSION_ID, 'shadow-out-2', 'declined')
      expect(userInputRequestManager.stats.recentResolutions.at(-1)).toMatchObject({
        id: 'shadow-out-2',
        kind: 'computer_use',
        outcome: 'declined',
      })

      simulateToolUse('mcp__computer-use__computer_click', 'shadow-out-3', { x: 3, y: 4 })
      sessions().clearComputerUseRequest(SESSION_ID, 'shadow-out-3', 'invalidated')
      expect(userInputRequestManager.stats.recentResolutions.at(-1)).toMatchObject({
        id: 'shadow-out-3',
        kind: 'computer_use',
        outcome: 'invalidated',
      })
      expect(userInputRequestManager.stats.mismatches).toBe(0)
    })

    it('unsubscribe drops every session-scoped registry entry as invalidated', () => {
      simulateToolUse('mcp__user-input__request_secret', 'shadow-drop-1', {
        secretName: 'API_KEY',
        reason: 'Need it',
      })
      simulateToolUse('mcp__computer-use__computer_click', 'shadow-drop-2', { x: 1, y: 2 })
      expect(userInputRequestManager.getOpenRequestsForSession(AGENT_SLUG, SESSION_ID)).toHaveLength(2)

      sessions().unsubscribe(SESSION_ID)
      expect(userInputRequestManager.getOpenRequestsForSession(AGENT_SLUG, SESSION_ID)).toHaveLength(0)
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
      sessions().syncAwaiting()
    }

    it('cancelAwaitingInput rejects recovered entries on the container despite the wire filter', async () => {
      sessions().recoverAwaitingInput(SESSION_ID, [
        { toolUseId: 'rec-cancel-1', toolName: 'AskUserQuestion' },
      ])
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
      // A recovered synthetic is a real wait in the registry but carries no
      // renderable payload, so no card event goes out for it — clients render
      // it from the transcript that triggered the recovery.
      expect(openStreamRequestIds()).toEqual(['rec-cancel-1'])
      expect(cardsFor('question')).toHaveLength(0)

      // The container-side cleanup still has to happen on cancel: the
      // recovered ask is exactly the one whose container pending may still be
      // live, and a late answer must not land on the abandoned turn.
      await sessions().cancelAwaitingInput(SESSION_ID)

      const rejectedUrls = live.runtime.containerFetch.mock.calls
        .map((call) => call[0])
        .filter((url): url is string => typeof url === 'string' && url.endsWith('/reject'))
      expect(rejectedUrls).toContain('/inputs/rec-cancel-1/reject')
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
    })

    it('a clean success mid-turn re-derives awaiting instead of blind-clearing it', () => {
      const globalEvents = globalFeedFromNow()
      // The runtime announces state-event authority: a result alone no
      // longer settles the session.
      client.emit({
        type: 'system',
        subtype: 'capabilities',
        session_state_events: true,
      })
      parkAgentReview('boundary-review-1')
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)

      client.emit({ type: 'result', subtype: 'success', num_turns: 1 })

      // Still active (the runtime owns idle) and the review is still open —
      // the session keeps reading awaiting, and no falling edge fires.
      expect(sessions().isActive(SESSION_ID)).toBe(true)
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
      expect(globalEvents().filter((e) => e.type === 'session_input_provided')).toHaveLength(0)

      // The review settles → the falling edge fires now, not never.
      userInputRequestManager.resolve('boundary-review-1', 'answered')
      sessions().syncAwaiting()
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
      expect(globalEvents().filter((e) => e.type === 'session_input_provided')).toHaveLength(1)
    })

    it('a runtime-started turn picks up an already-parked agent review', () => {
      const globalEvents = globalFeedFromNow()
      // End the current turn (result-driven idle — no authority announced).
      client.emit({ type: 'result', subtype: 'success', num_turns: 1 })
      expect(sessions().isActive(SESSION_ID)).toBe(false)

      // A review parks while the session is idle: an inactive session never
      // reads awaiting.
      parkAgentReview('boundary-review-2')
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)

      // The runtime starts the next (queued) turn itself — no POST, no
      // markActive. The self-heal must sync the projection too.
      client.emit({
        type: 'system',
        subtype: 'session_state_changed',
        state: 'running',
      })
      expect(sessions().isActive(SESSION_ID)).toBe(true)
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
      expect(globalEvents().filter((e) => e.type === 'session_awaiting_input')).toHaveLength(1)
    })

    it('a transport re-subscribe preserves parked requests, their registry entries, and replay', async () => {
      simulateToolUse('mcp__user-input__request_secret', 'resub-secret-1', {
        secretName: 'API_KEY',
        reason: 'Need it',
      })
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)

      // Reattach the stream (reconnect of an in-flight session). Only the
      // transport may turn over — the wait itself is still parked.
      const secondClient = createStreamClient()
      await sessions().subscribe(SESSION_ID, secondClient, SESSION_ID)

      // Replay store, registry entry, and cache all still agree, so a later
      // sync must NOT clear the genuinely parked ask.
      expect(openStreamRequestIds()).toEqual(['resub-secret-1'])
      expect(
        userInputRequestManager.getOpenRequestsForSession(AGENT_SLUG, SESSION_ID).map((r) => r.id)
      ).toContain('resub-secret-1')
      sessions().syncAwaiting()
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)

      // The parked ask resolves over the NEW transport and settles normally.
      secondClient.emit({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'resub-secret-1', content: 'resolved' },
          ],
        },
      })
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
      expect(openStreamRequestIds()).toHaveLength(0)
    })

    it('the markSessionIdle revert clears the awaiting cache an agent review had set', () => {
      parkAgentReview('boundary-review-3')
      // markActive's trailing sync picks up the open review.
      sessions().markActive(SESSION_ID)
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)

      // The optimistic send fails → revert. An inactive session is never
      // awaiting, review or not — the cache resets with isActive.
      sessions().markIdle(SESSION_ID)
      expect(sessions().isActive(SESSION_ID)).toBe(false)
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
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
      expect(userInputRequestManager.getOpenRequestsForSession(AGENT_SLUG, SESSION_ID)).toHaveLength(2)
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)

      sessions().completeRequest(SESSION_ID, 'par-secret-1', 'declined')

      // Registry and replay store both drop the declined ask NOW — a reload
      // must not resurrect it. The surviving question keeps the light on.
      expect(
        userInputRequestManager.getOpenRequestsForSession(AGENT_SLUG, SESSION_ID).map((r) => r.id),
      ).toEqual(['par-question-1'])
      expect(openStreamRequestIds()).toEqual(['par-question-1'])
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
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
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
    })

    it('the settled outcome is stamped for the messages route until the turn boundary clears it', () => {
      // The transcript still shows the declined call as unresolved while its
      // sibling holds the results back — the messages route stamps this
      // outcome so history consumers see a completed call.
      simulateToolUse('mcp__user-input__request_secret', 'par-stamp-1', {
        secretName: 'API_KEY',
        reason: 'Need it',
      })
      sessions().completeRequest(SESSION_ID, 'par-stamp-1', 'declined')
      expect(sessions().settledRequests(SESSION_ID).get('par-stamp-1')).toBe('declined')

      // The turn boundary lands the real results in the transcript — the
      // stamp expires with it.
      client.emit({ type: 'result', subtype: 'success', num_turns: 1 })
      expect(sessions().settledRequests(SESSION_ID).size).toBe(0)
    })

    it('reconcileTranscript answers the decided outcomes and parks again only the undecided asks of the running turn', () => {
      simulateToolUse('mcp__user-input__request_secret', 'par-decided-1', {
        secretName: 'API_KEY',
        reason: 'Need it',
      })
      sessions().completeRequest(SESSION_ID, 'par-decided-1', 'declined')
      const recover = vi.spyOn(sessions(), 'recoverAwaitingInput')

      const { settled } = sessions().reconcileTranscript(SESSION_ID, [
        { toolUseId: 'par-decided-1', toolName: 'mcp__user-input__request_secret', awaitsInput: true },
        { toolUseId: 'par-open-1', toolName: 'AskUserQuestion', awaitsInput: true },
        { toolUseId: 'par-earlier-1', toolName: 'AskUserQuestion', awaitsInput: false },
      ])

      expect(settled).toEqual({ 'par-decided-1': 'declined' })
      expect(recover).toHaveBeenCalledExactlyOnceWith(SESSION_ID, [{ toolUseId: 'par-open-1', toolName: 'AskUserQuestion' }])
      // A session that is not running parks nothing: its asks ended with its turn.
      recover.mockClear()
      expect(sessions().reconcileTranscript('idle-session', [{ toolUseId: 'q', toolName: 'AskUserQuestion', awaitsInput: true }])).toEqual({ settled: {} })
      expect(recover).not.toHaveBeenCalled()
    })

    it('settling the last parked ask clears awaiting, and callers without a sessionId derive it', () => {
      simulateToolUse('mcp__user-input__request_secret', 'par-solo-1', {
        secretName: 'API_KEY',
        reason: 'Need it',
      })
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)

      // Chat connectors know only the toolUseId — the registry entry's scope
      // supplies the session.
      sessions().completeRequest(undefined, 'par-solo-1', 'answered')

      expect(userInputRequestManager.getOpenRequestsForSession(AGENT_SLUG, SESSION_ID)).toHaveLength(0)
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
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
      client.emit({
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
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
      expect(userInputRequestManager.getOpenRequestsForSession(AGENT_SLUG, SESSION_ID)).toHaveLength(1)

      // The subagent finishes WITHOUT a tool_result for the parked ask
      // (killed, errored, or torn down) — sidechain 'result' is its terminal
      // frame. Nothing can answer the request anymore.
      client.emit({
        type: 'result',
        parent_tool_use_id: 'parent-dead-1',
        subtype: 'success',
      })

      expect(userInputRequestManager.getOpenRequestsForSession(AGENT_SLUG, SESSION_ID)).toHaveLength(0)
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
      expect(openStreamRequestIds()).toHaveLength(0)
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
          live.runtime.containerFetch.mock.calls.some(
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
      client.emit({
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
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
      expect(
        userInputRequestManager.getOpenRequestsForSession(AGENT_SLUG, SESSION_ID).map((r) => r.id),
      ).toEqual(['side-script-1'])

      client.emit({
        type: 'result',
        parent_tool_use_id: 'parent-script-1',
        subtype: 'success',
      })

      expect(userInputRequestManager.getOpenRequestsForSession(AGENT_SLUG, SESSION_ID)).toHaveLength(0)
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
      expect(
        userInputRequestManager.stats.recentResolutions.find((r) => r.id === 'side-script-1')
          ?.outcome,
      ).toBe('invalidated')
    })

    it("a sibling subagent's death leaves another subagent's parked request open", () => {
      sendSidechainToolUse('parent-alive-1', 'side-kept-1')
      sendSidechainToolUse('parent-dying-1', 'side-dropped-1')
      expect(userInputRequestManager.getOpenRequestsForSession(AGENT_SLUG, SESSION_ID)).toHaveLength(2)

      client.emit({
        type: 'result',
        parent_tool_use_id: 'parent-dying-1',
        subtype: 'success',
      })

      const open = userInputRequestManager.getOpenRequestsForSession(AGENT_SLUG, SESSION_ID)
      expect(open.map((r) => r.id)).toEqual(['side-kept-1'])
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
    })

    it("a main-agent request has no parent linkage and survives subagent completions", () => {
      simulateToolUse('mcp__user-input__request_secret', 'main-secret-1', {
        secretName: 'API_KEY',
        reason: 'Need it',
      })
      client.emit({
        type: 'result',
        parent_tool_use_id: 'parent-unrelated-1',
        subtype: 'success',
      })
      expect(
        userInputRequestManager.getOpenRequestsForSession(AGENT_SLUG, SESSION_ID).map((r) => r.id),
      ).toEqual(['main-secret-1'])
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
    })
  })

  // ==========================================================================
  // Unified wire: every registry transition broadcasts ONE typed event —
  // user_request_created / user_request_resolved — to the global stream
  // always and the session stream when session-scoped. Whatever mutation path
  // drives the transition, the wire sees it: that is the property that makes
  // silent settles impossible here.
  // ==========================================================================

  describe('unified wire broadcasts', () => {
    let globalEvents: () => Frame[]

    beforeEach(() => {
      globalEvents = globalFeedFromNow()
    })

    const createdFor = (events: Frame[], id: string) =>
      events.filter((e) => e.type === 'user_request_created' && e.request?.id === id)
    const resolvedFor = (events: Frame[], id: string) =>
      events.filter((e) => e.type === 'user_request_resolved' && e.requestId === id)

    it('a stream kind emits created on BOTH streams and resolved on its tool_result', () => {
      simulateToolUse('mcp__user-input__request_secret', 'wire-secret-1', {
        secretName: 'API_KEY',
        reason: 'Need it',
      })

      const created = createdFor(globalEvents(), 'wire-secret-1')
      expect(created).toHaveLength(1)
      expect(created[0].request.kind).toBe('secret')
      expect(created[0].request.scope).toEqual({ agentSlug: AGENT_SLUG, sessionId: SESSION_ID })
      expect(created[0].request.payload.secretName).toBe('API_KEY')
      expect(createdFor(sseEvents, 'wire-secret-1')).toHaveLength(1)

      sendToolResult('wire-secret-1')
      const resolved = resolvedFor(globalEvents(), 'wire-secret-1')
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
      client.emit({ type: 'result', subtype: 'success', num_turns: 1 })
      const resolved = resolvedFor(globalEvents(), 'wire-boundary-1')
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
      const created = createdFor(globalEvents(), 'wire-acl-1')
      expect(created).toHaveLength(1)
      expect(created[0].agentSlug).toBe(AGENT_SLUG)

      sendToolResult('wire-acl-1')
      const resolved = resolvedFor(globalEvents(), 'wire-acl-1')
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
      expect(createdFor(globalEvents(), 'wire-review-1')).toHaveLength(1)
      expect(createdFor(sseEvents, 'wire-review-1')).toHaveLength(0)

      userInputRequestManager.resolve('wire-review-1', 'declined')
      const resolved = resolvedFor(globalEvents(), 'wire-review-1')
      expect(resolved).toHaveLength(1)
      expect(resolved[0].outcome).toBe('declined')
    })

    it('a request without a verified agentSlug reaches no stream at all (fail closed)', () => {
      // The global-stream ACL filter forwards events without a top-level
      // agentSlug to EVERY authenticated user. The scope schema types the
      // slug as optional, so the broadcast boundary must fail closed rather
      // than trust that every registration path populated it.
      //
      // A request that names no agent has no agent to own it: no agent's
      // sessions hear of it, so it cannot reach a session stream either —
      // the reason a slugless registration is a bug to find rather than a
      // delivery to preserve.
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

      expect(createdFor(globalEvents(), 'wire-noslug-1')).toHaveLength(0)
      expect(createdFor(globalEvents(), 'wire-noslug-2')).toHaveLength(0)
      expect(createdFor(sseEvents, 'wire-noslug-1')).toHaveLength(0)
      expect(createdFor(sseEvents, 'wire-noslug-2')).toHaveLength(0)

      userInputRequestManager.resolve('wire-noslug-1', 'answered')
      expect(resolvedFor(globalEvents(), 'wire-noslug-1')).toHaveLength(0)
      expect(resolvedFor(sseEvents, 'wire-noslug-1')).toHaveLength(0)
    })

    it('recovery synthetics never hit the wire — the transcript renders those cards', () => {
      sessions().recoverAwaitingInput(SESSION_ID, [
        { toolUseId: 'wire-recovered-1', toolName: 'AskUserQuestion' },
      ])
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
      expect(createdFor(globalEvents(), 'wire-recovered-1')).toHaveLength(0)
      expect(createdFor(sseEvents, 'wire-recovered-1')).toHaveLength(0)
    })

    it('the real registration upgrades a recovered synthetic and finally hits the wire', () => {
      // Recovery beat the stream event (the GET-messages read raced the
      // container stream). Without the upgrade, the payload-less stub blocks
      // the real registration forever: clients never receive a renderable
      // user_request_created and the snapshot serves a stub the card guards
      // drop.
      sessions().recoverAwaitingInput(SESSION_ID, [
        { toolUseId: 'wire-upgrade-1', toolName: 'mcp__user-input__request_secret' },
      ])
      expect(createdFor(globalEvents(), 'wire-upgrade-1')).toHaveLength(0)

      simulateToolUse('mcp__user-input__request_secret', 'wire-upgrade-1', {
        secretName: 'API_KEY',
        reason: 'Need it',
      })

      const created = createdFor(globalEvents(), 'wire-upgrade-1')
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

  // ==========================================================================
  // Notification dispatch is driven by registry transitions
  // ==========================================================================

  describe('notification dispatch (registry-transition-driven)', () => {
    it('duplicate deliveries of the same request notify exactly ONCE', () => {
      // The subagent stream and the complete-assistant message can both carry
      // the same tool_use. The registry dedupes the ENTRY (first delivery
      // wins), and the notification must ride that dedupe — per-handler
      // triggering used to pop two OS notifications for one script approval.
      const input = { script: 'sw_vers', explanation: 'Version check', scriptType: 'shell' }
      const send = (via: 'stream' | 'complete') => {
        if (via === 'complete') {
          client.emit({
            type: 'assistant',
            parent_tool_use_id: 'parent-notif-1',
            message: {
              content: [
                { type: 'tool_use', id: 'notif-dup-1', name: 'mcp__user-input__request_script_run', input },
              ],
            },
          })
          return
        }
        const sendEvent = (event: Frame) =>
          client.emit({ type: 'stream_event', parent_tool_use_id: 'parent-notif-1', event })
        sendEvent({
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'notif-dup-1', name: 'mcp__user-input__request_script_run' },
        })
        sendEvent({
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
        })
        sendEvent({ type: 'content_block_stop' })
      }

      send('stream')
      send('complete')

      const forThisRequest = waitingInputNotifications().filter(
        (notification) => notification.request.kind === 'script_run',
      )
      expect(forThisRequest).toEqual([
        {
          kind: 'session_waiting_input',
          agentSlug: AGENT_SLUG,
          sessionId: SESSION_ID,
          request: expect.objectContaining({ kind: 'script_run' }),
        },
      ])
    })

    it('a review registered directly with the registry notifies like any other review', () => {
      // Since the registry became the pending-review store, registry-only
      // entries are decidable and sweepable — they must be noticeable too.
      userInputRequestManager.register({
        id: 'notif-review-1',
        kind: 'proxy_review',
        scope: { agentSlug: AGENT_SLUG },
        blocking: true,
        autoApproved: false,
        payload: { displayText: 'GET api.github.com /user' },
      })

      // Agent-scoped: attributed to the agent's active session.
      expect(live.host.sent('notification').filter((n) => n.kind === 'api_review_waiting')).toEqual([
        {
          kind: 'api_review_waiting',
          agentSlug: AGENT_SLUG,
          sessionId: SESSION_ID,
          reviewId: 'notif-review-1',
          displayText: 'GET api.github.com /user',
          reviewKind: 'api_request',
        },
      ])
    })

    it('a recovered synthetic does not notify; its real upgrade notifies once', () => {
      userInputRequestManager.register({
        id: 'notif-rec-1',
        kind: 'secret',
        scope: { agentSlug: AGENT_SLUG, sessionId: SESSION_ID },
        blocking: true,
        autoApproved: false,
        payload: { recovered: true },
      })
      expect(waitingInputNotifications()).toHaveLength(0)

      simulateToolUse('mcp__user-input__request_secret', 'notif-rec-1', {
        secretName: 'API_KEY',
        reason: 'Recovered then streamed',
      })
      expect(waitingInputNotifications().filter((n) => n.request.kind === 'secret')).toHaveLength(1)
    })
  })
})

// A session cloned into another agent replays the tool-use ids of its
// source, so the same request id can be open in two agents' stores at once.
// Each agent's sessions settle that agent's request and no other; and
// settling one agent's copy must not make the other's unreachable.
describe('request id ownership across agents', () => {
  beforeEach(() => live.reset())
  afterEach(() => live.reset())

  function registerInBoth(kind: 'secret' | 'computer_use') {
    for (const agentSlug of ['original', 'clone']) {
      userInputRequestManager.register({
        id: 'copied-tool-id',
        kind,
        scope: { agentSlug, sessionId: 'copied-session-id' },
        blocking: true,
        payload: kind === 'secret' ? { secretName: 'TOKEN' } : {},
      })
    }
  }

  it('completeInputRequest settles the named agent\'s request when another agent holds the same id', () => {
    // Every agent's store reports each transition to the router first.
    const report = vi.spyOn(userInputRequestManager, 'report')
    try {
      registerInBoth('secret')
      live.sessions('original').completeRequest('copied-session-id', 'copied-tool-id', 'answered')
      const resolvedOwners = report.mock.calls
        .map(([transition]) => transition)
        .filter((transition) => transition.type === 'resolved')
        .map((transition) => transition.request.scope.agentSlug)
      expect(resolvedOwners).toEqual(['original'])
      expect(userInputRequestManager.getOpenRequestsForAgent('original')).toHaveLength(0)
      expect(userInputRequestManager.getOpenRequestsForAgent('clone')).toHaveLength(1)
    } finally {
      report.mockRestore()
    }
  })

  it('clearing one agent\'s copy leaves the other agent\'s reachable by bare id', () => {
    registerInBoth('computer_use')
    userInputRequestManager.dropSessionRequests('original', 'copied-session-id')
    expect(userInputRequestManager.getOpenRequestsForAgent('original')).toHaveLength(0)
    expect(userInputRequestManager.getOpenRequest('copied-tool-id')?.scope.agentSlug).toBe('clone')
    expect(userInputRequestManager.getOpenRequest('copied-tool-id', 'clone')?.scope.agentSlug).toBe('clone')
    expect(userInputRequestManager.getOpenRequest('copied-tool-id', 'original')).toBeNull()
  })
})
