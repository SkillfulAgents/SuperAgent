'use client'

import { useState, useEffect, useCallback } from 'react'
import { useQueryClient, QueryClient } from '@tanstack/react-query'

interface StreamState {
  isActive: boolean // True from user message until query result
  isStreaming: boolean // True while actively receiving tokens
  streamingMessage: string | null
  streamingToolUse: { id: string; name: string; partialInput: string } | null
  isIdle: boolean // True after session_idle, prevents stale events from reactivating
}

// Global state to track streaming per session
const streamStates = new Map<string, StreamState>()
const streamListeners = new Map<string, Set<() => void>>()

// Singleton EventSource connections per session (prevents duplicates from StrictMode/re-renders)
const eventSources = new Map<string, EventSource>()
const refCounts = new Map<string, number>()

function getOrCreateEventSource(
  sessionId: string,
  queryClient: QueryClient
): EventSource {
  let es = eventSources.get(sessionId)
  if (es && es.readyState !== EventSource.CLOSED) {
    // Increment ref count
    refCounts.set(sessionId, (refCounts.get(sessionId) || 0) + 1)
    return es
  }

  // Create new EventSource
  es = new EventSource(`/api/sessions/${sessionId}/stream`)
  eventSources.set(sessionId, es)
  refCounts.set(sessionId, 1)

  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data)
      const current = streamStates.get(sessionId)

      // Every event includes isActive, so we always use it to self-correct state
      // BUT if we're idle, ignore stale events trying to set isActive=true (except session_active)
      let isActive = data.isActive ?? current?.isActive ?? false
      if (current?.isIdle && isActive && data.type !== 'session_active') {
        // Stale event arrived after session_idle - ignore its isActive
        isActive = false
      }

      // Connection event with initial state
      if (data.type === 'connected') {
        streamStates.set(sessionId, {
          isActive,
          isStreaming: false,
          streamingMessage: null,
          streamingToolUse: null,
          isIdle: false, // Don't assume idle on connect - wait for explicit session_idle
        })
      }
      // Session-level activity events
      else if (data.type === 'session_active') {
        // New user message - clear idle flag, allow events
        streamStates.set(sessionId, {
          isActive, // Will be true from server
          isStreaming: current?.isStreaming ?? false,
          streamingMessage: current?.streamingMessage ?? null,
          streamingToolUse: current?.streamingToolUse ?? null,
          isIdle: false,
        })
        queryClient.invalidateQueries({ queryKey: ['sessions'] })
      } else if (data.type === 'session_idle') {
        // Session stopped - set idle flag to ignore stale events
        streamStates.set(sessionId, {
          isActive: false, // Force false, don't trust payload for idle
          isStreaming: false,
          streamingMessage: null,
          streamingToolUse: null,
          isIdle: true,
        })
        queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
        queryClient.invalidateQueries({ queryKey: ['sessions'] })
      }
      // Streaming events - update state, preserve isIdle
      else if (data.type === 'stream_start') {
        streamStates.set(sessionId, {
          isActive,
          isStreaming: true,
          streamingMessage: '',
          streamingToolUse: null,
          isIdle: current?.isIdle ?? false,
        })
      } else if (data.type === 'stream_delta') {
        streamStates.set(sessionId, {
          isActive,
          isStreaming: true,
          streamingMessage: (current?.streamingMessage || '') + data.text,
          streamingToolUse: null,
          isIdle: current?.isIdle ?? false,
        })
      } else if (data.type === 'tool_use_start' || data.type === 'tool_use_streaming') {
        streamStates.set(sessionId, {
          isActive,
          isStreaming: true,
          streamingMessage: current?.streamingMessage ?? null,
          streamingToolUse: {
            id: data.toolId,
            name: data.toolName,
            partialInput: data.partialInput ?? '',
          },
          isIdle: current?.isIdle ?? false,
        })
      } else if (data.type === 'tool_use_ready') {
        streamStates.set(sessionId, {
          isActive,
          isStreaming: false,
          streamingMessage: current?.streamingMessage ?? null,
          streamingToolUse: null,
          isIdle: current?.isIdle ?? false,
        })
      } else if (data.type === 'stream_end') {
        streamStates.set(sessionId, {
          isActive,
          isStreaming: false,
          streamingMessage: null,
          streamingToolUse: null,
          isIdle: current?.isIdle ?? false,
        })
      }
      // Data events (refresh messages) - still update isActive
      else if (data.type === 'tool_call' || data.type === 'tool_result') {
        if (current) {
          streamStates.set(sessionId, { ...current, isActive })
        }
        queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
      }
      // Handle ping or unknown events - still update isActive if we have state
      else if (current && data.isActive !== undefined) {
        streamStates.set(sessionId, { ...current, isActive })
      }

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

function releaseEventSource(sessionId: string): void {
  const count = (refCounts.get(sessionId) || 1) - 1
  refCounts.set(sessionId, count)

  if (count <= 0) {
    const es = eventSources.get(sessionId)
    if (es) {
      es.close()
      eventSources.delete(sessionId)
    }
    refCounts.delete(sessionId)
  }
}

export function useMessageStream(sessionId: string | null) {
  const [state, setState] = useState<StreamState>({
    isActive: false,
    isStreaming: false,
    streamingMessage: null,
    streamingToolUse: null,
    isIdle: false, // Only true AFTER receiving session_idle
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
    if (!sessionId) return

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
        isIdle: false, // Only true AFTER receiving session_idle
      })
    }
    updateState()

    // Get or create singleton EventSource for this session
    getOrCreateEventSource(sessionId, queryClient)

    return () => {
      listeners?.delete(updateState)
      if (listeners?.size === 0) {
        streamListeners.delete(sessionId)
      }
      releaseEventSource(sessionId)
    }
  }, [sessionId, updateState, queryClient])

  return state
}
