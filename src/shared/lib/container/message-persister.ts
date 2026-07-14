import type { ContainerClient, StreamMessage, SlashCommandInfo } from './types'
import type { SessionUsage, SessionActivity } from '@shared/lib/types/agent'
import type { AskUserQuestionInput } from '@shared/lib/tool-definitions/ask-user-question'
import type { RequestSecretInput } from '@shared/lib/tool-definitions/request-secret'
import type { RequestFileInput } from '@shared/lib/tool-definitions/request-file'
import type { RequestConnectedAccountInput } from '@shared/lib/tool-definitions/request-connected-account'
import type { RequestRemoteMcpInput } from '@shared/lib/tool-definitions/request-remote-mcp'
import type { RequestBrowserInputInput } from '@shared/lib/tool-definitions/request-browser-input'
import type { RequestScriptRunInput } from '@shared/lib/tool-definitions/request-script-run'
import { isBlockingUserInputToolName } from '@shared/lib/tool-definitions/user-input-tools'
import { classifyResult } from './result-classification'
import { parseBackgroundTasksChanged } from './background-tasks-changed'
import { parseCommandLifecycle } from './command-lifecycle'
import { captureException } from '@shared/lib/error-reporting'
import {
  createScheduledTask,
  listPendingScheduledTasks,
  getScheduledTask,
  cancelScheduledTask,
  pauseScheduledTask,
  resumeScheduledTask,
  type ScheduledTask,
} from '@shared/lib/services/scheduled-task-service'
import {
  createWebhookTrigger,
  listActiveWebhookTriggers,
  cancelWebhookTriggerWithCleanup,
  getWebhookTrigger,
  resolvePlatformMemberForCandidates,
  updateWebhookTriggerName,
} from '@shared/lib/services/webhook-trigger-service'
import {
  createPlatformWebhookEndpoint,
  updatePlatformWebhookEndpoint,
  disablePlatformWebhookEndpoint,
  listPlatformWebhookEvents,
  testPlatformWebhookFilter,
} from '@shared/lib/services/webhook-endpoints-client'
import {
  createWebhookEndpointInputSchema,
  updateWebhookEndpointInputSchema,
  inspectWebhookEventsInputSchema,
  extractEndpointUrl,
  CUSTOM_WEBHOOK_TRIGGER_TYPE,
  type WebhookEndpointEvent,
} from '@shared/lib/services/webhook-endpoint-schema'
import { getPlatformAccessToken, getStoredPlatformMemberId } from '@shared/lib/services/platform-auth-service'
import {
  getAvailableTriggers,
  enableComposioTrigger,
  deleteComposioTrigger,
} from '@shared/lib/composio/triggers'
import { isPlatformComposioActive } from '@shared/lib/composio/client'
import { db } from '@shared/lib/db'
import { connectedAccounts } from '@shared/lib/db/schema'
import { eq } from 'drizzle-orm'
import { resolveTimezoneForAgent } from '@shared/lib/services/timezone-resolver'
import { getFrequencyWarning, getScheduleCountWarning, validateScheduleExpression } from '@shared/lib/services/schedule-parser'
import { getSessionMetadata, updateSessionMetadata } from '@shared/lib/services/session-service'
import { notificationManager } from '@shared/lib/notifications/notification-manager'
import { trackServerEvent } from '@shared/lib/analytics/server-analytics'
import { VALID_SCRIPT_TYPES, getAgentCapabilitySettings } from '@shared/lib/config/settings'
import { getActiveLlmProvider, getModelContextWindow } from '@shared/lib/llm-provider'
import { computerUsePermissionManager } from '@shared/lib/computer-use/permission-manager'
import { resolveAppFromWindowRef } from '@shared/lib/computer-use/executor'
import { computerUseMethodFromToolName, getRequiredPermissionLevel, resolveTargetApp, type ComputerUsePermissionLevel } from '@shared/lib/computer-use/types'
import { getAgentSessionsDir } from '@shared/lib/utils/file-storage'
import { WorkflowJournalTailer } from './workflow-journal-tailer'
import { SubagentCapture } from './subagent-capture'
import * as path from 'path'
// Per-subagent streaming state (supports multiple concurrent background agents)
interface SubagentStreamingState {
  agentId: string | null
  currentText: string
  currentToolUse: { id: string; name: string } | null
  currentToolInput: string
  isBackground: boolean // True for run_in_background agents — completion comes via sidechain 'result', not tool_result
}

// Tracks streaming state for SSE broadcasts
// In the file-based model, messages are stored in JSONL files by the Claude SDK.
// This class only handles SSE streaming updates to the frontend, not persistence.
interface StreamingState {
  currentText: string
  isStreaming: boolean
  currentToolUse: { id: string; name: string } | null
  currentToolInput: string // Accumulated partial JSON input for current tool
  currentThinking?: boolean // True while an extended-thinking content block is streaming
  isActive: boolean // True from user message until result received
  isInterrupted: boolean // True after user interrupts, prevents race conditions
  isCompacting: boolean // True while compaction is in progress, cleared on compact completion
  agentSlug?: string // The agent slug for this session
  lastContextWindow: number // Last known context window size (default 200k)
  lastAssistantUsage: SessionUsage | null // Per-call usage from most recent assistant message
  completedSubagentIds: Set<string> // agentIds of subagents that have completed (to avoid re-discovery)
  // Per-subagent streaming state, keyed by parent tool_use ID (supports concurrent background agents)
  activeSubagents: Map<string, SubagentStreamingState>
  slashCommands: SlashCommandInfo[] // Available slash commands from SDK
  isAwaitingInput: boolean // True when session is waiting for user input (e.g., secret, file, question)
  // TODO: computer-use and the other input requests are tracked in two separate maps with
  // divergent clearing rules (this one is cleared only via explicit route calls; pendingInputRequests
  // below is cleared on tool_result + turn boundaries — so e.g. interrupt clears one but not the
  // other). Unify into a single store + single SSE replay loop. Tracked: SUP-213 (sibling of SUP-163).
  pendingComputerUseRequests: Map<string, { toolUseId: string; method: string; params: Record<string, unknown>; permissionLevel: string; appName?: string; agentSlug?: string }> // Pending computer use requests awaiting user approval (keyed by toolUseId)
  // Pending user-input request broadcasts (secret/connected_account/question/file/remote_mcp/
  // script_run/browser_input), keyed by toolUseId. These are one-shot SSE events, so a client
  // that connects AFTER they fire would never see them; we store the exact payloads here and the
  // /stream route replays them on (re)connect. Cleared at turn boundaries (session_active/idle).
  pendingInputRequests: Map<string, { type: string; toolUseId: string; [k: string]: unknown }>
  lastApiErrorCode: string | null // SDK error code from last assistant message (e.g., 'authentication_failed', 'rate_limit')
  // Backgrounded Bash commands + dynamic workflows still running, keyed by the SDK task_id.
  // For workflows we also carry the launching tool's id, the meta.name, and — once the
  // Workflow tool result arrives — the real on-disk runId (`wf_…`), which is DISTINCT from
  // the task_id and is the name of the `subagents/workflows/<runId>` dir.
  activeBackgroundTasks: Map<
    string,
    { startedAt: number; isWorkflow?: boolean; isSubagent?: boolean; toolUseId?: string; workflowName?: string; runId?: string }
  >
  // Latest system/background_tasks_changed snapshot (SDK >= 0.3.203): the full
  // authoritative set of live background task ids. null until the first frame
  // (older runtimes never send one — all gates then fall back to the
  // incremental map alone). The snapshot LEADS per-task signals on the wire,
  // so it may briefly announce a task the map hasn't registered yet (metadata
  // arrives with the following task_started/tool-result) — liveness gates use
  // the UNION of both.
  bgTasksSnapshot: Set<string> | null
  pendingDeliverFiles: Map<string, { filePath: string; description?: string }> // deliver_file tool calls awaiting their tool_result, keyed by tool_use ID
  // True when the runtime publishes session_state_changed events — then IT is
  // the idle authority: a 'result' alone does not end the session (queued
  // messages or background work may keep the runtime non-idle, and it knows —
  // we don't). Set by the container's stream `capabilities` announcement (sent
  // on WebSocket connect, so it always precedes any relayed result), with
  // observed state events as a fallback signal. Discovery-by-first-event alone
  // is NOT sufficient: a CLI run starts in 'running' and publishes its first
  // transition — idle — only at the END of its first turn, which is too late
  // when a queued message makes the runtime continue past the first result.
  // When false (older container builds), results drive idle as before.
  stateEventsAuthority: boolean
  // Subtype of the most recent result — gates the completion notification when
  // idle arrives via session_state_changed (resume-exits pause, not finish).
  lastResultSubtype: string | null
  isRetrying: boolean // True while an API retry is in progress, cleared when the next message starts
}

// Lazy import to break circular dependency: container-manager -> message-persister
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _containerManagerModule: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _containerManagerImport: Promise<any> | null = null
async function getContainerManager() {
  if (!_containerManagerModule) {
    // Cache the in-flight import promise, not just the resolved module: concurrent
    // callers (e.g. a fire-and-forget tool handler resolving while cancelAwaitingInput
    // rejects) would otherwise each see a null module and start their own
    // import('./container-manager'), racing redundant dynamic imports of a module
    // that sits on the container-manager <-> message-persister circular edge.
    if (!_containerManagerImport) _containerManagerImport = import('./container-manager')
    _containerManagerModule = await _containerManagerImport
  }
  return _containerManagerModule.containerManager
}

// Tool inputs whose streamed JSON may carry an HMAC signing secret in a
// `secret` field. That secret is a shared credential — anyone holding it can
// forge signed webhooks — so it must never render in the live transcript / go
// out over SSE. (The SDK still persists the raw tool_use to the container's
// JSONL; that is agent-supplied and container-local. This masks the one path
// the host controls: the UI broadcast.)
const SECRET_BEARING_TOOL_NAMES = new Set([
  'create_webhook_endpoint',
  'update_webhook_endpoint',
])

// One inspection line per stored delivery. Bodies are already previews
// (proxy caps at 2KB); cap harder here — this text lands in the agent's
// context and 50 events × 2KB would crowd out the actual work.
const INSPECT_BODY_PREVIEW_CHARS = 200

export function formatWebhookEventLine(event: WebhookEndpointEvent): string {
  const filterNote = event.filter
    ? ` · filter: ${event.filter.outcome}${event.filter.outcome === 'error' && event.filter.error ? ` (${event.filter.error})` : ''}`
    : ''
  const kindNote = event.kind === 'handshake' ? ' · handshake' : ''
  const verifiedNote = event.kind === 'event' ? (event.verified ? ' · verified' : ' · unverified') : ''
  const body = typeof event.body === 'string' && event.body
    ? event.body.slice(0, INSPECT_BODY_PREVIEW_CHARS) +
      (event.body.length > INSPECT_BODY_PREVIEW_CHARS || event.body_truncated ? '…' : '')
    : '(empty body)'
  return `- ${event.id} · ${event.created_at} · ${event.status}${kindNote}${verifiedNote}${filterNote}\n  ${event.method ?? 'POST'} ${event.content_type ?? ''} — ${body}`
}

/**
 * Mask the value of a `secret` field in (possibly still-streaming) tool-input
 * JSON. Idempotent across deltas: the whole accumulated buffer is re-masked
 * each time, and a value whose closing quote hasn't streamed yet is masked as
 * far as it has arrived.
 */
export function redactStreamedToolInput(toolName: string | undefined, partialInput: string): string {
  if (!toolName) return partialInput
  // MCP tools stream under their qualified name (`mcp__<server>__<tool>`);
  // match on the bare tool name so the allowlist can't silently miss the wire
  // format.
  const bareName = toolName.startsWith('mcp__') ? toolName.slice(toolName.lastIndexOf('__') + 2) : toolName
  if (!SECRET_BEARING_TOOL_NAMES.has(bareName)) return partialInput
  // Replace the JSON string value after `"secret":"` with `***`, stopping at
  // the (unescaped) closing quote — which is left intact when present.
  return partialInput.replace(/("secret"\s*:\s*")(?:\\.|[^"\\])*/g, '$1***')
}

// TODO this file is too big, this class is HUGE. Needs breaking up
class MessagePersister {
  private streamingStates: Map<string, StreamingState> = new Map()
  // "Allow for this session" capability grants, keyed by sessionId. Display
  // bookkeeping ONLY — enforcement lives in the container (which persists its
  // copy with the session). Once granted, launches auto-allow container-side
  // with no pending entry, so we must stop broadcasting review cards for them.
  private sessionCapabilityGrants: Map<string, Set<'subagents' | 'workflows'>> = new Map()
  private subscriptions: Map<string, () => void> = new Map()
  private sseClients: Map<string, Set<(data: unknown) => void>> = new Map()
  // Per-run journal tailers driving the live workflow drawer, keyed `${sessionId}::${runId}`
  private workflowTailers: Map<string, WorkflowJournalTailer> = new Map()
  // Global notification subscribers (e.g., Electron main process)
  private globalNotificationClients: Set<(data: unknown) => void> = new Set()
  // Track container clients per session for reconnection
  private containerClients: Map<string, ContainerClient> = new Map()
  // Callback to request stopping a container (registered by container-manager)
  private onStopContainerRequested: ((agentSlug: string) => void) | null = null
  // Dev-only capture for building fixture replay tests
  private capture: SubagentCapture | null = SubagentCapture.fromEnv()

  // In-flight subscribe promises, keyed by sessionId. Concurrent
  // subscribeToSession() calls for the same session share the underlying
  // promise so we don't double-install listeners or double-tear-down state.
  private subscribingNow: Map<string, Promise<void>> = new Map()

  // Subscribe to a session's messages for SSE streaming.
  // Returns a promise that resolves when the WebSocket connection is ready.
  // Idempotent: concurrent calls for the same sessionId await the same in-flight
  // subscription instead of racing each other (which would re-init state and
  // leak listeners).
  async subscribeToSession(
    sessionId: string,
    client: ContainerClient,
    containerSessionId: string,
    agentSlug?: string
  ): Promise<void> {
    const inFlight = this.subscribingNow.get(sessionId)
    if (inFlight) return inFlight
    const promise = this.doSubscribeToSession(sessionId, client, containerSessionId, agentSlug)
      .finally(() => {
        this.subscribingNow.delete(sessionId)
      })
    this.subscribingNow.set(sessionId, promise)
    return promise
  }

  private async doSubscribeToSession(
    sessionId: string,
    client: ContainerClient,
    containerSessionId: string,
    agentSlug?: string
  ): Promise<void> {
    // Preserve session-lifecycle flags across (re-)subscribe so callers that
    // markSessionActive *before* subscribing (e.g. x-agent sync invoke) and
    // SSE reconnects of in-flight sessions don't lose their "currently busy"
    // state when the listener reattaches.
    const prior = this.streamingStates.get(sessionId)
    const priorIsActive = prior?.isActive ?? false
    const priorIsAwaitingInput = prior?.isAwaitingInput ?? false
    const priorBackgroundTasks = prior?.activeBackgroundTasks ?? new Map()

    // Unsubscribe if already subscribed (this also clears state, which is why
    // we captured the flags above)
    this.unsubscribeFromSession(sessionId)

    // Initialize state
    this.streamingStates.set(sessionId, {
      currentText: '',
      isStreaming: false,
      currentToolUse: null,
      currentToolInput: '',
      isActive: priorIsActive,
      isInterrupted: false,
      isCompacting: false,
      agentSlug,
      lastContextWindow: 200_000,
      lastAssistantUsage: null,
      completedSubagentIds: new Set(),
      activeSubagents: new Map(),
      slashCommands: [],
      isAwaitingInput: priorIsAwaitingInput,
      pendingComputerUseRequests: new Map(),
      pendingInputRequests: new Map(),
      lastApiErrorCode: null,
      activeBackgroundTasks: priorBackgroundTasks,
      bgTasksSnapshot: prior?.bgTasksSnapshot ?? null,
      pendingDeliverFiles: new Map(),
      stateEventsAuthority: prior?.stateEventsAuthority ?? false,
      lastResultSubtype: null,
      isRetrying: false,
    })

    // Store container client for reconnection checks
    this.containerClients.set(sessionId, client)

    // Subscribe to the container's message stream
    const { unsubscribe, ready } = client.subscribeToStream(
      containerSessionId,
      (message) => this.handleMessage(sessionId, message)
    )

    this.subscriptions.set(sessionId, unsubscribe)

    if (this.capture && agentSlug) {
      const subagentsDir = path.join(getAgentSessionsDir(agentSlug), sessionId, 'subagents')
      await this.capture.snapshotSubagentsDir(sessionId, subagentsDir, 'subscribe')
      await this.capture.recordNote(sessionId, 'subscribe', { agentSlug, containerSessionId })
    }

    // Wait for the WebSocket connection to be established
    await ready
  }

  // Unsubscribe from a session
  unsubscribeFromSession(sessionId: string): void {
    const unsubscribe = this.subscriptions.get(sessionId)
    if (unsubscribe) {
      unsubscribe()
      this.subscriptions.delete(sessionId)
    }
    this.streamingStates.delete(sessionId)
    this.containerClients.delete(sessionId)
  }

  // Single idle finalizer — flips state and broadcasts to session + global
  // listeners. Used by the result handler (legacy result-driven idle), the
  // session_state_changed handler (authoritative idle), and markSessionInactive.
  private finalizeIdle(sessionId: string, state: StreamingState): void {
    state.isActive = false
    this.broadcastToSSE(sessionId, { type: 'session_idle', isActive: false })
    this.broadcastGlobal({
      type: 'session_idle',
      sessionId,
      agentSlug: state.agentSlug,
      isActive: false,
    })
  }

  // Check if a session is currently active (processing user request)
  isSessionActive(sessionId: string): boolean {
    const state = this.streamingStates.get(sessionId)
    return state?.isActive ?? false
  }

  // Wait until a session is no longer active (i.e. a 'result' message arrived,
  // it was interrupted, or the connection closed). Polls streamingState because
  // there's no single "done" event — multiple code paths (handleMessage 'result',
  // markSessionInterrupted, markSessionInactive) clear isActive.
  //
  // requireActiveFirst (default true): require observing isActive=true at least once
  // before resolving. Guards against the race where waitForIdle is called before the
  // session has fully started — without this, an empty/missing state resolves instantly
  // and the caller thinks the agent finished with no output. Pass false for callers
  // that explicitly want "resolve if idle now" semantics.
  // observeMs (default 2000): how long to wait for the session to become active before
  // giving up with an error (only when requireActiveFirst=true).
  waitForIdle(
    sessionId: string,
    opts?: {
      timeoutMs?: number
      signal?: AbortSignal
      requireActiveFirst?: boolean
      observeMs?: number
    },
  ): Promise<void> {
    const timeoutMs = opts?.timeoutMs ?? 10 * 60 * 1000 // 10 min default
    const requireActiveFirst = opts?.requireActiveFirst ?? true
    const observeMs = opts?.observeMs ?? 2000
    return new Promise<void>((resolve, reject) => {
      const startedAt = Date.now()
      let everActive = false
      let timer: ReturnType<typeof setTimeout> | null = null

      const cleanup = () => {
        if (timer) clearTimeout(timer)
        opts?.signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = () => {
        cleanup()
        reject(new Error('waitForIdle aborted'))
      }
      if (opts?.signal) {
        if (opts.signal.aborted) {
          reject(new Error('waitForIdle aborted'))
          return
        }
        opts.signal.addEventListener('abort', onAbort, { once: true })
      }

      const tick = () => {
        const state = this.streamingStates.get(sessionId)
        if (state?.isActive) everActive = true

        if (!state || !state.isActive) {
          if (requireActiveFirst && !everActive) {
            // Haven't seen activity yet — keep observing briefly in case the
            // session is still spinning up. After observeMs, give up cleanly.
            if (Date.now() - startedAt > observeMs) {
              cleanup()
              reject(new Error('waitForIdle: session never became active'))
              return
            }
          } else {
            cleanup()
            resolve()
            return
          }
        }
        if (Date.now() - startedAt > timeoutMs) {
          cleanup()
          reject(new Error(`waitForIdle timeout after ${timeoutMs}ms`))
          return
        }
        timer = setTimeout(tick, 250)
      }
      tick()
    })
  }

  // Check if a session is waiting for user input
  isSessionAwaitingInput(sessionId: string): boolean {
    const state = this.streamingStates.get(sessionId)
    return state?.isAwaitingInput ?? false
  }

  /**
   * Project the session's streaming state onto a single activity label, using
   * the same precedence as the app's activity indicator. Streamed assistant
   * TEXT (not a thinking or tool block) owns the reply surface, so it yields the
   * placeholder; a thinking/tool block does not. See {@link SessionActivity}.
   */
  private computeActivity(state: StreamingState): SessionActivity {
    if (!state.isActive) return 'idle'
    if (state.isAwaitingInput) return 'awaiting'
    // Mirror the app's busy precedence exactly: compacting > retrying > thinking
    // > working. Checked BEFORE 'streaming' so a stale isStreaming (e.g. an
    // api_retry mid-stream) can't make chat yield the placeholder while the app
    // honestly shows "Compacting…"/"Retrying…" for the same underlying state.
    if (state.isCompacting) return 'compacting'
    if (state.isRetrying) return 'retrying'
    if (state.currentThinking) return 'thinking'
    // Assistant TEXT streaming (not a tool block) owns the reply surface, so it
    // yields the placeholder. Thinking is already handled above.
    if (state.isStreaming && !state.currentToolUse) return 'streaming'
    return 'working'
  }

  // Public snapshot of the activity — the chat manager's per-session tick samples it
  // each interval, and the subscribe-time reconcile reads it for a cold start.
  getSessionActivity(sessionId: string): SessionActivity {
    const state = this.streamingStates.get(sessionId)
    return state ? this.computeActivity(state) : 'idle'
  }

  // Get pending computer use requests for a session (for SSE replay on reconnect)
  getPendingComputerUseRequests(sessionId: string): Array<{ toolUseId: string; method: string; params: Record<string, unknown>; permissionLevel: string; appName?: string; agentSlug?: string }> {
    const state = this.streamingStates.get(sessionId)
    if (!state) return []
    return Array.from(state.pendingComputerUseRequests.values())
  }

  // Get pending user-input request broadcasts for a session (for SSE replay on (re)connect).
  // Returns the exact event payloads that were broadcast, so the route can re-send them verbatim.
  getPendingInputRequests(sessionId: string): Array<{ type: string; toolUseId: string; [k: string]: unknown }> {
    const state = this.streamingStates.get(sessionId)
    if (!state) return []
    return Array.from(state.pendingInputRequests.values())
  }

  // Record an "Allow for this session" capability grant (decision route calls
  // this when the user picks session scope) so later launches in the session
  // don't produce review cards the container will never wait on.
  grantSessionCapability(sessionId: string, capability: 'subagents' | 'workflows'): void {
    const grants = this.sessionCapabilityGrants.get(sessionId) ?? new Set()
    grants.add(capability)
    this.sessionCapabilityGrants.set(sessionId, grants)
  }

  hasSessionCapabilityGrant(sessionId: string, capability: 'subagents' | 'workflows'): boolean {
    return this.sessionCapabilityGrants.get(sessionId)?.has(capability) ?? false
  }

  // Clear a pending computer use request (after approval/rejection)
  clearPendingComputerUseRequest(sessionId: string, toolUseId: string): void {
    const state = this.streamingStates.get(sessionId)
    if (state) {
      state.pendingComputerUseRequests.delete(toolUseId)
      // Broadcast so the sidebar updates immediately.
      // Don't clear isAwaitingInput here — other input types (secrets, questions, etc.)
      // may still be pending. The flag is cleared when the tool result arrives in the stream.
      if (state.pendingComputerUseRequests.size === 0) {
        this.broadcastGlobal({
          type: 'session_input_provided',
          sessionId,
          agentSlug: state.agentSlug,
        })
      }
    }
  }

  // When a new message arrives while the session is awaiting user input, cancel the
  // pending request(s) so the message starts a fresh turn instead of deadlocking behind
  // the blocked tool.
  //
  // We interrupt FIRST — aborting the parked query outright — then cleanup-reject each
  // pending request. Order matters: rejecting first returns a tool result and RESUMES the
  // turn, letting the model emit a filler reply ("Go ahead …") that the user's forwarded
  // message then anchors to (it reads as a reply to the filler, not to the original ask).
  // Aborting at the parked point means the model never receives a tool result and never
  // speaks. The abort also unwinds a subagent's parked Task, so every awaiting type —
  // top-level (question / secret / file / connected_account / remote_mcp) and subagent
  // (browser_input / script_run / computer_use) — takes this one path. After the abort the
  // reject is pure cleanup: its reason is never read by the model.
  //
  // No-op when the session is not awaiting input. (This guard also makes rapid double-messages
  // idempotent when sends are serialized — the chat path serializes per chat via messageQueues;
  // the app send route does not, so two truly concurrent sends there can both pass it.)
  // Interrupt/reject failures are swallowed: a best-effort cancel must never block the message.
  async cancelAwaitingInput(sessionId: string, agentSlug: string): Promise<void> {
    if (!this.isSessionAwaitingInput(sessionId)) return

    // Snapshot the pending tool ids from BOTH maps before interrupting. pendingInputRequests holds
    // the broadcast types (cleared by markSessionInterrupted's session_idle); computer_use lives in
    // its own pendingComputerUseRequests map, which that broadcast does NOT clear.
    const inputRequestIds = this.getPendingInputRequests(sessionId).map((r) => r.toolUseId)
    const computerUseIds = this.getPendingComputerUseRequests(sessionId).map((r) => r.toolUseId)

    // Interrupt FIRST: abort the parked query so it can never resume into a filler reply.
    await this.interruptContainerSession(agentSlug, sessionId).catch(
      (e) => console.error(`[MessagePersister] cancelAwaitingInput interrupt failed for ${sessionId}:`, e),
    )
    await this.markSessionInterrupted(sessionId)

    // Clear the host-side computer_use bookkeeping explicitly — session_idle only clears
    // pendingInputRequests, so a leftover entry would replay a phantom approval card on reconnect.
    const state = this.streamingStates.get(sessionId)
    for (const id of computerUseIds) state?.pendingComputerUseRequests.delete(id)

    // Cleanup-reject each pending request on the CONTAINER: the query is already aborted, so the
    // reason is never read by the model — this just clears the container-side pending entry so a
    // late resolve/tap can't land on an abandoned request.
    for (const toolUseId of [...inputRequestIds, ...computerUseIds]) {
      await this.rejectContainerInput(agentSlug, toolUseId, 'Superseded: the user sent a new message.').catch(
        (e) => console.error(`[MessagePersister] cancelAwaitingInput reject failed for ${toolUseId}:`, e),
      )
    }
  }

  // Get available slash commands for a session
  getSlashCommands(sessionId: string): SlashCommandInfo[] {
    return this.streamingStates.get(sessionId)?.slashCommands ?? []
  }

  // Set slash commands for a session (from container session creation response)
  setSlashCommands(sessionId: string, commands: SlashCommandInfo[]): void {
    const state = this.streamingStates.get(sessionId)
    if (state) {
      state.slashCommands = commands
    }
  }

  getActiveBackgroundTasks(sessionId: string): Array<{ taskId: string; startedAt: number; isWorkflow?: boolean; isSubagent?: boolean }> {
    const state = this.streamingStates.get(sessionId)
    if (!state) return []
    return Array.from(state.activeBackgroundTasks.entries()).map(([taskId, info]) => ({
      taskId,
      startedAt: info.startedAt,
      isWorkflow: info.isWorkflow,
      isSubagent: info.isSubagent,
    }))
  }

  // Check if a session has an active subscription
  isSubscribed(sessionId: string): boolean {
    return this.subscriptions.has(sessionId)
  }

  // Check if any session for a given agent is currently active (processing)
  hasActiveSessionsForAgent(agentSlug: string): boolean {
    for (const [, state] of this.streamingStates) {
      if (state.agentSlug === agentSlug && state.isActive) {
        return true
      }
    }
    return false
  }

  // Return the IDs of all active sessions for a given agent.
  // Used to attribute agent-scoped events (e.g. proxy reviews) to the
  // session(s) actually running — mirrors the sidebar heuristic in
  // agents.ts that lights up `isActive && hasAgentLevelReviews`.
  getActiveSessionIdsForAgent(agentSlug: string): string[] {
    const ids: string[] = []
    for (const [sessionId, state] of this.streamingStates) {
      if (state.agentSlug === agentSlug && state.isActive) {
        ids.push(sessionId)
      }
    }
    return ids
  }

  // Check if any session for a given agent is awaiting user input
  hasSessionsAwaitingInputForAgent(agentSlug: string): boolean {
    for (const [, state] of this.streamingStates) {
      if (state.agentSlug === agentSlug && state.isAwaitingInput) {
        return true
      }
    }
    return false
  }

  // Mark all sessions for an agent as inactive and clean up subscriptions (e.g., when container stops)
  markAllSessionsInactiveForAgent(agentSlug: string): void {
    for (const [sessionId, state] of this.streamingStates) {
      if (state.agentSlug === agentSlug) {
        if (state.isActive) {
          console.log(`[MessagePersister] Marking session ${sessionId} inactive (container stopped)`)
          this.markSessionInactive(sessionId, state)
        }
        // Clean up stale WebSocket subscription so next message re-subscribes to the new container
        const unsubscribe = this.subscriptions.get(sessionId)
        if (unsubscribe) {
          unsubscribe()
          this.subscriptions.delete(sessionId)
        }
        this.containerClients.delete(sessionId)
      }
    }
  }

  // Broadcast to global notification clients only (e.g., sidebar updates, Electron main process)
  // Does NOT broadcast to session-specific SSE clients — use broadcastToSSE for that.
  broadcastGlobal(data: unknown): void {
    for (const client of this.globalNotificationClients) {
      try {
        client(data)
      } catch (error) {
        console.error('[SSE] Error sending to global notification client:', error)
      }
    }
  }

  // Add a global notification subscriber (receives all os_notification events)
  addGlobalNotificationClient(callback: (data: unknown) => void): () => void {
    this.globalNotificationClients.add(callback)

    // Return unsubscribe function
    return () => {
      this.globalNotificationClients.delete(callback)
    }
  }

  // Register callback for when a container should be stopped (e.g., on OOM)
  setStopContainerCallback(callback: (agentSlug: string) => void): void {
    this.onStopContainerRequested = callback
  }

  // Check if there are any session-specific SSE clients connected
  hasAnySessionClients(): boolean {
    return this.sseClients.size > 0
  }

  // Mark a session as interrupted (not active)
  async markSessionInterrupted(sessionId: string): Promise<void> {
    const state = this.streamingStates.get(sessionId)

    // Set interrupted flag FIRST to prevent race conditions with incoming events
    if (state) {
      state.isInterrupted = true
      state.isStreaming = false
      state.isActive = false
      state.isAwaitingInput = false
      state.currentText = ''
      state.currentToolUse = null
      state.currentToolInput = ''
      state.activeSubagents.clear()
      state.activeBackgroundTasks.clear()
      this.stopAllWorkflowTailers(sessionId)
    }

    // Broadcast to session-specific clients
    this.broadcastToSSE(sessionId, { type: 'session_idle', isActive: false })

    // Also broadcast globally so sidebar updates regardless of which session is being viewed
    const agentSlug = state?.agentSlug
    if (agentSlug) {
      this.broadcastGlobal({
        type: 'session_idle',
        sessionId,
        agentSlug,
        isActive: false,
      })
    }
  }

  // Add SSE client for real-time updates
  addSSEClient(sessionId: string, callback: (data: unknown) => void): () => void {
    let clients = this.sseClients.get(sessionId)
    if (!clients) {
      clients = new Set()
      this.sseClients.set(sessionId, clients)
    }
    clients.add(callback)

    return () => {
      clients?.delete(callback)
      if (clients?.size === 0) {
        this.sseClients.delete(sessionId)
      }
    }
  }

  // Public method to broadcast session metadata updates (e.g., name change)
  broadcastSessionUpdate(sessionId: string): void {
    this.broadcastToSSE(sessionId, { type: 'session_updated' })
  }

  // Mark session as active (when user sends a message)
  markSessionActive(sessionId: string, agentSlug?: string): void {
    let state = this.streamingStates.get(sessionId)
    if (!state) {
      state = {
        currentText: '',
        isStreaming: false,
        currentToolUse: null,
        currentToolInput: '',
        isActive: false,
        isInterrupted: false,
        isCompacting: false,
        agentSlug,
        lastContextWindow: 200_000,
        lastAssistantUsage: null,
        completedSubagentIds: new Set(),
        activeSubagents: new Map(),
        slashCommands: [],
        isAwaitingInput: false,
        pendingComputerUseRequests: new Map(),
        pendingInputRequests: new Map(),
        lastApiErrorCode: null,
        activeBackgroundTasks: new Map(),
        bgTasksSnapshot: null,
        pendingDeliverFiles: new Map(),
        stateEventsAuthority: false,
        lastResultSubtype: null,
        isRetrying: false,
      }
      this.streamingStates.set(sessionId, state)
      if (this.capture && agentSlug) {
        const subagentsDir = path.join(getAgentSessionsDir(agentSlug), sessionId, 'subagents')
        this.capture.snapshotSubagentsDir(sessionId, subagentsDir, 'state-created').catch(() => {})
        this.capture.recordNote(sessionId, 'state_created', { agentSlug }).catch(() => {})
      }
    }
    state.isActive = true
    state.isInterrupted = false // Reset interrupted flag on new message
    state.isAwaitingInput = false // Reset awaiting input on new message
    state.isRetrying = false // Reset retry flag on new message
    // Reset compaction/thinking too, mirroring the app's session_active reset: a
    // turn that ended mid-compaction/-thinking (error/interrupt before the clearing
    // event) must not wedge the next turn's label. State is reused across turns.
    state.isCompacting = false
    state.currentThinking = false
    state.lastApiErrorCode = null // Clear previous API error on new message
    // Clear the previous turn's result subtype so a late idle from an
    // already-finished (or interrupted) run can't fire a stale "success"
    // completion notification against the turn this message is starting.
    state.lastResultSubtype = null
    if (agentSlug) {
      state.agentSlug = agentSlug
    }

    // Broadcast to session-specific clients
    this.broadcastToSSE(sessionId, { type: 'session_active', isActive: true })

    // Also broadcast globally so sidebar updates regardless of which session is being viewed
    this.broadcastGlobal({
      type: 'session_active',
      sessionId,
      agentSlug: state.agentSlug,
      isActive: true,
    })
  }

  // Mark session as awaiting user input and broadcast globally
  private markSessionAwaitingInput(sessionId: string): void {
    const state = this.streamingStates.get(sessionId)
    if (state && !state.isAwaitingInput) {
      state.isAwaitingInput = true
      this.broadcastGlobal({
        type: 'session_awaiting_input',
        sessionId,
        agentSlug: state.agentSlug,
      })
      if (state.agentSlug) {
        this.promoteAutomatedSession(sessionId, state.agentSlug).catch((err) => {
          console.error('[MessagePersister] Failed to promote automated session:', err)
        })
      }
    }
  }

  // Recover awaiting-input state from persisted messages when the one-shot
  // request stream event was missed but the unresolved tool call is visible.
  recoverSessionAwaitingInput(sessionId: string, agentSlug?: string): void {
    const state = this.streamingStates.get(sessionId)
    if (!state?.isActive) return
    if (agentSlug && !state.agentSlug) {
      state.agentSlug = agentSlug
    }
    this.markSessionAwaitingInput(sessionId)
  }

  // Promote an automated session (cron/webhook/chat) to a regular session so it
  // appears in the sidebar and receives completion notifications.
  private async promoteAutomatedSession(sessionId: string, agentSlug: string): Promise<void> {
    const meta = await getSessionMetadata(agentSlug, sessionId)
    if (!meta) return
    if (meta.promotedToInteractive) return
    if (!meta.isScheduledExecution && !meta.isWebhookExecution && !meta.isChatIntegrationSession) return

    await updateSessionMetadata(agentSlug, sessionId, {
      promotedToInteractive: true,
    })

    console.log(`[MessagePersister] Promoted automated session ${sessionId} to interactive (agent: ${agentSlug})`)

    // Re-broadcast so the sidebar refetches sessions now that the metadata is updated
    this.broadcastGlobal({
      type: 'session_awaiting_input',
      sessionId,
      agentSlug,
    })
  }

  // Broadcast an arbitrary event to all SSE clients for a session (public)
  broadcastSessionEvent(sessionId: string, data: unknown): void {
    this.broadcastToSSE(sessionId, data)
  }

  // One-shot user-input request events that a late-joining client must be able to
  // recover on (re)connect. Keep in sync with the /stream route's replay loop.
  private static readonly INPUT_REQUEST_TYPES = new Set([
    'secret_request',
    'connected_account_request',
    'user_question_request',
    'file_request',
    'remote_mcp_request',
    'script_run_request',
    'browser_input_request',
    'capability_review_request',
  ])

  // Broadcast to SSE clients
  private broadcastToSSE(sessionId: string, data: unknown): void {
    this.capture?.recordOutput(sessionId, data)
    // Track/clear pending user-input requests so the /stream route can replay them to
    // clients that connect after the one-shot broadcast (the e2e late-join flake, and a
    // real reconnect/refresh while the agent is awaiting input). Turn boundaries clear them.
    const evt = data as { type?: string; toolUseId?: string } | null
    if (evt && typeof evt.type === 'string') {
      const state = this.streamingStates.get(sessionId)
      if (state) {
        if (evt.type === 'session_active' || evt.type === 'session_idle') {
          state.pendingInputRequests.clear()
        } else if (MessagePersister.INPUT_REQUEST_TYPES.has(evt.type) && typeof evt.toolUseId === 'string') {
          state.pendingInputRequests.set(evt.toolUseId, evt as { type: string; toolUseId: string })
        }
      }
    }
    const clients = this.sseClients.get(sessionId)
    if (clients) {
      clients.forEach((callback) => {
        try {
          callback(data)
        } catch (error) {
          console.error('Error broadcasting to SSE client:', error)
        }
      })
    }
  }

  // Handle incoming message from container
  private handleMessage(
    sessionId: string,
    message: StreamMessage
  ): void {
    this.capture?.recordInput(sessionId, message)
    const state = this.streamingStates.get(sessionId)
    if (!state) return

    // Skip processing if session was interrupted (prevents race conditions)
    // Allow 'result' through as it indicates the container actually stopped
    if (state.isInterrupted && message.content?.type !== 'result') {
      return
    }

    const content = message.content

    // Detect background task completion from `task_notification` system messages
    // BEFORE the sidechain filter. This is the idle/wake path: when a backgrounded
    // task settles while the agent is idle, the SDK wakes it with a `task_notification`
    // carrying this task's id + status. The busy path (task settles while a foreground
    // tool is in flight) is handled separately via `task_updated` in the system switch
    // below — that path does NOT emit a matching `task_notification`.
    if (content.type === 'system' && state.activeBackgroundTasks.size > 0) {
      const taskId = content.task_id as string | undefined
      if (taskId && content.status && state.activeBackgroundTasks.has(taskId)) {
        this.clearBackgroundTask(sessionId, state, taskId)
      }
    }

    // A workflow's REAL runId arrives only in its tool result (the next message after
    // task_started). Wire it up here: emit workflow_started + start the journal tailer
    // keyed by the real `wf_…` runId (the on-disk dir name), not the task_id.
    this.wireWorkflowFromToolResult(sessionId, content, state)

    // Filter sidechain (subagent) messages — they should not affect main streaming state
    // SDK emitted format uses parent_tool_use_id (non-null for subagent messages)
    if (content.parent_tool_use_id != null) {
      this.handleSidechainMessage(sessionId, content, state)
      return
    }

    switch (content.type) {
      case 'assistant': {
        // Complete assistant message - JSONL is the source of truth
        // Track SDK error code from assistant message (e.g., 'authentication_failed', 'rate_limit')
        if (content.error) {
          state.lastApiErrorCode = content.error
          // Broadcast the error code immediately so the UI can style the already-streaming
          // text as a provider error card without waiting for the JSONL refetch.
          // If the SDK already streamed text, just send the code. Otherwise also send the text.
          const hasStreamedText = state.currentText.length > 0
          if (hasStreamedText) {
            this.broadcastToSSE(sessionId, { type: 'stream_api_error', apiErrorCode: content.error })
          } else {
            const errorText = this.extractAssistantText(content)
            if (errorText) {
              this.broadcastToSSE(sessionId, { type: 'stream_delta', text: errorText, apiErrorCode: content.error })
            }
          }
        }
        // Clear currentText since the message is now persisted
        state.currentText = ''
        this.broadcastToSSE(sessionId, { type: 'messages_updated' })
        // Broadcast context usage from the assistant message's usage field
        const assistantUsage = content.message?.usage
        if (assistantUsage) {
          this.broadcastContextUsage(sessionId, state, assistantUsage)
        }
        break
      }

      case 'user':
        // Detect subagent completion: check if this user message contains tool_results
        // for any active subagent tool calls (meaning the subagent finished and returned its result)
        if (state.activeSubagents.size > 0) {
          const messageContent = content.message?.content
          if (Array.isArray(messageContent)) {
            for (const block of messageContent) {
              if (block.type === 'tool_result' && state.activeSubagents.has(block.tool_use_id)) {
                const sub = state.activeSubagents.get(block.tool_use_id)!

                // Extract agentId from tool result before broadcasting completion.
                // Try SDK tool_use_result metadata first, then parse from content text.
                if (!sub.agentId) {
                  const toolUseResult = content.tool_use_result as Record<string, unknown> | undefined
                  if (toolUseResult?.agentId && typeof toolUseResult.agentId === 'string') {
                    sub.agentId = toolUseResult.agentId
                  } else {
                    // Parse agentId from the tool result text (SDK includes "agentId: <hex>")
                    const parts = Array.isArray(block.content) ? block.content : []
                    for (const part of parts) {
                      if (part?.type === 'text' && typeof part.text === 'string') {
                        const match = part.text.match(/\bagentId:\s*([a-f0-9]+)\b/)
                        if (match) {
                          sub.agentId = match[1]
                          break
                        }
                      }
                    }
                  }
                }

                // A background (run_in_background) Agent returns an immediate
                // "async_launched" ack as its tool_result; its REAL completion
                // arrives later as task_updated/task_notification (handled in the
                // system switch), never a second tool_result or a sidechain
                // 'result'. Detect the ack authoritatively from tool_use_result
                // here and mark the subagent background — the streamed
                // run_in_background input is unreliable (interleaved content
                // blocks + the complete assistant message can clear currentToolUse
                // before it's parsed, leaving isBackground=false). Marking it here
                // both prevents the ack from completing the subagent and lets the
                // later task event complete it.
                const tur = content.tool_use_result as
                  | { status?: string; isAsync?: boolean; agentId?: string }
                  | undefined
                const isAsyncLaunchAck = tur?.status === 'async_launched' || tur?.isAsync === true
                if (isAsyncLaunchAck) {
                  sub.isBackground = true
                  // A background subagent outlives its launch turn, and since SDK
                  // 0.3.197 the runtime settles the turn (result + idle) while the
                  // subagent is still running — older SDKs held them back, which is
                  // why local_agent was never tracked here. Register it exactly like
                  // a backgrounded Bash command so it surfaces in the same
                  // "N background processes" UI and holds the session in the
                  // waiting-background state; its terminal task_updated /
                  // task_notification (task_id === agentId) clears it through the
                  // existing paths.
                  const bgAgentId = tur?.agentId ?? sub.agentId
                  if (bgAgentId && !state.activeBackgroundTasks.has(bgAgentId)) {
                    const startedAt = Date.now()
                    state.activeBackgroundTasks.set(bgAgentId, {
                      startedAt,
                      isSubagent: true,
                      toolUseId: block.tool_use_id,
                    })
                    // isSubagent lets the renderer skip these in the generic
                    // "N background processes" row — the named subagent row
                    // already represents this work in the activity tray.
                    this.broadcastToSSE(sessionId, {
                      type: 'background_task_started',
                      taskId: bgAgentId,
                      startedAt,
                      isSubagent: true,
                    })
                    this.broadcastGlobal({
                      type: 'background_task_started',
                      sessionId,
                      agentSlug: state.agentSlug,
                      taskId: bgAgentId,
                    })
                  }
                } else {
                  // Foreground subagent: the tool_result IS the completion.
                  let resultText: string | undefined
                  if (typeof block.content === 'string') {
                    resultText = block.content
                  } else if (Array.isArray(block.content)) {
                    resultText = block.content
                      .filter((p: { type?: string }) => p?.type === 'text')
                      .map((p: { text?: string }) => p.text || '')
                      .join('')
                  }
                  this.broadcastSubagentCompleted(sessionId, state, block.tool_use_id, resultText)
                }
              }
            }
          }
        }

        // Detect background Bash task from tool_use_result metadata
        {
          const tur = content.tool_use_result as Record<string, unknown> | undefined
          const bgId = (tur?.backgroundTaskId ?? tur?.background_task_id) as string | undefined
          if (bgId && typeof bgId === 'string' && !state.activeBackgroundTasks.has(bgId)) {
            const startedAt = Date.now()
            state.activeBackgroundTasks.set(bgId, { startedAt })
            this.broadcastToSSE(sessionId, {
              type: 'background_task_started',
              taskId: bgId,
              startedAt,
            })
            this.broadcastGlobal({
              type: 'background_task_started',
              sessionId,
              agentSlug: state.agentSlug,
              taskId: bgId,
            })
          }
        }

        // After SDK compaction starts, the next relevant user message is the compact summary.
        // This can follow either automatic compaction or a manual /compact path,
        // depending on which compact-related events the SDK emits.
        // Use position-based detection (state.isCompacting flag) as primary check,
        // with content.isCompactSummary as fallback, since the WebSocket payload
        // may not always carry the isCompactSummary metadata flag.
        if (state.isCompacting || content.isCompactSummary) {
          state.isCompacting = false
          // Compaction complete — broadcast so frontend transitions from spinner to boundary
          this.broadcastToSSE(sessionId, { type: 'compact_complete' })
          this.broadcastToSSE(sessionId, { type: 'messages_updated' })
          break
        }
        // Clear awaiting input when tool results arrive (user provided input)
        if (state.isAwaitingInput) {
          state.isAwaitingInput = false
          this.broadcastGlobal({
            type: 'session_input_provided',
            sessionId,
            agentSlug: state.agentSlug,
          })
        }
        // Tool results come as 'user' type messages
        this.handleToolResults(sessionId, content)
        // Broadcast refresh so frontend can detect the persisted user message
        // and clear the optimistic pending copy promptly.
        this.broadcastToSSE(sessionId, { type: 'messages_updated' })
        break

      case 'system':
        // System messages (init, etc.)
        if (content.subtype === 'init') {
          // Capture slash commands from init event as fallback (e.g. resumed sessions)
          if (state.slashCommands.length === 0 && Array.isArray(content.slash_commands)) {
            state.slashCommands = content.slash_commands.map((name: string) => ({
              name,
              description: '',
              argumentHint: '',
            }))
          }
          this.broadcastToSSE(sessionId, {
            type: 'stream_start',
            slashCommands: state.slashCommands.length > 0 ? state.slashCommands : undefined,
          })
        } else if (content.subtype === 'status') {
          // Prefer the SDK's explicit compacting status when available.
          if (content.status === 'compacting' && !state.isCompacting) {
            state.isCompacting = true
            this.broadcastToSSE(sessionId, { type: 'compact_start' })
          }
          if (content.status === 'requesting') {
            // The CLI is composing the next model request — the moment it
            // drains its command queue. Queued (mid-turn) messages picked up
            // here are persisted as queued_command attachments with no stream
            // event of their own, so broadcast a refetch to materialize their
            // ghosts promptly.
            this.broadcastToSSE(sessionId, { type: 'messages_updated' })
          }
        } else if (content.subtype === 'compact_boundary') {
          // Fallback for SDK paths that surface compaction via boundary without an earlier status.
          if (!state.isCompacting) {
            state.isCompacting = true
            this.broadcastToSSE(sessionId, { type: 'compact_start' })
          }
        } else if (content.subtype === 'api_retry') {
          // API retry in progress — broadcast details so the UI can show retry state
          state.isRetrying = true
          this.broadcastToSSE(sessionId, {
            type: 'api_retry',
            attempt: content.attempt,
            maxRetries: content.max_retries,
            delayMs: content.delay_ms,
            errorStatus: content.error_status,
          })
        } else if (content.subtype === 'task_started') {
          // Subagent started — set agentId deterministically from task_id (SDK 0.3.142+
          // guarantees task_id === subagent session ID === JSONL filename).
          const toolUseId = content.tool_use_id as string | undefined
          const agentId = content.task_id as string | undefined
          // A subagent's own inner Bash can surface in the parent stream as an
          // unparented task_started{task_type:'local_bash'} — it is not a
          // subagent, and creating an entry for it renders a phantom subagent
          // card that lingers for the whole background wait.
          if (toolUseId && content.task_type !== 'local_bash') {
            const existing = state.activeSubagents.get(toolUseId)
            if (existing) {
              if (agentId) existing.agentId = agentId
            } else {
              state.activeSubagents.set(toolUseId, {
                agentId: agentId ?? null,
                currentText: '',
                currentToolUse: null,
                currentToolInput: '',
                isBackground: false,
              })
            }
            this.broadcastToSSE(sessionId, {
              type: 'subagent_started',
              parentToolId: toolUseId,
              taskId: agentId,
              agentId: agentId,
              subagentType: content.subagent_type,
              description: content.description,
            })
          }
          // A dynamic workflow (task_type 'local_workflow') is a background task that
          // outlives its launch turn — register it exactly like a backgrounded Bash
          // command so it surfaces in the same "N background processes" UI and holds the
          // session in the waiting-background state. The idle handler already keeps the
          // session alive whenever activeBackgroundTasks is non-empty (the SDK fires idle
          // at turn-end while the work runs, then wakes on completion), and the terminal
          // task_updated/task_notification handlers below clear it by task_id — so no
          // workflow-specific handling is needed anywhere else.
          if (content.task_type === 'local_workflow') {
            const workflowTaskId = content.task_id as string | undefined
            if (workflowTaskId && !state.activeBackgroundTasks.has(workflowTaskId)) {
              const startedAt = Date.now()
              state.activeBackgroundTasks.set(workflowTaskId, {
                startedAt,
                isWorkflow: true,
                toolUseId,
                workflowName: typeof content.workflow_name === 'string' ? content.workflow_name : undefined,
              })
              this.broadcastToSSE(sessionId, { type: 'background_task_started', taskId: workflowTaskId, startedAt, isWorkflow: true })
              this.broadcastGlobal({ type: 'background_task_started', sessionId, agentSlug: state.agentSlug, taskId: workflowTaskId })
              // NOTE: we do NOT emit workflow_started or start the journal tailer yet — the
              // real on-disk runId (`wf_…`, the name of the subagents/workflows/<runId> dir)
              // is NOT the task_id; it only appears in the Workflow tool RESULT, which the
              // SDK delivers as the very next message. See wireWorkflowFromToolResult().
            }
          }
        } else if (content.subtype === 'task_progress') {
          // Subagent progress with usage stats (description intentionally omitted —
          // task_progress.description can change to reflect current action, but the
          // header should keep the original task description from task_started)
          this.broadcastToSSE(sessionId, {
            type: 'subagent_progress',
            parentToolId: content.tool_use_id,
            summary: content.summary,
            subagentType: content.subagent_type,
            usage: content.usage,
            lastToolName: content.last_tool_name,
          })
          // A dynamic workflow's task_progress carries a full live snapshot of its agent
          // tree in `workflow_progress[]` (per-agent state incl. failed, tokens, toolCalls,
          // current tool) plus cumulative `usage`. Forward it for the drawer's live view.
          this.emitWorkflowProgress(sessionId, content, state)
        } else if (content.subtype === 'task_updated') {
          // Background task state change. When a backgrounded Bash command completes
          // while the agent is still busy (a foreground tool was in flight when it
          // settled), the SDK delivers the completion as a `task_updated` patch — NOT
          // an in-band `task_notification` (that only fires on the idle/wake path, and
          // even then carries the *currently returning* task's id, not necessarily this
          // one). Without this branch the task is never removed from
          // activeBackgroundTasks, so the result handler keeps re-emitting
          // `session_waiting_background` and the session is pinned "working" forever.
          // See the background-bash-busy-completion replay fixture.
          const taskId = content.task_id as string | undefined
          const status = (content.patch as { status?: string } | undefined)?.status
          const isTerminal = status === 'completed' || status === 'failed' || status === 'killed'
          if (taskId && isTerminal && state.activeBackgroundTasks.has(taskId)) {
            this.clearBackgroundTask(sessionId, state, taskId)
          }
          // A background *subagent* (task_type 'local_agent') settles via a
          // task_updated whose task_id equals the subagent's agentId. The busy
          // path can deliver this without a matching task_notification, so finish
          // the subagent here too. Scoped to isBackground: foreground subagents
          // complete via their tool_result (see the 'user' case) and also emit
          // these task events — acting on them here would fire an early
          // completion with an unresolved (null) agentId. Idempotent:
          // broadcastSubagentCompleted removes it, so a trailing task_notification
          // no-ops.
          if (taskId && isTerminal) {
            for (const [parentToolId, sub] of state.activeSubagents) {
              if (sub.isBackground && sub.agentId === taskId) {
                this.broadcastSubagentCompleted(sessionId, state, parentToolId)
                break
              }
            }
          }
        } else if (content.subtype === 'task_notification') {
          // A background *subagent* reports completion via task_notification
          // carrying the launching Agent tool's id (background Bash tasks settle
          // through the activeBackgroundTasks path near the top of handleMessage).
          // Without this, broadcastSubagentCompleted never fires for a background
          // subagent — its tool_result stays the 'async_launched' ack and no
          // sidechain 'result' arrives — so the UI shows it running until the
          // whole turn ends. Scoped to isBackground for the same reason as the
          // task_updated branch above (foreground subagents finish via tool_result).
          const toolUseId = content.tool_use_id as string | undefined
          const status = content.status as string | undefined
          const sub = toolUseId ? state.activeSubagents.get(toolUseId) : undefined
          if (
            sub?.isBackground &&
            (status === 'completed' || status === 'failed' || status === 'killed')
          ) {
            const summary = typeof content.summary === 'string' ? content.summary : undefined
            this.broadcastSubagentCompleted(sessionId, state, toolUseId!, summary)
          }
        } else if (content.subtype === 'capabilities') {
          // The container announces its stream contract when the WebSocket
          // connects, before relaying any SDK message. `session_state_events`
          // means this build runs the CLI with
          // CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, so session_state_changed
          // is the idle authority from the session's very first turn — which
          // matters because the CLI's first state TRANSITION (idle) only
          // arrives at the end of the first turn, after the first result.
          if (content.session_state_events === true) {
            state.stateEventsAuthority = true
          }
        } else if (content.subtype === 'session_state_changed') {
          // The runtime's own session state — `idle` is the SDK's authoritative
          // "fully settled" signal: it fires only after heldBackResult flushes
          // and the bg-agent loop exits, so it correctly stays away while
          // queued (mid-turn) messages or background work keep the session
          // running. Once a session emits these events, they are the idle
          // authority and 'result' no longer decides. (Normally announced
          // up-front via the `capabilities` message; observing one directly
          // covers builds that emit state events but predate that handshake.)
          state.stateEventsAuthority = true
          if (content.state === 'idle') {
            // Only treat idle as authoritative when a result was actually seen
            // for this turn (lastResultSubtype is cleared on every new send).
            // A bare idle with no preceding result — a stale idle from a prior
            // or interrupted run racing a fresh message, or an event before any
            // turn output — must not finalize, or it fires a spurious
            // session_idle (and a bogus completion notification).
            if (state.isActive && state.lastResultSubtype !== null) {
              const openBackgroundWork = this.openBackgroundWorkCount(state)
              if (openBackgroundWork > 0) {
                // Idle here does NOT mean "settled". activeBackgroundTasks holds
                // backgrounded Bash commands (task_type=local_bash) and dynamic
                // workflows (local_workflow); for both the SDK fires `idle` at
                // TURN-END while the work is still running, then re-fires `running`
                // + task_notification when it actually finishes. Phantom-clearing
                // + finalizing here would
                // drop the indicator and un-gate auto-sleep mid-job — the exact
                // failure run_in_background is meant to prevent. Keep the session
                // alive and surface it as waiting-on-background; the per-task
                // terminal signal (task_notification / task_updated) clears each
                // task, and the subsequent, truly-settled idle finalizes.
                this.broadcastToSSE(sessionId, {
                  type: 'session_waiting_background',
                  backgroundTaskCount: openBackgroundWork,
                })
              } else {
                this.finalizeIdle(sessionId, state)
                // Completion notification at the real end of the work. Skip
                // resume-exits: the session is pausing for a resume, not done.
                if (state.lastResultSubtype === 'success' && state.agentSlug) {
                  notificationManager.triggerSessionComplete(sessionId, state.agentSlug).catch((err) => {
                    console.error('[MessagePersister] Failed to trigger session complete notification:', err)
                  })
                }
              }
            }
          } else if (content.state === 'running' && !state.isActive) {
            // The runtime started a turn we didn't initiate via POST (e.g. a
            // queued message picked up after an out-of-order idle) — self-heal.
            state.isActive = true
            this.broadcastToSSE(sessionId, { type: 'session_active', isActive: true })
            this.broadcastGlobal({
              type: 'session_active',
              sessionId,
              agentSlug: state.agentSlug,
              isActive: true,
            })
          }
        } else if (content.subtype === 'background_tasks_changed') {
          // Authoritative full snapshot of the session's live background tasks
          // (SDK >= 0.3.203), emitted on every membership change. A frame that
          // fails validation is ignored outright — acting on a partial parse
          // could clear running tasks (see parseBackgroundTasksChanged).
          const snapshot = parseBackgroundTasksChanged(content)
          if (snapshot) {
            state.bgTasksSnapshot = snapshot.taskIds
            // Self-heal: a tracked task the SDK no longer lists has finished.
            // Its per-task terminal signal normally follows within a frame and
            // then no-ops (clearBackgroundTask is idempotent) — but if that
            // signal is missed, the task would otherwise pin the session in
            // waiting-background forever.
            for (const taskId of [...state.activeBackgroundTasks.keys()]) {
              if (!snapshot.taskIds.has(taskId)) {
                console.log(
                  `[MessagePersister] background_tasks_changed: clearing ${taskId} (no longer in SDK snapshot)`
                )
                this.clearBackgroundTask(sessionId, state, taskId)
              }
            }
          }
        } else if (content.subtype === 'memory_recall') {
          // Memory recall — agent is reading memory files
          this.broadcastToSSE(sessionId, {
            type: 'memory_recall',
            memoryPaths: content.memory_paths || [],
          })
        }
        break

      case 'command_lifecycle': {
        // Per-command state transitions (queued/started/completed/cancelled/
        // discarded), keyed by the message's own uuid. Forwarded verbatim —
        // the renderer joins terminal dead states back to its optimistic
        // ghosts for deterministic composer rescue. Malformed frames are
        // dropped (nothing downstream can act without a uuid).
        const lifecycle = parseCommandLifecycle(content)
        if (lifecycle) {
          this.broadcastToSSE(sessionId, {
            type: 'command_lifecycle',
            commandUuid: lifecycle.commandUuid,
            state: lifecycle.state,
          })
        }
        break
      }

      case 'result': {
        // Query completed. Classification handles both error shapes — the
        // legacy error subtypes and the modern success-subtype-with-is_error
        // (terminal_reason: api_error etc.) that a subtype check alone misses.
        const classification = classifyResult(content)
        const isError = classification.isError
        state.isStreaming = false
        state.isAwaitingInput = false
        // On error the turn ends here, so settle isActive too BEFORE the single
        // emit. Collapsing every terminal flag change into ONE emit (reflecting
        // the final state) avoids a spurious working(true)→(false) pair — the
        // intermediate "isActive still true, streaming just cleared" snapshot
        // would read working=true and race connectors into a stuck indicator.
        if (isError || classification.isInterrupt) state.isActive = false
        state.currentText = ''
        state.lastResultSubtype = typeof content.subtype === 'string' ? content.subtype : null

        // Extract and persist context usage from result event
        this.handleResultUsage(sessionId, state, content)

        // A deliberately stopped turn (terminal_reason aborted_tools /
        // aborted_streaming — a graceful interrupt) arrives error-SHAPED but
        // is not an error: settle quietly. No session_error (the user clicked
        // Stop; an error card would be wrong) and no finalizeIdle here — the
        // Stop route's markSessionInterrupted owns the idle broadcast, and
        // container-internal restarts (MCP injection, effort change) resume
        // with a continuation turn moments later. turn_output_complete still
        // fires so partially-streamed text reconciles against the transcript.
        if (classification.isInterrupt) {
          this.broadcastToSSE(sessionId, { type: 'turn_output_complete' })
          break
        }

        // Check if this is an error result. Errors end the user-visible work
        // immediately in both lifecycle modes. (isActive + the working emit were
        // already settled above, before the session_error broadcasts below.)
        if (isError) {
          const errorMessage = classification.errorText || 'An error occurred during execution'
          // Use SDK error code from the preceding assistant message (e.g., 'authentication_failed', 'rate_limit')
          const apiErrorCode = state.lastApiErrorCode || null
          const { terminalReason, apiErrorStatus } = classification
          console.error(
            `[MessagePersister] Session ${sessionId} error:`,
            errorMessage,
            apiErrorCode ? `(${apiErrorCode})` : '',
            terminalReason ? `[${terminalReason}]` : ''
          )
          this.broadcastToSSE(sessionId, {
            type: 'session_error',
            error: errorMessage,
            apiErrorCode,
            terminalReason,
            apiErrorStatus,
            isActive: false
          })
          // Also broadcast globally
          this.broadcastGlobal({
            type: 'session_error',
            sessionId,
            agentSlug: state.agentSlug,
            error: errorMessage,
            apiErrorCode,
            terminalReason,
            apiErrorStatus,
            isActive: false,
          })
          // If the error is fatal (e.g., OOM), request container stop
          if (content.fatal && state.agentSlug && this.onStopContainerRequested) {
            console.log(`[MessagePersister] Fatal error for agent ${state.agentSlug}, requesting container stop`)
            this.onStopContainerRequested(state.agentSlug)
          }
          break
        }

        // The turn's output is complete (whether or not the session settles).
        // Let the renderer reconcile the just-streamed text against the
        // transcript (the JSONL write can lag the stream) — otherwise a
        // follow-up turn's stream_start can wipe the streaming bubble before
        // its persisted copy is fetched and the final message blinks out.
        this.broadcastToSSE(sessionId, { type: 'turn_output_complete' })

        // UI hint: background tasks outlive the turn output.
        {
          const openBackgroundWork = this.openBackgroundWorkCount(state)
          if (openBackgroundWork > 0) {
            this.broadcastToSSE(sessionId, {
              type: 'session_waiting_background',
              backgroundTaskCount: openBackgroundWork,
            })
          }
        }

        // When the runtime publishes session_state_changed events, IT decides
        // when the session is settled — a result alone doesn't: queued
        // (mid-turn) messages or background work may keep it running, and the
        // runtime holds that state, not us. session_state_changed:'idle'
        // finalizes (and fires the completion notification).
        if (state.stateEventsAuthority) {
          break
        }

        // Legacy containers (no state events): result-driven idle as before.
        if (this.openBackgroundWorkCount(state) > 0) {
          break
        }
        this.finalizeIdle(sessionId, state)
        // Trigger session complete notification. Whether to *show* an OS
        // notification (vs just creating the DB record) is the renderer's
        // call — it knows about window focus, per-user viewing, and the
        // `notifyWhenUnfocused` toggle. Skip for 'resume' exits — the
        // session is pausing for a resume, not truly finished.
        if (content.subtype !== 'resume' && state.agentSlug) {
          notificationManager.triggerSessionComplete(sessionId, state.agentSlug).catch((err) => {
            console.error('[MessagePersister] Failed to trigger session complete notification:', err)
          })
        }
        break
      }

      case 'browser_active':
        // Browser state changed — forward to SSE clients
        this.broadcastToSSE(sessionId, {
          type: 'browser_active',
          active: content.active,
        })
        break

      case 'connection_closed':
        // WebSocket connection to container was lost
        // Check if session is still actually running in the container
        console.log(`[MessagePersister] Connection closed for session ${sessionId}, checking container state`)
        this.handleConnectionClosed(sessionId, state)
        break

      case 'stream_event':
        // Handle stream events for SSE broadcasting
        if (content.event) {
          this.handleStreamEvent(sessionId, content.event, state)
        }
        break

      default:
        // Handle stream events directly (sometimes they come without wrapper)
        if (content.event) {
          this.handleStreamEvent(sessionId, content.event, state)
        }
    }
  }

  // Handle connection closed - check container and mark inactive if session is done
  private handleConnectionClosed(sessionId: string, state: StreamingState): void {
    const client = this.containerClients.get(sessionId)
    if (!client) {
      // No client reference, assume session is done
      this.markSessionInactive(sessionId, state)
      return
    }

    // Check container asynchronously
    client.getSession(sessionId)
      .then((containerSession) => {
        if (!containerSession) {
          // Session doesn't exist in container anymore
          console.log(`[MessagePersister] Session ${sessionId} not found in container, marking inactive`)
          this.markSessionInactive(sessionId, state)
          return
        }

        // Container session exists - check if it's still running
        // The container's getSession returns isRunning in the response
        const isRunning = (containerSession as any).isRunning
        if (isRunning) {
          // Session still running, try to re-subscribe
          console.log(`[MessagePersister] Session ${sessionId} still running, re-subscribing`)
          const { unsubscribe, ready } = client.subscribeToStream(
            sessionId,
            (message) => this.handleMessage(sessionId, message)
          )
          this.subscriptions.set(sessionId, unsubscribe)
          // Defense-in-depth: we don't await the re-subscribe here, so attach a
          // handler to the `ready` promise. A failed reconnect routes a
          // synthesized connection_closed message through the callback above;
          // this only stops the discarded rejection from becoming unhandled.
          ready.catch((err) => {
            console.error(`[MessagePersister] Re-subscribe failed for session ${sessionId}:`, err)
          })
        } else {
          // Session finished
          console.log(`[MessagePersister] Session ${sessionId} not running in container, marking inactive`)
          this.markSessionInactive(sessionId, state)
        }
      })
      .catch((error) => {
        // Can't reach container, assume session is done
        console.error(`[MessagePersister] Failed to check container for session ${sessionId}:`, error)
        this.markSessionInactive(sessionId, state)
      })
  }

  // Mark a session as inactive and broadcast the update
  private markSessionInactive(sessionId: string, state: StreamingState): void {
    // A session that was mid-turn (user message sent, no result yet) and not
    // deliberately interrupted didn't finish — its runtime vanished (container
    // crash, guest OOM kill of the agent process, VM death). Surface that as an
    // error instead of settling silently: session_idle would render as the turn
    // just ending with no explanation (and wipes any error client-side).
    const diedMidTurn = state.isActive && !state.isInterrupted
    state.isStreaming = false
    state.isAwaitingInput = false
    state.currentText = ''
    state.currentToolUse = null
    state.currentToolInput = ''
    state.activeSubagents.clear()
    state.activeBackgroundTasks.clear()
    this.stopAllWorkflowTailers(sessionId)
    if (diedMidTurn) {
      // Mirror the result-error path: settle isActive BEFORE broadcasting so
      // the terminal transition is a single non-busy emit (an intermediate
      // "isActive still true, streaming just cleared" snapshot would read
      // working=true and race connectors into a stuck indicator), and emit
      // session_error INSTEAD of session_idle — connectors finalize on either.
      state.isActive = false
      const errorMessage =
        'The agent stopped unexpectedly because the connection to its runtime was lost. ' +
        'The container may have crashed or run out of memory.'
      console.error(`[MessagePersister] Session ${sessionId} died mid-turn (connection lost)`)
      this.broadcastToSSE(sessionId, {
        type: 'session_error',
        error: errorMessage,
        apiErrorCode: null,
        terminalReason: 'connection_lost',
        isActive: false,
      })
      this.broadcastGlobal({
        type: 'session_error',
        sessionId,
        agentSlug: state.agentSlug,
        error: errorMessage,
        apiErrorCode: null,
        terminalReason: 'connection_lost',
        isActive: false,
      })
      return
    }
    // finalizeIdle clears isActive and emits the single settling working(false).
    // Don't emit here first: clearing streaming while isActive is still true
    // would read working=true and emit a spurious working(true)→(false) pair
    // that races connectors into a stuck indicator.
    this.finalizeIdle(sessionId, state)
  }

  // Handle sidechain (subagent) messages — filter them out of main streaming state
  private handleSidechainMessage(sessionId: string, content: any, state: StreamingState): void {
    const parentToolId = content.parent_tool_use_id as string

    // Look up or create the subagent entry for this parent tool
    let sub = state.activeSubagents.get(parentToolId)
    if (!sub) {
      // Sidechain message arrived before the tool_use was tracked (rare but possible)
      sub = { agentId: null, currentText: '', currentToolUse: null, currentToolInput: '', isBackground: false }
      state.activeSubagents.set(parentToolId, sub)
    }

    // Extract agentId from the message if available (belt-and-suspenders with task_started)
    const messageAgentId = content.agentId as string | undefined
    if (messageAgentId && !sub.agentId) {
      sub.agentId = messageAgentId
      this.broadcastToSSE(sessionId, {
        type: 'subagent_updated',
        parentToolId,
        agentId: sub.agentId,
      })
    }

    // Route stream events to the subagent stream handler for real-time streaming
    if (content.type === 'stream_event' && content.event) {
      this.handleSubagentStreamEvent(sessionId, content.event, state, parentToolId)
      return
    }
    // Bare events (sometimes come without wrapper, same as main agent)
    if (content.event && content.type !== 'user' && content.type !== 'assistant') {
      this.handleSubagentStreamEvent(sessionId, content.event, state, parentToolId)
      return
    }

    // Sidechain 'result' means the background subagent has finished execution
    if (content.type === 'result') {
      this.broadcastSubagentCompleted(sessionId, state, parentToolId)
      return
    }

    // Broadcast updates for complete messages (user/assistant).
    // Complete messages have been persisted to the subagent JSONL by the SDK,
    // so the frontend can refetch them via the API endpoint.
    if (content.type === 'user' || content.type === 'assistant') {
      if (content.type === 'assistant') {
        const messageContent = content.message?.content
        if (Array.isArray(messageContent)) {
          // Extract text from the complete message and broadcast as streaming delta
          // so the frontend shows it immediately (subagent messages often arrive as
          // complete messages without preceding stream_event deltas).
          const newText = messageContent
            .filter((b: { type: string }) => b.type === 'text')
            .map((b: { text?: string }) => b.text || '')
            .join('')
          if (newText && newText !== sub.currentText) {
            const delta = newText.startsWith(sub.currentText)
              ? newText.slice(sub.currentText.length)
              : newText
            if (delta) {
              if (!newText.startsWith(sub.currentText)) {
                this.broadcastToSSE(sessionId, {
                  type: 'subagent_stream_start',
                  parentToolId,
                  agentId: sub.agentId,
                })
              }
              this.broadcastToSSE(sessionId, {
                type: 'subagent_stream_delta',
                parentToolId,
                agentId: sub.agentId,
                text: delta,
              })
            }
          }
          sub.currentText = newText

          for (const block of messageContent) {
            if (block.type === 'tool_use' && block.name === 'mcp__user-input__request_browser_input') {
              this.handleBrowserInputRequestTool(
                sessionId,
                block.id,
                JSON.stringify(block.input || {}),
                state.agentSlug
              )
            }
            if (block.type === 'tool_use' && block.name === 'mcp__user-input__request_script_run') {
              this.handleScriptRunRequestTool(
                sessionId,
                block.id,
                JSON.stringify(block.input || {}),
                state.agentSlug
              )
            }
            if (block.type === 'tool_use' && block.name.startsWith('mcp__computer-use__')) {
              this.handleComputerUseRequestTool(
                sessionId,
                block.id,
                block.name,
                JSON.stringify(block.input || {}),
                state.agentSlug
              )
            }
          }
        }
      }
      this.broadcastToSSE(sessionId, {
        type: 'subagent_updated',
        parentToolId,
        agentId: sub.agentId,
      })
    }
  }

  // Clear a finished background task (backgrounded Bash OR a dynamic workflow),
  // emitting the shared `background_task_completed` plus, for workflows, the
  // `workflow_completed` event and stopping the journal tailer. Returns whether a
  // task was actually present. Centralized so every terminal path — the idle/wake
  // `task_notification` and the busy `task_updated` — behaves identically.
  // How many background tasks keep the session from settling. The union of
  // the incremental map and the latest SDK snapshot: the snapshot LEADS the
  // per-task signals on the wire, so around a membership change each side may
  // briefly know a task the other doesn't. Counting the union means a missed
  // registration can't cause a premature idle and a missed terminal signal
  // can't pin the session forever (the snapshot self-heal below clears it).
  private openBackgroundWorkCount(state: StreamingState): number {
    if (!state.bgTasksSnapshot) return state.activeBackgroundTasks.size
    const union = new Set(state.activeBackgroundTasks.keys())
    for (const id of state.bgTasksSnapshot) union.add(id)
    return union.size
  }

  private clearBackgroundTask(sessionId: string, state: StreamingState, taskId: string): boolean {
    const info = state.activeBackgroundTasks.get(taskId)
    if (!info) return false
    state.activeBackgroundTasks.delete(taskId)
    this.broadcastToSSE(sessionId, { type: 'background_task_completed', taskId })
    this.broadcastGlobal({ type: 'background_task_completed', sessionId, agentSlug: state.agentSlug, taskId })
    // Use the real on-disk runId (learned from the tool result), NOT the task_id.
    if (info.isWorkflow && info.runId) {
      this.broadcastToSSE(sessionId, { type: 'workflow_completed', runId: info.runId })
      this.stopWorkflowTailer(sessionId, info.runId)
    }
    return true
  }

  // The Workflow tool returns its result (`WorkflowOutput`) as a `user` message carrying a
  // structured `tool_use_result` with the real `wf_…` runId + transcriptDir. That runId is
  // the on-disk `subagents/workflows/<runId>` dir name and is DISTINCT from the task_id, so
  // it's the only correct key for the tree route + journal tailer. We match it back to the
  // workflow background task by the launching tool_use_id and fire workflow_started here.
  private wireWorkflowFromToolResult(sessionId: string, content: any, state: StreamingState): void {
    const tur = content?.tool_use_result as { taskType?: string; runId?: string } | undefined
    let runId = tur?.taskType === 'local_workflow' && typeof tur.runId === 'string' ? tur.runId : undefined
    // tool_use_id is on the tool_result block inside the user message.
    const blocks = content?.message?.content
    const toolUseId = Array.isArray(blocks)
      ? (blocks.find((b: { type?: string }) => b?.type === 'tool_result') as { tool_use_id?: string } | undefined)
          ?.tool_use_id
      : undefined
    if (!toolUseId) return
    // Fallback: parse the runId out of the result text if the structured field is absent.
    if (!runId) {
      const block = (blocks as Array<{ tool_use_id?: string; content?: unknown }>).find(
        (b) => b?.tool_use_id === toolUseId
      )
      const text = typeof block?.content === 'string' ? block.content : ''
      const m = text.match(/Run ID:\s*(wf_[A-Za-z0-9_-]+)/) || text.match(/workflows\/(wf_[A-Za-z0-9_-]+)/)
      if (m) runId = m[1]
    }
    if (!runId) return
    for (const [, info] of state.activeBackgroundTasks) {
      if (info.isWorkflow && info.toolUseId === toolUseId && !info.runId) {
        info.runId = runId
        this.broadcastToSSE(sessionId, {
          type: 'workflow_started',
          toolUseId,
          runId,
          name: info.workflowName,
          startedAt: info.startedAt,
        })
        this.startWorkflowTailer(sessionId, state.agentSlug, runId)
        break
      }
    }
  }

  // Forward the rich live snapshot in a workflow's task_progress.workflow_progress[] to
  // the drawer: per-agent state (incl. failed/killed) + tokens + toolCalls + current tool,
  // plus the workflow's cumulative usage. Resolves runId via the launching tool_use_id.
  private emitWorkflowProgress(sessionId: string, content: any, state: StreamingState): void {
    const wp = content?.workflow_progress
    const toolUseId = content?.tool_use_id as string | undefined
    if (!Array.isArray(wp) || !toolUseId) return
    let runId: string | undefined
    for (const [, info] of state.activeBackgroundTasks) {
      if (info.isWorkflow && info.toolUseId === toolUseId) {
        runId = info.runId
        break
      }
    }
    if (!runId) return // the tool result hasn't landed yet — next tick will carry it
    const agents = wp
      .filter((e: { type?: string }) => e?.type === 'workflow_agent')
      .map((e: Record<string, unknown>) => ({
        agentId: e.agentId as string,
        label: typeof e.label === 'string' ? e.label : undefined,
        phase: typeof e.phaseTitle === 'string' ? e.phaseTitle : null,
        state: typeof e.state === 'string' ? e.state : 'progress',
        tokens: typeof e.tokens === 'number' ? e.tokens : 0,
        toolCalls: typeof e.toolCalls === 'number' ? e.toolCalls : 0,
        lastTool:
          (typeof e.lastToolSummary === 'string' && e.lastToolSummary) ||
          (typeof e.lastToolName === 'string' && e.lastToolName) ||
          null,
      }))
      .filter((a: { agentId?: string }) => typeof a.agentId === 'string')
    const u = content.usage as { total_tokens?: number; tool_uses?: number; duration_ms?: number } | undefined
    this.broadcastToSSE(sessionId, {
      type: 'workflow_progress',
      runId,
      agents,
      usage: u
        ? { totalTokens: u.total_tokens ?? 0, toolUses: u.tool_uses ?? 0, durationMs: u.duration_ms ?? 0 }
        : undefined,
    })
  }

  private startWorkflowTailer(sessionId: string, agentSlug: string | undefined, runId: string): void {
    if (!agentSlug) return // can't resolve the workspace dir without a slug
    const key = `${sessionId}::${runId}`
    if (this.workflowTailers.has(key)) return
    const tailer = new WorkflowJournalTailer({
      sessionsDir: getAgentSessionsDir(agentSlug),
      sessionId,
      runId,
      emit: (update) => this.broadcastToSSE(sessionId, update),
    })
    this.workflowTailers.set(key, tailer)
    tailer.start()
  }

  private stopWorkflowTailer(sessionId: string, runId: string): void {
    const key = `${sessionId}::${runId}`
    const tailer = this.workflowTailers.get(key)
    if (tailer) {
      tailer.stop()
      this.workflowTailers.delete(key)
    }
  }

  private stopAllWorkflowTailers(sessionId: string): void {
    const prefix = `${sessionId}::`
    for (const [key, tailer] of this.workflowTailers) {
      if (key.startsWith(prefix)) {
        tailer.stop()
        this.workflowTailers.delete(key)
      }
    }
  }

  private broadcastSubagentCompleted(sessionId: string, state: StreamingState, parentToolId: string, resultText?: string): void {
    const sub = state.activeSubagents.get(parentToolId)
    // Broadcast a final subagent_updated so the frontend refetches subagent messages
    this.broadcastToSSE(sessionId, {
      type: 'subagent_updated',
      parentToolId,
      agentId: sub?.agentId ?? null,
    })
    this.broadcastToSSE(sessionId, {
      type: 'subagent_completed',
      parentToolId,
      agentId: sub?.agentId ?? null,
      ...(resultText && { resultText }),
    })
    // Track completed subagent ID so it won't be re-discovered
    if (sub?.agentId) {
      state.completedSubagentIds.add(sub.agentId)
    }
    state.activeSubagents.delete(parentToolId)
  }

  // Handle subagent stream events — mirrors handleStreamEvent but with subagent_ prefixed SSE events
  private handleSubagentStreamEvent(
    sessionId: string,
    event: { type: string; content_block?: { type: string; id?: string; name?: string }; delta?: { type: string; text?: string; partial_json?: string } },
    state: StreamingState,
    parentToolId: string
  ): void {
    const sub = state.activeSubagents.get(parentToolId)
    if (!sub) return

    switch (event.type) {
      case 'message_start':
        sub.currentText = ''
        sub.currentToolUse = null
        sub.currentToolInput = ''
        this.broadcastToSSE(sessionId, {
          type: 'subagent_stream_start',
          parentToolId,
          agentId: sub.agentId,
        })
        break

      case 'content_block_start':
        if (event.content_block?.type === 'tool_use') {
          sub.currentToolUse = {
            id: event.content_block.id!,
            name: event.content_block.name!,
          }
          sub.currentToolInput = ''
          this.broadcastToSSE(sessionId, {
            type: 'subagent_tool_use_start',
            parentToolId,
            agentId: sub.agentId,
            toolId: event.content_block.id,
            toolName: event.content_block.name,
            partialInput: '',
          })
        }
        break

      case 'content_block_delta':
        if (event.delta?.type === 'text_delta' && event.delta.text) {
          sub.currentText += event.delta.text
          this.broadcastToSSE(sessionId, {
            type: 'subagent_stream_delta',
            parentToolId,
            agentId: sub.agentId,
            text: event.delta.text,
          })
        } else if (event.delta?.type === 'input_json_delta') {
          const partialJson = event.delta.partial_json || ''
          sub.currentToolInput += partialJson
          this.broadcastToSSE(sessionId, {
            type: 'subagent_tool_use_streaming',
            parentToolId,
            agentId: sub.agentId,
            toolId: sub.currentToolUse?.id,
            toolName: sub.currentToolUse?.name,
            partialInput: redactStreamedToolInput(
              sub.currentToolUse?.name,
              sub.currentToolInput,
            ),
          })
        }
        break

      case 'content_block_stop':
        if (sub.currentToolUse) {
          // Safety net: detect browser input if stream events arrive for subagents
          if (sub.currentToolUse.name === 'mcp__user-input__request_browser_input') {
            this.handleBrowserInputRequestTool(
              sessionId,
              sub.currentToolUse.id,
              sub.currentToolInput,
              state.agentSlug
            )
          }

          if (sub.currentToolUse.name === 'mcp__user-input__request_script_run') {
            this.handleScriptRunRequestTool(
              sessionId,
              sub.currentToolUse.id,
              sub.currentToolInput,
              state.agentSlug
            )
          }

          if (sub.currentToolUse.name.startsWith('mcp__computer-use__')) {
            this.handleComputerUseRequestTool(
              sessionId,
              sub.currentToolUse.id,
              sub.currentToolUse.name,
              sub.currentToolInput,
              state.agentSlug
            )
          }

          // A nested launch from inside a subagent pauses in canUseTool too —
          // it needs the same approval card as a top-level one.
          if (['Task', 'Agent', 'Workflow'].includes(sub.currentToolUse.name)) {
            this.handleCapabilityReviewTool(
              sessionId,
              sub.currentToolUse.id,
              sub.currentToolUse.name,
              sub.currentToolInput,
              state.agentSlug
            )
          }

          this.broadcastToSSE(sessionId, {
            type: 'subagent_tool_use_ready',
            parentToolId,
            agentId: sub.agentId,
            toolId: sub.currentToolUse.id,
            toolName: sub.currentToolUse.name,
          })
          sub.currentToolUse = null
          sub.currentToolInput = ''
        }
        break

      case 'message_stop':
        sub.currentToolUse = null
        sub.currentToolInput = ''
        break
    }
  }

  // Handle stream events for SSE broadcasting (not for persistence)
  private handleStreamEvent(
    sessionId: string,
    event: { type: string; content_block?: { type: string; id?: string; name?: string }; delta?: { type: string; text?: string; partial_json?: string; thinking?: string }; usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } },
    state: StreamingState
  ): void {
    switch (event.type) {
      case 'message_start':
        state.currentText = ''
        state.isStreaming = false // text hasn't started; set true at the first text token below
        state.currentToolUse = null
        state.currentThinking = false
        state.isRetrying = false // the response is flowing now, so any retry resolved
        // 'streaming' is deferred to the first text token (set above) so a message that
        // opens with a tool call stays 'working' instead of flipping streaming→working.
        this.broadcastToSSE(sessionId, { type: 'stream_start' })
        break

      case 'content_block_start':
        // Track when a tool use block starts
        if (event.content_block?.type === 'tool_use') {
          state.currentToolUse = {
            id: event.content_block.id!,
            name: event.content_block.name!,
          }
          state.currentToolInput = '' // Reset input accumulator
          this.broadcastToSSE(sessionId, {
            type: 'tool_use_start',
            toolId: event.content_block.id,
            toolName: event.content_block.name,
            partialInput: '',
          })
        } else if (event.content_block?.type === 'thinking') {
          // Extended-thinking block started — UI flips "Working" to "Thinking".
          // Reasoning text follows via thinking_delta (the agent requests
          // `display: 'summarized'`; without it newer models omit the text).
          state.currentThinking = true
          this.broadcastToSSE(sessionId, { type: 'thinking_start' })
        }
        break

      case 'content_block_delta':
        if (event.delta?.type === 'text_delta' && event.delta.text) {
          state.currentText += event.delta.text
          this.broadcastToSSE(sessionId, {
            type: 'stream_delta',
            text: event.delta.text,
          })
          // The streamed reply now owns the surface → 'streaming' (deferred from
          // message_start so a tool-first message never flips streaming→working).
          state.isStreaming = true
        } else if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
          // Stream summarized reasoning text so the UI can accumulate it for "View thinking"
          this.broadcastToSSE(sessionId, {
            type: 'thinking_delta',
            text: event.delta.thinking,
          })
        } else if (event.delta?.type === 'input_json_delta') {
          // Tool input is being streamed - accumulate and broadcast
          const partialJson = event.delta.partial_json || ''
          state.currentToolInput += partialJson
          this.broadcastToSSE(sessionId, {
            type: 'tool_use_streaming',
            toolId: state.currentToolUse?.id,
            toolName: state.currentToolUse?.name,
            partialInput: redactStreamedToolInput(
              state.currentToolUse?.name,
              state.currentToolInput,
            ),
          })
        }
        break

      case 'content_block_stop':
        // Thinking block finished streaming — flip back to "Working"
        if (state.currentThinking) {
          state.currentThinking = false
          this.broadcastToSSE(sessionId, { type: 'thinking_stop' })
        }
        // Tool use block finished streaming
        if (state.currentToolUse) {
          // Track agent-emitted user request blocks
          if (state.currentToolUse.name === 'AskUserQuestion') {
            trackServerEvent('agent_requested_input', { agentSlug: state.agentSlug })
          } else if (state.currentToolUse.name.startsWith('mcp__user-input__')) {
            const action = state.currentToolUse.name.replace('mcp__user-input__', '')
            trackServerEvent(`agent_${action}`, { agentSlug: state.agentSlug })
          }

          // Check if this is a secret request tool
          if (state.currentToolUse.name === 'mcp__user-input__request_secret') {
            this.handleSecretRequestTool(
              sessionId,
              state.currentToolUse.id,
              state.currentToolInput,
              state.agentSlug
            )
          }

          // Check if this is a connected account request tool
          if (state.currentToolUse.name === 'mcp__user-input__request_connected_account') {
            this.handleConnectedAccountRequestTool(
              sessionId,
              state.currentToolUse.id,
              state.currentToolInput,
              state.agentSlug
            )
          }

          // Check if this is a schedule task tool
          if (state.currentToolUse.name === 'mcp__user-input__schedule_task') {
            this.handleScheduleTaskTool(
              sessionId,
              state.currentToolUse.id,
              state.currentToolInput,
              state.agentSlug
            )
          }

          // List scheduled tasks tool - blocking
          if (state.currentToolUse.name === 'mcp__user-input__list_scheduled_tasks') {
            this.handleListScheduledTasksTool(
              sessionId,
              state.currentToolUse.id,
              state.currentToolInput,
              state.agentSlug
            )
          }

          // Cancel scheduled task tool - blocking
          if (state.currentToolUse.name === 'mcp__user-input__cancel_scheduled_task') {
            this.handleCancelScheduledTaskTool(
              sessionId,
              state.currentToolUse.id,
              state.currentToolInput,
              state.agentSlug
            )
          }

          // Pause scheduled task tool - blocking
          if (state.currentToolUse.name === 'mcp__user-input__pause_scheduled_task') {
            this.handlePauseResumeScheduledTaskTool(
              'pause',
              sessionId,
              state.currentToolUse.id,
              state.currentToolInput,
              state.agentSlug
            )
          }

          // Resume scheduled task tool - blocking
          if (state.currentToolUse.name === 'mcp__user-input__resume_scheduled_task') {
            this.handlePauseResumeScheduledTaskTool(
              'resume',
              sessionId,
              state.currentToolUse.id,
              state.currentToolInput,
              state.agentSlug
            )
          }

          // Webhook trigger tools
          if (state.currentToolUse.name === 'mcp__user-input__get_available_triggers') {
            this.handleGetAvailableTriggersTool(
              sessionId, state.currentToolUse.id, state.currentToolInput, state.agentSlug
            )
          }
          if (state.currentToolUse.name === 'mcp__user-input__setup_trigger') {
            this.handleSetupTriggerTool(
              sessionId, state.currentToolUse.id, state.currentToolInput, state.agentSlug
            )
          }
          if (state.currentToolUse.name === 'mcp__user-input__list_triggers') {
            this.handleListTriggersTool(
              sessionId, state.currentToolUse.id, state.currentToolInput, state.agentSlug
            )
          }
          if (state.currentToolUse.name === 'mcp__user-input__cancel_trigger') {
            this.handleCancelTriggerTool(
              sessionId, state.currentToolUse.id, state.currentToolInput, state.agentSlug
            )
          }
          if (state.currentToolUse.name === 'mcp__user-input__create_webhook_endpoint') {
            this.handleCreateWebhookEndpointTool(
              sessionId, state.currentToolUse.id, state.currentToolInput, state.agentSlug
            )
          }
          if (state.currentToolUse.name === 'mcp__user-input__update_webhook_endpoint') {
            this.handleUpdateWebhookEndpointTool(
              sessionId, state.currentToolUse.id, state.currentToolInput, state.agentSlug
            )
          }
          if (state.currentToolUse.name === 'mcp__user-input__inspect_webhook_events') {
            this.handleInspectWebhookEventsTool(
              sessionId, state.currentToolUse.id, state.currentToolInput, state.agentSlug
            )
          }

          // Check if this is an AskUserQuestion tool
          if (state.currentToolUse.name === 'AskUserQuestion') {
            this.handleAskUserQuestionTool(
              sessionId,
              state.currentToolUse.id,
              state.currentToolInput,
              state.agentSlug
            )
          }

          // Check if this is a file request tool
          if (state.currentToolUse.name === 'mcp__user-input__request_file') {
            this.handleFileRequestTool(
              sessionId,
              state.currentToolUse.id,
              state.currentToolInput,
              state.agentSlug
            )
          }

          // Check if this is a remote MCP request tool
          if (state.currentToolUse.name === 'mcp__user-input__request_remote_mcp') {
            this.handleRemoteMcpRequestTool(
              sessionId,
              state.currentToolUse.id,
              state.currentToolInput,
              state.agentSlug
            )
          }

          if (state.currentToolUse.name === 'mcp__user-input__request_browser_input') {
            this.handleBrowserInputRequestTool(
              sessionId,
              state.currentToolUse.id,
              state.currentToolInput,
              state.agentSlug
            )
          }

          if (state.currentToolUse.name === 'mcp__user-input__request_script_run') {
            this.handleScriptRunRequestTool(
              sessionId,
              state.currentToolUse.id,
              state.currentToolInput,
              state.agentSlug
            )
          }

          if (state.currentToolUse.name.startsWith('mcp__computer-use__')) {
            this.handleComputerUseRequestTool(
              sessionId,
              state.currentToolUse.id,
              state.currentToolUse.name,
              state.currentToolInput,
              state.agentSlug
            )
          }

          // Subagent/workflow launches pause in the container under a 'review'
          // policy — surface the approval card. The handler itself checks the
          // policy and session grants (no-op under allow/block/granted).
          if (['Task', 'Agent', 'Workflow'].includes(state.currentToolUse.name)) {
            this.handleCapabilityReviewTool(
              sessionId,
              state.currentToolUse.id,
              state.currentToolUse.name,
              state.currentToolInput,
              state.agentSlug
            )
          }

          // Mark session as awaiting input when a blocking user-input tool fires
          // Only tools with 'request_' prefix actually block waiting for user response
          // (schedule_task, deliver_file, search_* resolve immediately and don't block)
          // Note: computer-use AND request_script_run tools are handled by their own
          // handlers which only mark awaiting input when user approval is actually
          // needed (not when auto-executed against a cached permission grant).
          if (isBlockingUserInputToolName(state.currentToolUse.name)) {
            this.markSessionAwaitingInput(sessionId)
          }

          // Track deliver_file tool calls so the matching tool_result can be
          // correlated. We deliver the file to chat clients off the tool RESULT
          // (which validates the file exists in-container) rather than off the
          // streamed input, so a path that doesn't exist never reaches host-side
          // delivery. Keyed by tool_use ID; resolved in handleToolResults.
          if (state.currentToolUse.name === 'mcp__user-input__deliver_file') {
            try {
              const parsed = JSON.parse(state.currentToolInput)
              if (parsed && typeof parsed.filePath === 'string') {
                state.pendingDeliverFiles.set(state.currentToolUse.id, {
                  filePath: parsed.filePath,
                  description: typeof parsed.description === 'string' ? parsed.description : undefined,
                })
              }
            } catch { /* partial or invalid JSON — nothing to deliver */ }
          }

          // Track Task/Agent tool for subagent correlation
          if (state.currentToolUse.name === 'Task' || state.currentToolUse.name === 'Agent') {
            let isBackground = false
            try {
              const parsed = JSON.parse(state.currentToolInput)
              isBackground = !!parsed.run_in_background
            } catch { /* partial or invalid JSON — default to foreground */ }
            state.activeSubagents.set(state.currentToolUse.id, {
              agentId: null,
              currentText: '',
              currentToolUse: null,
              currentToolInput: '',
              isBackground,
            })
          }

          this.broadcastToSSE(sessionId, {
            type: 'tool_use_ready',
            toolId: state.currentToolUse.id,
            toolName: state.currentToolUse.name,
          })
          state.currentToolUse = null
          state.currentToolInput = ''
        }
        break

      case 'message_delta':
        // message_delta carries final usage data (especially important for OpenRouter
        // which sends input_tokens: 0 in message_start but real values in message_delta)
        if (event.usage) {
          const deltaUsage = event.usage as { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
          if (deltaUsage.input_tokens || deltaUsage.output_tokens) {
            this.broadcastContextUsage(sessionId, state, deltaUsage)
          }
        }
        break

      case 'message_stop':
        // Don't save here - JSONL is the source of truth
        state.isStreaming = false
        state.currentToolUse = null
        state.currentToolInput = ''
        // Defensive: ensure thinking state is cleared if a stop was missed
        if (state.currentThinking) {
          state.currentThinking = false
          this.broadcastToSSE(sessionId, { type: 'thinking_stop' })
        }
        break
    }
  }

  // Handle secret request tool - broadcast to SSE clients so they can show the UI
  private handleSecretRequestTool(
    sessionId: string,
    toolUseId: string,
    toolInput: string,
    agentSlug?: string
  ): void {
    try {
      // Parse the tool input to get secretName and reason
      let input: RequestSecretInput = {}
      try {
        input = JSON.parse(toolInput)
      } catch {
        console.error('[MessagePersister] Failed to parse secret request input:', toolInput)
        return
      }

      if (!input.secretName) {
        console.error('[MessagePersister] Secret request missing secretName')
        return
      }

      // Broadcast the secret request event to SSE clients
      this.broadcastToSSE(sessionId, {
        type: 'secret_request',
        toolUseId,
        secretName: input.secretName,
        reason: input.reason,
        agentSlug,
      })

      // Renderer's notification gate decides whether to show the OS popup
      // based on focus / per-user viewing / `notifyWhenUnfocused` toggle.
      if (agentSlug) {
        notificationManager.triggerSessionWaitingInput(sessionId, agentSlug, 'secret').catch((err) => {
          console.error('[MessagePersister] Failed to trigger waiting input notification:', err)
        })
      }
    } catch (error) {
      console.error('[MessagePersister] Error handling secret request:', error)
    }
  }

  // Handle connected account request tool - broadcast to SSE clients so they can show the UI
  private handleConnectedAccountRequestTool(
    sessionId: string,
    toolUseId: string,
    toolInput: string,
    agentSlug?: string
  ): void {
    try {
      // Parse the tool input to get toolkit and reason
      let input: RequestConnectedAccountInput = {}
      try {
        input = JSON.parse(toolInput)
      } catch {
        console.error('[MessagePersister] Failed to parse connected account request input:', toolInput)
        return
      }

      if (!input.toolkit) {
        console.error('[MessagePersister] Connected account request missing toolkit')
        return
      }

      // Broadcast the connected account request event to SSE clients
      this.broadcastToSSE(sessionId, {
        type: 'connected_account_request',
        toolUseId,
        toolkit: input.toolkit.toLowerCase(),
        reason: input.reason,
        agentSlug,
      })

      // Renderer-side gate handles suppression; see session_complete trigger.
      if (agentSlug) {
        notificationManager.triggerSessionWaitingInput(sessionId, agentSlug, 'connected_account').catch((err) => {
          console.error('[MessagePersister] Failed to trigger waiting input notification:', err)
        })
      }
    } catch (error) {
      console.error('[MessagePersister] Error handling connected account request:', error)
    }
  }

  // Handle schedule task tool - blocking: persist to database, then resolve the
  // container tool only after the task is actually saved (fixes the false-success
  // bug where the tool reported success while persistence ran/failed in the
  // background). Also appends a warning for too-frequent recurring schedules.
  private handleScheduleTaskTool(
    sessionId: string,
    toolUseId: string,
    toolInput: string,
    agentSlug?: string
  ): void {
    ;(async () => {
      if (!agentSlug) {
        // Without an agentSlug we can't reach the container to resolve/reject.
        console.error('[MessagePersister] Schedule task missing agentSlug')
        return
      }

      // Parse the tool input
      let input: {
        scheduleType: 'at' | 'cron'
        scheduleExpression: string
        prompt: string
        name?: string
        timezone?: string
        model?: string
        effort?: string
      }
      try {
        input = JSON.parse(toolInput)
      } catch {
        console.error('[MessagePersister] Failed to parse schedule task input:', toolInput)
        await this.rejectContainerInput(agentSlug, toolUseId, 'Invalid tool input').catch(console.error)
        return
      }

      // Trim-aware required-field check, matching the container tool's own
      // validation (a whitespace-only prompt/expression is empty). Without the
      // trim the host would persist a task the container already told the agent
      // was rejected.
      if (!input.scheduleType || !input.scheduleExpression?.trim() || !input.prompt?.trim()) {
        await this.rejectContainerInput(
          agentSlug,
          toolUseId,
          'Missing required fields: scheduleType, scheduleExpression, and prompt are required'
        ).catch(console.error)
        return
      }

      // Persist the task. A failure here must reject — the agent is never told a
      // false success.
      let taskId: string
      let timezone: string | undefined
      try {
        // Resolve timezone: agent tool override > agent owner's timezone
        timezone = input.timezone || resolveTimezoneForAgent(agentSlug)
        const sessionOwnerId = (await getSessionMetadata(agentSlug, sessionId))?.createdByUserId
        taskId = await createScheduledTask({
          agentSlug,
          scheduleType: input.scheduleType,
          scheduleExpression: input.scheduleExpression,
          prompt: input.prompt,
          name: input.name,
          createdBySessionId: sessionId,
          createdByUserId: sessionOwnerId ?? undefined,
          timezone,
          model: input.model,
          effort: input.effort,
        })
      } catch (error) {
        console.error('[MessagePersister] Error handling schedule task:', error)
        const msg = error instanceof Error ? error.message : String(error)
        await this.rejectContainerInput(agentSlug, toolUseId, `Failed to schedule task: ${msg}`).catch(console.error)
        return
      }

      // The task is persisted. Everything past here is best-effort: a failure
      // delivering the result must NOT reject the tool, or the agent could be told
      // a real success failed and retry into a duplicate schedule.
      try {
        // Broadcast the scheduled task created event to session-specific SSE clients
        this.broadcastToSSE(sessionId, {
          type: 'scheduled_task_created',
          toolUseId,
          taskId,
          scheduleType: input.scheduleType,
          scheduleExpression: input.scheduleExpression,
          name: input.name,
          agentSlug,
        })

        // Also broadcast globally so scheduled task list updates regardless of which session is viewed
        this.broadcastGlobal({
          type: 'scheduled_task_created',
          taskId,
          agentSlug,
        })

        // Build the agent-facing result: base success + any frequency warning,
        // then enrich with the agent's active-schedule count, a soft-cap warning,
        // and the full active list so a runaway loop or duplicate schedules are
        // visible. The enrichment is best-effort — if reading the active list
        // throws we still resolve with the base success so the blocking tool never
        // hangs.
        let resultMessage = this.formatScheduleTaskResult(input, taskId, timezone)
        try {
          const activeTasks = await listPendingScheduledTasks(agentSlug)
          resultMessage += this.formatActiveScheduleSummary(activeTasks)
        } catch (summaryError) {
          console.error('[MessagePersister] Failed to build active-schedule summary:', summaryError)
        }

        // Resolve the blocking tool with the (possibly enriched) success message.
        await this.resolveContainerInput(agentSlug, toolUseId, resultMessage)
      } catch (deliveryError) {
        console.error('[MessagePersister] Schedule persisted but result delivery failed:', deliveryError)
      }
    })()
  }

  /**
   * Build the success message returned to the agent after a schedule is persisted,
   * appending a too-frequent-interval warning for recurring schedules below the
   * recommended minimum.
   */
  private formatScheduleTaskResult(
    input: {
      scheduleType: 'at' | 'cron'
      scheduleExpression: string
      prompt: string
      name?: string
    },
    taskId: string,
    timezone?: string
  ): string {
    const taskType = input.scheduleType === 'cron' ? 'recurring' : 'one-time'
    const taskName = input.name || 'Scheduled Task'
    const parsed = validateScheduleExpression(input.scheduleType, input.scheduleExpression, timezone)
    const nextRun = parsed.nextTime ? `\nNext run: ${parsed.nextTime.toISOString()}` : ''
    const continuation =
      input.scheduleType === 'cron'
        ? 'This recurring task will continue until cancelled.'
        : 'This one-time task will be removed after execution.'

    let result = `Scheduled ${taskType} task "${taskName}" (ID: ${taskId}).

Schedule: ${input.scheduleExpression}${timezone ? ` (${timezone})` : ''}${nextRun}

${continuation}`

    const warning = getFrequencyWarning(input.scheduleType, input.scheduleExpression, timezone)
    if (warning) {
      result += `\n\n${warning}`
    }

    return result
  }

  /**
   * Build the active-schedule summary appended to a schedule_task result: the
   * agent's current count of active schedules (pending + paused), a soft-cap
   * warning when the count is high, and the full list (id, name, schedule
   * expression, next run) so the agent can spot duplicates/overlaps and
   * self-correct. Always returns the count + list; the warning is conditional.
   */
  private formatActiveScheduleSummary(tasks: ScheduledTask[]): string {
    const count = tasks.length
    let summary = `\n\nActive schedules for this agent: ${count}`

    const warning = getScheduleCountWarning(count)
    if (warning) {
      summary += `\n\n${warning}`
    }

    if (count > 0) {
      const list = tasks
        .map((t) => {
          const kind = t.scheduleType === 'cron' ? 'recurring' : 'one-time'
          const next = t.nextExecutionAt ? t.nextExecutionAt.toISOString() : 'unknown'
          const status = t.status === 'paused' ? ' [PAUSED]' : ''
          return `- **${t.name || 'Scheduled Task'}** (ID: ${t.id})${status} — ${kind} (${t.scheduleExpression}), next run ${next}${t.timezone ? ` (${t.timezone})` : ''}`
        })
        .join('\n')
      summary += `\n\n${list}`
    }

    return summary
  }

  // Handle list_scheduled_tasks - blocking: read from SQLite and resolve
  private handleListScheduledTasksTool(
    _sessionId: string,
    toolUseId: string,
    _toolInput: string,
    agentSlug?: string
  ): void {
    ;(async () => {
      try {
        if (!agentSlug) {
          console.error('[MessagePersister] list_scheduled_tasks missing agentSlug')
          return
        }

        const tasks = await listPendingScheduledTasks(agentSlug)
        const formatted = tasks.length === 0
          ? 'No scheduled tasks on the schedule for this agent.'
          : `Scheduled tasks:\n\n${tasks.map((t) => {
              const kind = t.scheduleType === 'cron' ? 'recurring' : 'one-time'
              const next = t.nextExecutionAt ? t.nextExecutionAt.toISOString() : 'unknown'
              const status = t.status === 'paused' ? ' [PAUSED]' : ''
              return `- **${t.name || 'Scheduled Task'}** (ID: ${t.id})${status}\n  Type: ${kind} (${t.scheduleExpression})\n  Next run: ${next}${t.timezone ? ` (${t.timezone})` : ''}\n  Prompt: ${t.prompt.substring(0, 80)}${t.prompt.length > 80 ? '...' : ''}`
            }).join('\n\n')}`

        await this.resolveContainerInput(agentSlug, toolUseId, formatted)
      } catch (error) {
        console.error('[MessagePersister] Error handling list_scheduled_tasks:', error)
        if (agentSlug) {
          await this.rejectContainerInput(agentSlug, toolUseId, String(error)).catch(console.error)
        }
      }
    })()
  }

  // Handle cancel_scheduled_task - blocking: cancel in SQLite, then resolve
  private handleCancelScheduledTaskTool(
    sessionId: string,
    toolUseId: string,
    toolInput: string,
    agentSlug?: string
  ): void {
    ;(async () => {
      try {
        if (!agentSlug) {
          console.error('[MessagePersister] cancel_scheduled_task missing agentSlug')
          return
        }

        let input: { task_id: string }
        try {
          input = JSON.parse(toolInput)
        } catch {
          await this.rejectContainerInput(agentSlug, toolUseId, 'Invalid tool input')
          return
        }

        if (!input.task_id) {
          await this.rejectContainerInput(agentSlug, toolUseId, 'Missing required field: task_id')
          return
        }

        // Verify the task exists and belongs to this agent before cancelling, so
        // an agent can't cancel another agent's scheduled tasks by guessing IDs.
        const task = await getScheduledTask(input.task_id)
        if (!task || task.agentSlug !== agentSlug) {
          await this.rejectContainerInput(agentSlug, toolUseId, `Scheduled task ${input.task_id} not found`)
          return
        }

        const cancelled = await cancelScheduledTask(input.task_id)
        if (!cancelled) {
          await this.rejectContainerInput(agentSlug, toolUseId, `Scheduled task ${input.task_id} could not be cancelled — it may have already executed or been cancelled`)
          return
        }

        // Broadcast so the scheduled task list updates in the UI
        this.broadcastToSSE(sessionId, {
          type: 'scheduled_task_cancelled',
          toolUseId,
          taskId: input.task_id,
          agentSlug,
        })

        this.broadcastGlobal({
          type: 'scheduled_task_cancelled',
          taskId: input.task_id,
          agentSlug,
        })

        await this.resolveContainerInput(agentSlug, toolUseId,
          `Scheduled task ${input.task_id} has been cancelled. It will no longer execute.`)

        console.log(`[MessagePersister] Scheduled task ${input.task_id} cancelled`)
      } catch (error) {
        console.error('[MessagePersister] Error handling cancel_scheduled_task:', error)
        if (agentSlug) {
          const msg = error instanceof Error ? error.message : String(error)
          await this.rejectContainerInput(agentSlug, toolUseId, `Failed to cancel scheduled task: ${msg}`).catch(console.error)
        }
      }
    })()
  }

  // Handle pause_scheduled_task / resume_scheduled_task - blocking: update SQLite, then resolve
  private handlePauseResumeScheduledTaskTool(
    action: 'pause' | 'resume',
    sessionId: string,
    toolUseId: string,
    toolInput: string,
    agentSlug?: string
  ): void {
    ;(async () => {
      try {
        if (!agentSlug) {
          console.error(`[MessagePersister] ${action}_scheduled_task missing agentSlug`)
          return
        }

        let input: { task_id: string }
        try {
          input = JSON.parse(toolInput)
        } catch {
          await this.rejectContainerInput(agentSlug, toolUseId, 'Invalid tool input')
          return
        }

        if (!input.task_id) {
          await this.rejectContainerInput(agentSlug, toolUseId, 'Missing required field: task_id')
          return
        }

        // Verify the task exists and belongs to this agent before mutating it.
        const task = await getScheduledTask(input.task_id)
        if (!task || task.agentSlug !== agentSlug) {
          await this.rejectContainerInput(agentSlug, toolUseId, `Scheduled task ${input.task_id} not found`)
          return
        }

        const ok = action === 'pause'
          ? await pauseScheduledTask(input.task_id)
          : await resumeScheduledTask(input.task_id)

        if (!ok) {
          const reason = action === 'pause'
            ? `Scheduled task ${input.task_id} could not be paused — only active recurring tasks can be paused`
            : `Scheduled task ${input.task_id} could not be resumed — only paused recurring tasks can be resumed`
          await this.rejectContainerInput(agentSlug, toolUseId, reason)
          return
        }

        // Broadcast so the scheduled task list updates in the UI
        this.broadcastToSSE(sessionId, {
          type: 'scheduled_task_updated',
          toolUseId,
          taskId: input.task_id,
          agentSlug,
        })

        this.broadcastGlobal({
          type: 'scheduled_task_updated',
          taskId: input.task_id,
          agentSlug,
        })

        const verb = action === 'pause' ? 'paused' : 'resumed'
        await this.resolveContainerInput(agentSlug, toolUseId,
          `Scheduled task ${input.task_id} has been ${verb}.${action === 'pause' ? ' It will not execute until resumed.' : ' Its next run was recomputed from the schedule.'}`)

        console.log(`[MessagePersister] Scheduled task ${input.task_id} ${verb}`)
      } catch (error) {
        console.error(`[MessagePersister] Error handling ${action}_scheduled_task:`, error)
        if (agentSlug) {
          const msg = error instanceof Error ? error.message : String(error)
          await this.rejectContainerInput(agentSlug, toolUseId, `Failed to ${action} scheduled task: ${msg}`).catch(console.error)
        }
      }
    })()
  }

  // ============================================================================
  // Webhook Trigger Tool Handlers
  // ============================================================================

  /**
   * Resolve a blocking tool in the container with a string value.
   */
  private async resolveContainerInput(agentSlug: string, toolUseId: string, value: string): Promise<void> {
    const cm = await getContainerManager()
    const client = cm.getClient(agentSlug)
    await client.fetch(`/inputs/${encodeURIComponent(toolUseId)}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    })
  }

  /**
   * Reject a blocking tool in the container with an error message.
   */
  private async rejectContainerInput(agentSlug: string, toolUseId: string, reason: string): Promise<void> {
    const cm = await getContainerManager()
    const client = cm.getClient(agentSlug)
    await client.fetch(`/inputs/${encodeURIComponent(toolUseId)}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    })
  }

  /**
   * Interrupt the running query in the container (abort + resume) by POSTing the same
   * `/sessions/:id/interrupt` endpoint the explicit interrupt route hits. Uses `client.fetch`
   * (not the `client.interruptSession` helper that route calls) to stay on the proxy-routed path
   * the rest of MessagePersister's container calls use, e.g. `rejectContainerInput`.
   */
  private async interruptContainerSession(agentSlug: string, sessionId: string): Promise<void> {
    const cm = await getContainerManager()
    const client = cm.getClient(agentSlug)
    await client.fetch(`/sessions/${encodeURIComponent(sessionId)}/interrupt`, {
      method: 'POST',
    })
  }

  // Handle get_available_triggers - blocking: fetch from Composio and resolve
  private handleGetAvailableTriggersTool(
    sessionId: string,
    toolUseId: string,
    toolInput: string,
    agentSlug?: string
  ): void {
    ;(async () => {
      try {
        if (!agentSlug) {
          console.error('[MessagePersister] get_available_triggers missing agentSlug')
          return
        }

        if (!isPlatformComposioActive()) {
          await this.rejectContainerInput(agentSlug, toolUseId, 'Webhook triggers are only available with platform Composio')
          return
        }

        let input: { connected_account_id: string }
        try {
          input = JSON.parse(toolInput)
        } catch {
          await this.rejectContainerInput(agentSlug, toolUseId, 'Invalid tool input')
          return
        }

        // Look up the connected account to get its toolkit slug
        const [account] = await db
          .select()
          .from(connectedAccounts)
          .where(eq(connectedAccounts.id, input.connected_account_id))
          .limit(1)

        if (!account) {
          await this.rejectContainerInput(agentSlug, toolUseId, `Connected account ${input.connected_account_id} not found`)
          return
        }

        const triggers = await getAvailableTriggers(account.toolkitSlug)
        const formatted = triggers.length === 0
          ? 'No webhook triggers available for this account.\n\n' +
            'You can still react to events from this service with a custom webhook endpoint:\n' +
            '1. Call create_webhook_endpoint to mint a public URL (with a prompt describing what to do per event).\n' +
            `2. Register that URL with the service — most expose webhook registration via their API (use the connected ${account.toolkitSlug} account) or a settings page.\n` +
            '3. If the service provides a signing secret, attach it with update_webhook_endpoint so deliveries are verified.\n' +
            '4. If the service\'s webhook events are broader than what you need (most are), add a CEL filter_exp so only matching events start a session — dry-run candidates against real deliveries with inspect_webhook_events first.'
          : `Available triggers for ${account.toolkitSlug}:\n\n${triggers.map((t) =>
              `- **${t.slug}** (${t.name}): ${t.description}${t.type === 'poll' ? ' [poll-based]' : ''}`
            ).join('\n')}\n\nUse setup_trigger with the trigger slug to subscribe. ` +
            'For events this catalog does not cover, you can also mint a custom webhook endpoint (create_webhook_endpoint) and register its URL with the service directly — both kinds can run side by side.'

        await this.resolveContainerInput(agentSlug, toolUseId, formatted)
      } catch (error) {
        console.error('[MessagePersister] Error handling get_available_triggers:', error)
        if (agentSlug) {
          await this.rejectContainerInput(agentSlug, toolUseId, String(error)).catch(console.error)
        }
      }
    })()
  }

  // Handle setup_trigger - blocking: dual-write to Composio + SQLite, then resolve
  private handleSetupTriggerTool(
    sessionId: string,
    toolUseId: string,
    toolInput: string,
    agentSlug?: string
  ): void {
    ;(async () => {
      try {
        if (!agentSlug) {
          console.error('[MessagePersister] setup_trigger missing agentSlug')
          return
        }

        if (!isPlatformComposioActive()) {
          await this.rejectContainerInput(agentSlug, toolUseId, 'Webhook triggers are only available with platform Composio')
          return
        }

        let input: {
          connected_account_id: string
          trigger_type: string
          prompt: string
          name?: string
          trigger_config?: Record<string, unknown>
          model?: string
          effort?: string
        }
        try {
          input = JSON.parse(toolInput)
        } catch {
          await this.rejectContainerInput(agentSlug, toolUseId, 'Invalid tool input')
          return
        }

        if (!input.connected_account_id || !input.trigger_type || !input.prompt) {
          await this.rejectContainerInput(agentSlug, toolUseId, 'Missing required fields: connected_account_id, trigger_type, and prompt are required')
          return
        }

        // Resolve local SQLite account ID → Composio connection ID
        const [account] = await db
          .select()
          .from(connectedAccounts)
          .where(eq(connectedAccounts.id, input.connected_account_id))
          .limit(1)

        if (!account) {
          await this.rejectContainerInput(agentSlug, toolUseId, `Connected account ${input.connected_account_id} not found`)
          return
        }

        const providerConnectionId = account.providerConnectionId

        // Validate trigger type against available triggers for this account
        const availableTriggers = await getAvailableTriggers(account.toolkitSlug)
        const validSlugs = availableTriggers.map((t) => t.slug)
        if (!validSlugs.includes(input.trigger_type)) {
          const suggestion = validSlugs.length > 0
            ? `\n\nAvailable triggers for ${account.toolkitSlug}: ${validSlugs.join(', ')}`
            : `\n\nNo triggers are available for ${account.toolkitSlug}.`
          await this.rejectContainerInput(agentSlug, toolUseId,
            `Invalid trigger type "${input.trigger_type}" for this account.${suggestion}`)
          return
        }

        // 1. Enable trigger on Composio via proxy (using Composio's ca_* ID)
        const composioTriggerId = await enableComposioTrigger(
          input.trigger_type,
          providerConnectionId,
          input.trigger_config,
        )

        // 2. Save to SQLite (store the local account ID for app-level lookups)
        let triggerId: string
        try {
          const triggerOwnerId = (await getSessionMetadata(agentSlug, sessionId))?.createdByUserId
          triggerId = await createWebhookTrigger({
            agentSlug,
            composioTriggerId,
            connectedAccountId: input.connected_account_id,
            triggerType: input.trigger_type,
            triggerConfig: input.trigger_config ? JSON.stringify(input.trigger_config) : undefined,
            prompt: input.prompt,
            name: input.name,
            createdBySessionId: sessionId,
            createdByUserId: triggerOwnerId ?? undefined,
            model: input.model,
            effort: input.effort,
          })
        } catch (dbError) {
          // Rollback Composio trigger
          console.error('[MessagePersister] SQLite save failed, rolling back Composio trigger:', dbError)
          await deleteComposioTrigger(composioTriggerId).catch(console.error)
          await this.rejectContainerInput(agentSlug, toolUseId, 'Failed to save trigger locally').catch(console.error)
          return
        }

        // 3. Broadcast events
        this.broadcastToSSE(sessionId, {
          type: 'webhook_trigger_created',
          toolUseId,
          triggerId,
          triggerType: input.trigger_type,
          name: input.name,
          agentSlug,
        })

        this.broadcastGlobal({
          type: 'webhook_trigger_created',
          triggerId,
          agentSlug,
        })

        const triggerName = input.name || input.trigger_type
        await this.resolveContainerInput(agentSlug, toolUseId,
          `Webhook trigger "${triggerName}" created successfully (ID: ${triggerId}).\n\nTrigger type: ${input.trigger_type}\nConnected account: ${input.connected_account_id}\nPrompt: ${input.prompt.substring(0, 100)}${input.prompt.length > 100 ? '...' : ''}\n\nThe trigger is now active and will fire when the event occurs.`)

        console.log(`[MessagePersister] Webhook trigger ${triggerId} created (composio: ${composioTriggerId})`)
      } catch (error) {
        console.error('[MessagePersister] Error handling setup_trigger:', error)
        if (agentSlug) {
          const msg = error instanceof Error ? error.message : String(error)
          await this.rejectContainerInput(agentSlug, toolUseId, `Failed to set up trigger: ${msg}`).catch(console.error)
        }
      }
    })()
  }

  /**
   * Member context for platform webhook-endpoint calls: session owner first,
   * stored member as fallback, 'local' placeholder last (opaque platform keys
   * ignore the member suffix entirely).
   */
  private async resolvePlatformMemberForSession(agentSlug: string, sessionId: string): Promise<string> {
    const ownerId = (await getSessionMetadata(agentSlug, sessionId))?.createdByUserId
    const resolved = resolvePlatformMemberForCandidates([ownerId])
    return resolved?.memberId ?? getStoredPlatformMemberId() ?? 'local'
  }

  // Handle create_webhook_endpoint - blocking: mint on platform + save SQLite
  // trigger row (kind='custom'), rolling back the mint if the local save fails.
  private handleCreateWebhookEndpointTool(
    sessionId: string,
    toolUseId: string,
    toolInput: string,
    agentSlug?: string
  ): void {
    ;(async () => {
      try {
        if (!agentSlug) {
          console.error('[MessagePersister] create_webhook_endpoint missing agentSlug')
          return
        }

        // Gate on platform auth, not Composio mode: custom endpoints live on
        // the platform proxy and must keep working when the user brings their
        // own Composio key (mirrors the teardown gate in
        // webhook-trigger-service).
        if (!getPlatformAccessToken()) {
          await this.rejectContainerInput(agentSlug, toolUseId, 'Custom webhook endpoints are only available when connected to the platform')
          return
        }

        let rawInput: unknown
        try {
          rawInput = JSON.parse(toolInput)
        } catch {
          await this.rejectContainerInput(agentSlug, toolUseId, 'Invalid tool input')
          return
        }

        const parsedInput = createWebhookEndpointInputSchema.safeParse(rawInput)
        if (!parsedInput.success) {
          await this.rejectContainerInput(agentSlug, toolUseId,
            `Invalid tool input: ${parsedInput.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`)
          return
        }
        const input = parsedInput.data
        const verification = input.verification ?? undefined
        const filterExp = input.filter_exp ?? undefined

        const memberId = await this.resolvePlatformMemberForSession(agentSlug, sessionId)

        // 1. Mint the endpoint on the platform proxy
        const endpoint = await createPlatformWebhookEndpoint(memberId, {
          name: input.name.trim(),
          ...(verification ? { verification } : {}),
          ...(filterExp ? { filter_exp: filterExp } : {}),
        })

        // 2. Save the local trigger row (rollback the mint on failure)
        let triggerId: string
        try {
          const triggerOwnerId = (await getSessionMetadata(agentSlug, sessionId))?.createdByUserId
          triggerId = await createWebhookTrigger({
            agentSlug,
            kind: 'custom',
            composioTriggerId: endpoint.id,
            triggerType: CUSTOM_WEBHOOK_TRIGGER_TYPE,
            // The public URL lives platform-side; mirror it here so list/UI
            // don't need a platform round-trip.
            triggerConfig: JSON.stringify({ url: endpoint.url, endpointId: endpoint.id }),
            prompt: input.prompt,
            name: input.name.trim(),
            createdBySessionId: sessionId,
            createdByUserId: triggerOwnerId ?? undefined,
            model: input.model,
            effort: input.effort,
          })
        } catch (dbError) {
          console.error('[MessagePersister] SQLite save failed, disabling platform endpoint:', dbError)
          captureException(dbError, {
            tags: { area: 'webhook-endpoints', op: 'create-local-save' },
            extra: { endpointId: endpoint.id, agentSlug, sessionId },
          })
          await disablePlatformWebhookEndpoint(memberId, endpoint.id).catch((rollbackError) => {
            // Mint succeeded, local save failed, and now the rollback failed too:
            // a live public URL is orphaned with no local row. Loudest signal.
            console.error('[MessagePersister] Endpoint rollback failed — endpoint orphaned live:', rollbackError)
            captureException(rollbackError, {
              tags: { area: 'webhook-endpoints', op: 'create-rollback' },
              extra: { endpointId: endpoint.id, agentSlug, sessionId, memberId },
            })
          })
          await this.rejectContainerInput(agentSlug, toolUseId, 'Failed to save trigger locally').catch(console.error)
          return
        }

        // 3. Broadcast events (same shape as Composio trigger creation)
        this.broadcastToSSE(sessionId, {
          type: 'webhook_trigger_created',
          toolUseId,
          triggerId,
          triggerType: CUSTOM_WEBHOOK_TRIGGER_TYPE,
          name: input.name,
          agentSlug,
        })

        this.broadcastGlobal({
          type: 'webhook_trigger_created',
          triggerId,
          agentSlug,
        })

        await this.resolveContainerInput(agentSlug, toolUseId,
          `Webhook endpoint "${input.name}" created (trigger ID: ${triggerId}).\n\n` +
          `Public URL: ${endpoint.url}\n\n` +
          `Next: register this URL with the third-party service. Do the registration YOURSELF whenever possible — in order of preference:\n` +
          `1. The service's API: use the connected account through the authenticated proxy, or call it directly (request_secret for an API key if needed).\n` +
          `2. Offer to do it via the browser (navigate to the service's webhook settings page and fill it in).\n` +
          `3. Only if the user prefers to do it themselves (or registration requires access you don't have): give them a precise, copy-pasteable walkthrough — the exact settings path for that service, the URL to paste, the content type to pick, which events to enable, and where to put the signing secret.\n\n` +
          `Registration handshakes (Slack url_verification, Dropbox/Meta challenges, MS Graph validationToken) are answered automatically.\n\n` +
          `${verification
            ? 'Signature verification is configured — events with bad signatures are rejected at the edge.'
            : 'No signature verification is configured yet — events will be marked UNVERIFIED. If the service provides a signing secret (many reveal it only after registration), attach it with update_webhook_endpoint.'}\n\n` +
          `${filterExp
            ? `Delivery filter active: only events matching \`${filterExp}\` start a session (filtered events are logged — inspect_webhook_events shows them). After real traffic arrives, verify the filter behaves with inspect_webhook_events.`
            : 'No delivery filter is set — EVERY event this URL receives will start a session. After registering, decide whether you need one: compare the events the service will actually send against what your prompt handles. If the subscription is broader (it usually is — most services can\'t filter by assignee/status/type at registration), add a CEL filter_exp via update_webhook_endpoint so irrelevant events are dropped at the edge instead of waking you. Once real deliveries exist, dry-run candidates with inspect_webhook_events (test_filter_exp) before applying.'}\n\n` +
          `Every delivery to this URL starts a session with your prompt plus the request details.`)

        console.log(`[MessagePersister] Custom webhook endpoint ${endpoint.id} created (trigger: ${triggerId})`)
      } catch (error) {
        console.error('[MessagePersister] Error handling create_webhook_endpoint:', error)
        // Agent-visible via the reject below, but capture so a recurring
        // platform-integration regression surfaces in aggregate. Never attach
        // the tool input — it carries the HMAC secret.
        captureException(error, {
          tags: { area: 'webhook-endpoints', op: 'create' },
          extra: { agentSlug, sessionId, toolUseId },
        })
        if (agentSlug) {
          const msg = error instanceof Error ? error.message : String(error)
          await this.rejectContainerInput(agentSlug, toolUseId, `Failed to create webhook endpoint: ${msg}`).catch(console.error)
        }
      }
    })()
  }

  // Handle update_webhook_endpoint - blocking: PATCH the platform endpoint
  // (verification is usually attached AFTER registration reveals the secret).
  private handleUpdateWebhookEndpointTool(
    sessionId: string,
    toolUseId: string,
    toolInput: string,
    agentSlug?: string
  ): void {
    ;(async () => {
      try {
        if (!agentSlug) {
          console.error('[MessagePersister] update_webhook_endpoint missing agentSlug')
          return
        }

        // Gate on platform auth, not Composio mode: custom endpoints live on
        // the platform proxy and must keep working when the user brings their
        // own Composio key (mirrors the teardown gate in
        // webhook-trigger-service).
        if (!getPlatformAccessToken()) {
          await this.rejectContainerInput(agentSlug, toolUseId, 'Custom webhook endpoints are only available when connected to the platform')
          return
        }

        let rawInput: unknown
        try {
          rawInput = JSON.parse(toolInput)
        } catch {
          await this.rejectContainerInput(agentSlug, toolUseId, 'Invalid tool input')
          return
        }

        const parsedInput = updateWebhookEndpointInputSchema.safeParse(rawInput)
        if (!parsedInput.success) {
          await this.rejectContainerInput(agentSlug, toolUseId,
            `Invalid tool input: ${parsedInput.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`)
          return
        }
        const input = parsedInput.data

        const trigger = await getWebhookTrigger(input.trigger_id)
        if (!trigger || trigger.agentSlug !== agentSlug || trigger.kind !== 'custom' || !trigger.composioTriggerId) {
          await this.rejectContainerInput(agentSlug, toolUseId, `No custom webhook endpoint found for trigger ${input.trigger_id}`)
          return
        }
        if (trigger.status === 'cancelled') {
          await this.rejectContainerInput(agentSlug, toolUseId, `Trigger ${input.trigger_id} is cancelled; create a new endpoint instead`)
          return
        }

        const patch: {
          name?: string
          verification?: import('@shared/lib/services/webhook-endpoint-schema').VerificationProfile | null
          filter_exp?: string | null
        } = {}
        if (input.name) patch.name = input.name
        if (input.verification !== undefined) patch.verification = input.verification
        if (input.filter_exp !== undefined) patch.filter_exp = input.filter_exp
        if (Object.keys(patch).length === 0) {
          await this.rejectContainerInput(agentSlug, toolUseId, 'Nothing to update: pass name, verification, and/or filter_exp')
          return
        }

        // Creator-first member resolution, matching teardown: the endpoint is
        // scoped to whoever minted it, not whoever's session runs the update.
        const memberId =
          resolvePlatformMemberForCandidates([trigger.createdByUserId])?.memberId ??
          (await this.resolvePlatformMemberForSession(agentSlug, sessionId))
        await updatePlatformWebhookEndpoint(memberId, trigger.composioTriggerId, patch)

        // Keep the local row in sync so list_triggers/UI don't show a stale name.
        if (patch.name) {
          await updateWebhookTriggerName(trigger.id, patch.name)
        }

        const changed = [
          patch.name ? 'name' : null,
          patch.verification === null ? 'verification removed' : patch.verification ? 'verification attached' : null,
          patch.filter_exp === null ? 'filter removed' : patch.filter_exp ? 'filter set' : null,
        ].filter(Boolean).join(', ')
        await this.resolveContainerInput(agentSlug, toolUseId,
          `Webhook endpoint updated (${changed}).${patch.verification
            ? ' Incoming requests are now signature-verified at the edge; events with bad signatures are rejected.'
            : ''}${patch.filter_exp
            ? ` Only deliveries matching \`${patch.filter_exp}\` will start a session; non-matching ones are logged as filtered (inspect_webhook_events shows them, including any filter eval errors — errors fail open and still deliver).`
            : patch.filter_exp === null
              ? ' The delivery filter was removed — every event starts a session again.'
              : ''}`)

        console.log(`[MessagePersister] Custom webhook endpoint ${trigger.composioTriggerId} updated (${changed})`)
      } catch (error) {
        console.error('[MessagePersister] Error handling update_webhook_endpoint:', error)
        // Never attach the tool input — it carries the HMAC secret.
        captureException(error, {
          tags: { area: 'webhook-endpoints', op: 'update' },
          extra: { agentSlug, sessionId, toolUseId },
        })
        if (agentSlug) {
          const msg = error instanceof Error ? error.message : String(error)
          await this.rejectContainerInput(agentSlug, toolUseId, `Failed to update webhook endpoint: ${msg}`).catch(console.error)
        }
      }
    })()
  }

  // Handle inspect_webhook_events - blocking: read recent stored deliveries
  // (including filter-withheld rows) from the platform, or dry-run a candidate
  // filter expression against them. Read-only on both sides.
  private handleInspectWebhookEventsTool(
    sessionId: string,
    toolUseId: string,
    toolInput: string,
    agentSlug?: string
  ): void {
    ;(async () => {
      try {
        if (!agentSlug) {
          console.error('[MessagePersister] inspect_webhook_events missing agentSlug')
          return
        }

        if (!getPlatformAccessToken()) {
          await this.rejectContainerInput(agentSlug, toolUseId, 'Custom webhook endpoints are only available when connected to the platform')
          return
        }

        let rawInput: unknown
        try {
          rawInput = JSON.parse(toolInput)
        } catch {
          await this.rejectContainerInput(agentSlug, toolUseId, 'Invalid tool input')
          return
        }

        const parsedInput = inspectWebhookEventsInputSchema.safeParse(rawInput)
        if (!parsedInput.success) {
          await this.rejectContainerInput(agentSlug, toolUseId,
            `Invalid tool input: ${parsedInput.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`)
          return
        }
        const input = parsedInput.data

        // Cancelled triggers stay inspectable on purpose: the stored events
        // outlive the endpoint and post-mortems are a legitimate use.
        const trigger = await getWebhookTrigger(input.trigger_id)
        if (!trigger || trigger.agentSlug !== agentSlug || trigger.kind !== 'custom' || !trigger.composioTriggerId) {
          await this.rejectContainerInput(agentSlug, toolUseId, `No custom webhook endpoint found for trigger ${input.trigger_id}`)
          return
        }

        // Creator-first member resolution, same as update/teardown.
        const memberId =
          resolvePlatformMemberForCandidates([trigger.createdByUserId])?.memberId ??
          (await this.resolvePlatformMemberForSession(agentSlug, sessionId))

        if (input.test_filter_exp) {
          const result = await testPlatformWebhookFilter(
            memberId, trigger.composioTriggerId, input.test_filter_exp, input.limit)
          const lines = result.results.map((r) => {
            const stored = r.stored_status ? ` (stored: ${r.stored_status})` : ''
            const detail = r.outcome === 'error' && r.error ? ` — ${r.error}` : ''
            return `- ${r.event_id} · ${r.created_at}${stored}: ${r.outcome.toUpperCase()}${detail}`
          })
          await this.resolveContainerInput(agentSlug, toolUseId,
            `Dry-run of \`${result.filter_exp}\` against the ${result.evaluated} most recent deliveries — ` +
            `${result.summary.passed} would pass, ${result.summary.filtered} filtered out, ` +
            `${result.summary.error} errored (errors fail open = delivered), ${result.summary.skipped} skipped (handshakes/scrubbed).\n\n` +
            `${lines.length ? lines.join('\n') : 'No stored deliveries to evaluate yet — send a test event first.'}\n\n` +
            `Nothing was changed. When the verdicts look right, apply it with update_webhook_endpoint (filter_exp).`)
        } else {
          const { filterExp, events } = await listPlatformWebhookEvents(
            memberId, trigger.composioTriggerId, input.limit)
          await this.resolveContainerInput(agentSlug, toolUseId,
            `Active filter: ${filterExp ? `\`${filterExp}\`` : 'none (every event delivers)'}\n\n` +
            `${events.length
              ? `Recent deliveries (newest first):\n${events.map(formatWebhookEventLine).join('\n')}`
              : 'No deliveries recorded yet for this endpoint.'}`)
        }

        console.log(`[MessagePersister] Inspected webhook events for ${trigger.composioTriggerId}`)
      } catch (error) {
        console.error('[MessagePersister] Error handling inspect_webhook_events:', error)
        captureException(error, {
          tags: { area: 'webhook-endpoints', op: 'inspect' },
          extra: { agentSlug, sessionId, toolUseId },
        })
        if (agentSlug) {
          const msg = error instanceof Error ? error.message : String(error)
          await this.rejectContainerInput(agentSlug, toolUseId, `Failed to inspect webhook events: ${msg}`).catch(console.error)
        }
      }
    })()
  }

  // Handle list_triggers - blocking: read from SQLite and resolve
  private handleListTriggersTool(
    _sessionId: string,
    toolUseId: string,
    _toolInput: string,
    agentSlug?: string
  ): void {
    ;(async () => {
      try {
        if (!agentSlug) {
          console.error('[MessagePersister] list_triggers missing agentSlug')
          return
        }

        const triggers = await listActiveWebhookTriggers(agentSlug)
        const formatted = triggers.length === 0
          ? 'No active webhook triggers for this agent.'
          : `Active webhook triggers:\n\n${triggers.map((t) => {
              const source = t.kind === 'custom'
                ? `URL: ${extractEndpointUrl(t.triggerConfig) ?? '(unknown)'}`
                : `Account: ${t.connectedAccountId}`
              return `- **${t.name || t.triggerType}** (ID: ${t.id})\n  Type: ${t.triggerType}${t.kind === 'custom' ? ' (custom endpoint)' : ''}\n  ${source}\n  Fires: ${t.fireCount} time(s)\n  Prompt: ${t.prompt.substring(0, 80)}${t.prompt.length > 80 ? '...' : ''}`
            }).join('\n\n')}`

        await this.resolveContainerInput(agentSlug, toolUseId, formatted)
      } catch (error) {
        console.error('[MessagePersister] Error handling list_triggers:', error)
        if (agentSlug) {
          await this.rejectContainerInput(agentSlug, toolUseId, String(error)).catch(console.error)
        }
      }
    })()
  }

  // Handle cancel_trigger - blocking: dual-delete from Composio + SQLite, then resolve
  private handleCancelTriggerTool(
    sessionId: string,
    toolUseId: string,
    toolInput: string,
    agentSlug?: string
  ): void {
    ;(async () => {
      try {
        if (!agentSlug) {
          console.error('[MessagePersister] cancel_trigger missing agentSlug')
          return
        }

        let input: { trigger_id: string }
        try {
          input = JSON.parse(toolInput)
        } catch {
          await this.rejectContainerInput(agentSlug, toolUseId, 'Invalid tool input')
          return
        }

        if (!input.trigger_id) {
          await this.rejectContainerInput(agentSlug, toolUseId, 'Missing required field: trigger_id')
          return
        }

        // Scope to the calling agent so it can't cancel (and, for custom kind,
        // disable the public endpoint of) another agent's trigger by id.
        const cancelled = await cancelWebhookTriggerWithCleanup(input.trigger_id, agentSlug)
        if (!cancelled) {
          await this.rejectContainerInput(agentSlug, toolUseId, `Trigger ${input.trigger_id} not found or already cancelled`)
          return
        }

        // Broadcast events
        this.broadcastToSSE(sessionId, {
          type: 'webhook_trigger_cancelled',
          toolUseId,
          triggerId: input.trigger_id,
          agentSlug,
        })

        this.broadcastGlobal({
          type: 'webhook_trigger_cancelled',
          triggerId: input.trigger_id,
          agentSlug,
        })

        await this.resolveContainerInput(agentSlug, toolUseId,
          `Trigger ${input.trigger_id} has been cancelled. It will no longer fire webhook events.`)

        console.log(`[MessagePersister] Webhook trigger ${input.trigger_id} cancelled`)
      } catch (error) {
        console.error('[MessagePersister] Error handling cancel_trigger:', error)
        if (agentSlug) {
          const msg = error instanceof Error ? error.message : String(error)
          await this.rejectContainerInput(agentSlug, toolUseId, `Failed to cancel trigger: ${msg}`).catch(console.error)
        }
      }
    })()
  }

  // Handle AskUserQuestion tool - broadcast to SSE clients so they can show the UI
  private handleAskUserQuestionTool(
    sessionId: string,
    toolUseId: string,
    toolInput: string,
    agentSlug?: string
  ): void {
    try {
      // Parse the tool input to get questions
      let input: AskUserQuestionInput = {}
      try {
        input = JSON.parse(toolInput)
      } catch {
        console.error('[MessagePersister] Failed to parse AskUserQuestion input:', toolInput)
        return
      }

      if (!input.questions?.length) {
        console.error('[MessagePersister] AskUserQuestion missing questions')
        return
      }

      // Broadcast the question request event to SSE clients
      this.broadcastToSSE(sessionId, {
        type: 'user_question_request',
        toolUseId,
        questions: input.questions,
        agentSlug,
      })

      // Renderer-side gate handles suppression; see session_complete trigger.
      if (agentSlug) {
        notificationManager.triggerSessionWaitingInput(sessionId, agentSlug, 'question').catch((err) => {
          console.error('[MessagePersister] Failed to trigger waiting input notification:', err)
        })
      }
    } catch (error) {
      console.error('[MessagePersister] Error handling AskUserQuestion:', error)
    }
  }

  // Handle a subagent (Task/Agent) or workflow (Workflow) launch under a
  // 'review' policy: broadcast the approval card. The container's canUseTool
  // has paused the launch on a pending input keyed by the same toolUseId; the
  // decision route answers it via /inputs/:toolUseId/resolve|reject. Under
  // 'allow' or an active session grant the container never pauses, and under
  // 'block' it denies outright — no card in any of those cases.
  private handleCapabilityReviewTool(
    sessionId: string,
    toolUseId: string,
    toolName: string,
    toolInput: string,
    agentSlug?: string
  ): void {
    try {
      const capability = toolName === 'Workflow' ? 'workflows' : 'subagents'
      if (getAgentCapabilitySettings()[capability] !== 'review') return
      if (this.hasSessionCapabilityGrant(sessionId, capability)) return

      let input: Record<string, unknown> = {}
      try {
        input = JSON.parse(toolInput)
      } catch {
        // Launches with unparseable input still need a decision — show the card with what we have.
      }

      this.broadcastToSSE(sessionId, {
        type: 'capability_review_request',
        toolUseId,
        capability,
        toolName,
        input,
        agentSlug,
      })
      this.markSessionAwaitingInput(sessionId)

      if (agentSlug) {
        notificationManager.triggerSessionWaitingInput(sessionId, agentSlug, 'capability_review').catch((err) => {
          console.error('[MessagePersister] Failed to trigger waiting input notification:', err)
        })
      }
    } catch (error) {
      console.error('[MessagePersister] Error handling capability review:', error)
    }
  }

  // Handle file request tool - broadcast to SSE clients so they can show the upload UI
  private handleFileRequestTool(
    sessionId: string,
    toolUseId: string,
    toolInput: string,
    agentSlug?: string
  ): void {
    try {
      let input: RequestFileInput = {}
      try {
        input = JSON.parse(toolInput)
      } catch {
        console.error('[MessagePersister] Failed to parse file request input:', toolInput)
        return
      }

      if (!input.description) {
        console.error('[MessagePersister] File request missing description')
        return
      }

      // Broadcast the file request event to SSE clients
      this.broadcastToSSE(sessionId, {
        type: 'file_request',
        toolUseId,
        description: input.description,
        fileTypes: input.fileTypes,
        agentSlug,
      })

      // Renderer-side gate handles suppression; see session_complete trigger.
      if (agentSlug) {
        notificationManager.triggerSessionWaitingInput(sessionId, agentSlug, 'file').catch((err) => {
          console.error('[MessagePersister] Failed to trigger waiting input notification:', err)
        })
      }
    } catch (error) {
      console.error('[MessagePersister] Error handling file request:', error)
    }
  }

  // Handle remote MCP request tool - broadcast to SSE clients so they can show the UI
  private handleRemoteMcpRequestTool(
    sessionId: string,
    toolUseId: string,
    toolInput: string,
    agentSlug?: string
  ): void {
    try {
      let input: RequestRemoteMcpInput = {}
      try {
        input = JSON.parse(toolInput)
      } catch {
        console.error('[MessagePersister] Failed to parse remote MCP request input:', toolInput)
        return
      }

      if (!input.url) {
        console.error('[MessagePersister] Remote MCP request missing url')
        return
      }

      // Broadcast the remote MCP request event to SSE clients
      this.broadcastToSSE(sessionId, {
        type: 'remote_mcp_request',
        toolUseId,
        url: input.url,
        name: input.name,
        reason: input.reason,
        authHint: input.authHint,
        agentSlug,
      })

      // Renderer-side gate handles suppression; see session_complete trigger.
      if (agentSlug) {
        notificationManager.triggerSessionWaitingInput(sessionId, agentSlug, 'remote_mcp').catch((err) => {
          console.error('[MessagePersister] Failed to trigger waiting input notification:', err)
        })
      }
    } catch (error) {
      console.error('[MessagePersister] Error handling remote MCP request:', error)
    }
  }

  // Handle browser input request tool - broadcast to SSE clients so they can show the UI
  private handleBrowserInputRequestTool(
    sessionId: string,
    toolUseId: string,
    toolInput: string,
    agentSlug?: string
  ): void {
    try {
      let input: RequestBrowserInputInput = {}
      try {
        input = JSON.parse(toolInput)
      } catch {
        console.error('[MessagePersister] Failed to parse browser input request:', toolInput)
        return
      }

      if (!input.message) {
        console.error('[MessagePersister] Browser input request missing message')
        return
      }

      this.broadcastToSSE(sessionId, {
        type: 'browser_input_request',
        toolUseId,
        message: input.message,
        // The model controls this field — coerce a non-array (e.g. a bare
        // string) to [] so the renderer never calls `.map()` on a non-array.
        requirements: Array.isArray(input.requirements) ? input.requirements : [],
        agentSlug,
      })

      // Renderer-side gate handles suppression; see session_complete trigger.
      if (agentSlug) {
        notificationManager.triggerSessionWaitingInput(sessionId, agentSlug, 'browser_input').catch((err) => {
          console.error('[MessagePersister] Failed to trigger waiting input notification:', err)
        })
      }
    } catch (error) {
      console.error('[MessagePersister] Error handling browser input request:', error)
    }
  }

  /** Auto-reject a pending input request on the container with a reason message. */
  private autoRejectInput(agentSlug: string | undefined, toolUseId: string, reason: string): void {
    if (!agentSlug) return
    getContainerManager().then((cm) =>
      cm.getClient(agentSlug)
        .fetch(`/inputs/${encodeURIComponent(toolUseId)}/reject`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        })
    ).catch((err: Error) => {
      console.error('[MessagePersister] Failed to auto-reject input request:', err)
    })
  }

  // Handle script run request tool - broadcast to SSE clients or auto-reject
  private handleScriptRunRequestTool(
    sessionId: string,
    toolUseId: string,
    toolInput: string,
    agentSlug?: string
  ): void {
    try {
      let input: RequestScriptRunInput = {}
      try {
        input = JSON.parse(toolInput)
      } catch {
        console.error('[MessagePersister] Failed to parse script run request:', toolInput)
        return
      }

      if (!input.script || !input.scriptType) {
        console.error('[MessagePersister] Script run request missing required fields')
        return
      }

      // Check platform support
      const platform = process.platform
      if (!VALID_SCRIPT_TYPES[platform]) {
        this.autoRejectInput(agentSlug, toolUseId, `Host script execution is not supported on this platform (${platform}). Only macOS and Windows are supported.`)
        return
      }

      // Check script type matches platform
      if (!VALID_SCRIPT_TYPES[platform].includes(input.scriptType as any)) {
        this.autoRejectInput(agentSlug, toolUseId, `Script type "${input.scriptType}" is not supported on ${platform}. Supported types: ${VALID_SCRIPT_TYPES[platform].join(', ')}`)
        return
      }

      // Check computer use permissions (use_host_shell level) — auto-execute when granted.
      // We still broadcast (with autoApproved: true) so the client can suppress any
      // messages-based fallback prompt for this toolUseId during the brief window
      // between tool_use being persisted and tool_result coming back.
      let autoApproved = false
      if (agentSlug) {
        const permissionResult = computerUsePermissionManager.checkPermission(agentSlug, 'use_host_shell')
        if (permissionResult === 'granted') {
          autoApproved = true
          this.autoExecuteScriptRun(agentSlug, toolUseId, input.script, input.scriptType)
        }
      }

      this.broadcastToSSE(sessionId, {
        type: 'script_run_request',
        toolUseId,
        script: input.script,
        explanation: input.explanation,
        scriptType: input.scriptType,
        agentSlug,
        autoApproved,
      })

      // Only flip the global "awaiting input" status (which drives the orange agent-status
      // pill in the sidebar / tray) when the user actually has to respond.
      if (!autoApproved) {
        this.markSessionAwaitingInput(sessionId)
        // Renderer-side gate handles suppression; see session_complete trigger.
        if (agentSlug) {
          notificationManager.triggerSessionWaitingInput(sessionId, agentSlug, 'script_run').catch((err) => {
            console.error('[MessagePersister] Failed to trigger waiting input notification:', err)
          })
        }
      }
    } catch (error) {
      console.error('[MessagePersister] Error handling script run request:', error)
    }
  }

  /**
   * Handle computer use request tools — check permissions and either auto-execute or prompt user.
   */
  private async handleComputerUseRequestTool(
    sessionId: string,
    toolUseId: string,
    toolName: string,
    toolInput: string,
    agentSlug?: string,
  ): Promise<void> {
    try {
      // Extract AC method from tool name: mcp__computer-use__computer_launch -> launch.
      const method = computerUseMethodFromToolName(toolName)

      // The toolInput is the raw MCP tool input (e.g., { name: "Calculator" } for computer_launch)
      // Empty input is valid for tools like screenshot, apps, ungrab that take no required params
      let params: Record<string, unknown>
      try {
        params = toolInput.trim() ? JSON.parse(toolInput) : {}
      } catch {
        console.error('[MessagePersister] Failed to parse computer use request:', toolInput)
        return
      }

      // Check platform support — computer use requires macOS or Windows (skip in E2E mock mode)
      if (process.env.E2E_MOCK !== 'true' && process.platform !== 'darwin' && process.platform !== 'win32') {
        this.autoRejectInput(agentSlug, toolUseId, `Computer use is not supported on this platform (${process.platform}). macOS and Windows are supported.`)
        return
      }

      // Determine the actual permission level and app name
      const permissionLevel = getRequiredPermissionLevel(method)
      const grabbedApp = agentSlug ? computerUsePermissionManager.getGrabbedApp(agentSlug) : undefined
      let appName = resolveTargetApp(method, params, grabbedApp)

      // For grab-by-window-ref, resolve the owning app name via AC.
      // Done before permission check and before adding to pending Map
      // so that failures here don't leave orphaned pending entries.
      if (method === 'grab' && !appName && params.ref && typeof params.ref === 'string') {
        try {
          appName = await resolveAppFromWindowRef(params.ref)
        } catch {
          // Non-fatal — proceed without app name
        }
      }

      // Check cached permissions
      if (agentSlug) {
        const permissionResult = computerUsePermissionManager.checkPermission(agentSlug, permissionLevel, appName)

        if (permissionResult === 'granted') {
          // Auto-execute: permission already granted. Broadcast with autoApproved
          // so clients can suppress streaming/message-history fallback prompts
          // during the window before the tool result is persisted.
          this.broadcastToSSE(sessionId, {
            type: 'computer_use_request',
            toolUseId,
            method,
            params,
            permissionLevel,
            appName,
            agentSlug,
            autoApproved: true,
          })
          this.autoExecuteComputerUseCommand(sessionId, agentSlug, toolUseId, method, params, permissionLevel, appName)
          return
        }
      }

      // Permission needed — track and broadcast to UI for user approval
      const state = this.streamingStates.get(sessionId)
      if (state) {
        // Guard against duplicate entries (e.g., SSE event replayed)
        if (!state.pendingComputerUseRequests.has(toolUseId)) {
          state.pendingComputerUseRequests.set(toolUseId, { toolUseId, method, params, permissionLevel, appName, agentSlug })
        }
      }
      this.markSessionAwaitingInput(sessionId)

      this.broadcastToSSE(sessionId, {
        type: 'computer_use_request',
        toolUseId,
        method,
        params,
        permissionLevel,
        appName,
        agentSlug,
        autoApproved: false,
      })

      // Renderer-side gate handles suppression; see session_complete trigger.
      if (agentSlug) {
        notificationManager.triggerSessionWaitingInput(sessionId, agentSlug, 'computer_use').catch((err) => {
          console.error('[MessagePersister] Failed to trigger waiting input notification:', err)
        })
      }
    } catch (error) {
      console.error('[MessagePersister] Error handling computer use request:', error)
    }
  }

  /**
   * Auto-execute a host script when use_host_shell permission is already cached.
   * Calls the internal /run-script API endpoint which executes and resolves the input.
   */
  private autoExecuteScriptRun(
    agentSlug: string,
    toolUseId: string,
    script: string,
    scriptType: string,
  ): void {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 35_000)
    fetch(`http://localhost:${process.env.PORT || '3000'}/api/agents/${encodeURIComponent(agentSlug)}/sessions/_auto/run-script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolUseId, script, scriptType }),
      signal: controller.signal,
    })
      .then((res) => {
        clearTimeout(timeout)
        if (!res.ok) {
          console.error('[MessagePersister] Auto-execute script run failed:', res.status)
        }
      })
      .catch((err: Error) => {
        clearTimeout(timeout)
        console.error('[MessagePersister] Failed to auto-execute script run:', err)
        getContainerManager().then((cm) =>
          cm.getClient(agentSlug)
            .fetch(`/inputs/${encodeURIComponent(toolUseId)}/reject`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ reason: `Auto-execute failed: ${err.message}` }),
            })
        ).catch((rejectErr: Error) => {
          console.error('[MessagePersister] Failed to reject after auto-execute failure:', rejectErr)
        })
      })
  }

  /**
   * Auto-execute a computer use command when permission is already cached.
   * Calls the internal /computer-use API endpoint which handles AC execution.
   */
  private autoExecuteComputerUseCommand(
    sessionId: string,
    agentSlug: string,
    toolUseId: string,
    method: string,
    params: Record<string, unknown>,
    permissionLevel: ComputerUsePermissionLevel,
    appName?: string,
  ): void {
    // Use the same API endpoint the UI calls, but with _auto session
    // since permission is already verified
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    fetch(`http://localhost:${process.env.PORT || '3000'}/api/agents/${encodeURIComponent(agentSlug)}/sessions/_auto/computer-use`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolUseId, method, params, permissionLevel, appName }),
      signal: controller.signal,
    })
      .then((res) => {
        clearTimeout(timeout)
        if (!res.ok) {
          console.error('[MessagePersister] Auto-execute computer use failed:', res.status)
          return
        }
        // Broadcast grab state change to the real session SSE clients
        if (method === 'grab' || method === 'launch') {
          const targetApp = appName || (params.name as string) || (params.app as string)
          if (targetApp) {
            this.broadcastToSSE(sessionId, { type: 'computer_use_grab_changed', app: targetApp })
            // Resolve icon async and send update
            import('@shared/lib/computer-use/app-icon').then(({ getAppIconBase64 }) =>
              getAppIconBase64(targetApp).then((icon) => {
                if (icon) {
                  this.broadcastToSSE(sessionId, { type: 'computer_use_grab_changed', app: targetApp, appIcon: icon })
                }
              })
            ).catch(() => {})
          }
        } else if (method === 'ungrab' || method === 'quit') {
          this.broadcastToSSE(sessionId, { type: 'computer_use_grab_changed', app: null })
        }
      })
      .catch((err: Error) => {
        clearTimeout(timeout)
        console.error('[MessagePersister] Failed to auto-execute computer use command:', err)
        getContainerManager().then((cm) =>
          cm.getClient(agentSlug)
            .fetch(`/inputs/${encodeURIComponent(toolUseId)}/reject`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ reason: `Auto-execute failed: ${err.message}` }),
            })
        ).catch((rejectErr: Error) => {
          console.error('[MessagePersister] Failed to reject after auto-execute failure:', rejectErr)
        })
      })
  }

  // Broadcast context usage from an assistant message's per-call usage field.
  // This is the actual token count for that single API call (≈ current context size).
  private broadcastContextUsage(
    sessionId: string,
    state: StreamingState,
    usage: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
  ): void {
    const contextUsage: SessionUsage = {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
      contextWindow: state.lastContextWindow,
    }
    state.lastAssistantUsage = contextUsage
    this.broadcastToSSE(sessionId, { type: 'context_usage', ...contextUsage })
  }

  // Extract contextWindow from SDK result event, then persist the last assistant
  // message's per-call usage (NOT the cumulative result.usage which sums all turns).
  private handleResultUsage(
    sessionId: string,
    state: StreamingState,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    content: any
  ): void {
    try {
      // contextWindow precedence: catalog (non-Claude) > SDK-reported > 200K default.
      // The SDK always reports a number, but for non-Claude models it's a generic
      // 200K default — so catalog (which only carries non-Claude windows) must win
      // when present. Claude entries have no catalog window, so they use the SDK value.
      const modelUsage = content.modelUsage
      if (modelUsage && typeof modelUsage === 'object') {
        const [modelId] = Object.keys(modelUsage)
        const firstModel = modelUsage[modelId] as { contextWindow?: number } | undefined
        const catalogWindow = modelId
          ? getModelContextWindow(modelId, getActiveLlmProvider().id)
          : undefined
        if (catalogWindow) {
          state.lastContextWindow = catalogWindow
        } else if (firstModel?.contextWindow) {
          state.lastContextWindow = firstModel.contextWindow
        }
      }

      // Use the last assistant message's per-call usage (current context snapshot).
      // Update its contextWindow now that we have the authoritative value from modelUsage.
      if (state.lastAssistantUsage) {
        const lastUsage: SessionUsage = {
          ...state.lastAssistantUsage,
          contextWindow: state.lastContextWindow,
        }

        // Re-broadcast with the correct contextWindow
        this.broadcastToSSE(sessionId, { type: 'context_usage', ...lastUsage })

        // Persist to session metadata (fire-and-forget)
        if (state.agentSlug) {
          updateSessionMetadata(state.agentSlug, sessionId, { lastUsage }).catch((err) => {
            console.error('[MessagePersister] Failed to persist lastUsage:', err)
          })
        }
      }
    } catch (error) {
      console.error('[MessagePersister] Error handling result usage:', error)
    }
  }

  // Handle tool results - broadcast to SSE clients
  private handleToolResults(
    sessionId: string,
    content: { message?: { content?: Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }> } }
  ): void {
    try {
      const messageContent = content.message?.content || []

      const state = this.streamingStates.get(sessionId)
      for (const block of messageContent) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          // A resolved user-input request must not be replayed to a client that
          // reconnects later (e.g. answer one of several parallel requests, then
          // refresh) — its tool_result is in, so drop it from the replay store.
          state?.pendingInputRequests.delete(block.tool_use_id)

          // Broadcast update to SSE clients
          this.broadcastToSSE(sessionId, {
            type: 'tool_result',
            toolUseId: block.tool_use_id,
            result: block.content,
            isError: block.is_error || false,
          })

          // If this is the result of a tracked deliver_file call, surface a
          // dedicated event so chat integrations deliver the file only now that
          // the in-container tool has validated it exists (isError === false).
          const pendingDeliver = state?.pendingDeliverFiles.get(block.tool_use_id)
          if (pendingDeliver) {
            state!.pendingDeliverFiles.delete(block.tool_use_id)
            this.broadcastToSSE(sessionId, {
              type: 'tool_result_ready',
              toolName: 'mcp__user-input__deliver_file',
              toolUseId: block.tool_use_id,
              filePath: pendingDeliver.filePath,
              description: pendingDeliver.description,
              isError: block.is_error || false,
            })
          }
        }
      }
    } catch (error) {
      console.error('Failed to handle tool results:', error)
    }
  }

  // Extract text content from an SDK assistant message (handles string and content block array formats)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractAssistantText(content: any): string {
    const msgContent = content.message?.content
    if (typeof msgContent === 'string') return msgContent
    if (Array.isArray(msgContent)) {
      return msgContent
        .filter((b: { type: string }) => b.type === 'text')
        .map((b: { text: string }) => b.text)
        .join('')
    }
    return ''
  }
}

// Export singleton instance
// Use globalThis to persist across Next.js hot reloads in development
const globalForPersister = globalThis as unknown as {
  messagePersister: MessagePersister | undefined
}

export const messagePersister =
  globalForPersister.messagePersister ?? new MessagePersister()

if (process.env.NODE_ENV !== 'production') {
  globalForPersister.messagePersister = messagePersister
}
