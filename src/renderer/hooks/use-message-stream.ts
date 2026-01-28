
import { useState, useEffect, useCallback } from 'react'
import { useQueryClient, QueryClient } from '@tanstack/react-query'
import { getApiBaseUrl } from '@renderer/lib/env'

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

interface StreamState {
  isActive: boolean // True from user message until query result
  isStreaming: boolean // True while actively receiving tokens
  streamingMessage: string | null
  streamingToolUse: { id: string; name: string; partialInput: string } | null
  pendingSecretRequests: SecretRequest[]
  pendingConnectedAccountRequests: ConnectedAccountRequest[]
  error: string | null // Error message if session encountered an error
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
          error: null,
        })
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
          error: null, // Clear any previous error when starting new request
        })
        queryClient.invalidateQueries({ queryKey: ['sessions'] })
      }
      else if (data.type === 'session_idle') {
        // Session became idle - query completed or interrupted
        // Clear pending requests as the query is done
        streamStates.set(sessionId, {
          isActive: false,
          isStreaming: false,
          streamingMessage: null,
          streamingToolUse: null,
          pendingSecretRequests: [],
          pendingConnectedAccountRequests: [],
          error: null,
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
          error: data.error || 'An unknown error occurred',
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
          error: null,
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
          error: current?.error ?? null,
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
          error: current?.error ?? null,
        })
      }
      else if (data.type === 'tool_use_ready') {
        // Tool is ready to execute - keep streaming true, clear tool use
        streamStates.set(sessionId, {
          isActive: current?.isActive ?? false,
          isStreaming: true,
          streamingMessage: current?.streamingMessage ?? null,
          streamingToolUse: null,
          pendingSecretRequests: current?.pendingSecretRequests ?? [],
          pendingConnectedAccountRequests: current?.pendingConnectedAccountRequests ?? [],
          error: current?.error ?? null,
        })
      }
      else if (data.type === 'stream_end') {
        streamStates.set(sessionId, {
          isActive: current?.isActive ?? false,
          isStreaming: false,
          streamingMessage: null,
          streamingToolUse: null,
          pendingSecretRequests: current?.pendingSecretRequests ?? [],
          pendingConnectedAccountRequests: current?.pendingConnectedAccountRequests ?? [],
          error: current?.error ?? null,
        })
      }
      else if (data.type === 'tool_call' || data.type === 'tool_result') {
        // Message has been persisted - clear streaming state, refresh from DB
        if (current) {
          streamStates.set(sessionId, {
            isActive: current.isActive,
            isStreaming: false,
            streamingMessage: null,
            streamingToolUse: null,
            pendingSecretRequests: current.pendingSecretRequests ?? [],
            pendingConnectedAccountRequests: current.pendingConnectedAccountRequests ?? [],
            error: current.error ?? null,
          })
        }
        queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
      }
      else if (data.type === 'secret_request') {
        // Agent is requesting a secret from the user
        const newRequest: SecretRequest = {
          toolUseId: data.toolUseId,
          secretName: data.secretName,
          reason: data.reason,
        }
        streamStates.set(sessionId, {
          isActive: current?.isActive ?? false,
          isStreaming: current?.isStreaming ?? false,
          streamingMessage: current?.streamingMessage ?? null,
          streamingToolUse: current?.streamingToolUse ?? null,
          pendingSecretRequests: [
            ...(current?.pendingSecretRequests ?? []),
            newRequest,
          ],
          pendingConnectedAccountRequests: current?.pendingConnectedAccountRequests ?? [],
          error: current?.error ?? null,
        })
      }
      else if (data.type === 'connected_account_request') {
        // Agent is requesting access to a connected account
        const newRequest: ConnectedAccountRequest = {
          toolUseId: data.toolUseId,
          toolkit: data.toolkit,
          reason: data.reason,
        }
        streamStates.set(sessionId, {
          isActive: current?.isActive ?? false,
          isStreaming: current?.isStreaming ?? false,
          streamingMessage: current?.streamingMessage ?? null,
          streamingToolUse: current?.streamingToolUse ?? null,
          pendingSecretRequests: current?.pendingSecretRequests ?? [],
          pendingConnectedAccountRequests: [
            ...(current?.pendingConnectedAccountRequests ?? []),
            newRequest,
          ],
          error: current?.error ?? null,
        })
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
      // Note: os_notification events are handled by GlobalNotificationHandler, not here
      // Ignore ping and other events - they don't change state

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

export function useMessageStream(sessionId: string | null, agentSlug: string | null) {
  const [state, setState] = useState<StreamState>({
    isActive: false,
    isStreaming: false,
    streamingMessage: null,
    streamingToolUse: null,
    pendingSecretRequests: [],
    pendingConnectedAccountRequests: [],
    error: null,
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
        error: null,
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
