import type { ContainerClient, StreamMessage, SlashCommandInfo } from './types'
import type { SessionUsage } from '@shared/lib/types/agent'
import { createScheduledTask } from '@shared/lib/services/scheduled-task-service'
import { resolveTimezoneForAgent } from '@shared/lib/services/timezone-resolver'
import { updateSessionMetadata } from '@shared/lib/services/session-service'
import { notificationManager } from '@shared/lib/notifications/notification-manager'
import { trackServerEvent } from '@shared/lib/analytics/server-analytics'
import { getAgentSessionsDir } from '@shared/lib/utils/file-storage'
import * as path from 'path'
import { promises as fsPromises } from 'fs'

// Per-subagent streaming state (supports multiple concurrent background agents)
interface SubagentStreamingState {
  agentId: string | null
  currentText: string
  currentToolUse: { id: string; name: string } | null
  currentToolInput: string
  isBackground: boolean // True for run_in_background agents — completion comes via sidechain 'result', not tool_result
}

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
  isCompacting: boolean // True after compact_boundary, cleared on next user message (compact summary)
  agentSlug?: string // The agent slug for this session
  lastContextWindow: number // Last known context window size (default 200k)
  lastAssistantUsage: SessionUsage | null // Per-call usage from most recent assistant message
  completedSubagentIds: Set<string> // agentIds of subagents that have completed (to avoid re-discovery)
  // Per-subagent streaming state, keyed by parent tool_use ID (supports concurrent background agents)
  activeSubagents: Map<string, SubagentStreamingState>
  slashCommands: SlashCommandInfo[] // Available slash commands from SDK
}

class MessagePersister {
  private streamingStates: Map<string, StreamingState> = new Map()
  private subscriptions: Map<string, () => void> = new Map()
  private sseClients: Map<string, Set<(data: unknown) => void>> = new Map()
  // Global notification subscribers (e.g., Electron main process)
  private globalNotificationClients: Set<(data: unknown) => void> = new Set()
  // Track container clients per session for reconnection
  private containerClients: Map<string, ContainerClient> = new Map()
  // Callback to request stopping a container (registered by container-manager)
  private onStopContainerRequested: ((agentSlug: string) => void) | null = null

  // Subscribe to a session's messages for SSE streaming.
  // Returns a promise that resolves when the WebSocket connection is ready.
  async subscribeToSession(
    sessionId: string,
    client: ContainerClient,
    containerSessionId: string,
    agentSlug?: string
  ): Promise<void> {
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
      isCompacting: false,
      agentSlug,
      lastContextWindow: 200_000,
      lastAssistantUsage: null,
      completedSubagentIds: new Set(),
      activeSubagents: new Map(),
      slashCommands: [],
    })

    // Store container client for reconnection checks
    this.containerClients.set(sessionId, client)

    // Subscribe to the container's message stream
    const { unsubscribe, ready } = client.subscribeToStream(
      containerSessionId,
      (message) => this.handleMessage(sessionId, message)
    )

    this.subscriptions.set(sessionId, unsubscribe)

    // Wait for the WebSocket connection to be established
    await ready
  }

  // Unsubscribe from a session
  unsubscribeFromSession(sessionId: string): void {
    const unsubscribe = this.subscriptions.get(sessionId)
    if (unsubscribe) {
      unsubscribe()
      this.subscriptions.delete(sessionId)
    }
    this.streamingStates.delete(sessionId)
    this.containerClients.delete(sessionId)
  }

  // Check if a session is currently active (processing user request)
  isSessionActive(sessionId: string): boolean {
    const state = this.streamingStates.get(sessionId)
    return state?.isActive ?? false
  }

  // Get available slash commands for a session
  getSlashCommands(sessionId: string): SlashCommandInfo[] {
    return this.streamingStates.get(sessionId)?.slashCommands ?? []
  }

  // Set slash commands for a session (from container session creation response)
  setSlashCommands(sessionId: string, commands: SlashCommandInfo[]): void {
    const state = this.streamingStates.get(sessionId)
    if (state) {
      state.slashCommands = commands
    }
  }

  // Check if a session has an active subscription
  isSubscribed(sessionId: string): boolean {
    return this.subscriptions.has(sessionId)
  }

  // Check if any session for a given agent is currently active (processing)
  hasActiveSessionsForAgent(agentSlug: string): boolean {
    for (const [, state] of this.streamingStates) {
      if (state.agentSlug === agentSlug && state.isActive) {
        return true
      }
    }
    return false
  }

  // Mark all sessions for an agent as inactive and clean up subscriptions (e.g., when container stops)
  markAllSessionsInactiveForAgent(agentSlug: string): void {
    for (const [sessionId, state] of this.streamingStates) {
      if (state.agentSlug === agentSlug) {
        if (state.isActive) {
          console.log(`[MessagePersister] Marking session ${sessionId} inactive (container stopped)`)
          this.markSessionInactive(sessionId, state)
        }
        // Clean up stale WebSocket subscription so next message re-subscribes to the new container
        const unsubscribe = this.subscriptions.get(sessionId)
        if (unsubscribe) {
          unsubscribe()
          this.subscriptions.delete(sessionId)
        }
        this.containerClients.delete(sessionId)
      }
    }
  }

  // Check if a session has active SSE clients (someone is viewing it)
  hasActiveViewers(sessionId: string): boolean {
    const clients = this.sseClients.get(sessionId)
    return (clients?.size ?? 0) > 0
  }

  // Broadcast to global notification clients only (e.g., sidebar updates, Electron main process)
  // Does NOT broadcast to session-specific SSE clients — use broadcastToSSE for that.
  broadcastGlobal(data: unknown): void {
    for (const client of this.globalNotificationClients) {
      try {
        client(data)
      } catch (error) {
        console.error('[SSE] Error sending to global notification client:', error)
      }
    }
  }

  // Add a global notification subscriber (receives all os_notification events)
  addGlobalNotificationClient(callback: (data: unknown) => void): () => void {
    this.globalNotificationClients.add(callback)

    // Return unsubscribe function
    return () => {
      this.globalNotificationClients.delete(callback)
    }
  }

  // Register callback for when a container should be stopped (e.g., on OOM)
  setStopContainerCallback(callback: (agentSlug: string) => void): void {
    this.onStopContainerRequested = callback
  }

  // Check if there are any session-specific SSE clients connected
  hasAnySessionClients(): boolean {
    return this.sseClients.size > 0
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
      state.activeSubagents.clear()
    }

    // Broadcast to session-specific clients
    this.broadcastToSSE(sessionId, { type: 'session_idle', isActive: false })

    // Also broadcast globally so sidebar updates regardless of which session is being viewed
    const agentSlug = state?.agentSlug
    if (agentSlug) {
      this.broadcastGlobal({
        type: 'session_idle',
        sessionId,
        agentSlug,
        isActive: false,
      })
    }
  }

  // Add SSE client for real-time updates
  addSSEClient(sessionId: string, callback: (data: unknown) => void): () => void {
    let clients = this.sseClients.get(sessionId)
    if (!clients) {
      clients = new Set()
      this.sseClients.set(sessionId, clients)
    }
    clients.add(callback)

    return () => {
      clients?.delete(callback)
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
        isCompacting: false,
        agentSlug,
        lastContextWindow: 200_000,
        lastAssistantUsage: null,
        completedSubagentIds: new Set(),
        activeSubagents: new Map(),
        slashCommands: [],
      }
      this.streamingStates.set(sessionId, state)
    }
    state.isActive = true
    state.isInterrupted = false // Reset interrupted flag on new message
    if (agentSlug) {
      state.agentSlug = agentSlug
    }

    // Broadcast to session-specific clients
    this.broadcastToSSE(sessionId, { type: 'session_active', isActive: true })

    // Also broadcast globally so sidebar updates regardless of which session is being viewed
    this.broadcastGlobal({
      type: 'session_active',
      sessionId,
      agentSlug: state.agentSlug,
      isActive: true,
    })
  }

  // Broadcast to SSE clients
  private broadcastToSSE(sessionId: string, data: unknown): void {
    const clients = this.sseClients.get(sessionId)
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

    // Filter sidechain (subagent) messages — they should not affect main streaming state
    // SDK emitted format uses parent_tool_use_id (non-null for subagent messages)
    if (content.parent_tool_use_id != null) {
      this.handleSidechainMessage(sessionId, content, state)
      return
    }

    switch (content.type) {
      case 'assistant': {
        // Complete assistant message - JSONL is the source of truth
        // Clear currentText since the message is now persisted
        state.currentText = ''
        // Broadcast refresh event so frontend can refetch
        this.broadcastToSSE(sessionId, { type: 'messages_updated' })
        // Broadcast context usage from the assistant message's usage field
        const assistantUsage = content.message?.usage
        if (assistantUsage) {
          this.broadcastContextUsage(sessionId, state, assistantUsage)
        }
        break
      }

      case 'user':
        // Detect subagent completion: check if this user message contains tool_results
        // for any active subagent tool calls (meaning the subagent finished and returned its result)
        if (state.activeSubagents.size > 0) {
          const messageContent = content.message?.content
          if (Array.isArray(messageContent)) {
            for (const block of messageContent) {
              if (block.type === 'tool_result' && state.activeSubagents.has(block.tool_use_id)) {
                const sub = state.activeSubagents.get(block.tool_use_id)!

                // Extract agentId from tool result before broadcasting completion.
                // Try SDK tool_use_result metadata first, then parse from content text.
                if (!sub.agentId) {
                  const toolUseResult = content.tool_use_result as Record<string, unknown> | undefined
                  if (toolUseResult?.agentId && typeof toolUseResult.agentId === 'string') {
                    sub.agentId = toolUseResult.agentId
                  } else {
                    // Parse agentId from the tool result text (SDK includes "agentId: <hex>")
                    const parts = Array.isArray(block.content) ? block.content : []
                    for (const part of parts) {
                      if (part?.type === 'text' && typeof part.text === 'string') {
                        const match = part.text.match(/\bagentId:\s*([a-f0-9]+)\b/)
                        if (match) {
                          sub.agentId = match[1]
                          break
                        }
                      }
                    }
                  }
                }

                // Background agents get an immediate "async_launched" tool_result that is NOT
                // the real completion — their actual completion comes via sidechain 'result'.
                if (!sub.isBackground) {
                  this.handleSubagentCompletion(sessionId, state, block.tool_use_id)
                }
              }
            }
          }
        }

        // After a compact_boundary, the next user message is always the compact summary.
        // Use position-based detection (state.isCompacting flag) as primary check,
        // with content.isCompactSummary as fallback, since the WebSocket payload
        // may not always carry the isCompactSummary metadata flag.
        if (state.isCompacting || content.isCompactSummary) {
          state.isCompacting = false
          // Compaction complete — broadcast so frontend transitions from spinner to boundary
          this.broadcastToSSE(sessionId, { type: 'compact_complete' })
          this.broadcastToSSE(sessionId, { type: 'messages_updated' })
          break
        }
        // Tool results come as 'user' type messages
        this.handleToolResults(sessionId, content)
        break

      case 'system':
        // System messages (init, etc.)
        if (content.subtype === 'init') {
          // Capture slash commands from init event as fallback (e.g. resumed sessions)
          if (state.slashCommands.length === 0 && Array.isArray(content.slash_commands)) {
            state.slashCommands = content.slash_commands.map((name: string) => ({
              name,
              description: '',
              argumentHint: '',
            }))
          }
          this.broadcastToSSE(sessionId, {
            type: 'stream_start',
            slashCommands: state.slashCommands.length > 0 ? state.slashCommands : undefined,
          })
        } else if (content.subtype === 'compact_boundary') {
          // Compaction has started — set flag so we recognize the next user message as compact summary
          state.isCompacting = true
          this.broadcastToSSE(sessionId, { type: 'compact_start' })
        }
        break

      case 'result': {
        // Query completed - session is no longer active
        state.isStreaming = false
        state.isActive = false
        state.currentText = ''

        // Extract and persist context usage from result event
        this.handleResultUsage(sessionId, state, content)

        // Check if this is an error result
        if (content.subtype === 'error_during_execution' || content.subtype === 'error') {
          const errorMessage = content.error || content.message || 'An error occurred during execution'
          console.error(`[MessagePersister] Session ${sessionId} error:`, errorMessage)
          this.broadcastToSSE(sessionId, {
            type: 'session_error',
            error: errorMessage,
            isActive: false
          })
          // Also broadcast globally
          this.broadcastGlobal({
            type: 'session_error',
            sessionId,
            agentSlug: state.agentSlug,
            error: errorMessage,
            isActive: false,
          })
          // If the error is fatal (e.g., OOM), request container stop
          if (content.fatal && state.agentSlug && this.onStopContainerRequested) {
            console.log(`[MessagePersister] Fatal error for agent ${state.agentSlug}, requesting container stop`)
            this.onStopContainerRequested(state.agentSlug)
          }
        } else {
          this.broadcastToSSE(sessionId, { type: 'session_idle', isActive: false })
          // Also broadcast globally so sidebar updates
          this.broadcastGlobal({
            type: 'session_idle',
            sessionId,
            agentSlug: state.agentSlug,
            isActive: false,
          })
          // Trigger session complete notification (only if no one is viewing the session)
          if (state.agentSlug && !this.hasActiveViewers(sessionId)) {
            notificationManager.triggerSessionComplete(sessionId, state.agentSlug).catch((err) => {
              console.error('[MessagePersister] Failed to trigger session complete notification:', err)
            })
          }
        }
        break
      }

      case 'browser_active':
        // Browser state changed — forward to SSE clients
        this.broadcastToSSE(sessionId, {
          type: 'browser_active',
          active: content.active,
        })
        break

      case 'connection_closed':
        // WebSocket connection to container was lost
        // Check if session is still actually running in the container
        console.log(`[MessagePersister] Connection closed for session ${sessionId}, checking container state`)
        this.handleConnectionClosed(sessionId, state)
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

  // Handle connection closed - check container and mark inactive if session is done
  private handleConnectionClosed(sessionId: string, state: StreamingState): void {
    const client = this.containerClients.get(sessionId)
    if (!client) {
      // No client reference, assume session is done
      this.markSessionInactive(sessionId, state)
      return
    }

    // Check container asynchronously
    client.getSession(sessionId)
      .then((containerSession) => {
        if (!containerSession) {
          // Session doesn't exist in container anymore
          console.log(`[MessagePersister] Session ${sessionId} not found in container, marking inactive`)
          this.markSessionInactive(sessionId, state)
          return
        }

        // Container session exists - check if it's still running
        // The container's getSession returns isRunning in the response
        const isRunning = (containerSession as any).isRunning
        if (isRunning) {
          // Session still running, try to re-subscribe
          console.log(`[MessagePersister] Session ${sessionId} still running, re-subscribing`)
          const { unsubscribe } = client.subscribeToStream(
            sessionId,
            (message) => this.handleMessage(sessionId, message)
          )
          this.subscriptions.set(sessionId, unsubscribe)
        } else {
          // Session finished
          console.log(`[MessagePersister] Session ${sessionId} not running in container, marking inactive`)
          this.markSessionInactive(sessionId, state)
        }
      })
      .catch((error) => {
        // Can't reach container, assume session is done
        console.error(`[MessagePersister] Failed to check container for session ${sessionId}:`, error)
        this.markSessionInactive(sessionId, state)
      })
  }

  // Mark a session as inactive and broadcast the update
  private markSessionInactive(sessionId: string, state: StreamingState): void {
    state.isStreaming = false
    state.isActive = false
    state.currentText = ''
    state.currentToolUse = null
    state.currentToolInput = ''
    state.activeSubagents.clear()
    this.broadcastToSSE(sessionId, { type: 'session_idle', isActive: false })
    this.broadcastGlobal({
      type: 'session_idle',
      sessionId,
      agentSlug: state.agentSlug,
      isActive: false,
    })
  }

  // Handle sidechain (subagent) messages — filter them out of main streaming state
  private handleSidechainMessage(sessionId: string, content: any, state: StreamingState): void {
    const parentToolId = content.parent_tool_use_id as string

    // Look up or create the subagent entry for this parent tool
    let sub = state.activeSubagents.get(parentToolId)
    if (!sub) {
      // Sidechain message arrived before the tool_use was tracked (rare but possible)
      sub = { agentId: null, currentText: '', currentToolUse: null, currentToolInput: '', isBackground: false }
      state.activeSubagents.set(parentToolId, sub)
    }

    // Try to extract agentId directly from the message (available on complete user/assistant messages)
    const messageAgentId = content.agentId as string | undefined
    if (messageAgentId && messageAgentId !== sub.agentId) {
      sub.agentId = messageAgentId
    }

    // Fallback: discover agentIds from the subagent JSONL files using FIFO matching
    if (!sub.agentId && state.agentSlug) {
      this.discoverSubagentIds(sessionId, state).catch(() => {})
    }

    // Route stream events to the subagent stream handler for real-time streaming
    if (content.type === 'stream_event' && content.event) {
      this.handleSubagentStreamEvent(sessionId, content.event, state, parentToolId)
      return
    }
    // Bare events (sometimes come without wrapper, same as main agent)
    if (content.event && content.type !== 'user' && content.type !== 'assistant') {
      this.handleSubagentStreamEvent(sessionId, content.event, state, parentToolId)
      return
    }

    // Sidechain 'result' means the background subagent has finished execution
    if (content.type === 'result') {
      this.handleSubagentCompletion(sessionId, state, parentToolId)
      return
    }

    // Broadcast updates for complete messages (user/assistant).
    // Complete messages have been persisted to the subagent JSONL by the SDK,
    // so the frontend can refetch them via the API endpoint.
    if (content.type === 'user' || content.type === 'assistant') {
      // Clear streaming text since it's now persisted
      if (content.type === 'assistant') {
        sub.currentText = ''
        // Subagent messages arrive as complete messages (not stream events),
        // so detect browser input requests from the finished tool_use blocks.
        const messageContent = content.message?.content
        if (Array.isArray(messageContent)) {
          for (const block of messageContent) {
            if (block.type === 'tool_use' && block.name === 'mcp__user-input__request_browser_input') {
              this.handleBrowserInputRequestTool(
                sessionId,
                block.id,
                JSON.stringify(block.input || {}),
                state.agentSlug
              )
            }
          }
        }
      }
      this.broadcastToSSE(sessionId, {
        type: 'subagent_updated',
        parentToolId,
        agentId: sub.agentId,
      })
    }
  }

  // Discover agentIds for all active subagents using FIFO matching.
  // The SDK executes tool calls in order, so the first registered parentToolId
  // corresponds to the oldest subagent JSONL file (by modification time).
  private async discoverSubagentIds(sessionId: string, state: StreamingState): Promise<void> {
    if (!state.agentSlug) return

    // Collect parentToolIds needing agentIds (Map preserves insertion order = registration order)
    const needingIds: string[] = []
    for (const [parentToolId, sub] of state.activeSubagents) {
      if (!sub.agentId) needingIds.push(parentToolId)
    }
    if (needingIds.length === 0) return

    try {
      const sessionsDir = getAgentSessionsDir(state.agentSlug)
      const subagentsDir = path.join(sessionsDir, sessionId, 'subagents')
      const files = await fsPromises.readdir(subagentsDir)

      // Collect known IDs (completed or already assigned)
      const knownIds = new Set(state.completedSubagentIds)
      for (const [, s] of state.activeSubagents) {
        if (s.agentId) knownIds.add(s.agentId)
      }

      // Find unclaimed files and sort by modification time (oldest first = created first)
      const unclaimed: { id: string; mtimeMs: number }[] = []
      for (const file of files) {
        if (file.startsWith('agent-') && file.endsWith('.jsonl')) {
          const id = file.replace('agent-', '').replace('.jsonl', '')
          if (!knownIds.has(id)) {
            try {
              const fileStat = await fsPromises.stat(path.join(subagentsDir, file))
              unclaimed.push({ id, mtimeMs: fileStat.mtimeMs })
            } catch { /* file may have been removed */ }
          }
        }
      }
      unclaimed.sort((a, b) => a.mtimeMs - b.mtimeMs)

      // FIFO: match oldest unclaimed file → first registered parentToolId, etc.
      const count = Math.min(needingIds.length, unclaimed.length)
      for (let i = 0; i < count; i++) {
        const parentToolId = needingIds[i]
        const sub = state.activeSubagents.get(parentToolId)
        if (sub && !sub.agentId) {
          sub.agentId = unclaimed[i].id
          this.broadcastToSSE(sessionId, {
            type: 'subagent_updated',
            parentToolId,
            agentId: sub.agentId,
          })
        }
      }
    } catch {
      // Directory doesn't exist yet — will retry on next sidechain message
    }
  }

  // Handle subagent completion — broadcast and clear state for a specific parent tool
  private handleSubagentCompletion(sessionId: string, state: StreamingState, parentToolId: string): void {
    const sub = state.activeSubagents.get(parentToolId)
    // If we never discovered the agentId, try one final time before broadcasting
    if (sub && !sub.agentId && state.agentSlug) {
      this.discoverSubagentIds(sessionId, state)
        .finally(() => this.broadcastSubagentCompleted(sessionId, state, parentToolId))
    } else {
      this.broadcastSubagentCompleted(sessionId, state, parentToolId)
    }
  }

  private broadcastSubagentCompleted(sessionId: string, state: StreamingState, parentToolId: string): void {
    const sub = state.activeSubagents.get(parentToolId)
    // Broadcast a final subagent_updated so the frontend refetches subagent messages
    this.broadcastToSSE(sessionId, {
      type: 'subagent_updated',
      parentToolId,
      agentId: sub?.agentId ?? null,
    })
    this.broadcastToSSE(sessionId, {
      type: 'subagent_completed',
      parentToolId,
      agentId: sub?.agentId ?? null,
    })
    // Track completed subagent ID so it won't be re-discovered
    if (sub?.agentId) {
      state.completedSubagentIds.add(sub.agentId)
    }
    state.activeSubagents.delete(parentToolId)
  }

  // Handle subagent stream events — mirrors handleStreamEvent but with subagent_ prefixed SSE events
  private handleSubagentStreamEvent(
    sessionId: string,
    event: { type: string; content_block?: { type: string; id?: string; name?: string }; delta?: { type: string; text?: string; partial_json?: string } },
    state: StreamingState,
    parentToolId: string
  ): void {
    const sub = state.activeSubagents.get(parentToolId)
    if (!sub) return

    switch (event.type) {
      case 'message_start':
        sub.currentText = ''
        sub.currentToolUse = null
        sub.currentToolInput = ''
        this.broadcastToSSE(sessionId, {
          type: 'subagent_stream_start',
          parentToolId,
          agentId: sub.agentId,
        })
        break

      case 'content_block_start':
        if (event.content_block?.type === 'tool_use') {
          sub.currentToolUse = {
            id: event.content_block.id!,
            name: event.content_block.name!,
          }
          sub.currentToolInput = ''
          this.broadcastToSSE(sessionId, {
            type: 'subagent_tool_use_start',
            parentToolId,
            agentId: sub.agentId,
            toolId: event.content_block.id,
            toolName: event.content_block.name,
            partialInput: '',
          })
        }
        break

      case 'content_block_delta':
        if (event.delta?.type === 'text_delta' && event.delta.text) {
          sub.currentText += event.delta.text
          this.broadcastToSSE(sessionId, {
            type: 'subagent_stream_delta',
            parentToolId,
            agentId: sub.agentId,
            text: event.delta.text,
          })
        } else if (event.delta?.type === 'input_json_delta') {
          const partialJson = event.delta.partial_json || ''
          sub.currentToolInput += partialJson
          this.broadcastToSSE(sessionId, {
            type: 'subagent_tool_use_streaming',
            parentToolId,
            agentId: sub.agentId,
            toolId: sub.currentToolUse?.id,
            toolName: sub.currentToolUse?.name,
            partialInput: sub.currentToolInput,
          })
        }
        break

      case 'content_block_stop':
        if (sub.currentToolUse) {
          // Safety net: detect browser input if stream events arrive for subagents
          if (sub.currentToolUse.name === 'mcp__user-input__request_browser_input') {
            this.handleBrowserInputRequestTool(
              sessionId,
              sub.currentToolUse.id,
              sub.currentToolInput,
              state.agentSlug
            )
          }

          this.broadcastToSSE(sessionId, {
            type: 'subagent_tool_use_ready',
            parentToolId,
            agentId: sub.agentId,
            toolId: sub.currentToolUse.id,
            toolName: sub.currentToolUse.name,
          })
          sub.currentToolUse = null
          sub.currentToolInput = ''
        }
        break

      case 'message_stop':
        sub.currentToolUse = null
        sub.currentToolInput = ''
        break
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
          // Track agent-emitted user request blocks
          if (state.currentToolUse.name === 'AskUserQuestion') {
            trackServerEvent('agent_requested_input', { agentSlug: state.agentSlug })
          } else if (state.currentToolUse.name.startsWith('mcp__user-input__')) {
            const action = state.currentToolUse.name.replace('mcp__user-input__', '')
            trackServerEvent(`agent_${action}`, { agentSlug: state.agentSlug })
          }

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

          // Check if this is an AskUserQuestion tool
          if (state.currentToolUse.name === 'AskUserQuestion') {
            this.handleAskUserQuestionTool(
              sessionId,
              state.currentToolUse.id,
              state.currentToolInput,
              state.agentSlug
            )
          }

          // Check if this is a file request tool
          if (state.currentToolUse.name === 'mcp__user-input__request_file') {
            this.handleFileRequestTool(
              sessionId,
              state.currentToolUse.id,
              state.currentToolInput,
              state.agentSlug
            )
          }

          // Check if this is a remote MCP request tool
          if (state.currentToolUse.name === 'mcp__user-input__request_remote_mcp') {
            this.handleRemoteMcpRequestTool(
              sessionId,
              state.currentToolUse.id,
              state.currentToolInput,
              state.agentSlug
            )
          }

          if (state.currentToolUse.name === 'mcp__user-input__request_browser_input') {
            this.handleBrowserInputRequestTool(
              sessionId,
              state.currentToolUse.id,
              state.currentToolInput,
              state.agentSlug
            )
          }

          // Track Task/Agent tool for subagent correlation
          if (state.currentToolUse.name === 'Task' || state.currentToolUse.name === 'Agent') {
            let isBackground = false
            try {
              const parsed = JSON.parse(state.currentToolInput)
              isBackground = !!parsed.run_in_background
            } catch { /* partial or invalid JSON — default to foreground */ }
            state.activeSubagents.set(state.currentToolUse.id, {
              agentId: null,
              currentText: '',
              currentToolUse: null,
              currentToolInput: '',
              isBackground,
            })
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

      // Broadcast the secret request event to SSE clients
      this.broadcastToSSE(sessionId, {
        type: 'secret_request',
        toolUseId,
        secretName: input.secretName,
        reason: input.reason,
        agentSlug,
      })

      // Trigger waiting for input notification (only if no one is viewing the session)
      if (agentSlug && !this.hasActiveViewers(sessionId)) {
        notificationManager.triggerSessionWaitingInput(sessionId, agentSlug, 'secret').catch((err) => {
          console.error('[MessagePersister] Failed to trigger waiting input notification:', err)
        })
      }
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

      // Broadcast the connected account request event to SSE clients
      this.broadcastToSSE(sessionId, {
        type: 'connected_account_request',
        toolUseId,
        toolkit: input.toolkit.toLowerCase(),
        reason: input.reason,
        agentSlug,
      })

      // Trigger waiting for input notification (only if no one is viewing the session)
      if (agentSlug && !this.hasActiveViewers(sessionId)) {
        notificationManager.triggerSessionWaitingInput(sessionId, agentSlug, 'connected_account').catch((err) => {
          console.error('[MessagePersister] Failed to trigger waiting input notification:', err)
        })
      }
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
          timezone?: string
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

        // Resolve timezone: agent tool override > agent owner's timezone
        const timezone = input.timezone || resolveTimezoneForAgent(agentSlug)

        // Create the scheduled task in the database
        const taskId = await createScheduledTask({
          agentSlug,
          scheduleType: input.scheduleType,
          scheduleExpression: input.scheduleExpression,
          prompt: input.prompt,
          name: input.name,
          createdBySessionId: sessionId,
          timezone,
        })

        // Broadcast the scheduled task created event to session-specific SSE clients
        this.broadcastToSSE(sessionId, {
          type: 'scheduled_task_created',
          toolUseId,
          taskId,
          scheduleType: input.scheduleType,
          scheduleExpression: input.scheduleExpression,
          name: input.name,
          agentSlug,
        })

        // Also broadcast globally so scheduled task list updates regardless of which session is viewed
        this.broadcastGlobal({
          type: 'scheduled_task_created',
          taskId,
          agentSlug,
        })
      } catch (error) {
        console.error('[MessagePersister] Error handling schedule task:', error)
      }
    })()
  }

  // Handle AskUserQuestion tool - broadcast to SSE clients so they can show the UI
  private handleAskUserQuestionTool(
    sessionId: string,
    toolUseId: string,
    toolInput: string,
    agentSlug?: string
  ): void {
    try {
      // Parse the tool input to get questions
      let input: {
        questions?: Array<{
          question: string
          header: string
          options: Array<{ label: string; description: string }>
          multiSelect: boolean
        }>
      } = {}
      try {
        input = JSON.parse(toolInput)
      } catch {
        console.error('[MessagePersister] Failed to parse AskUserQuestion input:', toolInput)
        return
      }

      if (!input.questions?.length) {
        console.error('[MessagePersister] AskUserQuestion missing questions')
        return
      }

      // Broadcast the question request event to SSE clients
      this.broadcastToSSE(sessionId, {
        type: 'user_question_request',
        toolUseId,
        questions: input.questions,
        agentSlug,
      })

      // Trigger waiting for input notification (only if no one is viewing the session)
      if (agentSlug && !this.hasActiveViewers(sessionId)) {
        notificationManager.triggerSessionWaitingInput(sessionId, agentSlug, 'question').catch((err) => {
          console.error('[MessagePersister] Failed to trigger waiting input notification:', err)
        })
      }
    } catch (error) {
      console.error('[MessagePersister] Error handling AskUserQuestion:', error)
    }
  }

  // Handle file request tool - broadcast to SSE clients so they can show the upload UI
  private handleFileRequestTool(
    sessionId: string,
    toolUseId: string,
    toolInput: string,
    agentSlug?: string
  ): void {
    try {
      let input: { description: string; fileTypes?: string } = { description: '' }
      try {
        input = JSON.parse(toolInput)
      } catch {
        console.error('[MessagePersister] Failed to parse file request input:', toolInput)
        return
      }

      if (!input.description) {
        console.error('[MessagePersister] File request missing description')
        return
      }

      // Broadcast the file request event to SSE clients
      this.broadcastToSSE(sessionId, {
        type: 'file_request',
        toolUseId,
        description: input.description,
        fileTypes: input.fileTypes,
        agentSlug,
      })

      // Trigger waiting for input notification (only if no one is viewing the session)
      if (agentSlug && !this.hasActiveViewers(sessionId)) {
        notificationManager.triggerSessionWaitingInput(sessionId, agentSlug, 'file').catch((err) => {
          console.error('[MessagePersister] Failed to trigger waiting input notification:', err)
        })
      }
    } catch (error) {
      console.error('[MessagePersister] Error handling file request:', error)
    }
  }

  // Handle remote MCP request tool - broadcast to SSE clients so they can show the UI
  private handleRemoteMcpRequestTool(
    sessionId: string,
    toolUseId: string,
    toolInput: string,
    agentSlug?: string
  ): void {
    try {
      let input: { url: string; name?: string; reason?: string; authHint?: 'oauth' | 'bearer' } = { url: '' }
      try {
        input = JSON.parse(toolInput)
      } catch {
        console.error('[MessagePersister] Failed to parse remote MCP request input:', toolInput)
        return
      }

      if (!input.url) {
        console.error('[MessagePersister] Remote MCP request missing url')
        return
      }

      // Broadcast the remote MCP request event to SSE clients
      this.broadcastToSSE(sessionId, {
        type: 'remote_mcp_request',
        toolUseId,
        url: input.url,
        name: input.name,
        reason: input.reason,
        authHint: input.authHint,
        agentSlug,
      })

      // Trigger waiting for input notification (only if no one is viewing the session)
      if (agentSlug && !this.hasActiveViewers(sessionId)) {
        notificationManager.triggerSessionWaitingInput(sessionId, agentSlug, 'remote_mcp').catch((err) => {
          console.error('[MessagePersister] Failed to trigger waiting input notification:', err)
        })
      }
    } catch (error) {
      console.error('[MessagePersister] Error handling remote MCP request:', error)
    }
  }

  // Handle browser input request tool - broadcast to SSE clients so they can show the UI
  private handleBrowserInputRequestTool(
    sessionId: string,
    toolUseId: string,
    toolInput: string,
    agentSlug?: string
  ): void {
    try {
      let input: { message: string; requirements?: string[] } = { message: '' }
      try {
        input = JSON.parse(toolInput)
      } catch {
        console.error('[MessagePersister] Failed to parse browser input request:', toolInput)
        return
      }

      if (!input.message) {
        console.error('[MessagePersister] Browser input request missing message')
        return
      }

      this.broadcastToSSE(sessionId, {
        type: 'browser_input_request',
        toolUseId,
        message: input.message,
        requirements: input.requirements || [],
        agentSlug,
      })

      if (agentSlug && !this.hasActiveViewers(sessionId)) {
        notificationManager.triggerSessionWaitingInput(sessionId, agentSlug, 'browser_input').catch((err) => {
          console.error('[MessagePersister] Failed to trigger waiting input notification:', err)
        })
      }
    } catch (error) {
      console.error('[MessagePersister] Error handling browser input request:', error)
    }
  }

  // Broadcast context usage from an assistant message's per-call usage field.
  // This is the actual token count for that single API call (≈ current context size).
  private broadcastContextUsage(
    sessionId: string,
    state: StreamingState,
    usage: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
  ): void {
    const contextUsage: SessionUsage = {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
      contextWindow: state.lastContextWindow,
    }
    state.lastAssistantUsage = contextUsage
    this.broadcastToSSE(sessionId, { type: 'context_usage', ...contextUsage })
  }

  // Extract contextWindow from SDK result event, then persist the last assistant
  // message's per-call usage (NOT the cumulative result.usage which sums all turns).
  private handleResultUsage(
    sessionId: string,
    state: StreamingState,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    content: any
  ): void {
    try {
      // Extract contextWindow from modelUsage (per-model breakdown in SDK result)
      const modelUsage = content.modelUsage
      if (modelUsage && typeof modelUsage === 'object') {
        const firstModel = Object.values(modelUsage)[0] as { contextWindow?: number } | undefined
        if (firstModel?.contextWindow) {
          state.lastContextWindow = firstModel.contextWindow
        }
      }

      // Use the last assistant message's per-call usage (current context snapshot).
      // Update its contextWindow now that we have the authoritative value from modelUsage.
      if (state.lastAssistantUsage) {
        const lastUsage: SessionUsage = {
          ...state.lastAssistantUsage,
          contextWindow: state.lastContextWindow,
        }

        // Re-broadcast with the correct contextWindow
        this.broadcastToSSE(sessionId, { type: 'context_usage', ...lastUsage })

        // Persist to session metadata (fire-and-forget)
        if (state.agentSlug) {
          updateSessionMetadata(state.agentSlug, sessionId, { lastUsage }).catch((err) => {
            console.error('[MessagePersister] Failed to persist lastUsage:', err)
          })
        }
      }
    } catch (error) {
      console.error('[MessagePersister] Error handling result usage:', error)
    }
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
