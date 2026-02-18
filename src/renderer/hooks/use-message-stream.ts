
import { useState, useEffect, useCallback } from 'react'
import { useQueryClient, QueryClient } from '@tanstack/react-query'
import { getApiBaseUrl } from '@renderer/lib/env'
import type { SessionUsage } from '@shared/lib/types/agent'

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
}

export interface SubagentInfo {
  parentToolId: string | null
  agentId: string | null
  streamingMessage: string | null
  streamingToolUse: { id: string; name: string; partialInput: string } | null
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
  error: string | null // Error message if session encountered an error
  browserActive: boolean // Whether browser is running for this session
  activeStartTime: number | null // Timestamp when session became active (for elapsed timer)
  isCompacting: boolean // True while context compaction is in progress
  contextUsage: SessionUsage | null // Latest context window usage data
  activeSubagent: SubagentInfo | null // Currently running subagent info
}

// Global state to track streaming per session
const streamStates = new Map<string, StreamState>()
const streamListeners = new Map<string, Set<() => void>>()

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
          error: null,
          browserActive: current?.browserActive ?? false,
          activeStartTime: current?.activeStartTime ?? null,
          isCompacting: current?.isCompacting ?? false,
          contextUsage: current?.contextUsage ?? null,
          activeSubagent: current?.activeSubagent ?? null,
        })
        // Fetch current browser status to sync state (handles missed events)
        fetch(`${baseUrl}/api/agents/${agentSlug}/browser/status`)
          .then((res) => res.json())
          .then((status: { active?: boolean }) => {
            const latest = streamStates.get(sessionId)
            if (latest && latest.browserActive !== (status.active ?? false)) {
              streamStates.set(sessionId, { ...latest, browserActive: status.active ?? false })
              streamListeners.get(sessionId)?.forEach((listener) => listener())
            }
          })
          .catch(() => { /* ignore - agent may not be running */ })
      }
      else if (data.type === 'session_active') {
        // Session became active - user sent a message
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
          error: null, // Clear any previous error when starting new request
          browserActive: current?.browserActive ?? false,
          activeStartTime: Date.now(),
          isCompacting: false,
          contextUsage: current?.contextUsage ?? null,
          activeSubagent: null,
        })
        queryClient.invalidateQueries({ queryKey: ['sessions'] })
      }
      else if (data.type === 'session_idle') {
        // Session became idle - query completed or interrupted
        // Keep streamingMessage so it stays visible until persisted data arrives
        // (isStreamingMessagePersisted in MessageList handles deduplication)
        // Clear streamingToolUse - if the tool was persisted, ToolCallItem renders it;
        // if it wasn't (interrupted mid-stream), it should disappear.
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
          error: null,
          browserActive: current?.browserActive ?? false,
          activeStartTime: null,
          isCompacting: false,
          contextUsage: current?.contextUsage ?? null,
          activeSubagent: null,
        })
        queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
        queryClient.invalidateQueries({ queryKey: ['sessions'] })
      }
      else if (data.type === 'session_error') {
        // Session encountered an error
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
          error: data.error || 'An unknown error occurred',
          browserActive: current?.browserActive ?? false,
          activeStartTime: null,
          isCompacting: false,
          contextUsage: current?.contextUsage ?? null,
          activeSubagent: null,
        })
        queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
        queryClient.invalidateQueries({ queryKey: ['sessions'] })
      }
      // Streaming events - update streaming state, preserve isActive
      else if (data.type === 'stream_start') {
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
          error: null,
          browserActive: current?.browserActive ?? false,
          activeStartTime: current?.activeStartTime ?? null,
          isCompacting: current?.isCompacting ?? false,
          contextUsage: current?.contextUsage ?? null,
          activeSubagent: current?.activeSubagent ?? null,
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
          error: current?.error ?? null,
          browserActive: current?.browserActive ?? false,
          activeStartTime: current?.activeStartTime ?? null,
          isCompacting: current?.isCompacting ?? false,
          contextUsage: current?.contextUsage ?? null,
          activeSubagent: current?.activeSubagent ?? null,
        })
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
          error: current?.error ?? null,
          browserActive: current?.browserActive ?? false,
          activeStartTime: current?.activeStartTime ?? null,
          isCompacting: current?.isCompacting ?? false,
          contextUsage: current?.contextUsage ?? null,
          activeSubagent: current?.activeSubagent ?? null,
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
          error: current?.error ?? null,
          browserActive: current?.browserActive ?? false,
          activeStartTime: current?.activeStartTime ?? null,
          isCompacting: current?.isCompacting ?? false,
          contextUsage: current?.contextUsage ?? null,
          activeSubagent: current?.activeSubagent ?? null,
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
          error: current?.error ?? null,
          browserActive: current?.browserActive ?? false,
          activeStartTime: current?.activeStartTime ?? null,
          isCompacting: current?.isCompacting ?? false,
          contextUsage: current?.contextUsage ?? null,
          activeSubagent: current?.activeSubagent ?? null,
        })
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
        }
      }
      else if (data.type === 'remote_mcp_request') {
        // Agent is requesting access to a remote MCP server
        const newRequest: RemoteMcpRequest = {
          toolUseId: data.toolUseId,
          url: data.url,
          name: data.name,
          reason: data.reason,
        }
        if (current) {
          streamStates.set(sessionId, {
            ...current,
            pendingRemoteMcpRequests: [...current.pendingRemoteMcpRequests, newRequest],
          })
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
      else if (data.type === 'browser_active') {
        // Browser state changed
        if (current) {
          streamStates.set(sessionId, {
            ...current,
            browserActive: data.active ?? false,
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
      else if (data.type === 'subagent_updated') {
        // Subagent message persisted — clear streaming state, refetch persisted messages
        if (current) {
          streamStates.set(sessionId, {
            ...current,
            activeSubagent: {
              parentToolId: data.parentToolId,
              agentId: data.agentId,
              streamingMessage: null,
              streamingToolUse: null,
            },
          })
          queryClient.invalidateQueries({ queryKey: ['subagent-messages', sessionId] })
        }
      }
      else if (data.type === 'subagent_completed') {
        // Subagent finished
        if (current) {
          streamStates.set(sessionId, { ...current, activeSubagent: null })
          queryClient.invalidateQueries({ queryKey: ['subagent-messages', sessionId] })
          queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
        }
      }
      // Subagent streaming events
      else if (data.type === 'subagent_stream_start') {
        if (current) {
          streamStates.set(sessionId, {
            ...current,
            activeSubagent: {
              parentToolId: data.parentToolId,
              agentId: data.agentId ?? current.activeSubagent?.agentId ?? null,
              streamingMessage: '',
              streamingToolUse: null,
            },
          })
        }
      }
      else if (data.type === 'subagent_stream_delta') {
        if (current) {
          const existing = current.activeSubagent
          streamStates.set(sessionId, {
            ...current,
            activeSubagent: {
              parentToolId: data.parentToolId,
              agentId: data.agentId ?? existing?.agentId ?? null,
              streamingMessage: (existing?.streamingMessage || '') + data.text,
              streamingToolUse: existing?.streamingToolUse ?? null,
            },
          })
        }
      }
      else if (data.type === 'subagent_tool_use_start' || data.type === 'subagent_tool_use_streaming') {
        if (current) {
          const existing = current.activeSubagent
          streamStates.set(sessionId, {
            ...current,
            activeSubagent: {
              parentToolId: data.parentToolId,
              agentId: data.agentId ?? existing?.agentId ?? null,
              streamingMessage: existing?.streamingMessage ?? null,
              streamingToolUse: {
                id: data.toolId,
                name: data.toolName,
                partialInput: data.partialInput ?? '',
              },
            },
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
    error: null,
    browserActive: false,
    activeStartTime: null,
    isCompacting: false,
    contextUsage: null,
    activeSubagent: null,
  })
  const queryClient = useQueryClient()

  // Update local state when global state changes
  const updateState = useCallback(() => {
    if (sessionId) {
      const globalState = streamStates.get(sessionId)
      if (globalState) {
        setState(globalState)
      }
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
        error: null,
        browserActive: false,
        activeStartTime: null,
        isCompacting: false,
        contextUsage: null,
        activeSubagent: null,
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

  return state
}
