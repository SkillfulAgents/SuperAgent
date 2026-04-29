/**
 * ChatIntegrationManager — global lifecycle manager for external chat integrations.
 *
 * Manages connector instances, routes messages between external chats and agent sessions,
 * and handles SSE subscription for outgoing events.
 *
 * Supports multiple chat sessions per integration (e.g. multiple users DMing a Slack bot).
 * Each (integration, externalChatId) pair gets its own agent session and SSE subscription.
 *
 * Follows the TaskScheduler / TriggerManager singleton pattern.
 */

import type { ChatClientConnector, IncomingMessage } from './base-connector'
import type { UserRequestEvent } from '@shared/lib/tool-definitions/types'
import { getToolDefinition } from '@shared/lib/tool-definitions/registry'
import { formatToolName } from '@shared/lib/tool-definitions/types'
import { parseChatIntegrationConfig } from './config-schema'
import { formatProviderName } from './utils'
import {
  listStartupChatIntegrations,
  getChatIntegration,
  updateChatIntegrationStatus,
} from '@shared/lib/services/chat-integration-service'
import {
  getChatIntegrationSession,
  getChatIntegrationSessionBySessionId,
  createChatIntegrationSession,
  updateChatIntegrationSessionName,
  archiveChatIntegrationSession,
  listChatIntegrationSessions,
} from '@shared/lib/services/chat-integration-session-service'
import type { ChatIntegration } from '@shared/lib/db/schema'
import { messagePersister } from '@shared/lib/container/message-persister'
import { captureException, addErrorBreadcrumb } from '@shared/lib/error-reporting'

// ── Sentry helpers ─────────────────────────────────────────────────────

const COMPONENT = 'chat-integration'

function reportError(
  err: unknown,
  operation: string,
  extra?: Record<string, unknown>,
  level?: 'error' | 'warning',
): void {
  captureException(err, {
    tags: { component: COMPONENT, operation },
    extra,
    level,
  })
}

function breadcrumb(message: string, data?: Record<string, unknown>): void {
  addErrorBreadcrumb({ category: COMPONENT, message, data })
}

// ── Constants ───────────────────────────────────────────────────────────

const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000
const HEALTH_CHECK_ERROR_THRESHOLD_MS = 5 * 60 * 1000
const HEALTH_CHECK_MAX_CONSECUTIVE_FAILURES = 15
const MAX_FILE_DOWNLOAD_SIZE = 50 * 1024 * 1024 // 50 MB
const QUEUE_CLEANUP_INTERVAL_MS = 10 * 60 * 1000 // 10 minutes

// ── Types ───────────────────────────────────────────────────────────────

/** Integration-level connection: one connector per integration. */
interface IntegrationConnection {
  connector: ChatClientConnector
  integration: ChatIntegration
  messageUnsubscribe: (() => void) | null
  interactiveUnsubscribe: (() => void) | null
  errorUnsubscribe: (() => void) | null
}

/**
 * Per-chat streaming context. One per (integration, externalChatId) pair.
 * This is the type consumed by processSSEEvent — exported for testing.
 */
export interface ManagedConnector {
  connector: ChatClientConnector
  integration: ChatIntegration
  chatId: string
  sseUnsubscribe: (() => void) | null
  messageUnsubscribe: (() => void) | null
  interactiveUnsubscribe: (() => void) | null
  errorUnsubscribe: (() => void) | null
  streamingState: {
    currentMessageId: string | null
    accumulatedText: string
    lastUpdateTime: number
  }
  currentToolInput: string
  pendingToolMessages: Array<{ messageId: string; text: string }>
}

// ── Manager ─────────────────────────────────────────────────────────────

class ChatIntegrationManager {
  // Integration-level: one connector per integration
  private connections: Map<string, IntegrationConnection> = new Map()
  // Per-chat session: one streaming context per (integrationId, externalChatId)
  private chatSessions: Map<string, ManagedConnector> = new Map() // key: `${integrationId}:${chatId}`
  private isRunning = false
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null
  private queueCleanupInterval: ReturnType<typeof setInterval> | null = null
  private globalNotificationUnsubscribe: (() => void) | null = null
  private disconnectedSince: Map<string, number> = new Map()
  private consecutiveFailures: Map<string, number> = new Map()
  private messageQueues: Map<string, Promise<void>> = new Map()

  // ── Lifecycle ───────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true

    const integrations = listStartupChatIntegrations()

    for (const integration of integrations) {
      try {
        await this.connectIntegration(integration)
        // Clear error status on successful reconnect
        if (integration.status === 'error') {
          try { updateChatIntegrationStatus(integration.id, 'active', null) } catch { /* best-effort */ }
        }
      } catch (err) {
        console.error(`[ChatIntegrationManager] Failed to connect integration ${integration.id}:`, err)
        reportError(err, 'start-connect', { integrationId: integration.id, provider: integration.provider, agentSlug: integration.agentSlug })
        try { updateChatIntegrationStatus(integration.id, 'error', String(err)) } catch { /* best-effort */ }
      }
    }

    this.healthCheckInterval = setInterval(() => {
      this.runHealthChecks().catch((err) => {
        console.error('[ChatIntegrationManager] Health check error:', err)
        reportError(err, 'health-check')
      })
    }, HEALTH_CHECK_INTERVAL_MS)

    // Periodic cleanup of resolved message queue entries
    this.queueCleanupInterval = setInterval(() => {
      this.cleanupResolvedQueues()
    }, QUEUE_CLEANUP_INTERVAL_MS)

    // Subscribe to global notifications for proxy review requests (tool approvals)
    this.globalNotificationUnsubscribe = messagePersister.addGlobalNotificationClient((event: unknown) => {
      this.handleGlobalNotification(event).catch((err) => {
        console.error('[ChatIntegrationManager] Error handling global notification:', err)
        reportError(err, 'global-notification')
      })
    })
  }

  stop(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval)
      this.healthCheckInterval = null
    }
    if (this.queueCleanupInterval) {
      clearInterval(this.queueCleanupInterval)
      this.queueCleanupInterval = null
    }
    this.globalNotificationUnsubscribe?.()
    this.globalNotificationUnsubscribe = null

    // Clean up all chat session SSE subscriptions
    for (const [, session] of this.chatSessions) {
      session.sseUnsubscribe?.()
    }
    this.chatSessions.clear()

    // Disconnect all integrations
    for (const [, conn] of this.connections) {
      this.disconnectConnection(conn)
    }
    this.connections.clear()
    this.disconnectedSince.clear()
    this.consecutiveFailures.clear()
    this.messageQueues.clear()
    this.isRunning = false
  }

  // ── Public API ──────────────────────────────────────────────────────

  async addIntegration(id: string): Promise<void> {
    const integration = getChatIntegration(id)
    if (!integration) throw new Error(`Chat integration ${id} not found`)
    await this.connectIntegration(integration)
  }

  async removeIntegration(id: string): Promise<void> {
    // Remove all chat sessions for this integration
    for (const [key, session] of this.chatSessions) {
      if (key.startsWith(`${id}:`)) {
        session.sseUnsubscribe?.()
        this.chatSessions.delete(key)
      }
    }
    // Remove the connection
    const conn = this.connections.get(id)
    if (conn) {
      this.disconnectConnection(conn)
      this.connections.delete(id)
    }
    this.disconnectedSince.delete(id)
    this.consecutiveFailures.delete(id)
    this.messageQueues.delete(id)
  }

  async pauseIntegration(id: string): Promise<void> {
    await this.removeIntegration(id)
    updateChatIntegrationStatus(id, 'paused')
  }

  async resumeIntegration(id: string): Promise<void> {
    const integration = getChatIntegration(id)
    if (!integration) throw new Error(`Chat integration ${id} not found`)
    updateChatIntegrationStatus(id, 'active')
    await this.connectIntegration({ ...integration, status: 'active' })
  }

  getConnector(integrationId: string): ChatClientConnector | undefined {
    return this.connections.get(integrationId)?.connector
  }

  isIntegrationConnected(integrationId: string): boolean {
    const conn = this.connections.get(integrationId)
    return conn?.connector.isConnected() ?? false
  }

  getActiveIntegrationIds(): string[] {
    return [...this.connections.keys()]
  }

  // ── Connection setup ────────────────────────────────────────────────

  private async connectIntegration(integration: ChatIntegration): Promise<void> {
    if (this.connections.has(integration.id)) {
      await this.removeIntegration(integration.id)
    }

    const connector = await this.createConnector(integration)

    const conn: IntegrationConnection = {
      connector,
      integration,
      messageUnsubscribe: null,
      interactiveUnsubscribe: null,
      errorUnsubscribe: null,
    }

    // Subscribe to connector events (integration-level — routes by chatId)
    conn.messageUnsubscribe = connector.onMessage((msg) => {
      this.enqueueMessage(integration.id, msg)
    })

    conn.interactiveUnsubscribe = connector.onInteractiveResponse((toolUseId, response) => {
      this.handleInteractiveResponse(integration.id, toolUseId, response).catch((err) => {
        console.error(`[ChatIntegrationManager] Error handling interactive response for ${integration.id}:`, err)
        reportError(err, 'interactive-response', { integrationId: integration.id, provider: integration.provider, toolUseId })
      })
    })

    conn.errorUnsubscribe = connector.onError((error) => {
      console.error(`[ChatIntegrationManager] Connector error for ${integration.id}:`, error)
      reportError(error, 'connector-error', { integrationId: integration.id, provider: integration.provider, agentSlug: integration.agentSlug })
      try { updateChatIntegrationStatus(integration.id, 'error', error.message) } catch { /* best-effort */ }
      this.emitNotification(integration, 'error', error.message)
    })

    this.connections.set(integration.id, conn)

    try {
      await connector.connect()
    } catch (err) {
      this.disconnectConnection(conn)
      this.connections.delete(integration.id)
      throw err
    }
    this.disconnectedSince.delete(integration.id)
    breadcrumb('Integration connected', { integrationId: integration.id, provider: integration.provider })
    this.emitNotification(integration, 'connected')

    // Restore SSE subscriptions for existing chat sessions
    const existingSessions = listChatIntegrationSessions(integration.id)
    for (const session of existingSessions) {
      this.subscribeChatSession(integration.id, session.externalChatId, session.sessionId)
    }
  }

  private async createConnector(integration: ChatIntegration): Promise<ChatClientConnector> {
    const config = parseChatIntegrationConfig(
      integration.provider as 'telegram' | 'slack',
      integration.config,
    )
    if (!config) {
      throw new Error(`Invalid config for ${integration.provider} integration ${integration.id}`)
    }

    switch (integration.provider) {
      case 'telegram': {
        const { TelegramConnector } = await import('./telegram-connector')
        return new TelegramConnector(config as import('./telegram-connector').TelegramConfig)
      }
      case 'slack': {
        const { SlackConnector } = await import('./slack-connector')
        return new SlackConnector(config as import('./slack-connector').SlackConfig)
      }
      default:
        throw new Error(`Unknown chat integration provider: ${integration.provider}`)
    }
  }

  private disconnectConnection(conn: IntegrationConnection): void {
    conn.messageUnsubscribe?.()
    conn.interactiveUnsubscribe?.()
    conn.errorUnsubscribe?.()
    conn.connector.disconnect().catch((err) => {
      console.error(`[ChatIntegrationManager] Error disconnecting:`, err)
      reportError(err, 'disconnect', { integrationId: conn.integration.id, provider: conn.integration.provider })
    })
  }

  // ── Chat session management ────────────────────────────────────────

  private getChatSessionKey(integrationId: string, chatId: string): string {
    return `${integrationId}:${chatId}`
  }

  private getOrCreateChatSession(integrationId: string, chatId: string): ManagedConnector | null {
    const key = this.getChatSessionKey(integrationId, chatId)
    const existing = this.chatSessions.get(key)
    if (existing) return existing

    const conn = this.connections.get(integrationId)
    if (!conn) return null

    const session: ManagedConnector = {
      connector: conn.connector,
      integration: conn.integration,
      chatId,
      sseUnsubscribe: null,
      messageUnsubscribe: null,
      interactiveUnsubscribe: null,
      errorUnsubscribe: null,
      streamingState: {
        currentMessageId: null,
        accumulatedText: '',
        lastUpdateTime: 0,
      },
      currentToolInput: '',
      pendingToolMessages: [],
    }
    this.chatSessions.set(key, session)
    return session
  }

  private subscribeChatSession(integrationId: string, chatId: string, sessionId: string): void {
    const session = this.getOrCreateChatSession(integrationId, chatId)
    if (!session) return

    // Clean up any previous subscription
    session.sseUnsubscribe?.()

    const unsubscribe = messagePersister.addSSEClient(sessionId, (event: unknown) => {
      // Serialize SSE event processing per chat session to prevent race conditions
      // (e.g. session_idle arriving while stream_delta's sendStreamingUpdate is still in-flight)
      this.enqueueSSEEvent(integrationId, chatId, event)
    })
    session.sseUnsubscribe = unsubscribe
  }

  private enqueueSSEEvent(integrationId: string, chatId: string, event: unknown): void {
    const queueKey = `sse:${integrationId}:${chatId}`
    const current = this.messageQueues.get(queueKey) ?? Promise.resolve()
    const next = current.then(() =>
      this.handleSSEEvent(integrationId, chatId, event).catch((err) => {
        console.error(`[ChatIntegrationManager] Error handling SSE event:`, err)
        reportError(err, 'sse-event', { integrationId, chatId, eventType: (event as any)?.type })
      })
    )
    this.messageQueues.set(queueKey, next)
  }

  // ── Health monitoring ───────────────────────────────────────────────

  private async runHealthChecks(): Promise<void> {
    const now = Date.now()

    for (const [id, conn] of this.connections) {
      const connected = conn.connector.isConnected()

      if (connected) {
        this.disconnectedSince.delete(id)
        this.consecutiveFailures.delete(id)
        continue
      }

      if (!this.disconnectedSince.has(id)) {
        this.disconnectedSince.set(id, now)
      }

      const disconnectedFor = now - this.disconnectedSince.get(id)!

      if (disconnectedFor >= HEALTH_CHECK_ERROR_THRESHOLD_MS) {
        const integration = getChatIntegration(id)
        if (!integration || integration.status === 'paused') continue

        const failures = (this.consecutiveFailures.get(id) ?? 0) + 1
        this.consecutiveFailures.set(id, failures)

        if (failures >= HEALTH_CHECK_MAX_CONSECUTIVE_FAILURES) {
          console.error(`[ChatIntegrationManager] ${id}: ${failures} consecutive reconnect failures — pausing`)
          reportError(new Error(`Auto-paused after ${failures} failures`), 'health-check-auto-pause', { integrationId: id, provider: conn.integration.provider, failures }, 'warning')
          try { await this.removeIntegration(id) } catch { /* best-effort */ }
          try { updateChatIntegrationStatus(id, 'paused', `Auto-paused after ${failures} failed reconnection attempts`) } catch { /* best-effort */ }
          this.emitNotification(conn.integration, 'error', `Auto-paused after ${failures} failed reconnect attempts`)
          continue
        }

        try { updateChatIntegrationStatus(id, 'error', 'Connection lost — attempting reconnect') } catch { /* best-effort */ }
        this.emitNotification(conn.integration, 'error', 'Connection lost')

        try {
          await this.removeIntegration(id)
          await this.connectIntegration(integration)
        } catch (err) {
          console.error(`[ChatIntegrationManager] Reconnect failed for ${id} (attempt ${failures}):`, err)
          reportError(err, 'health-check-reconnect', { integrationId: id, provider: conn.integration.provider, attempt: failures })
          try { updateChatIntegrationStatus(id, 'error', `Reconnect failed (attempt ${failures}): ${err}`) } catch { /* best-effort */ }
        }
      }
    }
  }

  /** Remove resolved entries from the message queue map to prevent unbounded growth. */
  private cleanupResolvedQueues(): void {
    const settled = Promise.resolve()
    for (const [key, promise] of this.messageQueues) {
      // If the promise is already resolved, the .then fires synchronously in microtask
      let isSettled = false
      promise.then(() => { isSettled = true }, () => { isSettled = true })
      // Check synchronously — if it resolved, the microtask already ran
      if (promise === settled || isSettled) {
        this.messageQueues.delete(key)
      }
    }
  }

  // ── Message queue (serial per integration+chat) ─────────────────────

  private enqueueMessage(integrationId: string, message: IncomingMessage): void {
    const queueKey = `${integrationId}:${message.chatId}`
    const current = this.messageQueues.get(queueKey) ?? Promise.resolve()
    const next = current.then(() =>
      this.handleIncomingMessage(integrationId, message).catch((err) => {
        console.error(`[ChatIntegrationManager] Error handling incoming message:`, err)
        reportError(err, 'incoming-message', { integrationId, chatId: message.chatId })
      })
    )
    this.messageQueues.set(queueKey, next)
  }

  // ── Incoming message handling ─────────────────────────────────────

  private async handleIncomingMessage(integrationId: string, message: IncomingMessage): Promise<void> {
    const conn = this.connections.get(integrationId)
    if (!conn) return

    const integration = getChatIntegration(integrationId)
    if (!integration) return

    const chatId = message.chatId
    if (!chatId) return

    // Handle /clear command — reset the session for this chat
    if (message.text.trim().toLowerCase() === '/clear') {
      await this.clearChatSession(integrationId, chatId, conn.connector)
      return
    }

    // Lazy imports to avoid circular dependencies
    const { containerManager } = await import('@shared/lib/container/container-manager')
    const { agentExists } = await import('@shared/lib/services/agent-service')

    // Verify agent exists
    if (!(await agentExists(integration.agentSlug))) {
      await conn.connector.sendMessage(chatId, {
        text: 'Error: The agent no longer exists.',
      })
      try { updateChatIntegrationStatus(integrationId, 'error', 'Agent no longer exists') } catch { /* best-effort */ }
      return
    }

    // Ensure container is running
    let client: Awaited<ReturnType<typeof containerManager.ensureRunning>>
    try {
      client = await containerManager.ensureRunning(integration.agentSlug)
    } catch (err) {
      console.error(`[ChatIntegrationManager] Container startup failed for ${integration.agentSlug}:`, err)
      reportError(err, 'container-startup', { integrationId, agentSlug: integration.agentSlug, provider: integration.provider })
      await conn.connector.sendMessage(chatId, { text: 'Error: Failed to start the agent container. Please try again.' }).catch(() => {})
      return
    }

    // Look up existing session for this chat
    let chatSession = getChatIntegrationSession(integrationId, chatId)

    if (!chatSession) {
      // New chat — create a new agent session
      try {
        const { getEffectiveModels } = await import('@shared/lib/config/settings')
        const { getSecretEnvVars } = await import('@shared/lib/services/secrets-service')
        const { registerSession, updateSessionMetadata } = await import('@shared/lib/services/session-service')

        const availableEnvVars = await getSecretEnvVars(integration.agentSlug)

        const { text: messageText, failedFiles } = await this.buildMessageContent(integration, message)

        if (failedFiles.length > 0 && !messageText.trim()) {
          const names = failedFiles.join(', ')
          await conn.connector.sendMessage(chatId, {
            text: `Could not download file(s): ${names}. Message was not sent to the agent.\n\nIf this is a Slack bot, ensure the \`files:read\` scope is added and the app is reinstalled.`,
          })
          return
        }
        if (failedFiles.length > 0) {
          const names = failedFiles.join(', ')
          await conn.connector.sendMessage(chatId, {
            text: `Could not download file(s): ${names}. Your text message will still be sent.\n\nIf this is a Slack bot, ensure the \`files:read\` scope is added and the app is reinstalled.`,
          })
        }

        const containerSession = await client.createSession({
          availableEnvVars: availableEnvVars.length > 0 ? availableEnvVars : undefined,
          initialMessage: messageText,
          model: getEffectiveModels().agentModel,
          browserModel: getEffectiveModels().browserModel,
        })

        const sessionId = containerSession.id
        breadcrumb('New chat session created', { integrationId, sessionId, provider: integration.provider })

        const displayName = this.deriveDisplayName(integration.provider, message)

        const sessionName = displayName
          ? `${integration.name || integration.provider} — ${displayName}`
          : integration.name || `${integration.provider} chat`

        await registerSession(integration.agentSlug, sessionId, sessionName)

        await updateSessionMetadata(integration.agentSlug, sessionId, {
          isChatIntegrationSession: true,
          chatIntegrationId: integrationId,
        })

        createChatIntegrationSession({
          integrationId,
          externalChatId: chatId,
          sessionId,
          displayName,
        })

        await messagePersister.subscribeToSession(sessionId, client, sessionId, integration.agentSlug)
        messagePersister.markSessionActive(sessionId, integration.agentSlug)
        this.subscribeChatSession(integrationId, chatId, sessionId)

        return // initialMessage already sent via createSession
      } catch (err) {
        console.error(`[ChatIntegrationManager] Failed to create new session for ${integrationId}:`, err)
        reportError(err, 'create-session', { integrationId, agentSlug: integration.agentSlug, provider: integration.provider, chatId })
        await conn.connector.sendMessage(chatId, { text: 'Error: Failed to start a new session. Please try again.' }).catch(() => {})
        return
      }
    }

    // Update display name if we now have a better one
    // (covers the case where resolveUserName failed on first message but succeeds later)
    const resolvedName = this.deriveDisplayName(integration.provider, message)
    if (resolvedName && resolvedName !== chatSession.displayName && isDisplayNameFallback(chatSession.displayName)) {
      try { updateChatIntegrationSessionName(chatSession.id, resolvedName) } catch { /* best-effort */ }
    }

    const sessionId = chatSession.sessionId

    try {
      if (!messagePersister.isSubscribed(sessionId)) {
        await messagePersister.subscribeToSession(sessionId, client, sessionId, integration.agentSlug)
      }

      const { text: messageText, failedFiles } = await this.buildMessageContent(integration, message)

      if (failedFiles.length > 0 && !messageText.trim()) {
        const names = failedFiles.join(', ')
        await conn.connector.sendMessage(chatId, {
          text: `Could not download file(s): ${names}. Message was not sent to the agent.\n\nIf this is a Slack bot, ensure the \`files:read\` scope is added and the app is reinstalled.`,
        })
        return
      }
      if (failedFiles.length > 0) {
        const names = failedFiles.join(', ')
        await conn.connector.sendMessage(chatId, {
          text: `Could not download file(s): ${names}. Your text message will still be sent.\n\nIf this is a Slack bot, ensure the \`files:read\` scope is added and the app is reinstalled.`,
        })
      }

      await client.sendMessage(sessionId, messageText)
      messagePersister.markSessionActive(sessionId, integration.agentSlug)
    } catch (err) {
      console.error(`[ChatIntegrationManager] Failed to send message for ${integrationId}/${sessionId}:`, err)
      reportError(err, 'send-message', { integrationId, sessionId, provider: integration.provider, chatId })
      await conn.connector.sendMessage(chatId, { text: 'Error: Failed to send your message to the agent. Please try again.' }).catch(() => {})
      return
    }

    // Show typing indicator
    const managed = this.getOrCreateChatSession(integrationId, chatId)
    managed?.connector.showTypingIndicator(chatId).catch(() => {})
  }

  private async clearChatSession(
    integrationId: string,
    chatId: string,
    connector: ChatClientConnector,
  ): Promise<void> {
    try {
      const chatSession = getChatIntegrationSession(integrationId, chatId)
      if (chatSession) {
        const key = this.getChatSessionKey(integrationId, chatId)
        const managed = this.chatSessions.get(key)
        managed?.sseUnsubscribe?.()
        this.chatSessions.delete(key)
        try { archiveChatIntegrationSession(chatSession.id) } catch { /* best-effort */ }
      }
    } catch (err) {
      console.error('[ChatIntegrationManager] Error during session clear:', err)
      reportError(err, 'clear-session', { integrationId, chatId })
    }

    await connector.sendMessage(chatId, {
      text: '🗑️ Session cleared. Your next message will start a fresh conversation.',
    }).catch(() => {})
  }

  /** Clear a chat session by its DB row ID (called from API route). */
  clearChatSessionById(sessionId: string): void {
    // Find and clean up the managed session
    for (const [key, managed] of this.chatSessions) {
      // Look up the DB mapping to check if this managed session matches
      const [integrationId, chatId] = key.split(':')
      const chatSession = getChatIntegrationSession(integrationId, chatId)
      if (chatSession?.id === sessionId) {
        managed.sseUnsubscribe?.()
        this.chatSessions.delete(key)
        break
      }
    }
  }

  private deriveDisplayName(_provider: string, message: IncomingMessage): string | undefined {
    return deriveDisplayName(message)
  }

  /**
   * Build message text, downloading any file attachments to the agent workspace
   * and appending them using the same [Attached files:] format the UI uses.
   */
  private async buildMessageContent(
    integration: ChatIntegration,
    message: IncomingMessage,
  ): Promise<{ text: string; failedFiles: string[] }> {
    const text = message.text || ''

    if (!message.files || message.files.length === 0) {
      return { text, failedFiles: [] }
    }

    const { appendAttachedFiles } = await import('@shared/lib/utils/attached-files')
    const uploadedPaths: string[] = []
    const failedFiles: string[] = []

    for (const file of message.files) {
      if (!file.url) {
        failedFiles.push(file.name)
        continue
      }

      try {
        const data = await this.downloadFileBuffer(integration, file.url)
        if (data) {
          const path = await this.writeToWorkspace(integration.agentSlug, file.name, data)
          uploadedPaths.push(path)
        } else {
          failedFiles.push(file.name)
        }
      } catch (err) {
        console.error(`[ChatIntegrationManager] Failed to download file ${file.name}:`, err)
        failedFiles.push(file.name)
      }
    }

    return { text: appendAttachedFiles(text, uploadedPaths), failedFiles }
  }

  /** Download a file from the chat platform, returning a Buffer. */
  private async downloadFileBuffer(integration: ChatIntegration, fileUrl: string): Promise<Buffer | null> {
    try {
      const config = parseChatIntegrationConfig(
        integration.provider as 'telegram' | 'slack',
        integration.config,
      )
      if (!config) return null

      if (integration.provider === 'slack' && 'botToken' in config) {
        return await this.downloadSlackFile(config.botToken, fileUrl)
      }

      // Telegram: direct URL download (no auth needed, URL contains the bot token)
      const response = await fetch(fileUrl)
      if (!response.ok) return null
      const buffer = Buffer.from(await response.arrayBuffer())
      if (!this.validateFileContent(buffer)) return null
      return buffer
    } catch (err) {
      console.error(`[ChatIntegrationManager] File download failed:`, err)
      return null
    }
  }

  /** Download a Slack file using the Web API (requires files:read scope). */
  private async downloadSlackFile(botToken: string, fileUrl: string): Promise<Buffer | null> {
    // Extract file ID from Slack URL: .../files-pri/TEAM-FILEID/...
    const fileIdMatch = fileUrl.match(/files-pri\/[A-Z0-9]+-([A-Z0-9]+)/)
    if (!fileIdMatch) {
      // Fallback: try direct download with auth
      return this.downloadWithAuth(fileUrl, botToken)
    }

    const fileId = fileIdMatch[1]

    // Use files.info API to get a proper download URL
    const infoRes = await fetch(`https://slack.com/api/files.info?file=${fileId}`, {
      headers: { 'Authorization': `Bearer ${botToken}` },
    })
    const info = await infoRes.json() as { ok: boolean; file?: { url_private_download?: string }; error?: string }

    if (!info.ok || !info.file?.url_private_download) {
      console.error(`[ChatIntegrationManager] Slack files.info failed: ${info.error || 'no download URL'}`)
      return null
    }

    return this.downloadWithAuth(info.file.url_private_download, botToken)
  }

  /** Download a URL with Bearer auth, following redirects manually to preserve the header. */
  private async downloadWithAuth(url: string, token: string): Promise<Buffer | null> {
    const headers = { 'Authorization': `Bearer ${token}` }

    let response = await fetch(url, { headers, redirect: 'manual' })
    // Follow redirects with auth preserved
    let redirects = 0
    while (response.status >= 300 && response.status < 400 && redirects < 5) {
      const location = response.headers.get('location')
      if (!location) break
      response = await fetch(location, { headers })
      redirects++
    }

    if (!response.ok) {
      console.error(`[ChatIntegrationManager] File download HTTP ${response.status} for ${url}`)
      return null
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    if (!this.validateFileContent(buffer)) {
      return null
    }
    return buffer
  }

  /** Validate downloaded content is actual file data, not an HTML error page. */
  private validateFileContent(buffer: Buffer): boolean {
    if (buffer.length === 0) {
      console.error('[ChatIntegrationManager] Downloaded file is empty')
      return false
    }
    if (buffer.length > MAX_FILE_DOWNLOAD_SIZE) {
      console.error(`[ChatIntegrationManager] Downloaded file too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB, limit ${MAX_FILE_DOWNLOAD_SIZE / 1024 / 1024} MB)`)
      return false
    }
    // Check for HTML content (Slack login pages, error pages)
    if (buffer.length > 15) {
      const head = buffer.slice(0, 15).toString('utf8').toLowerCase()
      if (head.includes('<!doctype') || head.includes('<html')) {
        console.error('[ChatIntegrationManager] Downloaded file is HTML, not a valid file (missing files:read scope?)')
        return false
      }
    }
    return true
  }

  /** Write a file to the agent's workspace uploads directory. */
  private async writeToWorkspace(agentSlug: string, filename: string, data: Buffer): Promise<string> {
    const { getAgentWorkspaceDir } = await import('@shared/lib/config/data-dir')
    const path = await import('path')
    const fs = await import('fs')

    const uploadName = `${Date.now()}-${filename}`
    const workspaceDir = getAgentWorkspaceDir(agentSlug)
    const uploadsDir = path.resolve(workspaceDir, 'uploads')
    const fullPath = path.resolve(uploadsDir, uploadName)

    await fs.promises.mkdir(uploadsDir, { recursive: true })
    await fs.promises.writeFile(fullPath, data)

    return `/workspace/uploads/${uploadName}`
  }

  // ── Global notification handling (proxy review requests) ─────────

  private async handleGlobalNotification(event: unknown): Promise<void> {
    const data = event as Record<string, unknown>
    if (data.type !== 'session_awaiting_input') return

    const review = data.review as Record<string, unknown> | undefined
    if (!review || review.type !== 'proxy_review_request') return

    const agentSlug = data.agentSlug as string
    const sessionId = data.sessionId as string
    if (!agentSlug) return

    const reviewId = review.reviewId as string
    const displayText = review.displayText as string || 'Allow this action?'
    const toolkit = review.toolkit as string || ''

    const text = toolkit
      ? `🔐 *${formatProviderName(toolkit)} — Permission Request*\n${displayText}`
      : `🔐 *Permission Request*\n${displayText}`

    const card = {
      type: 'user_question_request',
      toolUseId: `review:${reviewId}:${agentSlug}`,
      questions: [{
        question: text,
        options: [
          { label: '✅ Allow', value: 'allow' },
          { label: '❌ Deny', value: 'deny' },
        ],
      }],
    } as any

    // If we know the sessionId, send only to the chat session that owns it
    if (sessionId) {
      try {
        const chatSession = getChatIntegrationSessionBySessionId(sessionId)
        if (chatSession) {
          const key = `${chatSession.integrationId}:${chatSession.externalChatId}`
          const managed = this.chatSessions.get(key)
          if (managed) {
            await managed.connector.sendUserRequestCard(managed.chatId, card)
            return
          }
        }
      } catch (err) {
        console.error('[ChatIntegrationManager] Error routing approval to session:', err)
        reportError(err, 'route-approval', { agentSlug, sessionId })
      }
    }

    // Fallback: no sessionId match — send to first active session for this agent
    for (const [, conn] of this.connections) {
      if (conn.integration.agentSlug !== agentSlug) continue
      for (const [key, session] of this.chatSessions) {
        if (!key.startsWith(`${conn.integration.id}:`)) continue
        try {
          await session.connector.sendUserRequestCard(session.chatId, card)
        } catch (err) {
          console.error('[ChatIntegrationManager] Failed to send approval card:', err)
        }
        return // Only send to first match
      }
    }
  }

  // ── SSE event handling ────────────────────────────────────────────

  private async handleSSEEvent(integrationId: string, chatId: string, event: unknown): Promise<void> {
    const key = this.getChatSessionKey(integrationId, chatId)
    const session = this.chatSessions.get(key)
    if (!session) return

    const showToolCalls = getChatIntegration(integrationId)?.showToolCalls ?? false
    await processSSEEvent(session, event, showToolCalls)
  }

  // ── Interactive response handling ─────────────────────────────────

  private async handleInteractiveResponse(
    integrationId: string,
    toolUseId: string,
    response: unknown,
  ): Promise<void> {
    // Handle proxy review decisions (tool approval requests)
    if (toolUseId.startsWith('review:')) {
      const parts = toolUseId.split(':')
      const reviewId = parts[1]
      const responseObj = response as Record<string, unknown>
      const answer = (responseObj?.answer as string)?.toLowerCase() || ''
      const decision = answer.includes('allow') ? 'allow' : 'deny'

      try {
        const { reviewManager } = await import('@shared/lib/proxy/review-manager')
        reviewManager.submitDecision(reviewId, decision as 'allow' | 'deny')
      } catch (err) {
        console.error(`[ChatIntegrationManager] Failed to submit review decision:`, err)
        reportError(err, 'review-decision', { integrationId, reviewId, decision })
      }
      return
    }

    const integration = getChatIntegration(integrationId)
    if (!integration) return

    try {
      const { containerManager } = await import('@shared/lib/container/container-manager')
      const client = await containerManager.ensureRunning(integration.agentSlug)

      const responseObj = response as Record<string, unknown>
      if (responseObj && typeof responseObj === 'object' && 'question' in responseObj && 'answer' in responseObj) {
        const answers: Record<string, string> = responseObj.answers
          ? responseObj.answers as Record<string, string>
          : { [responseObj.question as string]: responseObj.answer as string }
        const resolveResponse = await client.fetch(
          `/inputs/${encodeURIComponent(toolUseId)}/resolve`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: answers }),
          },
        )
        if (!resolveResponse.ok) {
          const text = await resolveResponse.text().catch(() => '')
          console.error(`[ChatIntegrationManager] Failed to resolve question ${toolUseId}:`, text)
          reportError(new Error(`Resolve question failed: ${resolveResponse.status}`), 'resolve-input', { integrationId, toolUseId, status: resolveResponse.status })
        }
        return
      }

      const resolveResponse = await client.fetch(
        `/inputs/${encodeURIComponent(toolUseId)}/resolve`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: response }),
        },
      )
      if (!resolveResponse.ok) {
        const text = await resolveResponse.text().catch(() => '')
        console.error(`[ChatIntegrationManager] Failed to resolve input ${toolUseId}:`, text)
        reportError(new Error(`Resolve input failed: ${resolveResponse.status}`), 'resolve-input', { integrationId, toolUseId, status: resolveResponse.status })
      }
    } catch (err) {
      console.error(`[ChatIntegrationManager] Failed to handle interactive response:`, err)
      reportError(err, 'interactive-response-resolve', { integrationId, toolUseId })
    }
  }

  // ── Notifications ──────────────────────────────────────────────────

  private emitNotification(
    integration: ChatIntegration,
    event: 'connected' | 'disconnected' | 'error',
    detail?: string,
  ): void {
    import('@shared/lib/notifications/notification-manager').then(({ notificationManager }) => {
      const name = integration.name || `${integration.provider} bot`
      const sessionId = integration.id
      notificationManager.triggerChatIntegrationEvent(
        sessionId, integration.agentSlug, name, event, detail,
      ).catch(() => {})
    }).catch(() => {})
  }
}

// ── SSE event processing (exported for testing) ────────────────────────

/**
 * Process a single SSE event for a managed connector.
 * Handles streaming text, tool calls, user request events, and session lifecycle.
 */
export async function processSSEEvent(
  managed: ManagedConnector,
  event: unknown,
  showToolCalls = false,
): Promise<void> {
  const data = event as Record<string, unknown>
  const eventType = data.type as string

  switch (eventType) {
    case 'stream_delta': {
      const text = data.text as string
      if (!text) break
      managed.streamingState.accumulatedText += text

      const now = Date.now()
      if (now - managed.streamingState.lastUpdateTime >= 1000) {
        try {
          const msgId = await managed.connector.sendStreamingUpdate(
            managed.chatId,
            managed.streamingState.accumulatedText,
            managed.streamingState.currentMessageId ?? undefined,
          )
          managed.streamingState.currentMessageId = msgId
          managed.streamingState.lastUpdateTime = now
        } catch (err) {
          console.error(`[ChatIntegrationManager] Streaming update failed:`, err)
          reportError(err, 'streaming-update', { integrationId: managed.integration.id, chatId: managed.chatId, provider: managed.integration.provider })
        }
      }
      break
    }

    case 'stream_start': {
      try {
        await finalizeStreaming(managed)
        await resolvePendingToolMessages(managed)
      } catch (err) {
        console.error('[ChatIntegrationManager] Failed to finalize on stream_start:', err)
      }
      managed.connector.showTypingIndicator(managed.chatId).catch(() => {})
      break
    }

    case 'messages_updated': {
      if (managed.streamingState.accumulatedText) {
        managed.connector.showTypingIndicator(managed.chatId).catch(() => {})
      }
      break
    }

    case 'tool_use_start': {
      try { await finalizeStreaming(managed) } catch { /* best-effort */ }
      managed.currentToolInput = ''
      break
    }

    case 'tool_use_streaming': {
      const partialInput = data.partialInput as string
      if (partialInput) managed.currentToolInput = partialInput
      break
    }

    case 'tool_use_ready': {
      const toolName = data.toolName as string

      // Handle file delivery — send the file to the chat client
      if (toolName === 'mcp__user-input__deliver_file') {
        try {
          const toolInput = JSON.parse(managed.currentToolInput || '{}')
          const filePath = toolInput.filePath as string | undefined
          const description = toolInput.description as string | undefined
          if (filePath) {
            await sendDeliveredFile(managed, filePath, description)
          }
        } catch (err) {
          console.error('[ChatIntegrationManager] Failed to deliver file:', err)
          reportError(err, 'deliver-file', { integrationId: managed.integration.id, provider: managed.integration.provider })
        }
        managed.currentToolInput = ''
        break
      }

      if (isUserRequestTool(toolName)) {
        managed.currentToolInput = ''
        break
      }

      if (showToolCalls) {
        let toolInput: Record<string, unknown> = {}
        try { toolInput = JSON.parse(managed.currentToolInput) } catch { /* partial/invalid */ }

        const def = getToolDefinition(toolName)
        const displayName = def?.displayName ?? formatToolName(toolName)
        const summary = def?.getSummary(toolInput) ?? ''
        const text = summary
          ? `🔧 *${displayName}* — \`${summary}\` ⏳`
          : `🔧 *${displayName}* ⏳`
        try {
          const messageId = await managed.connector.sendMessage(managed.chatId, { text })
          managed.pendingToolMessages.push({ messageId, text })
        } catch (err) {
          console.error('[ChatIntegrationManager] Failed to send tool call message:', err)
        }
      }
      managed.currentToolInput = ''
      break
    }

    case 'user_question_request':
    case 'secret_request':
    case 'file_request':
    case 'connected_account_request':
    case 'remote_mcp_request':
    case 'browser_input_request':
    case 'script_run_request':
    case 'computer_use_request': {
      try {
        await managed.connector.sendUserRequestCard(managed.chatId, data as UserRequestEvent)
      } catch (err) {
        console.error(`[ChatIntegrationManager] Failed to send user request card (${eventType}):`, err)
        reportError(err, 'send-user-request-card', { integrationId: managed.integration.id, provider: managed.integration.provider, eventType })
      }
      break
    }

    case 'session_idle': {
      try {
        await finalizeStreaming(managed)
        await resolvePendingToolMessages(managed)
      } catch (err) {
        console.error('[ChatIntegrationManager] Failed to finalize on session_idle:', err)
        reportError(err, 'session-idle-finalize', { integrationId: managed.integration.id, chatId: managed.chatId })
      }
      break
    }
  }
}

export async function resolvePendingToolMessages(managed: ManagedConnector): Promise<void> {
  for (const pending of managed.pendingToolMessages) {
    const doneText = pending.text.replace('⏳', '✅')
    try {
      await managed.connector.sendStreamingUpdate(managed.chatId, doneText, pending.messageId)
    } catch {
      // Non-critical
    }
  }
  managed.pendingToolMessages = []
}

export async function finalizeStreaming(managed: ManagedConnector): Promise<void> {
  const finalText = managed.streamingState.accumulatedText
  if (!finalText) return

  if (managed.streamingState.currentMessageId) {
    try {
      await managed.connector.finalizeStreamingMessage(
        managed.chatId,
        managed.streamingState.currentMessageId,
        finalText,
      )
    } catch {
      await managed.connector.sendMessage(managed.chatId, { text: finalText })
    }
  } else {
    await managed.connector.sendMessage(managed.chatId, { text: finalText })
  }

  managed.streamingState = {
    currentMessageId: null,
    accumulatedText: '',
    lastUpdateTime: 0,
  }
}

/** Read a file from the agent workspace and send it to the chat client. */
async function sendDeliveredFile(
  managed: ManagedConnector,
  filePath: string,
  description?: string,
): Promise<void> {
  const { getAgentWorkspaceDir } = await import('@shared/lib/config/data-dir')
  const path = await import('path')
  const fs = await import('fs')

  // filePath is like /workspace/output.png — resolve to host filesystem
  const relativePath = filePath.replace(/^\/workspace\//, '')
  const workspaceDir = getAgentWorkspaceDir(managed.integration.agentSlug)
  const fullPath = path.resolve(workspaceDir, relativePath)

  // Security: ensure path doesn't escape workspace
  if (!fullPath.startsWith(path.resolve(workspaceDir))) {
    console.error('[ChatIntegrationManager] deliver_file path escapes workspace:', filePath)
    reportError(new Error('Path traversal attempt in deliver_file'), 'deliver-file-security', { filePath, agentSlug: managed.integration.agentSlug }, 'warning')
    return
  }

  try {
    const fileData = await fs.promises.readFile(fullPath)
    const filename = path.basename(fullPath)
    await managed.connector.sendFile(managed.chatId, fileData, filename, description)
  } catch (err) {
    console.error('[ChatIntegrationManager] Failed to send delivered file:', err)
    reportError(err, 'send-delivered-file', { integrationId: managed.integration.id, provider: managed.integration.provider, filePath })
    // Fall back to a text message with the file path
    await managed.connector.sendMessage(managed.chatId, {
      text: `📎 File ready: \`${filePath}\`${description ? ` — ${description}` : ''}\n(File delivery to chat not available — download from the UI)`,
    })
  }
}

// ── Exported pure functions (testable) ────────────────────────────────

const USER_REQUEST_TOOLS = new Set([
  'AskUserQuestion',
  'mcp__user-input__request_secret',
  'mcp__user-input__request_file',
  'mcp__user-input__deliver_file',
  'mcp__user-input__request_connected_account',
  'mcp__user-input__request_remote_mcp',
  'mcp__user-input__request_browser_input',
  'mcp__user-input__request_script_run',
])

export function isUserRequestTool(toolName: string): boolean {
  return USER_REQUEST_TOOLS.has(toolName)
}

/**
 * Derive a human-readable display name from an incoming chat message.
 * Priority: chatName (group/channel title) → userName (DM sender) → userId fallback.
 */
export function deriveDisplayName(message: Pick<IncomingMessage, 'chatName' | 'userName' | 'userId'>): string | undefined {
  return message.chatName || message.userName || (message.userId ? `User ${message.userId}` : undefined)
}

/** Check if a display name looks like the raw-ID fallback (e.g. "User U08G59..."). */
export function isDisplayNameFallback(name: string | null | undefined): boolean {
  return !name || name.startsWith('User ')
}

// ── Singleton (globalThis for HMR persistence) ─────────────────────────

const globalForManager = globalThis as unknown as {
  chatIntegrationManager: ChatIntegrationManager | undefined
}

export const chatIntegrationManager =
  globalForManager.chatIntegrationManager ?? new ChatIntegrationManager()

if (process.env.NODE_ENV !== 'production') {
  globalForManager.chatIntegrationManager = chatIntegrationManager
}
