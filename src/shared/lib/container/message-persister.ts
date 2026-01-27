import type { ContainerClient, StreamMessage } from './types'
import { createScheduledTask } from '@shared/lib/services/scheduled-task-service'

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
  agentSlug?: string // The agent slug for this session
}

class MessagePersister {
  private streamingStates: Map<string, StreamingState> = new Map()
  private subscriptions: Map<string, () => void> = new Map()
  private sseClients: Map<string, Set<(data: unknown) => void>> = new Map()

  // Subscribe to a session's messages for SSE streaming
  subscribeToSession(
    sessionId: string,
    client: ContainerClient,
    containerSessionId: string,
    agentSlug?: string
  ): void {
    // Unsubscribe if already subscribed
    this.unsubscribeFromSession(sessionId)

    // Initialize state
    this.streamingStates.set(sessionId, {
      currentText: '',
      isStreaming: false,
      currentToolUse: null,
      currentToolInput: '',
      isActive: false,
      isInterrupted: false,
      agentSlug,
    })

    // Subscribe to the container's message stream
    const unsubscribe = client.subscribeToStream(
      containerSessionId,
      (message) => this.handleMessage(sessionId, message)
    )

    this.subscriptions.set(sessionId, unsubscribe)
  }

  // Unsubscribe from a session
  unsubscribeFromSession(sessionId: string): void {
    const unsubscribe = this.subscriptions.get(sessionId)
    if (unsubscribe) {
      unsubscribe()
      this.subscriptions.delete(sessionId)
    }
    this.streamingStates.delete(sessionId)
  }

  // Check if a session is currently active (processing user request)
  isSessionActive(sessionId: string): boolean {
    const state = this.streamingStates.get(sessionId)
    return state?.isActive ?? false
  }

  // Check if a session has an active subscription
  isSubscribed(sessionId: string): boolean {
    return this.subscriptions.has(sessionId)
  }

  // Mark a session as interrupted (not active)
  async markSessionInterrupted(sessionId: string): Promise<void> {
    const state = this.streamingStates.get(sessionId)

    // Set interrupted flag FIRST to prevent race conditions with incoming events
    if (state) {
      state.isInterrupted = true
      state.isStreaming = false
      state.isActive = false
      state.currentText = ''
      state.currentToolUse = null
      state.currentToolInput = ''
    }

    // Broadcast immediately to update UI
    this.broadcastToSSE(sessionId, { type: 'session_idle', isActive: false })
  }

  // Add SSE client for real-time updates
  addSSEClient(sessionId: string, callback: (data: unknown) => void): () => void {
    let clients = this.sseClients.get(sessionId)
    if (!clients) {
      clients = new Set()
      this.sseClients.set(sessionId, clients)
    }
    clients.add(callback)
    console.log(`[SSE] Client added for session ${sessionId}, total: ${clients.size}`)

    return () => {
      clients?.delete(callback)
      console.log(`[SSE] Client removed for session ${sessionId}, remaining: ${clients?.size ?? 0}`)
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
        agentSlug,
      }
      this.streamingStates.set(sessionId, state)
    }
    state.isActive = true
    state.isInterrupted = false // Reset interrupted flag on new message
    if (agentSlug) {
      state.agentSlug = agentSlug
    }
    this.broadcastToSSE(sessionId, { type: 'session_active', isActive: true })
  }

  // Broadcast to SSE clients
  private broadcastToSSE(sessionId: string, data: unknown): void {
    const clients = this.sseClients.get(sessionId)
    console.log(`[SSE] Broadcasting to session ${sessionId}:`, (data as { type?: string }).type, `(${clients?.size ?? 0} clients)`)
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
    const state = this.streamingStates.get(sessionId)
    if (!state) return

    // Skip processing if session was interrupted (prevents race conditions)
    // Allow 'result' through as it indicates the container actually stopped
    if (state.isInterrupted && message.content?.type !== 'result') {
      return
    }

    const content = message.content

    switch (content.type) {
      case 'assistant':
        // Complete assistant message - JSONL is the source of truth
        // Clear currentText since the message is now persisted
        state.currentText = ''
        // Broadcast refresh event so frontend can refetch
        this.broadcastToSSE(sessionId, { type: 'messages_updated' })
        break

      case 'user':
        // Tool results come as 'user' type messages
        this.handleToolResults(sessionId, content)
        break

      case 'system':
        // System messages (init, etc.)
        if (content.subtype === 'init') {
          this.broadcastToSSE(sessionId, { type: 'stream_start' })
        }
        break

      case 'result':
        // Query completed - session is no longer active
        state.isStreaming = false
        state.isActive = false
        state.currentText = ''

        // Check if this is an error result
        if (content.subtype === 'error_during_execution' || content.subtype === 'error') {
          const errorMessage = content.error || content.message || 'An error occurred during execution'
          console.error(`[MessagePersister] Session ${sessionId} error:`, errorMessage)
          this.broadcastToSSE(sessionId, {
            type: 'session_error',
            error: errorMessage,
            isActive: false
          })
        } else {
          this.broadcastToSSE(sessionId, { type: 'session_idle', isActive: false })
        }
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

  // Handle stream events for SSE broadcasting (not for persistence)
  private handleStreamEvent(
    sessionId: string,
    event: { type: string; content_block?: { type: string; id?: string; name?: string }; delta?: { type: string; text?: string; partial_json?: string } },
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

          this.broadcastToSSE(sessionId, {
            type: 'tool_use_ready',
            toolId: state.currentToolUse.id,
            toolName: state.currentToolUse.name,
          })
          state.currentToolUse = null
          state.currentToolInput = ''
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
      let input: { secretName: string; reason?: string } = { secretName: '' }
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

      console.log(
        '[MessagePersister] Broadcasting secret_request:',
        toolUseId,
        input.secretName,
        'for agent:',
        agentSlug
      )

      // Broadcast the secret request event to SSE clients
      this.broadcastToSSE(sessionId, {
        type: 'secret_request',
        toolUseId,
        secretName: input.secretName,
        reason: input.reason,
        agentSlug,
      })
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
      let input: { toolkit: string; reason?: string } = { toolkit: '' }
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

      console.log(
        '[MessagePersister] Broadcasting connected_account_request:',
        toolUseId,
        input.toolkit,
        'for agent:',
        agentSlug
      )

      // Broadcast the connected account request event to SSE clients
      this.broadcastToSSE(sessionId, {
        type: 'connected_account_request',
        toolUseId,
        toolkit: input.toolkit.toLowerCase(),
        reason: input.reason,
        agentSlug,
      })
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

        console.log(
          '[MessagePersister] Creating scheduled task:',
          input.scheduleType,
          input.scheduleExpression,
          'for agent:',
          agentSlug
        )

        // Create the scheduled task in the database
        const taskId = await createScheduledTask({
          agentSlug,
          scheduleType: input.scheduleType,
          scheduleExpression: input.scheduleExpression,
          prompt: input.prompt,
          name: input.name,
          createdBySessionId: sessionId,
        })

        console.log('[MessagePersister] Scheduled task created:', taskId)

        // Broadcast the scheduled task created event to SSE clients
        this.broadcastToSSE(sessionId, {
          type: 'scheduled_task_created',
          toolUseId,
          taskId,
          scheduleType: input.scheduleType,
          scheduleExpression: input.scheduleExpression,
          name: input.name,
          agentSlug,
        })
      } catch (error) {
        console.error('[MessagePersister] Error handling schedule task:', error)
      }
    })()
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
