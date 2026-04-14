
import { useState, useEffect, useCallback } from 'react'
import { useQueryClient, QueryClient } from '@tanstack/react-query'
import { getApiBaseUrl } from '@renderer/lib/env'
import type { SessionUsage } from '@shared/lib/types/agent'
import type { SlashCommandInfo } from '@shared/lib/container/types'

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
  progressSummary: string | null // AI-generated progress summary from agentProgressSummaries
}

interface ApiRetryInfo {
  attempt: number
  maxRetries?: number
  delayMs?: number
  errorStatus?: number
}

interface StreamState {
  isActive: boolean // True from user message until query result
  isStreaming: boolean // True while actively receiving tokens
  streamingMessage: string | null
  streamingToolUse: { id: string; name: string; partialInput: string } | null
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
  peerUserMessage: { content: string; sender: { id: string; name?: string; email?: string } } | null // User message from another user
  apiRetry: ApiRetryInfo | null // Non-null while API is retrying a transient error
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
const streamStates = new Map<string, StreamState>()
const streamListeners = new Map<string, Set<() => void>>()

// Slash commands per session (separate from streamStates to avoid touching 25+ set() calls)
const sessionSlashCommands = new Map<string, SlashCommandInfo[]>()


// Singleton EventSource connections per session (prevents duplicates from StrictMode/re-renders)
const eventSources = new Map<string, EventSource>()
const refCounts = new Map<string, number>()

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
          streamingToolUse: null,
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
          activeStartTime: current?.activeStartTime ?? (data.isActive ? Date.now() : null),
          isCompacting: current?.isCompacting ?? false,
          contextUsage: current?.contextUsage ?? null,
          activeSubagents: current?.activeSubagents ?? [],
          completedSubagents: current?.completedSubagents ?? null,
          typingUser: current?.typingUser ?? null,
          peerUserMessage: current?.peerUserMessage ?? null,
          apiRetry: current?.apiRetry ?? null,
        })
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
        streamStates.set(sessionId, {
          isActive: true,
          isStreaming: current?.isStreaming ?? false,
          streamingMessage: current?.streamingMessage ?? null,
          streamingToolUse: current?.streamingToolUse ?? null,
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
          peerUserMessage: current?.peerUserMessage ?? null,
          apiRetry: null,
        })
        queryClient.invalidateQueries({ queryKey: ['sessions'] })
      }
      else if (data.type === 'session_idle') {
        // Session became idle - query completed or interrupted
        // Keep streamingMessage so it stays visible until persisted data arrives
        // (isStreamingMessagePersisted in MessageList handles deduplication)
        // Clear streamingToolUse - if the tool was persisted, ToolCallItem renders it;
        // if it wasn't (interrupted mid-stream), it should disappear.
        if (data.sessionId && data.sessionId !== sessionId) return
        streamStates.set(sessionId, {
          isActive: false,
          isStreaming: false,
          streamingMessage: current?.streamingMessage ?? null,
          streamingToolUse: null,
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
          peerUserMessage: current?.peerUserMessage ?? null,
          apiRetry: current?.apiRetry ?? null,
        })
        queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
        queryClient.invalidateQueries({ queryKey: ['sessions'] })
      }
      else if (data.type === 'session_error') {
        // Session encountered an error
        // Keep streamingMessage so error text (streamed via stream_delta) stays visible
        // until the persisted JSONL data arrives (isStreamingMessagePersisted handles dedup).
        streamStates.set(sessionId, {
          isActive: false,
          isStreaming: false,
          streamingMessage: current?.streamingMessage ?? null,
          streamingToolUse: null,
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
          peerUserMessage: current?.peerUserMessage ?? null,
          apiRetry: current?.apiRetry ?? null,
        })
        queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
        queryClient.invalidateQueries({ queryKey: ['sessions'] })
      }
      // Streaming events - update streaming state, preserve isActive
      else if (data.type === 'stream_start') {
        // Capture slash commands from init event (piggybacked on stream_start)
        if (Array.isArray(data.slashCommands)) {
          sessionSlashCommands.set(sessionId, data.slashCommands)
        }
        // If there was a streaming tool use, trigger a refetch so the persisted
        // version is available before we clear the streaming state.
        if (current?.streamingToolUse) {
          queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
        }
        streamStates.set(sessionId, {
          isActive: current?.isActive ?? false,
          isStreaming: true,
          streamingMessage: '',
          streamingToolUse: null,
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
          peerUserMessage: current?.peerUserMessage ?? null,
          apiRetry: null, // Clear retry state — API call succeeded
        })
      }
      else if (data.type === 'stream_delta') {
        streamStates.set(sessionId, {
          isActive: current?.isActive ?? false,
          isStreaming: true,
          streamingMessage: (current?.streamingMessage || '') + data.text,
          streamingToolUse: null,
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
          peerUserMessage: current?.peerUserMessage ?? null,
          apiRetry: current?.apiRetry ?? null,
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
        streamStates.set(sessionId, {
          isActive: current?.isActive ?? false,
          isStreaming: true,
          streamingMessage: current?.streamingMessage ?? null,
          streamingToolUse: {
            id: data.toolId,
            name: data.toolName,
            partialInput: data.partialInput ?? '',
          },
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
          peerUserMessage: current?.peerUserMessage ?? null,
          apiRetry: current?.apiRetry ?? null,
        })
      }
      else if (data.type === 'tool_use_ready') {
        // Tool is ready to execute - keep streamingToolUse visible until persisted
        streamStates.set(sessionId, {
          isActive: current?.isActive ?? false,
          isStreaming: true,
          streamingMessage: current?.streamingMessage ?? null,
          streamingToolUse: current?.streamingToolUse ?? null,
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
          peerUserMessage: current?.peerUserMessage ?? null,
          apiRetry: current?.apiRetry ?? null,
        })
      }
      else if (data.type === 'stream_end') {
        streamStates.set(sessionId, {
          isActive: current?.isActive ?? false,
          isStreaming: false,
          streamingMessage: current?.streamingMessage ?? null,
          streamingToolUse: null,
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
          peerUserMessage: current?.peerUserMessage ?? null,
          apiRetry: current?.apiRetry ?? null,
        })
      }
      else if (data.type === 'user_message') {
        // Another user sent a message in this shared session
        streamStates.set(sessionId, {
          ...current!,
          peerUserMessage: { content: data.content, sender: data.sender },
          typingUser: null, // Clear typing since they sent
        })
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
        // Don't clear peerUserMessage here — the render dedup in MessageList
        // hides it once the fetched messages include the matching text.
        // Server signals that a message has been persisted to JSONL.
        // Refetch so that persisted data is available before stream_start
        // clears the streaming tool use state (prevents tool call flicker).
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
      else if (data.type === 'secret_request') {
        // Agent is requesting a secret from the user
        const newRequest: SecretRequest = {
          toolUseId: data.toolUseId,
          secretName: data.secretName,
          reason: data.reason,
        }
        if (current) {
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
        if (current) {
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
        if (current) {
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
        if (current) {
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
        if (current) {
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
        // Agent is requesting script execution on the host
        if (current && !current.pendingScriptRunRequests.some(r => r.toolUseId === data.toolUseId)) {
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
      else if (data.type === 'scheduled_task_created') {
        // A scheduled task was created - invalidate scheduled tasks cache
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
          }
          streamStates.set(sessionId, {
            ...current,
            activeSubagents: upsertSubagent(current.activeSubagents, updated),
          })
          queryClient.invalidateQueries({ queryKey: ['subagent-messages', sessionId] })
        }
      }
      else if (data.type === 'subagent_completed') {
        // Subagent finished — keep streaming data visible (for summary text) until persisted data arrives.
        // Update agentId if provided, and mark as completed so status logic shows "completed".
        if (current) {
          const existing = current.activeSubagents.find(s => s.parentToolId === data.parentToolId)
          const newCompleted = new Set(current.completedSubagents)
          if (data.parentToolId) {
            newCompleted.add(data.parentToolId)
          }
          const updatedSubagents = existing
            ? upsertSubagent(current.activeSubagents, { ...existing, agentId: data.agentId ?? existing.agentId })
            : current.activeSubagents
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
          }
          streamStates.set(sessionId, {
            ...current,
            activeSubagents: upsertSubagent(current.activeSubagents, updated),
          })
        }
      }
      else if (data.type === 'subagent_progress') {
        // AI-generated progress summary for a running subagent
        if (current) {
          const existing = current.activeSubagents.find(s => s.parentToolId === data.parentToolId)
          const updated: SubagentInfo = {
            parentToolId: data.parentToolId,
            agentId: existing?.agentId ?? null,
            streamingMessage: existing?.streamingMessage ?? null,
            streamingToolUse: existing?.streamingToolUse ?? null,
            progressSummary: data.summary ?? null,
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
            streamingToolUse: null,
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
        streamingToolUse: null,
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
  const [state, setState] = useState<StreamState>({
    isActive: false,
    isStreaming: false,
    streamingMessage: null,
    streamingToolUse: null,
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
    peerUserMessage: null,
    apiRetry: null,
  })
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([])
  const queryClient = useQueryClient()

  // Update local state when global state changes
  const updateState = useCallback(() => {
    if (sessionId) {
      const globalState = streamStates.get(sessionId)
      if (globalState) {
        setState(globalState)
      }
      setSlashCommands(sessionSlashCommands.get(sessionId) ?? [])
    }
  }, [sessionId])

  useEffect(() => {
    if (!sessionId || !agentSlug) return

    // Register listener
    let listeners = streamListeners.get(sessionId)
    if (!listeners) {
      listeners = new Set()
      streamListeners.set(sessionId, listeners)
    }
    listeners.add(updateState)

    // Initialize state
    if (!streamStates.has(sessionId)) {
      streamStates.set(sessionId, {
        isActive: false,
        isStreaming: false,
        streamingMessage: null,
        streamingToolUse: null,
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
        peerUserMessage: null,
        apiRetry: null,
      })
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

  return { ...state, slashCommands }
}
