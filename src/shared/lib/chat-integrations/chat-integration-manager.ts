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
import { TelegramConnector, type DashboardDelivery } from './telegram-connector'
import type { UserRequestEvent } from '@shared/lib/tool-definitions/types'
import { getToolDefinition } from '@shared/lib/tool-definitions/registry'
import { formatToolName } from '@shared/lib/tool-definitions/types'
import { parseChatIntegrationConfig, type ChatProvider } from './config-schema'
import { formatProviderName, formatSessionTimestamp } from './utils'
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
  touchChatIntegrationSession,
  listChatIntegrationSessions,
  listActiveChatIntegrationSessions,
  resolveActiveSession,
  getLastDisplayName,
} from '@shared/lib/services/chat-integration-session-service'
import { assertPathWithinDir, isPathWithinDir, sanitizeUploadFilename } from '@shared/lib/utils/path-safety'
import { isHostOrSubdomain, tryParseUrl } from '@shared/lib/utils/url-safety'
import type { EffortLevel, ContainerClient } from '@shared/lib/container/types'
import type { ChatIntegration } from '@shared/lib/db/schema'
import { messagePersister } from '@shared/lib/container/message-persister'
import { runWithOptionalUser } from '@shared/lib/platform-attribution'
import { captureException, addErrorBreadcrumb } from '@shared/lib/error-reporting'
import {
  decideInboundAccess,
  isChatAllowed,
  getChatAccess,
  markNoticeSent,
} from '@shared/lib/services/chat-integration-access-service'

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

/**
 * True if the error is the recoverable "Container is not running" case thrown by
 * BaseContainerClient.getPortOrThrow when the container died between requests.
 * On the chat-integration send/create paths the user is told to retry and the
 * container restarts on the next message, so this is reported as a warning.
 */
function isContainerNotRunning(err: unknown): boolean {
  return err instanceof Error && err.message.includes('Container is not running')
}

/**
 * True iff `u` is an HTTPS request to Slack (slack.com or a *.slack.com
 * subdomain). Only these hosts may receive the Slack bot token on a redirect
 * hop (SUP-232).
 */
function isTrustedSlackDownloadHost(u: URL): boolean {
  return u.protocol === 'https:' && isHostOrSubdomain(u.hostname, 'slack.com')
}

// ── Constants ───────────────────────────────────────────────────────────

const IMESSAGE_SYSTEM_PROMPT = `This is an iMessage-based conversation. Follow these rules:
- Keep responses concise and conversational — this is a text message, not a document.
- Use tools, skills, and capabilities as you normally would.
- Prefer asking questions directly in natural language rather than using the ask questions tool.
- You can react to the user's last message by starting your response with a reaction tag. Available reactions: [[reaction:heart]], [[reaction:thumbs_up]], [[reaction:thumbs_down]], [[reaction:haha]], [[reaction:emphasize]], [[reaction:question]]. The tag will be stripped from the message and sent as a tapback reaction. If your entire response is just a reaction tag, only the reaction is sent (no text message).
- The user may send voice notes which are automatically transcribed.`

const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000
const HEALTH_CHECK_ERROR_THRESHOLD_MS = 5 * 60 * 1000
// Idle-silence watchdog: if a turn shows the working indicator and then goes
// completely silent (no SSE events) for this long, assume it stalled and tear
// the indicator down. The backstop for any missing-terminal-event path (SDK
// stall, dropped stream, an event type nobody handles). Reset on any activity,
// so a healthy long turn never trips it. Set generously: a single silent tool
// call (a long build / install / search that streams nothing) is legitimate
// work, so the threshold must clear that before it assumes a stall — and even
// then the notice is softened (see onWorkingWatchdogFired) because it can be a
// false positive on slow-but-alive work.
const WORKING_WATCHDOG_MS = 5 * 60 * 1000
const HEALTH_CHECK_MAX_CONSECUTIVE_FAILURES = 15
const MAX_FILE_DOWNLOAD_SIZE = 50 * 1024 * 1024 // 50 MB

// ── Types ───────────────────────────────────────────────────────────────

/** Integration-level connection: one connector per integration. */
interface IntegrationConnection {
  connector: ChatClientConnector
  integration: ChatIntegration
  messageUnsubscribe: (() => void) | null
  interactiveUnsubscribe: (() => void) | null
  errorUnsubscribe: (() => void) | null
  typingHintUnsubscribe: (() => void) | null
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
  // Idle-silence watchdog timer (see WORKING_WATCHDOG_MS). Armed when the
  // working indicator is shown, reset on every SSE event, cleared on teardown.
  watchdogTimer?: ReturnType<typeof setTimeout> | null
  // True once a terminal user-facing notice (the session_error message or the
  // watchdog stall notice) has gone out for the current turn, so a turn can't
  // emit repeated/duplicate notices. Reset once per turn at dispatch (not per
  // segment), so a multi-stall turn still yields at most one notice.
  turnNotified?: boolean
}

// ── Manager ─────────────────────────────────────────────────────────────

class ChatIntegrationManager {
  // Integration-level: one connector per integration
  private connections: Map<string, IntegrationConnection> = new Map()
  // Per-chat session: one streaming context per (integrationId, externalChatId)
  private chatSessions: Map<string, ManagedConnector> = new Map() // key: `${integrationId}:${chatId}`
  private isRunning = false
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null
  private globalNotificationUnsubscribe: (() => void) | null = null
  private disconnectedSince: Map<string, number> = new Map()
  private consecutiveFailures: Map<string, number> = new Map()
  // Per-(integration,chat) serialized tail promise. Entries self-evict once their
  // chain settles (see scheduleQueueEviction), so the map stays bounded.
  private messageQueues: Map<string, Promise<void>> = new Map()
  private lastSessionTouch: Map<string, number> = new Map()

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
    this.globalNotificationUnsubscribe?.()
    this.globalNotificationUnsubscribe = null

    // Clean up all chat session SSE subscriptions
    for (const [, session] of this.chatSessions) {
      this.stopSession(session)
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

  async reconnectAll(): Promise<void> {
    if (!this.isRunning) return
    console.log('[ChatIntegrationManager] Reconnecting all integrations (system resume)')

    const entries = [...this.connections.entries()]
    for (const [id, conn] of entries) {
      try {
        const integration = getChatIntegration(id)
        if (!integration || integration.status === 'paused') continue
        await this.removeIntegration(id)
        await this.connectIntegration(integration)
        this.disconnectedSince.delete(id)
        this.consecutiveFailures.delete(id)
      } catch (err) {
        console.error(`[ChatIntegrationManager] Resume reconnect failed for ${id}:`, err)
        reportError(err, 'resume-reconnect', { integrationId: id, provider: conn.integration.provider })
      }
    }
  }

  async addIntegration(id: string): Promise<void> {
    const integration = getChatIntegration(id)
    if (!integration) throw new Error(`Chat integration ${id} not found`)
    await this.connectIntegration(integration)
  }

  async removeIntegration(id: string): Promise<void> {
    // Remove all chat sessions for this integration
    for (const [key, session] of this.chatSessions) {
      if (key.startsWith(`${id}:`)) {
        this.stopSession(session)
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
    // Drop any per-chat message/SSE queues for this integration. Keys are
    // `${id}:${chatId}` and `sse:${id}:${chatId}`, so the old bare delete(id)
    // never matched — iterate by prefix. The `:` delimiter plus UUID integration
    // ids (which contain no `:` and are never the literal "sse") guarantee this
    // can't false-match a sibling integration's keys.
    //
    // Settled chains already self-evict, so this only force-drops STILL-IN-FLIGHT
    // chains. On a true teardown that is exactly what we want. On the reconnect
    // path (runHealthChecks → removeIntegration → connectIntegration) it means a
    // handler still running against the now-dead connection no longer serializes
    // ahead of the first post-reconnect message — an accepted trade-off, since the
    // stale connection is going away and new work should not block on it.
    for (const key of [...this.messageQueues.keys()]) {
      if (key.startsWith(`${id}:`) || key.startsWith(`sse:${id}:`)) {
        this.messageQueues.delete(key)
      }
    }
  }

  /**
   * Ensure a chat integration session exists for the given (integrationId, chatId).
   * If an active session already exists (and hasn't timed out), returns its sessionId.
   * Otherwise creates a lightweight session (no container, no agent response) and
   * returns the new sessionId.
   *
   * Used by outbound sends so they can log messages into the session JSONL.
   */
  async ensureSession(integrationId: string, chatId: string): Promise<string> {
    const integration = getChatIntegration(integrationId)
    if (!integration) throw new Error(`Chat integration ${integrationId} not found`)
    if (!isChatAllowed(integrationId, chatId)) throw new Error(`Chat ${chatId} is not allowed for integration ${integrationId}`)

    const existing = resolveActiveSession(
      integrationId, chatId, integration.sessionTimeout,
      (archivedId) => {
        this.teardownManagedSession(integrationId, chatId)
        this.lastSessionTouch.delete(archivedId)
      },
    )
    if (existing) return existing.sessionId

    const { registerSession, updateSessionMetadata } = await import('@shared/lib/services/session-service')

    const displayName = getLastDisplayName(integrationId, chatId)
    const sessionId = crypto.randomUUID()
    const sessionName = buildSessionName(
      integration.name,
      integration.provider,
      displayName,
      integration.sessionTimeout,
    )

    await registerSession(integration.agentSlug, sessionId, sessionName)
    await updateSessionMetadata(integration.agentSlug, sessionId, {
      isChatIntegrationSession: true,
      chatIntegrationId: integrationId,
      ...(integration.createdByUserId ? { createdByUserId: integration.createdByUserId } : {}),
    })

    createChatIntegrationSession({
      integrationId,
      externalChatId: chatId,
      sessionId,
      displayName,
    })

    return sessionId
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

  async shareDashboard(
    integrationId: string,
    chatId: string,
    opts: { agentSlug: string; dashboardSlug: string; name: string },
  ): Promise<DashboardDelivery> {
    const connector = this.getConnector(integrationId)
    if (!connector) throw new Error('Integration not connected')
    if (!(connector instanceof TelegramConnector)) {
      throw new Error('Dashboards are only supported on Telegram integrations')
    }
    return connector.sendDashboardCard(chatId, {
      integrationId,
      agentSlug: opts.agentSlug,
      dashboardSlug: opts.dashboardSlug,
      name: opts.name,
    })
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
      typingHintUnsubscribe: null,
    }

    // Subscribe to connector events (integration-level — routes by chatId)
    conn.messageUnsubscribe = connector.onMessage((msg) => {
      this.enqueueMessage(integration.id, msg)
    })

    conn.interactiveUnsubscribe = connector.onInteractiveResponse((toolUseId, response, chatId) => {
      this.handleInteractiveResponse(integration.id, toolUseId, response, chatId).catch((err) => {
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

    // Intentionally provider-agnostic and NOT access-gated: Telegram excludes typing hints
    // from allowed_updates today, so this never fires in practice. If a future provider (or
    // Telegram config change) emits typing hints, add an isChatAllowed check here before
    // pre-warming to avoid leaking container resources for ungated chats.
    conn.typingHintUnsubscribe = connector.onTypingHint(() => {
      this.preWarmContainer(integration.agentSlug)
    })

    this.connections.set(integration.id, conn)

    try {
      await connector.connect()
    } catch (err) {
      await this.removeIntegration(integration.id)
      throw err
    }
    this.disconnectedSince.delete(integration.id)
    breadcrumb('Integration connected', { integrationId: integration.id, provider: integration.provider })
    this.emitNotification(integration, 'connected')

    // Restore SSE subscriptions for ACTIVE, allowed chat sessions only. Archived/
    // cleared/timed-out sessions must not be re-subscribed, or stale agent output
    // could be forwarded back to the external chat (SUP-233); unapproved chats are
    // skipped by the access check below.
    const existingSessions = listActiveChatIntegrationSessions(integration.id)
    for (const session of existingSessions) {
      if (!isChatAllowed(integration.id, session.externalChatId)) continue
      this.subscribeChatSession(integration.id, session.externalChatId, session.sessionId)
    }
  }

  private async createConnector(integration: ChatIntegration): Promise<ChatClientConnector> {
    const config = parseChatIntegrationConfig(
      integration.provider as ChatProvider,
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
      case 'imessage': {
        const { IMessageConnector } = await import('./imessage-connector')
        return new IMessageConnector(config as import('./imessage-connector').IMessageConfig)
      }
      default:
        throw new Error(`Unknown chat integration provider: ${integration.provider}`)
    }
  }

  private disconnectConnection(conn: IntegrationConnection): void {
    conn.messageUnsubscribe?.()
    conn.interactiveUnsubscribe?.()
    conn.errorUnsubscribe?.()
    conn.typingHintUnsubscribe?.()
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
    this.scheduleQueueEviction(queueKey, next)
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

  /**
   * Once `promise` (the tail enqueued for `queueKey`) settles, drop it from the
   * map so messageQueues stays bounded. The identity check is the crux: a newer
   * enqueue chains off this promise and replaces the map slot, so we evict only
   * if the map still holds *this* promise — otherwise we'd delete a live,
   * still-running successor. In-flight entries are never evicted because their
   * `.finally` hasn't run yet. This makes a periodic sweep unnecessary: native
   * Promise state can't be read synchronously, but driving eviction off the
   * promise's own settlement avoids needing to.
   */
  private scheduleQueueEviction(queueKey: string, promise: Promise<void>): void {
    void promise.finally(() => {
      if (this.messageQueues.get(queueKey) === promise) {
        this.messageQueues.delete(queueKey)
      }
    })
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
    this.scheduleQueueEviction(queueKey, next)
  }

  // ── Incoming message handling ─────────────────────────────────────

  private async handleIncomingMessage(integrationId: string, message: IncomingMessage): Promise<void> {
    const integration = getChatIntegration(integrationId)
    if (!integration) return
    return runWithOptionalUser(integration.createdByUserId ?? undefined, () =>
      this.handleIncomingMessageInner(integrationId, message, integration),
    )
  }

  private async handleIncomingMessageInner(
    integrationId: string,
    message: IncomingMessage,
    integration: ChatIntegration,
  ): Promise<void> {
    const conn = this.connections.get(integrationId)
    if (!conn) return

    const chatId = message.chatId
    if (!chatId) return

    // Access gate — enforce owner approval BEFORE any token spend (and before
    // /clear or /start), so a non-allowed chat can neither command nor cost.
    const decision = decideInboundAccess({
      integrationId,
      externalChatId: chatId,
      chatType: message.chatType,
      userId: message.userId,
      userName: message.userName,
      chatName: message.chatName,
      preview: message.text,
    })
    if (decision.action === 'blocked') {
      if (decision.sendNotice) {
        const access = getChatAccess(integrationId, chatId)
        if (access) {
          try {
            await conn.connector.sendMessage(chatId, { text: 'This bot needs the owner to approve this conversation before it can respond.' })
            markNoticeSent(access.id)
          } catch (err) {
            reportError(err, 'access-notice', { integrationId, chatId }, 'warning')
          }
        }
      }
      return
    }

    // Handle /start — a freshly bootstrapped/allowed chat gets a greeting without
    // spending on the agent. (Pending chats never reach here — the gate blocked them.)
    // Telegram-only: /start is the Telegram onboarding convention and part of the
    // allowlist bootstrap UX. Other providers forward "/start" to the agent as a
    // normal message (their pre-allowlist behavior).
    if (integration.provider === 'telegram' && message.text.trim().toLowerCase() === '/start') {
      await conn.connector.sendMessage(chatId, { text: "You're connected. Send a message to start." }).catch(() => {})
      return
    }

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

    // Revoke can land mid-flight (during the awaits above). Re-check before spending.
    if (!isChatAllowed(integrationId, chatId)) return

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

    // Look up existing session, rotating if timed out
    let chatSession = resolveActiveSession(
      integrationId, chatId, integration.sessionTimeout,
      (archivedId) => {
        breadcrumb('Session timed out, rotating', { integrationId, chatId, timeoutHours: integration.sessionTimeout })
        this.teardownManagedSession(integrationId, chatId)
        this.lastSessionTouch.delete(archivedId)
      },
    )

    if (!chatSession) {
      // New chat — create a new agent session
      try {
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

        // Revoke can land mid-flight (during the awaits above). Re-check before spending.
        if (!isChatAllowed(integrationId, chatId)) return

        await this.startNewChatSession(integration, client, chatId, message, messageText)
        return // initialMessage already sent via createSession
      } catch (err) {
        console.error(`[ChatIntegrationManager] Failed to create new session for ${integrationId}:`, err)
        // This path recovers and prompts the user to retry. A dead container
        // ("Container is not running") is expected and self-healing here, so
        // report it as a warning rather than an error to cut Sentry noise.
        reportError(err, 'create-session', { integrationId, agentSlug: integration.agentSlug, provider: integration.provider, chatId }, isContainerNotRunning(err) ? 'warning' : 'error')
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

    // Hoisted so the catch can reuse it for self-heal without re-downloading.
    let messageText = ''
    try {
      if (!messagePersister.isSubscribed(sessionId)) {
        await messagePersister.subscribeToSession(sessionId, client, sessionId, integration.agentSlug)
      }

      // Ensure SSE → chat forwarding is active (may have been torn down by reconnect)
      this.subscribeChatSession(integrationId, chatId, sessionId)

      const built = await this.buildMessageContent(integration, message)
      messageText = built.text
      const failedFiles = built.failedFiles

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

      // Revoke can land mid-flight (during the awaits above). Re-check before spending.
      if (!isChatAllowed(integrationId, chatId)) return

      await client.sendMessage(sessionId, messageText)
      messagePersister.markSessionActive(sessionId, integration.agentSlug)
      const now = Date.now()
      const lastTouch = this.lastSessionTouch.get(chatSession.id) ?? 0
      if (now - lastTouch > 60_000) {
        try { touchChatIntegrationSession(chatSession.id) } catch { /* best-effort */ }
        this.lastSessionTouch.set(chatSession.id, now)
      }
    } catch (err) {
      // Self-heal: the container no longer has this agent session (e.g. it was
      // evicted and could not be resumed). Without recovery, resolveActiveSession
      // keeps returning this dead row, so EVERY future message to this chat would
      // fail. Archive the stale mapping and transparently start a fresh session
      // with the same message. Transient failures (dead container, network) are
      // NOT session-gone, so they keep the retry prompt below.
      if (this.isSessionGoneError(err)) {
        console.warn(`[ChatIntegrationManager] Agent session ${sessionId} gone in container; rotating chat ${chatId} to a fresh session`)
        breadcrumb('Chat agent session gone, self-healing', { integrationId, chatId, sessionId })
        this.teardownManagedSession(integrationId, chatId, { archive: chatSession.id })
        try {
          // messageText is already built unless we failed before it (e.g. the
          // subscribe threw); rebuild in that rare case so the message isn't lost.
          if (!messageText) {
            messageText = (await this.buildMessageContent(integration, message)).text
          }
          // Revoke can land mid-flight (during the awaits above). Re-check before spending.
          if (!isChatAllowed(integrationId, chatId)) return
          await this.startNewChatSession(integration, client, chatId, message, messageText)
          return
        } catch (healErr) {
          console.error(`[ChatIntegrationManager] Self-heal failed for ${integrationId}/${chatId}:`, healErr)
          reportError(healErr, 'send-message-selfheal', { integrationId, chatId, provider: integration.provider }, isContainerNotRunning(healErr) ? 'warning' : 'error')
          await conn.connector.sendMessage(chatId, { text: 'Error: Failed to send your message to the agent. Please try again.' }).catch(() => {})
          return
        }
      }

      console.error(`[ChatIntegrationManager] Failed to send message for ${integrationId}/${sessionId}:`, err)
      // Recovered path (user is told to retry); a dead container is expected and
      // self-healing, so downgrade it to a warning to cut Sentry noise.
      reportError(err, 'send-message', { integrationId, sessionId, provider: integration.provider, chatId }, isContainerNotRunning(err) ? 'warning' : 'error')
      await conn.connector.sendMessage(chatId, { text: 'Error: Failed to send your message to the agent. Please try again.' }).catch(() => {})
      return
    }

    // Show the "Thinking…" indicator (the connector keeps it alive) until the first token streams.
    const dispatched = this.chatSessions.get(this.getChatSessionKey(integrationId, chatId))
    if (dispatched) {
      // New user turn: re-allow exactly one terminal notice (the watchdog stall
      // notice OR the session_error message). Reset here, once per turn, rather
      // than on every stream_start, so a single multi-stall turn can't emit
      // repeated notices.
      dispatched.turnNotified = false
      dispatched.connector.startWorking(dispatched.chatId).catch(() => {})
      armWorkingWatchdog(dispatched)
    }
  }

  /**
   * Create a fresh agent session for a chat, persist the (integration, chat) →
   * session mapping, and wire up SSE forwarding. `messageText` is sent as the
   * session's initial message via createSession. Callers build messageText (and
   * surface any failed-download warnings) and archive any prior session for this
   * chat first. Shared by the new-chat path and the send-time self-heal.
   */
  private async startNewChatSession(
    integration: ChatIntegration,
    client: ContainerClient,
    chatId: string,
    message: IncomingMessage,
    messageText: string,
  ): Promise<void> {
    const { getEffectiveModels } = await import('@shared/lib/config/settings')
    const { getSecretEnvVars } = await import('@shared/lib/services/secrets-service')
    const { registerSession, updateSessionMetadata } = await import('@shared/lib/services/session-service')

    const availableEnvVars = await getSecretEnvVars(integration.agentSlug)
    const models = getEffectiveModels()

    const containerSession = await client.createSession({
      availableEnvVars: availableEnvVars.length > 0 ? availableEnvVars : undefined,
      initialMessage: messageText,
      model: integration.model || models.agentModel,
      browserModel: models.browserModel,
      dashboardBuilderModel: models.dashboardBuilderModel,
      ...(integration.effort ? { effort: integration.effort as EffortLevel } : {}),
      ...(integration.provider === 'imessage' ? { systemPrompt: IMESSAGE_SYSTEM_PROMPT } : {}),
    })

    const sessionId = containerSession.id
    breadcrumb('New chat session created', { integrationId: integration.id, sessionId, provider: integration.provider })

    const displayName = this.deriveDisplayName(integration.provider, message)
    const sessionName = buildSessionName(
      integration.name,
      integration.provider,
      displayName,
      integration.sessionTimeout,
    )

    await registerSession(integration.agentSlug, sessionId, sessionName)
    await updateSessionMetadata(integration.agentSlug, sessionId, {
      isChatIntegrationSession: true,
      chatIntegrationId: integration.id,
      ...(integration.createdByUserId ? { createdByUserId: integration.createdByUserId } : {}),
    })

    createChatIntegrationSession({
      integrationId: integration.id,
      externalChatId: chatId,
      sessionId,
      displayName,
    })

    await messagePersister.subscribeToSession(sessionId, client, sessionId, integration.agentSlug)
    messagePersister.markSessionActive(sessionId, integration.agentSlug)
    this.subscribeChatSession(integration.id, chatId, sessionId)
  }

  /**
   * True when a container call failed because the agent session no longer exists
   * there (evicted / not resumable) — as opposed to a transient container or
   * network error. Gates the send-time self-heal so only genuinely-gone sessions
   * are rotated, while transient errors still surface a retry prompt.
   */
  private isSessionGoneError(err: unknown): boolean {
    if (!(err instanceof Error)) return false
    // Matches both shapes the container surfaces: the 404 guard's generic
    // "Session not found" (host client: "Failed to send message: Session not
    // found") and the resume-failure form "Session <id> not found".
    return /session(\s+\S+)?\s+not\s+found/i.test(err.message)
  }

  /** Stop a chat session's live streaming: drop the SSE subscription and the working indicator. */
  private stopSession(session: ManagedConnector): void {
    session.sseUnsubscribe?.()
    session.connector.stopWorking(session.chatId).catch(() => {})
    clearWorkingWatchdog(session)
  }

  private teardownManagedSession(integrationId: string, chatId: string, opts?: { archive?: string }): void {
    const key = this.getChatSessionKey(integrationId, chatId)
    const managed = this.chatSessions.get(key)
    if (managed) this.stopSession(managed)
    this.chatSessions.delete(key)
    if (opts?.archive) {
      this.lastSessionTouch.delete(opts.archive)
      try { archiveChatIntegrationSession(opts.archive) } catch { /* best-effort */ }
    }
  }

  private async clearChatSession(
    integrationId: string,
    chatId: string,
    connector: ChatClientConnector,
  ): Promise<void> {
    try {
      const chatSession = getChatIntegrationSession(integrationId, chatId)
      if (chatSession) {
        this.teardownManagedSession(integrationId, chatId, { archive: chatSession.id })
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
    for (const [key, managed] of this.chatSessions) {
      const [integrationId, chatId] = key.split(':')
      const chatSession = getChatIntegrationSession(integrationId, chatId)
      if (chatSession?.id === sessionId) {
        this.stopSession(managed)
        this.chatSessions.delete(key)
        break
      }
    }
  }

  /**
   * Send the "you're approved" notice to an external chat.
   * Best-effort: exceptions are captured but do NOT roll back the approval.
   */
  async notifyChatApproved(integrationId: string, externalChatId: string): Promise<void> {
    const conn = this.connections.get(integrationId)
    if (!conn) return
    try {
      await conn.connector.sendMessage(externalChatId, { text: "You're approved. Send a message to start." })
    } catch (e) {
      captureException(e, { tags: { component: COMPONENT, operation: 'approve-notice' }, level: 'warning' })
    }
  }

  /**
   * Tear down the managed chat session for a revoked external chat:
   * unsubscribes SSE delivery and archives the DB session row.
   */
  async tearDownChatSession(integrationId: string, externalChatId: string): Promise<void> {
    const session = getChatIntegrationSession(integrationId, externalChatId)
    if (!session) return
    this.teardownManagedSession(integrationId, externalChatId)
    archiveChatIntegrationSession(session.id)
  }

  /**
   * Reconcile running sessions against current access (called when approval is
   * enabled). Tears down any active session whose chat is no longer allowed, so
   * a flip to require-approval immediately gates previously-public conversations.
   */
  async reconcileAccess(integrationId: string): Promise<void> {
    const sessions = listChatIntegrationSessions(integrationId)
    for (const session of sessions) {
      if (session.archivedAt) continue
      if (!isChatAllowed(integrationId, session.externalChatId)) {
        await this.tearDownChatSession(integrationId, session.externalChatId)
      }
    }
  }

  private deriveDisplayName(_provider: string, message: IncomingMessage): string | undefined {
    const baseName = deriveDisplayName(message)

    // Per-thread sessions use composite chatId (channelId|threadTs) — append datetime
    if (message.chatId.includes('|')) {
      const d = message.timestamp
      const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      const label = `${date}, ${time}`
      return baseName ? `${baseName} — ${label}` : label
    }

    return baseName
  }

  /**
   * Build message text, downloading any file attachments to the agent workspace
   * and appending them using the same [Attached files:] format the UI uses.
   */
  private async buildMessageContent(
    integration: ChatIntegration,
    message: IncomingMessage,
  ): Promise<{ text: string; failedFiles: string[] }> {
    // In group/channel contexts, prefix with sender name so the agent can attribute messages.
    const prefix = message.chatName && message.userName ? `\\[${message.userName}]: ` : ''
    const text = prefix + (message.text || '')

    if (!message.files || message.files.length === 0) {
      return { text, failedFiles: [] }
    }

    const { appendAttachedFiles } = await import('@shared/lib/utils/attached-files')
    const uploadedPaths: string[] = []
    const failedFiles: string[] = []

    let transcribedText = text
    for (const file of message.files) {
      if (!file.url) {
        failedFiles.push(file.name)
        continue
      }

      try {
        const data = await this.downloadFileBuffer(integration, file.url)
        if (data) {
          // For iMessage voice notes, try to transcribe audio files
          if (integration.provider === 'imessage' && file.mimeType?.startsWith('audio/')) {
            const transcript = await this.tryTranscribeAudio(data, file.mimeType)
            if (transcript) {
              transcribedText = (transcribedText ? transcribedText + '\n' : '') + `[Voice note: "${transcript}"]`
              continue
            }
            // Transcription unavailable — fall through to file attachment
            transcribedText = (transcribedText ? transcribedText + '\n' : '') + '[Voice note — transcription unavailable]'
          }
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

    return { text: appendAttachedFiles(transcribedText, uploadedPaths), failedFiles }
  }

  /** Download a file from the chat platform, returning a Buffer. */
  private async downloadFileBuffer(integration: ChatIntegration, fileUrl: string): Promise<Buffer | null> {
    try {
      const config = parseChatIntegrationConfig(
        integration.provider as ChatProvider,
        integration.config,
      )
      if (!config) return null

      if (integration.provider === 'slack' && 'botToken' in config) {
        return await this.downloadSlackFile(config.botToken, fileUrl)
      }

      // Telegram & iMessage: direct URL download (no auth needed)
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

  /**
   * Download a URL with Bearer auth, following redirects manually.
   *
   * The Slack bot token is attached ONLY when the next hop is an HTTPS request
   * to a trusted Slack host (SUP-232). Slack download URLs redirect to signed S3
   * URLs whose auth lives in the query string, so dropping the header on
   * cross-origin hops does not break legitimate downloads — but it prevents the
   * xoxb token from leaking to an attacker-controlled redirect target.
   */
  private async downloadWithAuth(url: string, token: string): Promise<Buffer | null> {
    let target = tryParseUrl(url)
    if (!target) {
      console.error('[ChatIntegrationManager] Invalid Slack download URL')
      return null
    }

    const headersFor = (u: URL): Record<string, string> =>
      isTrustedSlackDownloadHost(u) ? { 'Authorization': `Bearer ${token}` } : {}

    let response = await fetch(target.toString(), { headers: headersFor(target), redirect: 'manual' })
    // Follow redirects, re-evaluating auth for every hop.
    let redirects = 0
    while (response.status >= 300 && response.status < 400 && redirects < 5) {
      const location = response.headers.get('location')
      if (!location) break
      // Resolve relative redirects against the current URL.
      const next = tryParseUrl(location, target)
      if (!next) {
        console.error('[ChatIntegrationManager] Invalid redirect location in Slack download')
        return null
      }
      target = next
      response = await fetch(target.toString(), { headers: headersFor(target), redirect: 'manual' })
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

    // External attachment names are attacker-controlled — sanitize to a safe
    // basename so `../` segments cannot escape the uploads directory (SUP-231).
    const safeName = sanitizeUploadFilename(filename)
    const uploadName = `${Date.now()}-${safeName}`
    const workspaceDir = getAgentWorkspaceDir(agentSlug)
    const uploadsDir = path.resolve(workspaceDir, 'uploads')
    const fullPath = path.resolve(uploadsDir, uploadName)

    // Defense in depth: never write outside uploads even if sanitization is
    // weakened in the future. Throws on escape.
    assertPathWithinDir(uploadsDir, fullPath, 'Resolved upload path escapes the uploads directory')

    await fs.promises.mkdir(uploadsDir, { recursive: true })
    await fs.promises.writeFile(fullPath, data)

    return `/workspace/uploads/${uploadName}`
  }

  /** Pre-warm the agent container so it's ready when the user's message arrives. */
  private preWarmContainer(agentSlug: string): void {
    import('@shared/lib/container/container-manager').then(({ containerManager }) => {
      containerManager.ensureRunning(agentSlug).catch(() => {
        // Best-effort — if it fails, the normal message flow will handle the error
      })
    }).catch(() => {})
  }

  /** Try to transcribe an audio buffer using the configured STT provider. Returns null on failure. */
  private async tryTranscribeAudio(audioBuffer: Buffer, mimeType: string): Promise<string | null> {
    try {
      const { getConfiguredSttProvider } = await import('@shared/lib/stt')
      const provider = getConfiguredSttProvider()
      if (!provider || !provider.supportsTranscription()) return null
      const transcript = await provider.transcribe(audioBuffer, mimeType)
      return transcript || null
    } catch (err) {
      console.error('[ChatIntegrationManager] Audio transcription failed:', err)
      reportError(err, 'transcribe-audio', {}, 'warning')
      return null
    }
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

    // Fail closed: never forward agent output to a chat that is no longer allowed.
    // Teardown normally unsubscribes on revoke/deny, but this guards the window
    // where an event is already in flight when access is revoked.
    if (!isChatAllowed(integrationId, chatId)) return

    const showToolCalls = getChatIntegration(integrationId)?.showToolCalls ?? false
    await processSSEEvent(session, event, showToolCalls)
  }

  // ── Interactive response handling ─────────────────────────────────

  private async handleInteractiveResponse(
    integrationId: string,
    toolUseId: string,
    response: unknown,
    chatId?: string,
  ): Promise<void> {
    if (!isChatAllowed(integrationId, chatId ?? '')) return // revoked/stale keyboard, or missing identity → fail closed

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

// ── Working-indicator teardown + idle watchdog ─────────────────────────

/**
 * Tear down a turn's live UI: stop the working indicator (kills the keep-alive
 * heartbeat), commit any streamed text, and settle pending tool pills. Shared by
 * session_idle, session_error, and the idle watchdog so every terminal path
 * clears the indicator the same way. Idempotent.
 */
async function settleTurn(managed: ManagedConnector): Promise<void> {
  clearWorkingWatchdog(managed)
  managed.connector.stopWorking(managed.chatId).catch(() => {})
  try {
    await finalizeStreaming(managed)
    await resolvePendingToolMessages(managed)
  } catch (err) {
    console.error('[ChatIntegrationManager] Failed to finalize turn:', err)
    reportError(err, 'settle-turn', { integrationId: managed.integration.id, chatId: managed.chatId })
  }
}

/** Clear the idle watchdog timer (if armed). */
function clearWorkingWatchdog(managed: ManagedConnector): void {
  if (managed.watchdogTimer) {
    clearTimeout(managed.watchdogTimer)
    managed.watchdogTimer = null
  }
}

/**
 * (Re)arm the idle watchdog. Called when the working indicator is shown (dispatch
 * / stream_start) and reset on every subsequent SSE event, so it fires only after
 * a full WORKING_WATCHDOG_MS of total silence — a stalled turn that never emits a
 * terminal event.
 */
function armWorkingWatchdog(managed: ManagedConnector): void {
  clearWorkingWatchdog(managed)
  const timer = setTimeout(() => {
    // Ignore a stale fire. If the watchdog was cleared or re-armed after this
    // timer was scheduled (clearTimeout can't un-queue an already-fired timer),
    // managed.watchdogTimer no longer points at us — do nothing.
    if (managed.watchdogTimer !== timer) return
    managed.watchdogTimer = null
    void onWorkingWatchdogFired(managed)
  }, WORKING_WATCHDOG_MS)
  managed.watchdogTimer = timer
}

/** Reset the watchdog only if it is currently armed — any SSE event proves liveness. */
function resetWatchdogIfRunning(managed: ManagedConnector): void {
  if (managed.watchdogTimer) armWorkingWatchdog(managed)
}

async function onWorkingWatchdogFired(managed: ManagedConnector): Promise<void> {
  console.warn(
    `[ChatIntegrationManager] Working-indicator watchdog fired after ${WORKING_WATCHDOG_MS}ms of silence (chat ${managed.chatId})`,
  )
  reportError(
    new Error('working-indicator watchdog fired after SSE silence'),
    'working-indicator-watchdog',
    {
      integrationId: managed.integration.id,
      chatId: managed.chatId,
      agentSlug: managed.integration.agentSlug,
      silenceMs: WORKING_WATCHDOG_MS,
    },
    'warning',
  )
  await settleTurn(managed)
  // Notify at most once per turn: if a near-simultaneous session_error already
  // surfaced its message, don't pile a second notice on top. Softened copy — the
  // watchdog can be a false positive on a slow-but-alive turn, so it must not
  // flatly assert the agent died.
  if (!managed.turnNotified) {
    managed.turnNotified = true
    try {
      await managed.connector.sendMessage(managed.chatId, {
        text: "⚠️ This is taking longer than expected. If you don't see a reply soon, send your message again.",
      })
    } catch {
      // Delivery failed — release the latch so a later terminal notice (e.g. a real
      // session_error) can still reach the user instead of being suppressed.
      managed.turnNotified = false
    }
  }
}

/**
 * A short, user-facing message for a turn that ended in an error. Curated by the
 * SDK error code; never echoes the raw internal error (which can leak file paths,
 * tokens, or stack text into the chat).
 */
function friendlyErrorMessage(apiErrorCode: string | null | undefined): string {
  const code = (apiErrorCode ?? '').toLowerCase()
  if (code.includes('overload')) return '⚠️ The assistant is overloaded right now. Please try again in a moment.'
  if (code.includes('rate') || code.includes('429')) return '⚠️ Hit a rate limit. Please wait a few seconds and try again.'
  if (code.includes('auth') || code.includes('permission')) return '⚠️ The assistant could not authenticate. Please check the integration settings.'
  if (code.includes('context') || code.includes('too_long') || code.includes('too_large') || code.includes('length')) {
    return '⚠️ This conversation got too long for the assistant. Try starting a new conversation.'
  }
  return '⚠️ The assistant hit an error and stopped. Please try again.'
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

  // Any agent activity proves the turn is alive: push the idle watchdog out.
  // No-op when the indicator isn't currently armed.
  resetWatchdogIfRunning(managed)

  switch (eventType) {
    case 'stream_delta': {
      const text = data.text as string
      if (!text) break
      // First token of this segment: the response is streaming now, so drop "Thinking…".
      // Guard on the empty accumulator so stopWorking fires once on the transition,
      // not on every streamed token.
      if (managed.streamingState.accumulatedText === '') {
        managed.connector.stopWorking(managed.chatId).catch(() => {})
        clearWorkingWatchdog(managed)
      }
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
      // "Thinking…" again for the next segment. startWorking self-keep-alives, so a
      // long gap before the next token no longer drops it; the first token replaces it.
      managed.connector.startWorking(managed.chatId).catch(() => {})
      armWorkingWatchdog(managed)
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

      // Note: deliver_file is handled off its tool_result (see 'tool_result_ready'
      // below), not off the streamed input — so we never read a host-side path
      // before the in-container tool has validated the file exists. It falls
      // through to isUserRequestTool() here, which just resets the tool input.

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

    case 'tool_result_ready': {
      // Fired once the in-container tool has returned its result. Currently only
      // deliver_file acts on it: deliver the file to the chat client, but only if
      // the tool validated the file exists (isError === false). On an error
      // result we skip host delivery — the agent's text already covers the user.
      const toolName = data.toolName as string
      if (toolName === 'mcp__user-input__deliver_file' && !data.isError) {
        const filePath = data.filePath as string | undefined
        const description = data.description as string | undefined
        if (filePath) {
          try {
            await sendDeliveredFile(managed, filePath, description)
          } catch (err) {
            console.error('[ChatIntegrationManager] Failed to deliver file:', err)
            reportError(err, 'deliver-file', { integrationId: managed.integration.id, provider: managed.integration.provider })
          }
        }
      }
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
      // The agent is now waiting on the user, so the silence that follows is the
      // human, not a stall — pause the idle watchdog until the next turn re-arms it.
      clearWorkingWatchdog(managed)
      try {
        await managed.connector.sendUserRequestCard(managed.chatId, data as UserRequestEvent)
      } catch (err) {
        console.error(`[ChatIntegrationManager] Failed to send user request card (${eventType}):`, err)
        reportError(err, 'send-user-request-card', { integrationId: managed.integration.id, provider: managed.integration.provider, eventType })
      }
      break
    }

    case 'session_idle': {
      await settleTurn(managed)
      break
    }

    case 'session_error': {
      // An errored turn emits session_error (NOT session_idle), and the host
      // suppresses the later authoritative idle. Without this case the working
      // indicator's keep-alive heartbeat is never torn down and re-stamps
      // "Thinking…" forever. Settle the turn the same way session_idle does, then
      // surface the error so the user isn't left staring at a frozen indicator.
      await settleTurn(managed)
      if (!managed.turnNotified) {
        managed.turnNotified = true
        try {
          await managed.connector.sendMessage(managed.chatId, { text: friendlyErrorMessage(data.apiErrorCode as string | null) })
        } catch (err) {
          // Delivery failed — release the latch so a later notice isn't suppressed.
          managed.turnNotified = false
          console.error('[ChatIntegrationManager] Failed to send error message:', err)
        }
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
  const messageId = managed.streamingState.currentMessageId

  // Claim the buffer synchronously, before the first await, so a concurrent
  // finalize (e.g. the idle watchdog tearing down while a late stream event is
  // processed) reads an empty buffer and can't double-send the same text. The
  // reset previously ran only after the await, leaving that window open.
  managed.streamingState = {
    currentMessageId: null,
    accumulatedText: '',
    lastUpdateTime: 0,
  }

  try {
    if (messageId) {
      try {
        await managed.connector.finalizeStreamingMessage(managed.chatId, messageId, finalText)
      } catch {
        await managed.connector.sendMessage(managed.chatId, { text: finalText })
      }
    } else {
      await managed.connector.sendMessage(managed.chatId, { text: finalText })
    }
  } catch (err) {
    // Both delivery attempts failed (chat unreachable) — nothing reached the user.
    // Restore the claimed buffer so a later terminal path can retry, but only if it
    // is still empty, so we never overwrite newer streamed text (a later stream_delta
    // repopulated it). Re-throw so callers log/handle the failure exactly as before.
    if (!managed.streamingState.accumulatedText) {
      managed.streamingState = { currentMessageId: messageId, accumulatedText: finalText, lastUpdateTime: 0 }
    }
    throw err
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

  // Security: ensure path doesn't escape workspace. A bare startsWith() check is
  // unsafe — a sibling workspace sharing the path prefix (agent vs agent-victim)
  // would pass — so use prefix-safe isPathWithinDir (path.relative based).
  if (!isPathWithinDir(workspaceDir, fullPath)) {
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
    // ENOENT is benign: the file isn't host-visible (e.g. a not-yet-flushed
    // write across the VM file-share). The text fallback below still reaches the
    // user, so don't page Sentry — log everything else at 'warning'.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      reportError(err, 'send-delivered-file', { integrationId: managed.integration.id, provider: managed.integration.provider, filePath }, 'warning')
    }
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

export { formatSessionTimestamp } from './utils'

/** Decide whether a chat session should be rotated based on the configured timeout. */
export function shouldRotateSession(
  session: { updatedAt: Date | null; createdAt: Date },
  timeoutHours: number | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!timeoutHours || timeoutHours <= 0) return false
  const lastActivity = session.updatedAt?.getTime?.() ?? session.createdAt.getTime()
  const timeoutMs = timeoutHours * 60 * 60 * 1000
  return now.getTime() - lastActivity > timeoutMs
}

/** Build the session name, appending a timestamp when session rotation is enabled. */
export function buildSessionName(
  integrationName: string | null,
  provider: string,
  displayName: string | undefined,
  timeoutHours: number | null | undefined,
  now: Date = new Date(),
): string {
  const baseName = displayName
    ? `${integrationName || provider} — ${displayName}`
    : integrationName || `${provider} chat`

  if (timeoutHours && timeoutHours > 0) {
    return `${baseName} — ${formatSessionTimestamp(now)}`
  }
  return baseName
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
