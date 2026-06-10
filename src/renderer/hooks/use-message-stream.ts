
import { useState, useEffect, useCallback } from 'react'
import { useQueryClient, QueryClient } from '@tanstack/react-query'
import { getApiBaseUrl } from '@renderer/lib/env'
import type { SessionUsage } from '@shared/lib/types/agent'
import type { SlashCommandInfo } from '@shared/lib/container/types'
import type { ApiMessage, ApiMessageOrBoundary } from '@shared/lib/types/api'

interface SecretRequest {
  toolUseId: string
  secretName: string
  reason?: string
}

interface ConnectedAccountRequest {
  toolUseId: string
  toolkit: string
  reason?: string
}

interface QuestionRequest {
  toolUseId: string
  questions: Array<{
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    multiSelect: boolean
  }>
}

interface FileRequest {
  toolUseId: string
  description: string
  fileTypes?: string
}

interface RemoteMcpRequest {
  toolUseId: string
  url: string
  name?: string
  reason?: string
  authHint?: 'oauth' | 'bearer'
}

interface BrowserInputRequest {
  toolUseId: string
  message: string
  requirements: string[]
}

interface ScriptRunRequest {
  toolUseId: string
  script: string
  explanation: string
  scriptType: 'applescript' | 'shell' | 'powershell'
}

export interface ComputerUseRequest {
  toolUseId: string
  method: string
  params: Record<string, unknown>
  permissionLevel: string
  appName?: string
}

export interface SubagentInfo {
  parentToolId: string | null
  agentId: string | null
  streamingMessage: string | null
  streamingToolUse: { id: string; name: string; partialInput: string } | null
  progressSummary: string | null
  subagentType: string | null
  description: string | null
  usage: { total_tokens: number; tool_uses: number; duration_ms: number } | null
  lastToolName: string | null
  resultText?: string | null
}

interface ApiRetryInfo {
  attempt: number
  maxRetries?: number
  delayMs?: number
  errorStatus?: number
}

/**
 * Optimistic copy of a message another user sent in this shared session,
 * shown until the persisted message (matched by uuid) arrives via refetch.
 */
export interface PeerUserMessage {
  uuid: string
  content: string
  sender: { id: string; name?: string; email?: string }
  /** Sent while the agent was mid-turn — rendered as a queued ghost. */
  queued?: boolean
}

interface StreamState {
  isActive: boolean // True from user message until query result
  isStreaming: boolean // True while actively receiving tokens
  streamingMessage: string | null
  streamingToolUses: Array<{ id: string; name: string; partialInput: string; ready?: boolean }>
  pendingSecretRequests: SecretRequest[]
  pendingConnectedAccountRequests: ConnectedAccountRequest[]
  pendingQuestionRequests: QuestionRequest[]
  pendingFileRequests: FileRequest[]
  pendingRemoteMcpRequests: RemoteMcpRequest[]
  pendingBrowserInputRequests: BrowserInputRequest[]
  pendingScriptRunRequests: ScriptRunRequest[]
  pendingComputerUseRequests: ComputerUseRequest[]
  error: string | null // Error message if session encountered an error
  /** SDK error code from the LLM provider (e.g., 'authentication_failed', 'rate_limit', 'server_error') */
  apiErrorCode: string | null
  browserActive: boolean // Whether browser is running for this session
  computerUseApp: string | null // Name of the app currently grabbed for computer use
  computerUseAppIcon: string | null // Base64 PNG icon of the grabbed app
  activeStartTime: number | null // Timestamp when session became active (for elapsed timer)
  isCompacting: boolean // True while context compaction is in progress
  contextUsage: SessionUsage | null // Latest context window usage data
  activeSubagents: SubagentInfo[] // Currently running subagent(s) info
  completedSubagents: Set<string> | null // parentToolIds of completed subagents (for status logic)
  typingUser: { id: string; name?: string } | null // User currently typing (auth mode shared agents)
  peerUserMessages: PeerUserMessage[] // Messages from other users not yet seen in fetched messages
  apiRetry: ApiRetryInfo | null // Non-null while API is retrying a transient error
  backgroundTasks: Array<{ taskId: string; startedAt: number }> // Active background Bash commands
  isWaitingBackground: boolean // True when agent turn ended but background tasks are still running
}

// Upsert a subagent entry in the array by parentToolId (immutable)
function upsertSubagent(list: SubagentInfo[], entry: SubagentInfo): SubagentInfo[] {
  const idx = list.findIndex(s => s.parentToolId === entry.parentToolId)
  if (idx >= 0) {
    const copy = [...list]
    copy[idx] = entry
    return copy
  }
  return [...list, entry]
}

// Global state to track streaming per session
const EMPTY_STREAM_STATE: StreamState = {
  isActive: false,
  isStreaming: false,
  streamingMessage: null,
  streamingToolUses: [],
  pendingSecretRequests: [],
  pendingConnectedAccountRequests: [],
  pendingQuestionRequests: [],
  pendingFileRequests: [],
  pendingRemoteMcpRequests: [],
  pendingBrowserInputRequests: [],
  pendingScriptRunRequests: [],
  pendingComputerUseRequests: [],
  error: null,
  apiErrorCode: null,
  browserActive: false,
  computerUseApp: null,
  computerUseAppIcon: null,
  activeStartTime: null,
  isCompacting: false,
  contextUsage: null,
  activeSubagents: [],
  completedSubagents: null,
  typingUser: null,
  peerUserMessages: [],
  apiRetry: null,
  backgroundTasks: [],
  isWaitingBackground: false,
}

const streamStates = new Map<string, StreamState>()
const streamListeners = new Map<string, Set<() => void>>()

// Slash commands per session (separate from streamStates to avoid touching 25+ set() calls)
const sessionSlashCommands = new Map<string, SlashCommandInfo[]>()

// Extended-thinking stream per session. Kept outside StreamState (like slash commands)
// so the ~15 full state-rebuild sites don't have to thread it through. `isThinking`
// drives the "Thinking" status; `text` accumulates the streamed (summarized) reasoning
// for the "View thinking" panel. Text only arrives when the agent requests
// `display: 'summarized'` (see agent-container/src/claude-code.ts).
interface ThinkingState { text: string; isThinking: boolean }
const EMPTY_THINKING: ThinkingState = { text: '', isThinking: false }
const sessionThinking = new Map<string, ThinkingState>()

// Stable empty Set so the hook return is referentially stable when nothing is auto-approved.
const EMPTY_AUTO_APPROVED_SET: ReadonlySet<string> = new Set()

// Tool-use ids of script_run requests that the server auto-approved on this session.
// We suppress any prompt UI for these ids — both the SSE-broadcast pending list
// (we never add them) and the messages-based fallback in MessageList. Tracked outside
// StreamState to avoid threading a new field through ~15 state-rebuild sites.
const sessionAutoApprovedScriptRunIds = new Map<string, Set<string>>()


// Singleton EventSource connections per session (prevents duplicates from StrictMode/re-renders)
const eventSources = new Map<string, EventSource>()
const refCounts = new Map<string, number>()

// Sessions with an in-flight post-idle reconcile loop, so overlapping
// session_idle events don't spawn duplicate loops for the same session.
const reconcilingIdleSessions = new Set<string>()

// Does the last persisted assistant message in the messages cache match the
// just-streamed text? Mirrors MessageList's `isStreamingMessagePersisted` so we
// stop reconciling at exactly the point the UI considers the turn finalized.
function lastPersistedAssistantMatches(
  queryClient: QueryClient,
  sessionId: string,
  expectedText: string
): boolean {
  const entries = queryClient.getQueriesData<ApiMessageOrBoundary[]>({
    queryKey: ['messages', sessionId],
  })
  for (const [, data] of entries) {
    if (!Array.isArray(data)) continue
    for (let i = data.length - 1; i >= 0; i--) {
      if (data[i].type === 'assistant') {
        const content = (data[i] as ApiMessage).content as { text?: string } | undefined
        const persisted = content?.text?.trim() || ''
        if (!persisted) return false
        return persisted.startsWith(expectedText) || expectedText.startsWith(persisted)
      }
    }
  }
  return false
}

// The session_idle SSE event can arrive before the final assistant line is
// durably readable in the JSONL transcript (it's written across the container
// boundary), so the immediate invalidate's refetch may come back without it.
// No further SSE event follows, so without this the UI would only reconcile on
// the slow safety-net poll (useMessages, 15s) — the regression where a turn's
// "Worked for Xs" line takes seconds to appear. Refetch a few times with short
// backoff until the persisted tail matches the streamed text, then stop.
// Bounded and self-terminating; the background poll remains the ultimate backstop.
async function reconcileMessagesAfterIdle(
  sessionId: string,
  queryClient: QueryClient,
  streamingText: string | null
): Promise<void> {
  const expected = streamingText?.trim()
  // Nothing streamed (e.g. a tool-only or interrupted turn) — no text to match
  // against, so the handler's immediate invalidate is all we can do.
  if (!expected) return
  if (reconcilingIdleSessions.has(sessionId)) return
  reconcilingIdleSessions.add(sessionId)
  try {
    // ~1.5s total across 3 tries — long enough to beat the write/read race,
    // short enough that a genuine mismatch falls through to the poll quickly.
    for (const delay of [250, 500, 750]) {
      if (lastPersistedAssistantMatches(queryClient, sessionId, expected)) return
      await new Promise((resolve) => setTimeout(resolve, delay))
      // refetchType defaults to 'active': refetches the mounted messages query
      // (the session being viewed) and resolves once the cache is updated.
      await queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
    }
  } finally {
    reconcilingIdleSessions.delete(sessionId)
  }
}

function getOrCreateEventSource(
  sessionId: string,
  agentSlug: string,
  queryClient: QueryClient
): EventSource {
  const key = `${agentSlug}:${sessionId}`
  let es = eventSources.get(key)
  if (es && es.readyState !== EventSource.CLOSED) {
    // Increment ref count
    refCounts.set(key, (refCounts.get(key) || 0) + 1)
    return es
  }

  // Create new EventSource
  const baseUrl = getApiBaseUrl()
  es = new EventSource(`${baseUrl}/api/agents/${agentSlug}/sessions/${sessionId}/stream`)
  eventSources.set(key, es)
  refCounts.set(key, 1)

  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data)
      const current = streamStates.get(sessionId)

      // Only session_active and session_idle events change isActive
      // All other events preserve the current isActive value

      if (data.type === 'connected') {
        // Capture slash commands from server
        if (Array.isArray(data.slashCommands)) {
          sessionSlashCommands.set(sessionId, data.slashCommands)
        }
        // Initial connection - get isActive from server
        streamStates.set(sessionId, {
          isActive: data.isActive ?? false,
          isStreaming: false,
          streamingMessage: null,
          streamingToolUses: [],
          pendingSecretRequests: current?.pendingSecretRequests ?? [],
          pendingConnectedAccountRequests: current?.pendingConnectedAccountRequests ?? [],
          pendingQuestionRequests: current?.pendingQuestionRequests ?? [],
          pendingFileRequests: current?.pendingFileRequests ?? [],
          pendingRemoteMcpRequests: current?.pendingRemoteMcpRequests ?? [],
          pendingBrowserInputRequests: current?.pendingBrowserInputRequests ?? [],
          pendingScriptRunRequests: current?.pendingScriptRunRequests ?? [],
          pendingComputerUseRequests: current?.pendingComputerUseRequests ?? [],
          error: null,
          apiErrorCode: null,
          browserActive: current?.browserActive ?? false,
          computerUseApp: current?.computerUseApp ?? null,
          computerUseAppIcon: current?.computerUseAppIcon ?? null,
          activeStartTime: current?.activeStartTime ?? null,
          isCompacting: current?.isCompacting ?? false,
          contextUsage: current?.contextUsage ?? null,
          activeSubagents: current?.activeSubagents ?? [],
          completedSubagents: current?.completedSubagents ?? null,
          typingUser: current?.typingUser ?? null,
          peerUserMessages: current?.peerUserMessages ?? [],
          apiRetry: current?.apiRetry ?? null,
          backgroundTasks: Array.isArray(data.backgroundTasks) ? data.backgroundTasks : (current?.backgroundTasks ?? []),
          isWaitingBackground: Array.isArray(data.backgroundTasks) && data.backgroundTasks.length > 0,
        })
        // Reconcile against the persisted transcript on every (re)connect. A client
        // that opens the stream AFTER the agent already broadcast events (common for a
        // freshly-created session, or any reconnect) misses those one-shot broadcasts —
        // they are not buffered server-side. The persisted messages are the source of
        // truth (MessageList renders streamed text, tool calls, and derives pending
        // input requests from them), so force a refetch now instead of waiting for the
        // safety-net poll. Without this, a late join only recovers on the next poll
        // tick, which races the assertion timeout in tests and shows a stale UI in prod.
        queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
        // Fetch current browser status to sync state (handles missed events)
        fetch(`${baseUrl}/api/agents/${agentSlug}/browser/status`)
          .then((res) => res.json())
          .then((status: { active?: boolean; sessionId?: string }) => {
            const latest = streamStates.get(sessionId)
            // Only mark browser active if it belongs to THIS session
            const activeForThisSession = (status.active ?? false) && status.sessionId === sessionId
            if (latest && latest.browserActive !== activeForThisSession) {
              streamStates.set(sessionId, { ...latest, browserActive: activeForThisSession })
              streamListeners.get(sessionId)?.forEach((listener) => listener())
            }
          })
          .catch(() => { /* ignore - agent may not be running */ })
      }
      else if (data.type === 'session_active') {
        // Session became active - user sent a message
        if (data.sessionId && data.sessionId !== sessionId) return
        // Reset thinking stream for the new turn
        sessionThinking.delete(sessionId)
        streamStates.set(sessionId, {
          isActive: true,
          isStreaming: current?.isStreaming ?? false,
          streamingMessage: current?.streamingMessage ?? null,
          streamingToolUses: current?.streamingToolUses ?? [],
          pendingSecretRequests: current?.pendingSecretRequests ?? [],
          pendingConnectedAccountRequests: current?.pendingConnectedAccountRequests ?? [],
          pendingQuestionRequests: current?.pendingQuestionRequests ?? [],
          pendingFileRequests: current?.pendingFileRequests ?? [],
          pendingRemoteMcpRequests: current?.pendingRemoteMcpRequests ?? [],
          pendingBrowserInputRequests: current?.pendingBrowserInputRequests ?? [],
          pendingScriptRunRequests: current?.pendingScriptRunRequests ?? [],
          pendingComputerUseRequests: current?.pendingComputerUseRequests ?? [],
          error: null, // Clear any previous error when starting new request
          apiErrorCode: null,
          browserActive: current?.browserActive ?? false,
          computerUseApp: current?.computerUseApp ?? null,
          computerUseAppIcon: current?.computerUseAppIcon ?? null,
          activeStartTime: Date.now(),
          isCompacting: false,
          contextUsage: current?.contextUsage ?? null,
          activeSubagents: [],
          completedSubagents: null,
          typingUser: null,
          peerUserMessages: current?.peerUserMessages ?? [],
          apiRetry: null,
          backgroundTasks: current?.backgroundTasks ?? [],
          isWaitingBackground: false,
        })
        queryClient.invalidateQueries({ queryKey: ['sessions'] })
      }
      else if (data.type === 'session_idle') {
        // Session became idle - query completed or interrupted
        // Keep streamingMessage so it stays visible until persisted data arrives
        // (isStreamingMessagePersisted in MessageList handles deduplication)
        // Clear streamingToolUses - if tools were persisted, ToolCallItem renders them;
        // if they weren't (interrupted mid-stream), they should disappear.
        if (data.sessionId && data.sessionId !== sessionId) return
        streamStates.set(sessionId, {
          isActive: false,
          isStreaming: false,
          streamingMessage: current?.streamingMessage ?? null,
          streamingToolUses: [],
          pendingSecretRequests: [],
          pendingConnectedAccountRequests: [],
          pendingQuestionRequests: [],
          pendingFileRequests: [],
          pendingRemoteMcpRequests: [],
          pendingBrowserInputRequests: [],
          pendingScriptRunRequests: [],
          pendingComputerUseRequests: [],
          error: null,
          // Preserve apiErrorCode — it was set from the assistant message's error field
          // and is still valid context for the last turn. Cleared on next session_active.
          apiErrorCode: current?.apiErrorCode ?? null,
          browserActive: current?.browserActive ?? false,
          computerUseApp: current?.computerUseApp ?? null,
          computerUseAppIcon: current?.computerUseAppIcon ?? null,
          activeStartTime: null,
          isCompacting: false,
          contextUsage: current?.contextUsage ?? null,
          // Keep activeSubagents so subagent streaming summaries remain visible
          // until persisted data arrives (isStreamingMessagePersisted handles dedup).
          // Cleared on next session_active.
          activeSubagents: current?.activeSubagents ?? [],
          completedSubagents: current?.completedSubagents ?? null,
          typingUser: null,
          peerUserMessages: current?.peerUserMessages ?? [],
          apiRetry: current?.apiRetry ?? null,
          backgroundTasks: [],
          isWaitingBackground: false,
        })
        queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
        queryClient.invalidateQueries({ queryKey: ['sessions'] })
        // The immediate invalidate above can refetch before the final assistant
        // line is durably readable in the JSONL transcript. Beat that race with a
        // short bounded reconcile so the turn's "Worked for Xs" line appears
        // promptly instead of waiting for the next safety-net poll.
        void reconcileMessagesAfterIdle(sessionId, queryClient, current?.streamingMessage ?? null)
      }
      // Agent turn ended but background tasks are still running — allow sending messages
      else if (data.type === 'session_waiting_background') {
        if (current) {
          streamStates.set(sessionId, { ...current, isWaitingBackground: true })
        }
      }
      else if (data.type === 'session_error') {
        // Session encountered an error
        // Keep streamingMessage so error text (streamed via stream_delta) stays visible
        // until the persisted JSONL data arrives (isStreamingMessagePersisted handles dedup).
        streamStates.set(sessionId, {
          isActive: false,
          isStreaming: false,
          streamingMessage: current?.streamingMessage ?? null,
          streamingToolUses: [],
          pendingSecretRequests: [],
          pendingConnectedAccountRequests: [],
          pendingQuestionRequests: [],
          pendingFileRequests: [],
          pendingRemoteMcpRequests: [],
          pendingBrowserInputRequests: [],
          pendingScriptRunRequests: [],
          pendingComputerUseRequests: [],
          error: data.error || 'An unknown error occurred',
          apiErrorCode: data.apiErrorCode || null,
          browserActive: current?.browserActive ?? false,
          computerUseApp: current?.computerUseApp ?? null,
          computerUseAppIcon: current?.computerUseAppIcon ?? null,
          activeStartTime: null,
          isCompacting: false,
          contextUsage: current?.contextUsage ?? null,
          activeSubagents: [],
          completedSubagents: null,
          typingUser: null,
          peerUserMessages: current?.peerUserMessages ?? [],
          apiRetry: current?.apiRetry ?? null,
          backgroundTasks: [],
          isWaitingBackground: false,
        })
        queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
        queryClient.invalidateQueries({ queryKey: ['sessions'] })
      }
      // Background Bash task events
      else if (data.type === 'background_task_started') {
        if (current) {
          const existing = current.backgroundTasks.filter(t => t.taskId !== data.taskId)
          streamStates.set(sessionId, {
            ...current,
            backgroundTasks: [...existing, { taskId: data.taskId, startedAt: data.startedAt }],
          })
        }
      }
      else if (data.type === 'background_task_completed') {
        if (current) {
          const backgroundTasks = current.backgroundTasks.filter(t => t.taskId !== data.taskId)
          streamStates.set(sessionId, {
            ...current,
            backgroundTasks,
            // Clear the "waiting on background" flag once the last task is gone. This
            // flag drives the composer's stop button + submit-enabled logic and is
            // otherwise only reset by session_idle/session_active — so if the final
            // task clears without a follow-up idle, the composer would stay pinned.
            isWaitingBackground: current.isWaitingBackground && backgroundTasks.length > 0,
          })
        }
      }
      // Streaming events - update streaming state, preserve isActive
      else if (data.type === 'stream_start') {
        // Capture slash commands from init event (piggybacked on stream_start)
        if (Array.isArray(data.slashCommands)) {
          sessionSlashCommands.set(sessionId, data.slashCommands)
        }
        // If there were streaming tool uses, trigger a refetch so the persisted
        // versions are available before we clear the streaming state.
        if (current?.streamingToolUses?.length) {
          queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
        }
        streamStates.set(sessionId, {
          isActive: current?.isActive ?? false,
          isStreaming: true,
          streamingMessage: '',
          streamingToolUses: [],
          pendingSecretRequests: current?.pendingSecretRequests ?? [],
          pendingConnectedAccountRequests: current?.pendingConnectedAccountRequests ?? [],
          pendingQuestionRequests: current?.pendingQuestionRequests ?? [],
          pendingFileRequests: current?.pendingFileRequests ?? [],
          pendingRemoteMcpRequests: current?.pendingRemoteMcpRequests ?? [],
          pendingBrowserInputRequests: current?.pendingBrowserInputRequests ?? [],
          pendingScriptRunRequests: current?.pendingScriptRunRequests ?? [],
          pendingComputerUseRequests: current?.pendingComputerUseRequests ?? [],
          error: null,
          apiErrorCode: null,
          browserActive: current?.browserActive ?? false,
          computerUseApp: current?.computerUseApp ?? null,
          computerUseAppIcon: current?.computerUseAppIcon ?? null,
          activeStartTime: current?.activeStartTime ?? null,
          isCompacting: current?.isCompacting ?? false,
          contextUsage: current?.contextUsage ?? null,
          activeSubagents: current?.activeSubagents ?? [],
          completedSubagents: current?.completedSubagents ?? null,
          typingUser: current?.typingUser ?? null,
          peerUserMessages: current?.peerUserMessages ?? [],
          apiRetry: null, // Clear retry state — API call succeeded
          backgroundTasks: current?.backgroundTasks ?? [],
          isWaitingBackground: false,
        })
      }
      else if (data.type === 'stream_delta') {
        streamStates.set(sessionId, {
          isActive: current?.isActive ?? false,
          isStreaming: true,
          streamingMessage: (current?.streamingMessage || '') + data.text,
          streamingToolUses: current?.streamingToolUses ?? [],
          pendingSecretRequests: current?.pendingSecretRequests ?? [],
          pendingConnectedAccountRequests: current?.pendingConnectedAccountRequests ?? [],
          pendingQuestionRequests: current?.pendingQuestionRequests ?? [],
          pendingFileRequests: current?.pendingFileRequests ?? [],
          pendingRemoteMcpRequests: current?.pendingRemoteMcpRequests ?? [],
          pendingBrowserInputRequests: current?.pendingBrowserInputRequests ?? [],
          pendingScriptRunRequests: current?.pendingScriptRunRequests ?? [],
          pendingComputerUseRequests: current?.pendingComputerUseRequests ?? [],
          error: current?.error ?? null,
          apiErrorCode: data.apiErrorCode || current?.apiErrorCode || null,
          browserActive: current?.browserActive ?? false,
          computerUseApp: current?.computerUseApp ?? null,
          computerUseAppIcon: current?.computerUseAppIcon ?? null,
          activeStartTime: current?.activeStartTime ?? null,
          isCompacting: current?.isCompacting ?? false,
          contextUsage: current?.contextUsage ?? null,
          activeSubagents: current?.activeSubagents ?? [],
          completedSubagents: current?.completedSubagents ?? null,
          typingUser: current?.typingUser ?? null,
          peerUserMessages: current?.peerUserMessages ?? [],
          apiRetry: current?.apiRetry ?? null,
          backgroundTasks: current?.backgroundTasks ?? [],
          isWaitingBackground: current?.isWaitingBackground ?? false,
        })
      }
      else if (data.type === 'stream_api_error') {
        // SDK error code arrived for the currently-streaming message — update apiErrorCode
        // so the streaming text immediately re-renders as a provider error card.
        if (current) {
          streamStates.set(sessionId, {
            ...current,
            apiErrorCode: data.apiErrorCode || null,
          })
        }
      }
      else if (data.type === 'tool_use_start' || data.type === 'tool_use_streaming') {
        const newTool = { id: data.toolId, name: data.toolName, partialInput: data.partialInput ?? '' }
        const existing = current?.streamingToolUses ?? []
        const idx = existing.findIndex(t => t.id === newTool.id)
        const updatedTools = idx >= 0
          ? existing.map((t, i) => i === idx ? newTool : t)
          : [...existing, newTool]
        streamStates.set(sessionId, {
          isActive: current?.isActive ?? false,
          isStreaming: true,
          streamingMessage: current?.streamingMessage ?? null,
          streamingToolUses: updatedTools,
          pendingSecretRequests: current?.pendingSecretRequests ?? [],
          pendingConnectedAccountRequests: current?.pendingConnectedAccountRequests ?? [],
          pendingQuestionRequests: current?.pendingQuestionRequests ?? [],
          pendingFileRequests: current?.pendingFileRequests ?? [],
          pendingRemoteMcpRequests: current?.pendingRemoteMcpRequests ?? [],
          pendingBrowserInputRequests: current?.pendingBrowserInputRequests ?? [],
          pendingScriptRunRequests: current?.pendingScriptRunRequests ?? [],
          pendingComputerUseRequests: current?.pendingComputerUseRequests ?? [],
          error: current?.error ?? null,
          apiErrorCode: current?.apiErrorCode ?? null,
          browserActive: current?.browserActive ?? false,
          computerUseApp: current?.computerUseApp ?? null,
          computerUseAppIcon: current?.computerUseAppIcon ?? null,
          activeStartTime: current?.activeStartTime ?? null,
          isCompacting: current?.isCompacting ?? false,
          contextUsage: current?.contextUsage ?? null,
          activeSubagents: current?.activeSubagents ?? [],
          completedSubagents: current?.completedSubagents ?? null,
          typingUser: current?.typingUser ?? null,
          peerUserMessages: current?.peerUserMessages ?? [],
          apiRetry: current?.apiRetry ?? null,
          backgroundTasks: current?.backgroundTasks ?? [],
          isWaitingBackground: current?.isWaitingBackground ?? false,
        })
      }
      else if (data.type === 'tool_use_ready') {
        if (current) {
          const tools = current.streamingToolUses
          const idx = tools.findIndex(t => t.id === data.toolId)
          if (idx >= 0) {
            const updated = tools.map((t, i) => i === idx ? { ...t, ready: true } : t)
            streamStates.set(sessionId, { ...current, streamingToolUses: updated })
          }
        }
      }
      else if (data.type === 'stream_end') {
        streamStates.set(sessionId, {
          isActive: current?.isActive ?? false,
          isStreaming: false,
          streamingMessage: current?.streamingMessage ?? null,
          streamingToolUses: current?.streamingToolUses ?? [],
          pendingSecretRequests: current?.pendingSecretRequests ?? [],
          pendingConnectedAccountRequests: current?.pendingConnectedAccountRequests ?? [],
          pendingQuestionRequests: current?.pendingQuestionRequests ?? [],
          pendingFileRequests: current?.pendingFileRequests ?? [],
          pendingRemoteMcpRequests: current?.pendingRemoteMcpRequests ?? [],
          pendingBrowserInputRequests: current?.pendingBrowserInputRequests ?? [],
          pendingScriptRunRequests: current?.pendingScriptRunRequests ?? [],
          pendingComputerUseRequests: current?.pendingComputerUseRequests ?? [],
          error: current?.error ?? null,
          apiErrorCode: current?.apiErrorCode ?? null,
          browserActive: current?.browserActive ?? false,
          computerUseApp: current?.computerUseApp ?? null,
          computerUseAppIcon: current?.computerUseAppIcon ?? null,
          activeStartTime: current?.activeStartTime ?? null,
          isCompacting: current?.isCompacting ?? false,
          contextUsage: current?.contextUsage ?? null,
          activeSubagents: current?.activeSubagents ?? [],
          completedSubagents: current?.completedSubagents ?? null,
          typingUser: current?.typingUser ?? null,
          peerUserMessages: current?.peerUserMessages ?? [],
          apiRetry: current?.apiRetry ?? null,
          backgroundTasks: current?.backgroundTasks ?? [],
          isWaitingBackground: current?.isWaitingBackground ?? false,
        })
      }
      else if (data.type === 'user_message') {
        // Another user sent a message in this shared session. Track it until
        // the persisted copy (same uuid) shows up in fetched messages — there
        // may be several at once when users queue messages mid-turn.
        if (current && data.uuid) {
          const existing = current.peerUserMessages
          streamStates.set(sessionId, {
            ...current,
            peerUserMessages: existing.some((p) => p.uuid === data.uuid)
              ? existing
              : [...existing, { uuid: data.uuid, content: data.content, sender: data.sender, queued: data.queued }],
            typingUser: null, // Clear typing since they sent
          })
        }
        // Refetch to pick up the persisted message shortly
        queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
      }
      else if (data.type === 'user_typing') {
        // Another user is typing in this shared session
        if (current) {
          streamStates.set(sessionId, { ...current, typingUser: data.sender })
          // Auto-clear after 5s if no follow-up
          setTimeout(() => {
            const latest = streamStates.get(sessionId)
            if (latest && latest.typingUser?.id === data.sender.id) {
              streamStates.set(sessionId, { ...latest, typingUser: null })
              streamListeners.get(sessionId)?.forEach((l) => l())
            }
          }, 5000)
        }
      }
      else if (data.type === 'messages_updated') {
        queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
      }
      else if (data.type === 'tool_call' || data.type === 'tool_result') {
        // Message has been persisted - keep streamingMessage visible until refetch completes
        if (current) {
          streamStates.set(sessionId, {
            ...current,
            isStreaming: false,
          })
        }
        queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
      }
      else if (data.type === 'context_usage') {
        // Context window usage update from backend
        if (current) {
          streamStates.set(sessionId, {
            ...current,
            contextUsage: {
              inputTokens: data.inputTokens ?? 0,
              outputTokens: data.outputTokens ?? 0,
              cacheCreationInputTokens: data.cacheCreationInputTokens ?? 0,
              cacheReadInputTokens: data.cacheReadInputTokens ?? 0,
              contextWindow: data.contextWindow ?? 200_000,
            },
          })
        }
      }
      else if (data.type === 'thinking_start') {
        // New thinking episode — reset text so the panel shows only the current block
        sessionThinking.set(sessionId, { text: '', isThinking: true })
      }
      else if (data.type === 'thinking_delta') {
        // Accumulate streamed (summarized) reasoning text for the "View thinking" panel
        const t = sessionThinking.get(sessionId) ?? EMPTY_THINKING
        sessionThinking.set(sessionId, { text: t.text + (data.text ?? ''), isThinking: true })
      }
      else if (data.type === 'thinking_stop') {
        // Thinking block ended — flip back to "Working", keep accumulated text
        const t = sessionThinking.get(sessionId)
        if (t) sessionThinking.set(sessionId, { text: t.text, isThinking: false })
      }
      else if (data.type === 'secret_request') {
        // Agent is requesting a secret from the user
        const newRequest: SecretRequest = {
          toolUseId: data.toolUseId,
          secretName: data.secretName,
          reason: data.reason,
        }
        if (current && !current.pendingSecretRequests.some(r => r.toolUseId === data.toolUseId)) {
          streamStates.set(sessionId, {
            ...current,
            pendingSecretRequests: [...current.pendingSecretRequests, newRequest],
          })
          // Invalidate sessions so sidebar picks up awaiting-input state
          // (redundant safety net for global SSE race condition)
          queryClient.invalidateQueries({ queryKey: ['sessions'] })
        }
      }
      else if (data.type === 'connected_account_request') {
        // Agent is requesting access to a connected account
        const newRequest: ConnectedAccountRequest = {
          toolUseId: data.toolUseId,
          toolkit: data.toolkit,
          reason: data.reason,
        }
        if (current && !current.pendingConnectedAccountRequests.some(r => r.toolUseId === data.toolUseId)) {
          streamStates.set(sessionId, {
            ...current,
            pendingConnectedAccountRequests: [...current.pendingConnectedAccountRequests, newRequest],
          })
          queryClient.invalidateQueries({ queryKey: ['sessions'] })
        }
      }
      else if (data.type === 'user_question_request') {
        // Agent is asking the user questions
        const newRequest: QuestionRequest = {
          toolUseId: data.toolUseId,
          questions: data.questions,
        }
        if (current && !current.pendingQuestionRequests.some(r => r.toolUseId === data.toolUseId)) {
          streamStates.set(sessionId, {
            ...current,
            pendingQuestionRequests: [...current.pendingQuestionRequests, newRequest],
          })
          queryClient.invalidateQueries({ queryKey: ['sessions'] })
        }
      }
      else if (data.type === 'file_request') {
        // Agent is requesting a file from the user
        const newRequest: FileRequest = {
          toolUseId: data.toolUseId,
          description: data.description,
          fileTypes: data.fileTypes,
        }
        if (current && !current.pendingFileRequests.some(r => r.toolUseId === data.toolUseId)) {
          streamStates.set(sessionId, {
            ...current,
            pendingFileRequests: [...current.pendingFileRequests, newRequest],
          })
          queryClient.invalidateQueries({ queryKey: ['sessions'] })
        }
      }
      else if (data.type === 'remote_mcp_request') {
        // Agent is requesting access to a remote MCP server
        const newRequest: RemoteMcpRequest = {
          toolUseId: data.toolUseId,
          url: data.url,
          name: data.name,
          reason: data.reason,
          authHint: data.authHint,
        }
        if (current && !current.pendingRemoteMcpRequests.some(r => r.toolUseId === data.toolUseId)) {
          streamStates.set(sessionId, {
            ...current,
            pendingRemoteMcpRequests: [...current.pendingRemoteMcpRequests, newRequest],
          })
          queryClient.invalidateQueries({ queryKey: ['sessions'] })
        }
      }
      else if (data.type === 'browser_input_request') {
        // Dedupe: the server may broadcast the same toolUseId from multiple detection points
        if (current && !current.pendingBrowserInputRequests.some(r => r.toolUseId === data.toolUseId)) {
          const newRequest: BrowserInputRequest = {
            toolUseId: data.toolUseId,
            message: data.message,
            requirements: data.requirements || [],
          }
          streamStates.set(sessionId, {
            ...current,
            pendingBrowserInputRequests: [...current.pendingBrowserInputRequests, newRequest],
          })
          queryClient.invalidateQueries({ queryKey: ['sessions'] })
        }
      }
      else if (data.type === 'script_run_request') {
        // Agent is requesting script execution on the host. When `autoApproved` is
        // true the server is already executing it; we just record the toolUseId so
        // the messages-based fallback in MessageList knows to suppress its prompt.
        if (data.autoApproved) {
          let approved = sessionAutoApprovedScriptRunIds.get(sessionId)
          if (!approved) {
            approved = new Set()
            sessionAutoApprovedScriptRunIds.set(sessionId, approved)
          }
          approved.add(data.toolUseId)
          streamListeners.get(sessionId)?.forEach((l) => l())
        } else if (current && !current.pendingScriptRunRequests.some(r => r.toolUseId === data.toolUseId)) {
          const newRequest: ScriptRunRequest = {
            toolUseId: data.toolUseId,
            script: data.script,
            explanation: data.explanation,
            scriptType: data.scriptType,
          }
          streamStates.set(sessionId, {
            ...current,
            pendingScriptRunRequests: [...current.pendingScriptRunRequests, newRequest],
          })
          queryClient.invalidateQueries({ queryKey: ['sessions'] })
        }
      }
      else if (data.type === 'computer_use_request') {
        // Agent is requesting computer use on the host
        if (current && !current.pendingComputerUseRequests.some(r => r.toolUseId === data.toolUseId)) {
          const newRequest: ComputerUseRequest = {
            toolUseId: data.toolUseId,
            method: data.method,
            params: data.params || {},
            permissionLevel: data.permissionLevel,
            appName: data.appName,
          }
          streamStates.set(sessionId, {
            ...current,
            pendingComputerUseRequests: [...current.pendingComputerUseRequests, newRequest],
          })
          queryClient.invalidateQueries({ queryKey: ['sessions'] })
        }
      }
      else if (data.type === 'compact_start') {
        // Context compaction started
        if (current) {
          streamStates.set(sessionId, {
            ...current,
            isCompacting: true,
          })
        }
      }
      else if (data.type === 'compact_complete') {
        // Context compaction finished — messages_updated will trigger refetch
        if (current) {
          streamStates.set(sessionId, {
            ...current,
            isCompacting: false,
          })
        }
        queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
      }
      else if (data.type === 'memory_recall') {
        // Agent recalled memory files — refetch messages so the persisted entry appears
        queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
      }
      else if (data.type === 'api_retry') {
        // API is retrying a transient error — show retry state in activity indicator
        if (current) {
          streamStates.set(sessionId, {
            ...current,
            apiRetry: {
              attempt: data.attempt,
              maxRetries: data.maxRetries,
              delayMs: data.delayMs,
              errorStatus: data.errorStatus,
            },
          })
        }
      }
      else if (data.type === 'browser_active') {
        // Browser state changed
        if (current) {
          streamStates.set(sessionId, {
            ...current,
            browserActive: data.active ?? false,
          })
        }
      }
      else if (data.type === 'computer_use_grab_changed') {
        // Computer use grab state changed (icon may arrive in a follow-up event)
        if (current) {
          streamStates.set(sessionId, {
            ...current,
            computerUseApp: data.app ?? null,
            computerUseAppIcon: data.appIcon ?? (data.app ? current.computerUseAppIcon : null),
          })
        }
      }
      else if (data.type === 'session_updated') {
        // Session metadata changed (e.g., name) - invalidate session caches
        queryClient.invalidateQueries({ queryKey: ['sessions'] })
        queryClient.invalidateQueries({ queryKey: ['session', sessionId] })
      }
      else if (data.type === 'scheduled_task_created' || data.type === 'scheduled_task_cancelled' || data.type === 'scheduled_task_updated') {
        // A scheduled task was created, cancelled, or updated - invalidate scheduled tasks cache
        const taskAgentSlug = (data as { agentSlug?: string }).agentSlug
        if (taskAgentSlug) {
          queryClient.invalidateQueries({ queryKey: ['scheduled-tasks', taskAgentSlug] })
        }
      }
      else if (data.type === 'webhook_trigger_created' || data.type === 'webhook_trigger_cancelled') {
        const triggerAgentSlug = (data as { agentSlug?: string }).agentSlug
        if (triggerAgentSlug) {
          queryClient.invalidateQueries({ queryKey: ['webhook-triggers', triggerAgentSlug] })
        }
      }
      else if (data.type === 'subagent_started') {
        // task_started fired — immediately register agentId, type, and description
        if (current) {
          const existing = current.activeSubagents.find(s => s.parentToolId === data.parentToolId)
          const updated: SubagentInfo = {
            parentToolId: data.parentToolId,
            agentId: data.agentId ?? existing?.agentId ?? null,
            streamingMessage: existing?.streamingMessage ?? null,
            streamingToolUse: existing?.streamingToolUse ?? null,
            progressSummary: existing?.progressSummary ?? null,
            subagentType: data.subagentType ?? existing?.subagentType ?? null,
            description: data.description ?? existing?.description ?? null,
            usage: existing?.usage ?? null,
            lastToolName: existing?.lastToolName ?? null,
          }
          streamStates.set(sessionId, {
            ...current,
            activeSubagents: upsertSubagent(current.activeSubagents, updated),
          })
        }
      }
      else if (data.type === 'subagent_updated') {
        // Subagent message persisted or agentId discovered — refetch persisted messages.
        // Preserve existing streaming state; SubAgentBlock's isStreamingMessagePersisted
        // dedup logic handles the transition from streaming to persisted display.
        if (current) {
          const existing = current.activeSubagents.find(s => s.parentToolId === data.parentToolId)
          const updated: SubagentInfo = {
            parentToolId: data.parentToolId,
            agentId: data.agentId ?? existing?.agentId ?? null,
            streamingMessage: existing?.streamingMessage ?? null,
            streamingToolUse: existing?.streamingToolUse ?? null,
            progressSummary: existing?.progressSummary ?? null,
            subagentType: existing?.subagentType ?? null,
            description: existing?.description ?? null,
            usage: existing?.usage ?? null,
            lastToolName: existing?.lastToolName ?? null,
          }
          streamStates.set(sessionId, {
            ...current,
            activeSubagents: upsertSubagent(current.activeSubagents, updated),
          })
          queryClient.invalidateQueries({ queryKey: ['subagent-messages', sessionId] })
        }
      }
      else if (data.type === 'subagent_completed') {
        // Subagent finished — update streaming message with resultText if provided
        // (shows the exit summary immediately without waiting for refetch).
        if (current) {
          const existing = current.activeSubagents.find(s => s.parentToolId === data.parentToolId)
          const newCompleted = new Set(current.completedSubagents)
          if (data.parentToolId) {
            newCompleted.add(data.parentToolId)
          }
          const updatedEntry: SubagentInfo = {
            ...(existing ?? {
              parentToolId: data.parentToolId,
              streamingMessage: null,
              streamingToolUse: null,
              progressSummary: null,
              subagentType: null,
              description: null,
              usage: null,
              lastToolName: null,
            }),
            agentId: data.agentId ?? existing?.agentId ?? null,
            resultText: data.resultText ?? null,
          }
          const updatedSubagents = upsertSubagent(current.activeSubagents, updatedEntry)
          streamStates.set(sessionId, {
            ...current,
            activeSubagents: updatedSubagents,
            completedSubagents: newCompleted,
          })
          queryClient.invalidateQueries({ queryKey: ['subagent-messages', sessionId] })
          queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
        }
      }
      // Subagent streaming events
      else if (data.type === 'subagent_stream_start') {
        if (current) {
          const existing = current.activeSubagents.find(s => s.parentToolId === data.parentToolId)
          const updated: SubagentInfo = {
            parentToolId: data.parentToolId,
            agentId: data.agentId ?? existing?.agentId ?? null,
            streamingMessage: '',
            streamingToolUse: null,
            progressSummary: existing?.progressSummary ?? null,
            subagentType: existing?.subagentType ?? null,
            description: existing?.description ?? null,
            usage: existing?.usage ?? null,
            lastToolName: existing?.lastToolName ?? null,
          }
          streamStates.set(sessionId, {
            ...current,
            activeSubagents: upsertSubagent(current.activeSubagents, updated),
          })
        }
      }
      else if (data.type === 'subagent_stream_delta') {
        if (current) {
          const existing = current.activeSubagents.find(s => s.parentToolId === data.parentToolId)
          const updated: SubagentInfo = {
            parentToolId: data.parentToolId,
            agentId: data.agentId ?? existing?.agentId ?? null,
            streamingMessage: (existing?.streamingMessage || '') + data.text,
            streamingToolUse: existing?.streamingToolUse ?? null,
            progressSummary: existing?.progressSummary ?? null,
            subagentType: existing?.subagentType ?? null,
            description: existing?.description ?? null,
            usage: existing?.usage ?? null,
            lastToolName: existing?.lastToolName ?? null,
          }
          streamStates.set(sessionId, {
            ...current,
            activeSubagents: upsertSubagent(current.activeSubagents, updated),
          })
        }
      }
      else if (data.type === 'subagent_tool_use_start' || data.type === 'subagent_tool_use_streaming') {
        if (current) {
          const existing = current.activeSubagents.find(s => s.parentToolId === data.parentToolId)
          const updated: SubagentInfo = {
            parentToolId: data.parentToolId,
            agentId: data.agentId ?? existing?.agentId ?? null,
            streamingMessage: existing?.streamingMessage ?? null,
            streamingToolUse: {
              id: data.toolId,
              name: data.toolName,
              partialInput: data.partialInput ?? '',
            },
            progressSummary: existing?.progressSummary ?? null,
            subagentType: existing?.subagentType ?? null,
            description: existing?.description ?? null,
            usage: existing?.usage ?? null,
            lastToolName: existing?.lastToolName ?? null,
          }
          streamStates.set(sessionId, {
            ...current,
            activeSubagents: upsertSubagent(current.activeSubagents, updated),
          })
        }
      }
      else if (data.type === 'subagent_progress') {
        if (current) {
          const existing = current.activeSubagents.find(s => s.parentToolId === data.parentToolId)
          const updated: SubagentInfo = {
            parentToolId: data.parentToolId,
            agentId: existing?.agentId ?? null,
            streamingMessage: existing?.streamingMessage ?? null,
            streamingToolUse: existing?.streamingToolUse ?? null,
            progressSummary: data.summary ?? existing?.progressSummary ?? null,
            subagentType: data.subagentType ?? existing?.subagentType ?? null,
            description: existing?.description ?? null, // keep original from task_started
            usage: data.usage ?? existing?.usage ?? null,
            lastToolName: data.lastToolName ?? existing?.lastToolName ?? null,
          }
          streamStates.set(sessionId, {
            ...current,
            activeSubagents: upsertSubagent(current.activeSubagents, updated),
          })
        }
      }
      else if (data.type === 'subagent_tool_use_ready') {
        // Tool ready — keep visible until subagent_updated clears it
      }
      else if (data.type === 'ping') {
        // Safety net: sync isActive from server.
        // If server says inactive but we think active, the session ended and we missed it.
        if (current?.isActive && data.isActive === false) {
          streamStates.set(sessionId, {
            ...current,
            isActive: false,
            isStreaming: false,
            streamingMessage: null,
            streamingToolUses: [],
            error: null,
            apiErrorCode: null,
            activeStartTime: null,
          })
          queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
          queryClient.invalidateQueries({ queryKey: ['sessions'] })
        }
      }
      // Note: os_notification events are handled by GlobalNotificationHandler, not here

      // Notify all listeners
      streamListeners.get(sessionId)?.forEach((listener) => listener())
    } catch (error) {
      console.error('Failed to parse SSE message:', error)
    }
  }

  es.onerror = () => {
    // Don't reset isActive on error - EventSource will auto-reconnect
    // and we'll get the correct state from the 'connected' event.
    // Only reset streaming state since that's definitely interrupted.
    // Preserve pending secret requests and error as they may still be valid.
    const current = streamStates.get(sessionId)
    if (current) {
      streamStates.set(sessionId, {
        ...current,
        isStreaming: false,
        streamingMessage: null,
        streamingToolUses: [],
      })
    }
    streamListeners.get(sessionId)?.forEach((listener) => listener())
    // Refetch messages to ensure we have latest data
    queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
  }

  return es
}

function releaseEventSource(sessionId: string, agentSlug: string): void {
  const key = `${agentSlug}:${sessionId}`
  const count = (refCounts.get(key) || 1) - 1
  refCounts.set(key, count)

  if (count <= 0) {
    const es = eventSources.get(key)
    if (es) {
      es.close()
      eventSources.delete(key)
    }
    refCounts.delete(key)
  }
}

// Helper function to remove a secret request from a session
export function removeSecretRequest(sessionId: string, toolUseId: string): void {
  const current = streamStates.get(sessionId)
  if (current) {
    streamStates.set(sessionId, {
      ...current,
      pendingSecretRequests: current.pendingSecretRequests.filter(
        (r) => r.toolUseId !== toolUseId
      ),
    })
    // Notify listeners
    streamListeners.get(sessionId)?.forEach((listener) => listener())
  }
}

// Helper function to remove a connected account request from a session
export function removeConnectedAccountRequest(sessionId: string, toolUseId: string): void {
  const current = streamStates.get(sessionId)
  if (current) {
    streamStates.set(sessionId, {
      ...current,
      pendingConnectedAccountRequests: current.pendingConnectedAccountRequests.filter(
        (r) => r.toolUseId !== toolUseId
      ),
    })
    // Notify listeners
    streamListeners.get(sessionId)?.forEach((listener) => listener())
  }
}

// Helper function to remove a file request from a session
export function removeFileRequest(sessionId: string, toolUseId: string): void {
  const current = streamStates.get(sessionId)
  if (current) {
    streamStates.set(sessionId, {
      ...current,
      pendingFileRequests: current.pendingFileRequests.filter(
        (r) => r.toolUseId !== toolUseId
      ),
    })
    // Notify listeners
    streamListeners.get(sessionId)?.forEach((listener) => listener())
  }
}

// Helper function to remove a question request from a session
export function removeQuestionRequest(sessionId: string, toolUseId: string): void {
  const current = streamStates.get(sessionId)
  if (current) {
    streamStates.set(sessionId, {
      ...current,
      pendingQuestionRequests: current.pendingQuestionRequests.filter(
        (r) => r.toolUseId !== toolUseId
      ),
    })
    // Notify listeners
    streamListeners.get(sessionId)?.forEach((listener) => listener())
  }
}

// Helper function to remove a remote MCP request from a session
export function removeRemoteMcpRequest(sessionId: string, toolUseId: string): void {
  const current = streamStates.get(sessionId)
  if (current) {
    streamStates.set(sessionId, {
      ...current,
      pendingRemoteMcpRequests: current.pendingRemoteMcpRequests.filter(
        (r) => r.toolUseId !== toolUseId
      ),
    })
    // Notify listeners
    streamListeners.get(sessionId)?.forEach((listener) => listener())
  }
}

// Helper function to remove a browser input request from a session
export function removeBrowserInputRequest(sessionId: string, toolUseId: string): void {
  const current = streamStates.get(sessionId)
  if (current) {
    streamStates.set(sessionId, {
      ...current,
      pendingBrowserInputRequests: current.pendingBrowserInputRequests.filter(
        (r) => r.toolUseId !== toolUseId
      ),
    })
    streamListeners.get(sessionId)?.forEach((listener) => listener())
  }
}

// Helper function to remove a script run request from a session
export function removeScriptRunRequest(sessionId: string, toolUseId: string): void {
  const current = streamStates.get(sessionId)
  if (current) {
    streamStates.set(sessionId, {
      ...current,
      pendingScriptRunRequests: current.pendingScriptRunRequests.filter(
        (r) => r.toolUseId !== toolUseId
      ),
    })
    streamListeners.get(sessionId)?.forEach((listener) => listener())
  }
}

// Helper function to remove a computer use request from a session
export function removeComputerUseRequest(sessionId: string, toolUseId: string): void {
  const current = streamStates.get(sessionId)
  if (current) {
    streamStates.set(sessionId, {
      ...current,
      pendingComputerUseRequests: current.pendingComputerUseRequests.filter(
        (r) => r.toolUseId !== toolUseId
      ),
    })
    streamListeners.get(sessionId)?.forEach((listener) => listener())
  }
}

// Remove a peer user message once its persisted copy is visible in fetched messages
export function removePeerUserMessage(sessionId: string, uuid: string): void {
  const current = streamStates.get(sessionId)
  if (current && current.peerUserMessages.some((p) => p.uuid === uuid)) {
    streamStates.set(sessionId, {
      ...current,
      peerUserMessages: current.peerUserMessages.filter((p) => p.uuid !== uuid),
    })
    streamListeners.get(sessionId)?.forEach((listener) => listener())
  }
}

// Drop all peer user messages (safety net for messages that never persisted,
// e.g. the agent was interrupted before picking up a queued message)
export function clearPeerUserMessages(sessionId: string): void {
  const current = streamStates.get(sessionId)
  if (current && current.peerUserMessages.length > 0) {
    streamStates.set(sessionId, { ...current, peerUserMessages: [] })
    streamListeners.get(sessionId)?.forEach((listener) => listener())
  }
}

// Helper to clear isCompacting state (used when persisted messages already show the boundary)
export function clearCompacting(sessionId: string): void {
  const current = streamStates.get(sessionId)
  if (current && current.isCompacting) {
    streamStates.set(sessionId, { ...current, isCompacting: false })
    streamListeners.get(sessionId)?.forEach((listener) => listener())
  }
}

// Helper to clear browserActive state (used by BrowserPreview when stream disconnects)
export function clearBrowserActive(sessionId: string): void {
  const current = streamStates.get(sessionId)
  if (current && current.browserActive) {
    streamStates.set(sessionId, { ...current, browserActive: false })
    streamListeners.get(sessionId)?.forEach((listener) => listener())
  }
}

export function useMessageStream(sessionId: string | null, agentSlug: string | null) {
  const [state, setState] = useState<StreamState>(EMPTY_STREAM_STATE)
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([])
  const [thinking, setThinking] = useState<ThinkingState>(EMPTY_THINKING)
  const [autoApprovedScriptRunIds, setAutoApprovedScriptRunIds] = useState<ReadonlySet<string>>(EMPTY_AUTO_APPROVED_SET)
  const queryClient = useQueryClient()

  // Update local state when global state changes
  const updateState = useCallback(() => {
    if (sessionId) {
      const globalState = streamStates.get(sessionId)
      if (globalState) {
        setState(globalState)
      }
      setSlashCommands(sessionSlashCommands.get(sessionId) ?? [])
      // Mirror the thinking side-map into React state, preserving referential
      // stability when nothing changed so consumers don't re-render needlessly.
      const t = sessionThinking.get(sessionId)
      setThinking((prev) => {
        if (!t) return prev === EMPTY_THINKING ? prev : EMPTY_THINKING
        if (prev.text === t.text && prev.isThinking === t.isThinking) return prev
        return { text: t.text, isThinking: t.isThinking }
      })
      const approved = sessionAutoApprovedScriptRunIds.get(sessionId)
      // Hand back a fresh snapshot when the contents changed so React re-renders consumers.
      setAutoApprovedScriptRunIds((prev) => {
        if (!approved || approved.size === 0) {
          return prev.size === 0 ? prev : EMPTY_AUTO_APPROVED_SET
        }
        if (prev.size === approved.size) {
          let identical = true
          for (const id of approved) {
            if (!prev.has(id)) { identical = false; break }
          }
          if (identical) return prev
        }
        return new Set(approved)
      })
    }
  }, [sessionId])

  useEffect(() => {
    if (!sessionId || !agentSlug) {
      // Reset local state so a previous subscription's values (e.g. isStreaming=true)
      // don't leak after the caller stops passing a sessionId — otherwise an unselected
      // session row can get stuck in a "working" state after the stream finishes.
      setState(EMPTY_STREAM_STATE)
      setSlashCommands([])
      setThinking(EMPTY_THINKING)
      return
    }

    // Register listener
    let listeners = streamListeners.get(sessionId)
    if (!listeners) {
      listeners = new Set()
      streamListeners.set(sessionId, listeners)
    }
    listeners.add(updateState)

    // Initialize state
    if (!streamStates.has(sessionId)) {
      streamStates.set(sessionId, EMPTY_STREAM_STATE)
    }
    updateState()

    // Get or create singleton EventSource for this session
    getOrCreateEventSource(sessionId, agentSlug, queryClient)

    return () => {
      listeners?.delete(updateState)
      if (listeners?.size === 0) {
        streamListeners.delete(sessionId)
      }
      releaseEventSource(sessionId, agentSlug)
    }
  }, [sessionId, agentSlug, updateState, queryClient])

  return { ...state, slashCommands, autoApprovedScriptRunIds, isThinking: thinking.isThinking, thinkingText: thinking.text }
}
