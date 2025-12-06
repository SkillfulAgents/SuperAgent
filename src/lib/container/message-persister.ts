import { db } from '@/lib/db'
import { messages, sessions, toolCalls } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { v4 as uuidv4 } from 'uuid'
import type { ContainerClient, StreamMessage } from './types'

// Tracks streaming state for SSE broadcasts
interface StreamingState {
  currentText: string
  isStreaming: boolean
  currentToolUse: { id: string; name: string } | null
  isActive: boolean // True from user message until result received
}

class MessagePersister {
  private streamingStates: Map<string, StreamingState> = new Map()
  private subscriptions: Map<string, () => void> = new Map()
  private sseClients: Map<string, Set<(data: any) => void>> = new Map()

  // Subscribe to a session's messages and persist them
  subscribeToSession(
    sessionId: string,
    client: ContainerClient,
    containerSessionId: string
  ): void {
    // Unsubscribe if already subscribed
    this.unsubscribeFromSession(sessionId)

    // Initialize state
    this.streamingStates.set(sessionId, {
      currentText: '',
      isStreaming: false,
      currentToolUse: null,
      isActive: false,
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
  markSessionInterrupted(sessionId: string): void {
    const state = this.streamingStates.get(sessionId)
    if (state) {
      state.isStreaming = false
      state.isActive = false
      state.currentText = ''
      state.currentToolUse = null
    }
    this.broadcastToSSE(sessionId, { type: 'session_idle' })
  }

  // Add SSE client for real-time updates
  addSSEClient(sessionId: string, callback: (data: any) => void): () => void {
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

  // Broadcast to SSE clients
  private broadcastToSSE(sessionId: string, data: any): void {
    const clients = this.sseClients.get(sessionId)
    console.log(`[SSE] Broadcasting to session ${sessionId}:`, data.type, `(${clients?.size ?? 0} clients)`)
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
  private async handleMessage(
    sessionId: string,
    message: StreamMessage
  ): Promise<void> {
    const state = this.streamingStates.get(sessionId)
    if (!state) return

    const content = message.content

    switch (content.type) {
      case 'assistant':
        // Complete assistant message - save/update in DB
        await this.upsertAssistantMessage(sessionId, content)
        break

      case 'user':
        // Tool results come as 'user' type messages
        await this.handleToolResults(sessionId, content)
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
        this.broadcastToSSE(sessionId, { type: 'session_idle' })
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
    event: any,
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
            id: event.content_block.id,
            name: event.content_block.name,
          }
          this.broadcastToSSE(sessionId, {
            type: 'tool_use_start',
            toolId: event.content_block.id,
            toolName: event.content_block.name,
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
          // Tool input is being streamed - broadcast to keep UI alive
          this.broadcastToSSE(sessionId, {
            type: 'tool_use_streaming',
            toolId: state.currentToolUse?.id,
            toolName: state.currentToolUse?.name,
          })
        }
        break

      case 'content_block_stop':
        // Tool use block finished streaming
        if (state.currentToolUse) {
          this.broadcastToSSE(sessionId, {
            type: 'tool_use_ready',
            toolId: state.currentToolUse.id,
            toolName: state.currentToolUse.name,
          })
          state.currentToolUse = null
        }
        break

      case 'message_stop':
        // Don't save here - wait for the complete 'assistant' message
        state.isStreaming = false
        state.currentToolUse = null
        break
    }
  }

  // Handle tool results - update the corresponding tool call with its result
  private async handleToolResults(
    sessionId: string,
    content: any
  ): Promise<void> {
    try {
      const messageContent = content.message?.content || []

      for (const block of messageContent) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          // Update the tool call record with the result
          await db
            .update(toolCalls)
            .set({
              result: block.content,
              isError: block.is_error || false,
            })
            .where(eq(toolCalls.id, block.tool_use_id))

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

  // Upsert assistant message - insert if new, merge if exists
  private async upsertAssistantMessage(
    sessionId: string,
    content: any
  ): Promise<void> {
    try {
      const claudeMessageId = content.message?.id
      if (!claudeMessageId) {
        console.warn('Assistant message without ID, skipping')
        return
      }

      // Extract content from this message
      const messageContent = content.message?.content || []
      let newText = ''
      const newToolCalls: { id: string; name: string; input: any }[] = []

      for (const block of messageContent) {
        if (block.type === 'text' && block.text) {
          newText = block.text
        } else if (block.type === 'tool_use') {
          newToolCalls.push({
            id: block.id,
            name: block.name,
            input: block.input,
          })
        }
      }

      // Check if message already exists
      const existing = await db
        .select()
        .from(messages)
        .where(eq(messages.id, claudeMessageId))
        .limit(1)

      if (existing.length > 0) {
        // Update existing message - merge text if needed
        const existingContent = existing[0].content as { text: string }
        const mergedText = existingContent.text || newText

        if (mergedText !== existingContent.text) {
          await db
            .update(messages)
            .set({ content: { text: mergedText } })
            .where(eq(messages.id, claudeMessageId))
        }
      } else {
        // Insert new message using Claude's message ID
        await db.insert(messages).values({
          id: claudeMessageId,
          sessionId,
          type: 'assistant',
          content: { text: newText },
          createdAt: new Date(),
        })
      }

      // Insert tool calls into separate table (if any)
      for (const tc of newToolCalls) {
        // Check if tool call already exists
        const existingTc = await db
          .select()
          .from(toolCalls)
          .where(eq(toolCalls.id, tc.id))
          .limit(1)

        if (existingTc.length === 0) {
          await db.insert(toolCalls).values({
            id: tc.id,
            messageId: claudeMessageId,
            name: tc.name,
            input: tc.input,
            createdAt: new Date(),
          })

          // Broadcast new tool call to SSE clients
          this.broadcastToSSE(sessionId, {
            type: 'tool_call',
            toolCall: {
              id: tc.id,
              messageId: claudeMessageId,
              name: tc.name,
              input: tc.input,
            },
          })
        }
      }

      // Update session last activity
      await db
        .update(sessions)
        .set({ lastActivityAt: new Date() })
        .where(eq(sessions.id, sessionId))

      // Note: We no longer broadcast stream_end here.
      // Session activity is tracked via session_active/session_idle events.
    } catch (error) {
      console.error('Failed to upsert assistant message:', error)
    }
  }

  // Save user message to database and mark session as active
  async saveUserMessage(sessionId: string, text: string): Promise<void> {
    try {
      await db.insert(messages).values({
        id: uuidv4(), // User messages still use UUID since they don't have a Claude ID
        sessionId,
        type: 'user',
        content: { text },
        createdAt: new Date(),
      })

      // Update session last activity
      await db
        .update(sessions)
        .set({ lastActivityAt: new Date() })
        .where(eq(sessions.id, sessionId))

      // Mark session as active - user sent a message, agent will respond
      let state = this.streamingStates.get(sessionId)
      if (!state) {
        state = {
          currentText: '',
          isStreaming: false,
          currentToolUse: null,
          isActive: false,
        }
        this.streamingStates.set(sessionId, state)
      }
      state.isActive = true
      this.broadcastToSSE(sessionId, { type: 'session_active' })
    } catch (error) {
      console.error('Failed to save user message:', error)
    }
  }
}

// Export singleton instance
export const messagePersister = new MessagePersister()
