'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'

interface StreamState {
  isStreaming: boolean
  streamingMessage: string | null
}

// Global state to track streaming per session
const streamStates = new Map<string, StreamState>()
const streamListeners = new Map<string, Set<() => void>>()

export function useMessageStream(sessionId: string | null) {
  const [state, setState] = useState<StreamState>({
    isStreaming: false,
    streamingMessage: null,
  })
  const queryClient = useQueryClient()
  const eventSourceRef = useRef<EventSource | null>(null)

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
      streamStates.set(sessionId, { isStreaming: false, streamingMessage: null })
    }
    updateState()

    // Connect to SSE stream
    const eventSource = new EventSource(`/api/sessions/${sessionId}/stream`)
    eventSourceRef.current = eventSource

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)

        if (data.type === 'stream_start') {
          streamStates.set(sessionId, { isStreaming: true, streamingMessage: '' })
          // Invalidate sessions to update isActive status
          queryClient.invalidateQueries({ queryKey: ['sessions'] })
        } else if (data.type === 'stream_delta') {
          const current = streamStates.get(sessionId)
          if (current) {
            streamStates.set(sessionId, {
              isStreaming: true,
              streamingMessage: (current.streamingMessage || '') + data.text,
            })
          }
        } else if (data.type === 'stream_end') {
          streamStates.set(sessionId, { isStreaming: false, streamingMessage: null })
          // Invalidate messages query to fetch the complete message
          queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
          // Invalidate sessions to update isActive status
          queryClient.invalidateQueries({ queryKey: ['sessions'] })
        } else if (data.type === 'tool_call' || data.type === 'tool_result') {
          // Invalidate messages to show tool call updates
          queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
        }

        // Notify all listeners
        streamListeners.get(sessionId)?.forEach((listener) => listener())
      } catch (error) {
        console.error('Failed to parse SSE message:', error)
      }
    }

    eventSource.onerror = () => {
      // Connection lost, reset streaming state
      streamStates.set(sessionId, { isStreaming: false, streamingMessage: null })
      streamListeners.get(sessionId)?.forEach((listener) => listener())
    }

    return () => {
      listeners?.delete(updateState)
      if (listeners?.size === 0) {
        streamListeners.delete(sessionId)
      }
      eventSource.close()
      eventSourceRef.current = null
    }
  }, [sessionId, updateState, queryClient])

  return state
}
