'use client'

import { useState, useEffect, useCallback } from 'react'
import { useQueryClient, QueryClient } from '@tanstack/react-query'

interface StreamState {
  isStreaming: boolean
  streamingMessage: string | null
  streamingToolUse: { id: string; name: string } | null
  pendingToolCalls: Set<string>
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

      if (data.type === 'stream_start') {
        const current = streamStates.get(sessionId)
        streamStates.set(sessionId, {
          isStreaming: true,
          streamingMessage: '',
          streamingToolUse: null,
          pendingToolCalls: current?.pendingToolCalls || new Set(),
        })
        queryClient.invalidateQueries({ queryKey: ['sessions'] })
      } else if (data.type === 'stream_delta') {
        const current = streamStates.get(sessionId)
        if (current) {
          streamStates.set(sessionId, {
            ...current,
            isStreaming: true,
            streamingMessage: (current.streamingMessage || '') + data.text,
            streamingToolUse: null, // Clear tool use when we get text
          })
        }
      } else if (data.type === 'tool_use_start' || data.type === 'tool_use_streaming') {
        const current = streamStates.get(sessionId)
        if (current) {
          streamStates.set(sessionId, {
            ...current,
            isStreaming: true,
            streamingToolUse: { id: data.toolId, name: data.toolName },
          })
        }
      } else if (data.type === 'tool_use_ready') {
        const current = streamStates.get(sessionId)
        if (current) {
          streamStates.set(sessionId, {
            ...current,
            streamingToolUse: null,
          })
        }
      } else if (data.type === 'stream_end' || data.type === 'stream_interrupted') {
        const current = streamStates.get(sessionId)
        streamStates.set(sessionId, {
          isStreaming: false,
          streamingMessage: null,
          streamingToolUse: null,
          pendingToolCalls: current?.pendingToolCalls || new Set(),
        })
        queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
        queryClient.invalidateQueries({ queryKey: ['sessions'] })
      } else if (data.type === 'tool_call') {
        // Track pending tool call
        const current = streamStates.get(sessionId)
        if (current && data.toolCall?.id) {
          current.pendingToolCalls.add(data.toolCall.id)
          streamStates.set(sessionId, { ...current })
        }
        queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
      } else if (data.type === 'tool_result') {
        // Remove from pending tool calls
        const current = streamStates.get(sessionId)
        if (current && data.toolUseId) {
          current.pendingToolCalls.delete(data.toolUseId)
          streamStates.set(sessionId, { ...current })
        }
        queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
      }

      // Notify all listeners
      streamListeners.get(sessionId)?.forEach((listener) => listener())
    } catch (error) {
      console.error('Failed to parse SSE message:', error)
    }
  }

  es.onerror = () => {
    streamStates.set(sessionId, {
      isStreaming: false,
      streamingMessage: null,
      streamingToolUse: null,
      pendingToolCalls: new Set(),
    })
    streamListeners.get(sessionId)?.forEach((listener) => listener())
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
    isStreaming: false,
    streamingMessage: null,
    streamingToolUse: null,
    pendingToolCalls: new Set(),
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
        isStreaming: false,
        streamingMessage: null,
        streamingToolUse: null,
        pendingToolCalls: new Set(),
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

  // Session is "active" if streaming OR waiting for tool results
  const isActive = state.isStreaming || state.pendingToolCalls.size > 0

  return {
    ...state,
    isActive,
  }
}
