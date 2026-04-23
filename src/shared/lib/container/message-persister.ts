import type { ContainerClient, StreamMessage, SlashCommandInfo } from './types'
import type { SessionUsage } from '@shared/lib/types/agent'
import type { AskUserQuestionInput } from '@shared/lib/tool-definitions/ask-user-question'
import type { RequestSecretInput } from '@shared/lib/tool-definitions/request-secret'
import type { RequestFileInput } from '@shared/lib/tool-definitions/request-file'
import type { RequestConnectedAccountInput } from '@shared/lib/tool-definitions/request-connected-account'
import type { RequestRemoteMcpInput } from '@shared/lib/tool-definitions/request-remote-mcp'
import type { RequestBrowserInputInput } from '@shared/lib/tool-definitions/request-browser-input'
import type { RequestScriptRunInput } from '@shared/lib/tool-definitions/request-script-run'
import { createScheduledTask } from '@shared/lib/services/scheduled-task-service'
import {
  createWebhookTrigger,
  listActiveWebhookTriggers,
  cancelWebhookTriggerWithCleanup,
} from '@shared/lib/services/webhook-trigger-service'
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
import { updateSessionMetadata } from '@shared/lib/services/session-service'
import { notificationManager } from '@shared/lib/notifications/notification-manager'
import { trackServerEvent } from '@shared/lib/analytics/server-analytics'
import { VALID_SCRIPT_TYPES } from '@shared/lib/config/settings'
import { computerUsePermissionManager } from '@shared/lib/computer-use/permission-manager'
import { resolveAppFromWindowRef } from '@shared/lib/computer-use/executor'
import { getRequiredPermissionLevel, resolveTargetApp, type ComputerUsePermissionLevel } from '@shared/lib/computer-use/types'
import { getAgentSessionsDir } from '@shared/lib/utils/file-storage'
import { SubagentCapture } from './subagent-capture'
import * as path from 'path'
import { promises as fsPromises, readdirSync } from 'fs'

// Seed completedSubagentIds with every agent-*.jsonl already on disk for this
// session. Called when StreamingState is (re)created so the FIFO live-discovery
// in discoverSubagentIds() can't match a new subagent to a stale file from a
// prior run of the same session (the root cause of the "subagent B shows
// subagent A's history" bug across app restarts).
export function seedKnownSubagentIds(agentSlug: string | undefined, sessionId: string): Set<string> {
  const seeded = new Set<string>()
  if (!agentSlug) return seeded
  try {
    const subagentsDir = path.join(getAgentSessionsDir(agentSlug), sessionId, 'subagents')
    for (const file of readdirSync(subagentsDir)) {
      if (file.startsWith('agent-') && file.endsWith('.jsonl')) {
        seeded.add(file.slice('agent-'.length, -'.jsonl'.length))
      }
    }
  } catch {
    // Directory missing / unreadable — nothing to seed, which is fine.
  }
  return seeded
}

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
  pendingComputerUseRequests: Map<string, { toolUseId: string; method: string; params: Record<string, unknown>; permissionLevel: string; appName?: string; agentSlug?: string }> // Pending computer use requests awaiting user approval (keyed by toolUseId)
  lastApiErrorCode: string | null // SDK error code from last assistant message (e.g., 'authentication_failed', 'rate_limit')
}

// Lazy import to break circular dependency: container-manager -> message-persister
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _containerManagerModule: any = null
async function getContainerManager() {
  if (!_containerManagerModule) {
    _containerManagerModule = await import('./container-manager')
  }
  return _containerManagerModule.containerManager
}

// TODO this file is too big, this class is HUGE. Needs breaking up
class MessagePersister {
  private streamingStates: Map<string, StreamingState> = new Map()
  private subscriptions: Map<string, () => void> = new Map()
  private sseClients: Map<string, Set<(data: unknown) => void>> = new Map()
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
      completedSubagentIds: seedKnownSubagentIds(agentSlug, sessionId),
      activeSubagents: new Map(),
      slashCommands: [],
      isAwaitingInput: priorIsAwaitingInput,
      pendingComputerUseRequests: new Map(),
      lastApiErrorCode: null,
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

  // Get pending computer use requests for a session (for SSE replay on reconnect)
  getPendingComputerUseRequests(sessionId: string): Array<{ toolUseId: string; method: string; params: Record<string, unknown>; permissionLevel: string; appName?: string; agentSlug?: string }> {
    const state = this.streamingStates.get(sessionId)
    if (!state) return []
    return Array.from(state.pendingComputerUseRequests.values())
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

  // Check if a session has active SSE clients (someone is viewing it)
  hasActiveViewers(sessionId: string): boolean {
    const clients = this.sseClients.get(sessionId)
    return (clients?.size ?? 0) > 0
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
        completedSubagentIds: seedKnownSubagentIds(agentSlug, sessionId),
        activeSubagents: new Map(),
        slashCommands: [],
        isAwaitingInput: false,
        pendingComputerUseRequests: new Map(),
        lastApiErrorCode: null,
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
    state.lastApiErrorCode = null // Clear previous API error on new message
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
    }
  }

  // Broadcast an arbitrary event to all SSE clients for a session (public)
  broadcastSessionEvent(sessionId: string, data: unknown): void {
    this.broadcastToSSE(sessionId, data)
  }

  // Broadcast to SSE clients
  private broadcastToSSE(sessionId: string, data: unknown): void {
    this.capture?.recordOutput(sessionId, data)
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
        // Broadcast refresh event so frontend can refetch
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

                // Background agents get an immediate "async_launched" tool_result that is NOT
                // the real completion — their actual completion comes via sidechain 'result'.
                if (!sub.isBackground) {
                  this.handleSubagentCompletion(sessionId, state, block.tool_use_id)
                }
              }
            }
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
        } else if (content.subtype === 'compact_boundary') {
          // Fallback for SDK paths that surface compaction via boundary without an earlier status.
          if (!state.isCompacting) {
            state.isCompacting = true
            this.broadcastToSSE(sessionId, { type: 'compact_start' })
          }
        } else if (content.subtype === 'api_retry') {
          // API retry in progress — broadcast details so the UI can show retry state
          this.broadcastToSSE(sessionId, {
            type: 'api_retry',
            attempt: content.attempt,
            maxRetries: content.max_retries,
            delayMs: content.delay_ms,
            errorStatus: content.error_status,
          })
        } else if (content.subtype === 'task_progress') {
          // Subagent progress summary (from agentProgressSummaries option)
          this.broadcastToSSE(sessionId, {
            type: 'subagent_progress',
            parentToolId: content.parent_tool_use_id,
            summary: content.summary,
          })
        } else if (content.subtype === 'memory_recall') {
          // Memory recall — agent is reading memory files
          this.broadcastToSSE(sessionId, {
            type: 'memory_recall',
            memoryPaths: content.memory_paths || [],
          })
        }
        break

      case 'result': {
        // Query completed - session is no longer active
        state.isStreaming = false
        state.isActive = false
        state.isAwaitingInput = false
        state.currentText = ''

        // Extract and persist context usage from result event
        this.handleResultUsage(sessionId, state, content)

        // Check if this is an error result
        if (content.subtype === 'error_during_execution' || content.subtype === 'error') {
          const errorMessage = content.error || content.message || 'An error occurred during execution'
          // Use SDK error code from the preceding assistant message (e.g., 'authentication_failed', 'rate_limit')
          const apiErrorCode = state.lastApiErrorCode || null
          console.error(`[MessagePersister] Session ${sessionId} error:`, errorMessage, apiErrorCode ? `(${apiErrorCode})` : '')
          this.broadcastToSSE(sessionId, {
            type: 'session_error',
            error: errorMessage,
            apiErrorCode,
            isActive: false
          })
          // Also broadcast globally
          this.broadcastGlobal({
            type: 'session_error',
            sessionId,
            agentSlug: state.agentSlug,
            error: errorMessage,
            apiErrorCode,
            isActive: false,
          })
          // If the error is fatal (e.g., OOM), request container stop
          if (content.fatal && state.agentSlug && this.onStopContainerRequested) {
            console.log(`[MessagePersister] Fatal error for agent ${state.agentSlug}, requesting container stop`)
            this.onStopContainerRequested(state.agentSlug)
          }
        } else {
          this.broadcastToSSE(sessionId, { type: 'session_idle', isActive: false })
          // Also broadcast globally so sidebar updates
          this.broadcastGlobal({
            type: 'session_idle',
            sessionId,
            agentSlug: state.agentSlug,
            isActive: false,
          })
          // Trigger session complete notification (only if no one is viewing the session)
          // Skip for 'resume' exits — the session is pausing for a resume, not truly finished
          if (content.subtype !== 'resume' && state.agentSlug && !this.hasActiveViewers(sessionId)) {
            notificationManager.triggerSessionComplete(sessionId, state.agentSlug).catch((err) => {
              console.error('[MessagePersister] Failed to trigger session complete notification:', err)
            })
          }
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
          const { unsubscribe } = client.subscribeToStream(
            sessionId,
            (message) => this.handleMessage(sessionId, message)
          )
          this.subscriptions.set(sessionId, unsubscribe)
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
    state.isStreaming = false
    state.isActive = false
    state.isAwaitingInput = false
    state.currentText = ''
    state.currentToolUse = null
    state.currentToolInput = ''
    state.activeSubagents.clear()
    this.broadcastToSSE(sessionId, { type: 'session_idle', isActive: false })
    this.broadcastGlobal({
      type: 'session_idle',
      sessionId,
      agentSlug: state.agentSlug,
      isActive: false,
    })
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

    // Try to extract agentId directly from the message (available on complete user/assistant messages)
    const messageAgentId = content.agentId as string | undefined
    if (messageAgentId && messageAgentId !== sub.agentId) {
      sub.agentId = messageAgentId
    }

    // Fallback: discover agentIds from the subagent JSONL files using FIFO matching
    if (!sub.agentId && state.agentSlug) {
      this.discoverSubagentIds(sessionId, state).catch(() => {})
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
      this.handleSubagentCompletion(sessionId, state, parentToolId)
      return
    }

    // Broadcast updates for complete messages (user/assistant).
    // Complete messages have been persisted to the subagent JSONL by the SDK,
    // so the frontend can refetch them via the API endpoint.
    if (content.type === 'user' || content.type === 'assistant') {
      // Clear streaming text since it's now persisted
      if (content.type === 'assistant') {
        sub.currentText = ''
        // Subagent messages arrive as complete messages (not stream events),
        // so detect browser input requests from the finished tool_use blocks.
        const messageContent = content.message?.content
        if (Array.isArray(messageContent)) {
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

  // Discover agentIds for all active subagents using FIFO matching.
  // The SDK executes tool calls in order, so the first registered parentToolId
  // corresponds to the oldest subagent JSONL file (by modification time).
  private async discoverSubagentIds(sessionId: string, state: StreamingState): Promise<void> {
    if (!state.agentSlug) return

    // Collect parentToolIds needing agentIds (Map preserves insertion order = registration order)
    const needingIds: string[] = []
    for (const [parentToolId, sub] of state.activeSubagents) {
      if (!sub.agentId) needingIds.push(parentToolId)
    }
    if (needingIds.length === 0) return

    try {
      const sessionsDir = getAgentSessionsDir(state.agentSlug)
      const subagentsDir = path.join(sessionsDir, sessionId, 'subagents')
      const files = await fsPromises.readdir(subagentsDir)

      // Collect known IDs (completed or already assigned)
      const knownIds = new Set(state.completedSubagentIds)
      for (const [, s] of state.activeSubagents) {
        if (s.agentId) knownIds.add(s.agentId)
      }

      // Find unclaimed files and sort by modification time (oldest first = created first)
      const unclaimed: { id: string; mtimeMs: number }[] = []
      for (const file of files) {
        if (file.startsWith('agent-') && file.endsWith('.jsonl')) {
          const id = file.replace('agent-', '').replace('.jsonl', '')
          if (!knownIds.has(id)) {
            try {
              const fileStat = await fsPromises.stat(path.join(subagentsDir, file))
              unclaimed.push({ id, mtimeMs: fileStat.mtimeMs })
            } catch { /* file may have been removed */ }
          }
        }
      }
      unclaimed.sort((a, b) => a.mtimeMs - b.mtimeMs)

      // FIFO: match oldest unclaimed file → first registered parentToolId, etc.
      const count = Math.min(needingIds.length, unclaimed.length)
      for (let i = 0; i < count; i++) {
        const parentToolId = needingIds[i]
        const sub = state.activeSubagents.get(parentToolId)
        if (sub && !sub.agentId) {
          sub.agentId = unclaimed[i].id
          this.broadcastToSSE(sessionId, {
            type: 'subagent_updated',
            parentToolId,
            agentId: sub.agentId,
          })
        }
      }
    } catch {
      // Directory doesn't exist yet — will retry on next sidechain message
    }
  }

  // Handle subagent completion — broadcast and clear state for a specific parent tool
  private handleSubagentCompletion(sessionId: string, state: StreamingState, parentToolId: string): void {
    const sub = state.activeSubagents.get(parentToolId)
    // If we never discovered the agentId, try one final time before broadcasting
    if (sub && !sub.agentId && state.agentSlug) {
      this.discoverSubagentIds(sessionId, state)
        .finally(() => this.broadcastSubagentCompleted(sessionId, state, parentToolId))
    } else {
      this.broadcastSubagentCompleted(sessionId, state, parentToolId)
    }
  }

  private broadcastSubagentCompleted(sessionId: string, state: StreamingState, parentToolId: string): void {
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
            partialInput: sub.currentToolInput,
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
    event: { type: string; content_block?: { type: string; id?: string; name?: string }; delta?: { type: string; text?: string; partial_json?: string }; usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } },
    state: StreamingState
  ): void {
    switch (event.type) {
      case 'message_start':
        state.currentText = ''
        state.isStreaming = true
        state.currentToolUse = null
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
        }
        break

      case 'content_block_delta':
        if (event.delta?.type === 'text_delta' && event.delta.text) {
          state.currentText += event.delta.text
          this.broadcastToSSE(sessionId, {
            type: 'stream_delta',
            text: event.delta.text,
          })
        } else if (event.delta?.type === 'input_json_delta') {
          // Tool input is being streamed - accumulate and broadcast
          const partialJson = event.delta.partial_json || ''
          state.currentToolInput += partialJson
          this.broadcastToSSE(sessionId, {
            type: 'tool_use_streaming',
            toolId: state.currentToolUse?.id,
            toolName: state.currentToolUse?.name,
            partialInput: state.currentToolInput,
          })
        }
        break

      case 'content_block_stop':
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

          // Mark session as awaiting input when a blocking user-input tool fires
          // Only tools with 'request_' prefix actually block waiting for user response
          // (schedule_task, deliver_file, search_* resolve immediately and don't block)
          // Note: computer-use AND request_script_run tools are handled by their own
          // handlers which only mark awaiting input when user approval is actually
          // needed (not when auto-executed against a cached permission grant).
          if (
            state.currentToolUse.name === 'AskUserQuestion' ||
            (state.currentToolUse.name.startsWith('mcp__user-input__request_') &&
              state.currentToolUse.name !== 'mcp__user-input__request_script_run')
          ) {
            this.markSessionAwaitingInput(sessionId)
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

      // Trigger waiting for input notification (only if no one is viewing the session)
      if (agentSlug && !this.hasActiveViewers(sessionId)) {
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

      // Trigger waiting for input notification (only if no one is viewing the session)
      if (agentSlug && !this.hasActiveViewers(sessionId)) {
        notificationManager.triggerSessionWaitingInput(sessionId, agentSlug, 'connected_account').catch((err) => {
          console.error('[MessagePersister] Failed to trigger waiting input notification:', err)
        })
      }
    } catch (error) {
      console.error('[MessagePersister] Error handling connected account request:', error)
    }
  }

  // Handle schedule task tool - save to database and broadcast to SSE clients
  private handleScheduleTaskTool(
    sessionId: string,
    toolUseId: string,
    toolInput: string,
    agentSlug?: string
  ): void {
    // Use async IIFE since we need to await database operations
    ;(async () => {
      try {
        // Parse the tool input
        let input: {
          scheduleType: 'at' | 'cron'
          scheduleExpression: string
          prompt: string
          name?: string
          timezone?: string
        }
        try {
          input = JSON.parse(toolInput)
        } catch {
          console.error('[MessagePersister] Failed to parse schedule task input:', toolInput)
          return
        }

        if (!input.scheduleType || !input.scheduleExpression || !input.prompt) {
          console.error('[MessagePersister] Schedule task missing required fields')
          return
        }

        if (!agentSlug) {
          console.error('[MessagePersister] Schedule task missing agentSlug')
          return
        }

        // Resolve timezone: agent tool override > agent owner's timezone
        const timezone = input.timezone || resolveTimezoneForAgent(agentSlug)

        // Create the scheduled task in the database
        const taskId = await createScheduledTask({
          agentSlug,
          scheduleType: input.scheduleType,
          scheduleExpression: input.scheduleExpression,
          prompt: input.prompt,
          name: input.name,
          createdBySessionId: sessionId,
          timezone,
        })

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
      } catch (error) {
        console.error('[MessagePersister] Error handling schedule task:', error)
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
          ? 'No webhook triggers available for this account.'
          : `Available triggers for ${account.toolkitSlug}:\n\n${triggers.map((t) =>
              `- **${t.slug}** (${t.name}): ${t.description}${t.type === 'poll' ? ' [poll-based]' : ''}`
            ).join('\n')}\n\nUse setup_trigger with the trigger slug to subscribe.`

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

        const composioConnectionId = account.composioConnectionId

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
          composioConnectionId,
          input.trigger_config,
        )

        // 2. Save to SQLite (store the local account ID for app-level lookups)
        let triggerId: string
        try {
          triggerId = await createWebhookTrigger({
            agentSlug,
            composioTriggerId,
            connectedAccountId: input.connected_account_id,
            triggerType: input.trigger_type,
            triggerConfig: input.trigger_config ? JSON.stringify(input.trigger_config) : undefined,
            prompt: input.prompt,
            name: input.name,
            createdBySessionId: sessionId,
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
          : `Active webhook triggers:\n\n${triggers.map((t) =>
              `- **${t.name || t.triggerType}** (ID: ${t.id})\n  Type: ${t.triggerType}\n  Account: ${t.connectedAccountId}\n  Fires: ${t.fireCount} time(s)\n  Prompt: ${t.prompt.substring(0, 80)}${t.prompt.length > 80 ? '...' : ''}`
            ).join('\n\n')}`

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

        const cancelled = await cancelWebhookTriggerWithCleanup(input.trigger_id)
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

      // Trigger waiting for input notification (only if no one is viewing the session)
      if (agentSlug && !this.hasActiveViewers(sessionId)) {
        notificationManager.triggerSessionWaitingInput(sessionId, agentSlug, 'question').catch((err) => {
          console.error('[MessagePersister] Failed to trigger waiting input notification:', err)
        })
      }
    } catch (error) {
      console.error('[MessagePersister] Error handling AskUserQuestion:', error)
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

      // Trigger waiting for input notification (only if no one is viewing the session)
      if (agentSlug && !this.hasActiveViewers(sessionId)) {
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

      // Trigger waiting for input notification (only if no one is viewing the session)
      if (agentSlug && !this.hasActiveViewers(sessionId)) {
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
        requirements: input.requirements || [],
        agentSlug,
      })

      if (agentSlug && !this.hasActiveViewers(sessionId)) {
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
        if (agentSlug && !this.hasActiveViewers(sessionId)) {
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
      // Extract AC method from tool name: mcp__computer-use__computer_launch → launch
      // Tool names follow the pattern: mcp__computer-use__computer_{method}
      const toolSuffix = toolName.replace('mcp__computer-use__computer_', '')
      // Map tool suffixes to AC method names
      const methodMap: Record<string, string> = {
        apps: 'apps', windows: 'windows', snapshot: 'snapshot', find: 'find',
        screenshot: 'screenshot', read: 'read', status: 'status', displays: 'displays',
        permissions: 'permissions', click: 'click', type: 'type', fill: 'fill',
        key: 'key', scroll: 'scroll', select: 'select', hover: 'hover',
        launch: 'launch', quit: 'quit', grab: 'grab', ungrab: 'ungrab',
        menu: 'menuClick', dialog: 'dialog', run: 'run',
      }
      const method = methodMap[toolSuffix] || toolSuffix

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
          // Auto-execute: permission already granted
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
      })

      if (agentSlug && !this.hasActiveViewers(sessionId)) {
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
      // Extract contextWindow from modelUsage (per-model breakdown in SDK result)
      const modelUsage = content.modelUsage
      if (modelUsage && typeof modelUsage === 'object') {
        const firstModel = Object.values(modelUsage)[0] as { contextWindow?: number } | undefined
        if (firstModel?.contextWindow) {
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

      for (const block of messageContent) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          // Broadcast update to SSE clients
          this.broadcastToSSE(sessionId, {
            type: 'tool_result',
            toolUseId: block.tool_use_id,
            result: block.content,
            isError: block.is_error || false,
          })
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
