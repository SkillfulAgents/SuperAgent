'use client'

import { useState, useEffect, useCallback } from 'react'
import { useQueryClient, QueryClient } from '@tanstack/react-query'

interface StreamState {
  isStreaming: boolean
  streamingMessage: string | null
  streamingToolUse: { id: string; name: string } | null
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
        streamStates.set(sessionId, {
          isStreaming: true,
          streamingMessage: '',
          streamingToolUse: null,
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
        streamStates.set(sessionId, {
          isStreaming: false,
          streamingMessage: null,
          streamingToolUse: null,
        })
        queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
        queryClient.invalidateQueries({ queryKey: ['sessions'] })
      } else if (data.type === 'tool_call' || data.type === 'tool_result') {
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
