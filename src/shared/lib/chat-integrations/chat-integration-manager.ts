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

import type { ChatClientConnector, ChatConnectorClass, IncomingMessage } from './base-connector'
import type { UserRequestEvent } from '@shared/lib/tool-definitions/types'
import type { SessionActivity } from '@shared/lib/types/agent'
import { getToolDefinition } from '@shared/lib/tool-definitions/registry'
import { formatToolName } from '@shared/lib/tool-definitions/types'
import { parseChatIntegrationConfig, type ChatProvider } from './config-schema'
import { formatProviderName, formatSessionTimestamp } from './utils'
import { consumeOrCancelAwaitingInput } from './resolve-awaiting-input'
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
import type { EffortLevel, SpeedLevel, ContainerClient } from '@shared/lib/container/types'
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

const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000
const HEALTH_CHECK_ERROR_THRESHOLD_MS = 5 * 60 * 1000
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
  // Pull-model indicator state. `indicatorShown` makes the clear idempotent so
  // idle ticks make zero connector calls; `indicatorTickTimer` is the per-session
  // sampling tick, alive for the SSE subscription (started on subscribe, cleared
  // on teardown).
  indicatorShown?: boolean
  indicatorTickTimer?: ReturnType<typeof setInterval> | null
  // The session the tick samples; set when the tick is armed (subscribe / wake) so the
  // sleep guard and the health-check backstop can re-read getSessionActivity(sessionId).
  sessionId?: string
  // Pending idle-sleep debounce. Scheduled when the session settles non-busy; when it
  // fires it re-reads activity and stops the tick only if STILL non-busy (so a stale or
  // type-mismatched sleep can't strand a working session). Cleared wherever the tick is.
  sleepTimer?: ReturnType<typeof setTimeout> | null
  // True once the session_error notice has gone out for the current turn, so a
  // turn can't emit duplicate notices.
  turnNotified?: boolean
  // True while a /stop is being processed for this chat. The priority lane runs
  // concurrent /stops (they bypass the serial queue), so this latch keeps a double-tap
  // or tap+typed /stop from double-interrupting or trailing a contradictory ack.
  stopInFlight?: boolean
  // Stall-nudge silence timer (see armStallNudge). Named to make its job
  // unmistakable: it NEVER paints or clears the indicator.
  stallNudgeTimer?: ReturnType<typeof setTimeout> | null
  // True once this turn's stall nudge has gone out, so a turn nudges at most once.
  stallNotified?: boolean
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
  // Integrations with a rebuild in flight. Reconcile passes (5-min tick, resume,
  // resume follow-ups) can overlap when a connect hangs; this keeps any one
  // integration from being torn down by one pass while another is mid-connect.
  private reconcilingIds: Set<string> = new Set()
  // Per-integration lifecycle generation. Every PUBLIC lifecycle mutation
  // (add/remove/pause/resume — and config update, which is remove+add) bumps
  // it; background work (rebuilds, in-flight connects) captures the value up
  // front and treats any change as CANCELLATION. A rebuild spans two await
  // gaps (teardown, connect) and a user operation landing in either used to
  // let the rebuild reconnect from its stale row snapshot — resurrecting a
  // paused integration or restoring pre-update credentials — and clobber the
  // status the user's operation just wrote.
  private generations: Map<string, number> = new Map()
  // In-flight system-resume pass; concurrent reconnectAll calls coalesce onto it.
  private resumeReconcile: Promise<void> | null = null
  // A resume arrived while a pass was in flight: run one more FORCE pass when
  // the current one finishes (its follow-ups are force:false, and the second
  // wake's sockets are suspect again — isConnected() can read stale-true).
  private resumeQueued = false
  // Follow-up delays after the resume force pass, while anything is still down.
  private static readonly RESUME_RETRY_DELAYS_MS = [15_000, 30_000, 60_000]
  // Upper bound on waiting for an old connector to tear down before rebuilding.
  private static readonly DISCONNECT_TIMEOUT_MS = 5_000
  // Per-(integration,chat) serialized tail promise. Entries self-evict once their
  // chain settles (see scheduleQueueEviction), so the map stays bounded.
  private messageQueues: Map<string, Promise<void>> = new Map()
  private lastSessionTouch: Map<string, number> = new Map()
  // Per-(integration,chat) monotonic interrupt counter, bumped each time /stop actually
  // interrupts a turn. A normal-message send captures it before its awaits and abandons
  // itself if a concurrent /stop bumped it mid-flight — otherwise the send would resurrect
  // a turn the user just stopped (the priority lane lets /stop interleave a suspended send).
  // Keyed by the stable chat key (not the mutable ManagedConnector, which may not exist yet
  // on a cold/reconnect path); evicted with the session in teardownManagedSession.
  private stopEpochs: Map<string, number> = new Map()

  // ── Lifecycle ───────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true

    const integrations = listStartupChatIntegrations()

    for (const integration of integrations) {
      try {
        const connected = await this.connectIntegration(integration)
        // Clear error status on successful reconnect
        if (connected && integration.status === 'error') {
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

    // Positive start signal: startup.ts only logs start() FAILURES, so without
    // this a dead manager is indistinguishable from a healthy idle one.
    console.log(`[ChatIntegrationManager] Started (${integrations.length} startup integration(s))`)
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

    // Disconnect all integrations (fire-and-forget: stop() is shutdown-path sync)
    for (const [, conn] of this.connections) {
      void this.disconnectConnection(conn)
    }
    this.connections.clear()
    this.disconnectedSince.clear()
    this.consecutiveFailures.clear()
    this.reconcilingIds.clear()
    this.generations.clear()
    this.messageQueues.clear()
    this.isRunning = false
  }

  // ── Lifecycle generations ───────────────────────────────────────────

  private bumpGeneration(id: string): number {
    const next = (this.generations.get(id) ?? 0) + 1
    this.generations.set(id, next)
    return next
  }

  private generationOf(id: string): number {
    return this.generations.get(id) ?? 0
  }

  // ── Public API ──────────────────────────────────────────────────────

  async reconnectAll(): Promise<void> {
    if (!this.isRunning) return
    // Overlap guard: resume events can fire in quick bursts (short lid cycles);
    // racing two full teardown/rebuild passes produced concurrent connect/stop
    // on the same integration. Coalesce onto the in-flight pass — but queue one
    // more FORCE pass, because the in-flight pass's follow-ups are force:false
    // and can't be trusted to rebuild sockets the second sleep re-broke.
    if (this.resumeReconcile) {
      this.resumeQueued = true
      return this.resumeReconcile
    }

    console.log('[ChatIntegrationManager] Reconnecting all integrations (system resume)')
    this.resumeReconcile = (async () => {
      try {
        do {
          this.resumeQueued = false
          await this.reconcileIntegrations({ force: true })
          // The force pass races the network coming back up, so failures are
          // expected; they're no longer orphans, but the next regular tick is up
          // to 5 minutes out — too long right after opening the lid. Run a few
          // quick follow-ups while anything is still down.
          for (const delayMs of ChatIntegrationManager.RESUME_RETRY_DELAYS_MS) {
            if (this.resumeQueued) break // a fresh wake wants a full force pass instead
            if (!this.hasDisconnectedIntegrations()) break
            await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
            if (!this.isRunning) return
            await this.reconcileIntegrations({ force: false })
          }
        } while (this.resumeQueued && this.isRunning)
      } finally {
        this.resumeReconcile = null
        this.resumeQueued = false
      }
    })()
    return this.resumeReconcile
  }

  private hasDisconnectedIntegrations(): boolean {
    return listStartupChatIntegrations().some(
      (i) => !(this.connections.get(i.id)?.connector.isConnected() ?? false),
    )
  }

  async addIntegration(id: string): Promise<void> {
    const integration = getChatIntegration(id)
    if (!integration) throw new Error(`Chat integration ${id} not found`)
    await this.connectIntegration(integration)
  }

  async removeIntegration(id: string): Promise<void> {
    // Public removal (delete, pause, config update): this operation owns the
    // integration from here on — any in-flight background rebuild or connect
    // for the same id must cancel itself rather than resurrect it.
    this.bumpGeneration(id)
    await this.teardownConnection(id)
  }

  /** Internal teardown: no generation bump — rebuilds tear down without ceding ownership. */
  private async teardownConnection(id: string): Promise<void> {
    // Remove all chat sessions for this integration
    for (const [key, session] of this.chatSessions) {
      if (key.startsWith(`${id}:`)) {
        this.stopSession(session)
        this.chatSessions.delete(key)
      }
    }
    // Remove the connection. The teardown is awaited (bounded) so a rebuild
    // can't start while the old socket is still live — gateways that allow one
    // connection per identity kick whichever side loses the race (the iMessage
    // code=4000 "replaced by another connection" fights).
    const conn = this.connections.get(id)
    if (conn) {
      this.connections.delete(id)
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        this.disconnectConnection(conn),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, ChatIntegrationManager.DISCONNECT_TIMEOUT_MS) }),
      ])
      clearTimeout(timer)
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

  isIntegrationConnected(integrationId: string): boolean {
    const conn = this.connections.get(integrationId)
    return conn?.connector.isConnected() ?? false
  }

  getActiveIntegrationIds(): string[] {
    return [...this.connections.keys()]
  }

  // ── Connection setup ────────────────────────────────────────────────

  /**
   * Build, register, and connect a connector for `integration`.
   *
   * Returns true when the connection is live AND this call still owns the
   * integration; false when the connect was CANCELLED — a newer lifecycle
   * operation (pause/remove/config update/newer connect) took ownership while
   * we were mid-flight, and its socket (if one opened) has been torn down.
   * Callers must treat false as "stand down", not as success.
   *
   * `expectedGeneration` is passed by rebuilds that captured the generation
   * earlier; user-driven calls omit it and take ownership here via a bump.
   */
  private async connectIntegration(integration: ChatIntegration, expectedGeneration?: number): Promise<boolean> {
    const id = integration.id
    const generation = expectedGeneration ?? this.bumpGeneration(id)

    if (this.connections.has(id)) {
      await this.teardownConnection(id)
      // A newer lifecycle operation landed while we waited on the teardown.
      if (this.generationOf(id) !== generation) return false
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
      // Tear down only what we still own: a newer connect may have replaced
      // our map entry while this one was failing, and removing THAT would
      // silently kill the healthy winner.
      if (this.connections.get(id) === conn) {
        this.connections.delete(id)
        void this.disconnectConnection(conn)
      } else {
        connector.disconnect().catch(() => {})
      }
      throw err
    }
    // A pause/remove/newer-connect that raced the connect owns the teardown
    // now (generation moved, or the map entry is no longer ours) — and a
    // stopped manager must not be resurrected past its stop(). Don't wire up
    // subscriptions for a connection the user just removed; tear down the
    // freshly opened, now-ownerless socket.
    if (this.connections.get(id) !== conn || this.generationOf(id) !== generation || !this.isRunning) {
      if (this.connections.get(id) === conn) this.connections.delete(id)
      void this.disconnectConnection(conn)
      return false
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
    return true
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

  /**
   * Resolve a provider's connector CLASS for static capability lookups (e.g.
   * generateSystemPrompt, discoveryCapabilities, classifyChatId). Mirrors
   * createConnector's lazy imports — connector modules stay unloaded until
   * their provider is actually used. Returns undefined for unknown providers
   * rather than throwing: static lookups are best-effort decorations, not
   * connection attempts. Public so API routes can label listings and advertise
   * capabilities without a live connector.
   */
  async getConnectorClass(provider: string): Promise<ChatConnectorClass | undefined> {
    switch (provider) {
      case 'telegram':
        return (await import('./telegram-connector')).TelegramConnector
      case 'slack':
        return (await import('./slack-connector')).SlackConnector
      case 'imessage':
        return (await import('./imessage-connector')).IMessageConnector
      default:
        return undefined
    }
  }

  private disconnectConnection(conn: IntegrationConnection): Promise<void> {
    conn.messageUnsubscribe?.()
    conn.interactiveUnsubscribe?.()
    conn.errorUnsubscribe?.()
    conn.typingHintUnsubscribe?.()
    return conn.connector.disconnect().catch((err) => {
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

    // Clean up any previous subscription + its indicator tick + any stall timer
    // (a session swap must not leave a stale countdown running)
    session.sseUnsubscribe?.()
    stopIndicatorTick(session)
    cancelStallNudge(session)

    const unsubscribe = messagePersister.addSSEClient(sessionId, (event: unknown) => {
      // Wake on a BUSY snapshot: an event means something changed, so re-arm the tick if the
      // session is now busy (and it had slept), painting immediately on a cold arm. A non-busy
      // event is ignored — it must NOT arm a tick that nothing would sleep, nor cancel a pending
      // sleep. Synchronous and BEFORE the serialization queue, so a backed-up handler can't
      // delay the wake. The tick — not this — keeps painting.
      const eventActivity = messagePersister.getSessionActivity(sessionId)
      armIndicatorIfBusy(session, sessionId, eventActivity)
      // Any event is a sign of life: (re)arm the stall-nudge silence countdown.
      // Arm-if-busy (not reset-if-armed) so a turn that started or resumed
      // outside the dispatch points self-arms off its own events. Synchronous
      // and BEFORE the queue, same reasoning as the wake above - a backed-up
      // handler must not let the nudge fire while events are arriving.
      armStallNudgeIfBusy(session, sessionId, eventActivity)
      // Serialize SSE event processing per chat session to prevent race conditions
      // (e.g. session_idle arriving while stream_delta's sendStreamingUpdate is still in-flight)
      this.enqueueSSEEvent(integrationId, chatId, event)
    })
    session.sseUnsubscribe = unsubscribe
    // Arm-if-busy from the cold snapshot — the same primitive as the wake. Busy → arm + paint
    // now (so a cold subscribe mid-turn isn't blank); non-busy → clear any stale indicator and
    // hold zero timers. Crucially, if the busy-making events fired BEFORE this callback existed
    // (reconnect mid-turn, or markSessionActive racing ahead of subscribe at session creation),
    // this snapshot is what arms the tick; we never depend on a future event to start it. The
    // tick is alive for the subscription, not the turn.
    session.sessionId = sessionId
    const coldActivity = messagePersister.getSessionActivity(sessionId)
    armIndicatorIfBusy(session, sessionId, coldActivity)
    // Same cold-snapshot symmetry for the stall nudge: a mid-turn re-subscribe
    // (server restart, reconnect) starts a fresh countdown even before any event.
    armStallNudgeIfBusy(session, sessionId, coldActivity)
    if (!BUSY_ACTIVITIES.has(coldActivity)) clearIndicator(session)
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
    // Backstop: re-arm any subscribed session that reads busy but has no tick — an
    // unforeseen missed wake (e.g. a process restart that re-subscribed mid-turn). Rides
    // this existing timer, so it adds NO new timer, and leaves idle sessions asleep (zero
    // per-session timers at rest). Same arm-if-busy primitive as subscribe and the wake;
    // this only catches a miss those didn't.
    for (const session of this.chatSessions.values()) {
      const sessionId = session.sessionId
      if (!sessionId || session.indicatorTickTimer) continue
      armIndicatorIfBusy(session, sessionId, messagePersister.getSessionActivity(sessionId))
    }

    await this.reconcileIntegrations({ force: false })
  }

  /**
   * Reconcile live connections against the DB work list.
   *
   * The DB (every startup-eligible integration: status active/error) is the
   * source of truth, NOT the in-memory connections map — an integration whose
   * reconnect failed has no map entry, and iterating the map is exactly what
   * used to orphan it forever. Here a missing entry just means "rebuild now",
   * so every failure is retried on the next pass.
   *
   * force=false (health tick): rebuild orphans immediately; give a present-but-
   * disconnected connector a grace window first, so its own faster reconnect
   * loop (iMessage backoff, Slack socket restart) wins when the outage is short.
   * force=true (system resume): rebuild everything — sockets are suspect after
   * sleep and honest isConnected() may lag a half-open TCP connection by up to
   * a ping cycle.
   *
   * Rebuilds run serially: connects fail fast (connector-level timeouts), and
   * one integration hammering a dead network shouldn't be parallelized anyway.
   */
  private async reconcileIntegrations(opts: { force: boolean }): Promise<void> {
    const now = Date.now()
    for (const integration of listStartupChatIntegrations()) {
      // A stop() mid-pass (app shutdown) must not resurrect connections it
      // just tore down.
      if (!this.isRunning) return
      const id = integration.id
      if (this.reconcilingIds.has(id)) continue

      const conn = this.connections.get(id)
      const connected = conn?.connector.isConnected() ?? false

      if (connected && !opts.force) {
        this.disconnectedSince.delete(id)
        this.consecutiveFailures.delete(id)
        if (integration.status === 'error') {
          // The connector recovered on its own — clear the stale error badge.
          try { updateChatIntegrationStatus(id, 'active', null) } catch { /* best-effort */ }
        }
        continue
      }

      if (conn && !connected && !opts.force) {
        if (!this.disconnectedSince.has(id)) this.disconnectedSince.set(id, now)
        if (now - this.disconnectedSince.get(id)! < HEALTH_CHECK_ERROR_THRESHOLD_MS) continue
      }

      await this.rebuildIntegration(id, opts.force ? 'resume-reconnect' : 'health-check-reconnect')
    }
  }

  /** Tear down and reconnect one integration, with retry/auto-pause accounting. */
  private async rebuildIntegration(id: string, operation: string): Promise<void> {
    this.reconcilingIds.add(id)
    try {
      // Capture the lifecycle generation before anything else: any user
      // operation from here on (pause, delete, config update) bumps it, and
      // this rebuild must then CANCEL — reconnecting from the row snapshot
      // below would resurrect a paused integration or restore pre-update
      // credentials, and writing status would clobber what the user's
      // operation just wrote.
      const generation = this.generationOf(id)

      // Fresh read: the user may have paused or deleted it since the list snapshot.
      const integration = getChatIntegration(id)
      if (!integration || integration.status === 'paused') return

      // The teardown wipes the failure counter (correct for user-initiated
      // removal); capture it first so retry accounting survives.
      const prevFailures = this.consecutiveFailures.get(id) ?? 0
      try {
        await this.teardownConnection(id)
        // Re-read after the teardown await — a user operation may have landed
        // in the gap, and the manager may have been stopped.
        if (!this.isRunning || this.generationOf(id) !== generation) return
        const fresh = getChatIntegration(id)
        if (!fresh || fresh.status === 'paused') return

        const connected = await this.connectIntegration(fresh, generation)
        if (!connected) return // ownership lost mid-connect — cancelled, not successful
        this.disconnectedSince.delete(id)
        this.consecutiveFailures.delete(id)
        if (fresh.status === 'error') {
          try { updateChatIntegrationStatus(id, 'active', null) } catch { /* best-effort */ }
        }
      } catch (err) {
        // A cancelled rebuild reports nothing: the failure was (or may have
        // been) caused by the user's own operation tearing our connect down,
        // and an 'error' write would flip their fresh 'paused' back to a
        // startup-eligible status.
        if (!this.isRunning || this.generationOf(id) !== generation) return
        const failures = prevFailures + 1
        this.consecutiveFailures.set(id, failures)
        console.error(`[ChatIntegrationManager] Reconnect failed for ${id} (attempt ${failures}):`, err)
        reportError(err, operation, { integrationId: id, provider: integration.provider, attempt: failures })

        if (failures >= HEALTH_CHECK_MAX_CONSECUTIVE_FAILURES) {
          console.error(`[ChatIntegrationManager] ${id}: ${failures} consecutive reconnect failures — pausing`)
          reportError(new Error(`Auto-paused after ${failures} failures`), 'health-check-auto-pause', { integrationId: id, provider: integration.provider, failures }, 'warning')
          try { updateChatIntegrationStatus(id, 'paused', `Auto-paused after ${failures} failed reconnection attempts`) } catch { /* best-effort */ }
          this.emitNotification(integration, 'error', `Auto-paused after ${failures} failed reconnect attempts`)
          this.disconnectedSince.delete(id)
          this.consecutiveFailures.delete(id)
          return
        }

        try { updateChatIntegrationStatus(id, 'error', `Reconnect failed (attempt ${failures}): ${err}`) } catch { /* best-effort */ }
        // Notify once per outage, not once per 5-minute tick.
        if (failures === 1) this.emitNotification(integration, 'error', 'Connection lost')
      }
    } finally {
      this.reconcilingIds.delete(id)
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
    // Priority lane: /stop is an interrupt against the in-flight turn, not a turn
    // of its own. It must act immediately, so it bypasses the serial per-chat
    // queue instead of waiting behind an in-flight normal message (e.g. a cold
    // container start that can take 20-30s). It still runs the full access gate
    // and the existing /stop dispatch via handleIncomingMessage; it just isn't
    // chained onto the queue.
    if (isChatCommand(message.text, 'stop')) {
      void this.handleIncomingMessage(integrationId, message).catch((err) => {
        console.error(`[ChatIntegrationManager] Error handling /stop:`, err)
        reportError(err, 'incoming-message', { integrationId, chatId: message.chatId })
      })
      return
    }

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
    if (integration.provider === 'telegram' && isChatCommand(message.text, 'start')) {
      await conn.connector.sendMessage(chatId, { text: "You're connected. Send a message to start." }).catch(() => {})
      return
    }

    // Handle /clear command — reset the session for this chat
    if (isChatCommand(message.text, 'clear')) {
      await this.clearChatSession(integrationId, chatId, conn.connector)
      return
    }

    // Handle /stop command - interrupt the in-flight turn, keep the conversation
    if (isChatCommand(message.text, 'stop')) {
      await this.stopChatTurn(integration, chatId, conn.connector)
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
    // Capture the interrupt epoch before the awaits below. A /stop can run concurrently
    // (priority lane) and settle this session inactive while we're suspended; if it bumps
    // the epoch we must abandon this send rather than resurrect the stopped turn (guarded
    // before and after the container send below). Keyed by the stable chat key.
    const stopKey = this.getChatSessionKey(integrationId, chatId)
    const stopEpochAtEntry = this.stopEpochs.get(stopKey) ?? 0

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

      // A plain-text reply to an open single-question card continues the same turn as the
      // free-form "Other" answer; anything else cancels the pending request (and strips its
      // now-abandoned card) so this message starts a fresh turn instead of deadlocking. No-op
      // when not awaiting. Mirrors the app send-message route.
      const consumed = await consumeOrCancelAwaitingInput({
        sessionId,
        agentSlug: integration.agentSlug,
        chatId,
        messageText,
        // Resolve an open question with the RAW user text (no group sender-name prefix): the
        // prefixed messageText is only for the fresh-turn forward below.
        answerText: message.text ?? '',
        hasFiles: !!(message.files && message.files.length > 0),
        persister: messagePersister,
        connector: conn.connector,
      })
      if (consumed) return

      // A concurrent /stop (priority lane) settled this session while we were suspended in
      // the awaits above. Re-check the interrupt epoch before submitting to the container:
      // if the user stopped, abandon the message entirely — don't send it, don't activate.
      // Mirrors the mid-flight revoke re-check above.
      if ((this.stopEpochs.get(stopKey) ?? 0) !== stopEpochAtEntry) return
      await client.sendMessage(sessionId, messageText)
      // Check again after the send: a /stop landing while it was in flight must not be
      // re-activated here (the container-side interrupt discards the just-queued message).
      if ((this.stopEpochs.get(stopKey) ?? 0) !== stopEpochAtEntry) return
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
        // A concurrent /stop abandoned this turn while we were mid-send (it bumped the epoch
        // and settled the session). Do NOT self-heal it into a fresh session — that would
        // recreate the exact turn the user just stopped. Checked BEFORE teardown deletes the
        // epoch; /stop already acked, and the next genuine message self-heals normally.
        if ((this.stopEpochs.get(stopKey) ?? 0) !== stopEpochAtEntry) return
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

    // The working indicator arms via the per-session tick (it reads getSessionActivity),
    // not here — turn start only ARMS, the tick paints within at most one tick.
    const dispatched = this.chatSessions.get(this.getChatSessionKey(integrationId, chatId))
    if (dispatched) {
      // New user turn: re-allow exactly one terminal notice (the session_error
      // message). Reset here, once per turn, so a single multi-segment turn can't
      // emit repeated notices.
      dispatched.turnNotified = false
      // Same once-per-turn contract for the stall nudge, then start its countdown.
      dispatched.stallNotified = false
      armStallNudge(dispatched, sessionId)
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
    const { readAgentPreferences } = await import('@shared/lib/services/agent-preferences-service')

    const availableEnvVars = await getSecretEnvVars(integration.agentSlug)
    // Provider-specific session context (DM vs channel vs thread, delivery
    // semantics) — owned by each connector class, not the manager.
    const systemPrompt = (await this.getConnectorClass(integration.provider))?.generateSystemPrompt?.(message)
    // Model/effort/speed preference order: integration override > agent default > global default.
    const models = getEffectiveModels()
    const agentPrefs = await readAgentPreferences(integration.agentSlug)
    const effort = integration.effort ?? agentPrefs.defaultEffort
    const speed = integration.speed ?? agentPrefs.defaultSpeed

    const containerSession = await client.createSession({
      availableEnvVars: availableEnvVars.length > 0 ? availableEnvVars : undefined,
      initialMessage: messageText,
      model: integration.model || agentPrefs.defaultModel || models.agentModel,
      browserModel: models.browserModel,
      dashboardBuilderModel: models.dashboardBuilderModel,
      ...(effort ? { effort: effort as EffortLevel } : {}),
      ...(speed ? { speed: speed as SpeedLevel } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
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
    const managed = this.chatSessions.get(this.getChatSessionKey(integration.id, chatId))
    if (managed) {
      // First turn of a fresh session: start the stall-nudge countdown.
      managed.stallNotified = false
      armStallNudge(managed, sessionId)
    }
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

  /** Stop a chat session's live streaming: drop the SSE subscription, the tick, and the indicator. */
  private stopSession(session: ManagedConnector): void {
    session.sseUnsubscribe?.()
    stopIndicatorTick(session)
    cancelStallNudge(session)
    // Force-clear on teardown (unconditional, not the idempotent clearIndicator): the
    // session is going away, so settle the connector even if indicatorShown drifted.
    session.connector.stopWorking(session.chatId).catch(() => {})
  }

  private teardownManagedSession(integrationId: string, chatId: string, opts?: { archive?: string }): void {
    const key = this.getChatSessionKey(integrationId, chatId)
    const managed = this.chatSessions.get(key)
    if (managed) this.stopSession(managed)
    this.chatSessions.delete(key)
    this.stopEpochs.delete(key)
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
        // Clear = stop + forget: without the interrupt, an in-flight turn keeps
        // running orphaned in the container (burning tokens with nowhere to
        // deliver) after the mapping is archived. Same shared path and same
        // turn-lifecycle gate as /stop (NOT the indicator's BUSY_ACTIVITIES).
        // Best-effort in its own try so a failed interrupt can never block the
        // archive below.
        if (messagePersister.isSessionActive(chatSession.sessionId)) {
          try {
            const integration = getChatIntegration(integrationId)
            if (integration) {
              const { interruptAgentSession } = await import('@shared/lib/container/interrupt-session')
              await interruptAgentSession(integration.agentSlug, chatSession.sessionId)
            }
          } catch (err) {
            console.error('[ChatIntegrationManager] Failed to interrupt before clear:', err)
            reportError(err, 'clear-session-interrupt', { integrationId, chatId })
          }
          // Same card hygiene as /stop: an open question card would outlive the turn.
          await connector.dismissOpenCards(chatId).catch(() => {})
        }
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

  /**
   * /stop - interrupt the chat's in-flight turn via the app Stop button's shared
   * path (interruptAgentSession always settles locally, even on a wedged
   * container). Unlike /clear, the session mapping survives: the next message
   * runs as a fresh turn in the same conversation. The whole in-flight turn is
   * discarded, including container-queued mid-turn messages.
   */
  private async stopChatTurn(
    integration: ChatIntegration,
    chatId: string,
    connector: ChatClientConnector,
  ): Promise<void> {
    const chatKey = this.getChatSessionKey(integration.id, chatId)
    const managed = this.chatSessions.get(chatKey)
    // A concurrent /stop (double-tap, or a tap racing a typed /stop) bypasses the serial
    // queue via the priority lane, so two can reach here at once. The first stop's
    // interrupt + "⏹ Stopped" ack is the turn's terminal notice; a second racing it must
    // not double-interrupt or trail it with a contradictory "⏹ Nothing is running". The
    // guard is await-free up to the flag set below, so the first call latches before it
    // yields at the interrupt and the second returns silently. (The serial queue used to
    // provide this ordering; the priority lane traded it away, so re-establish it here.)
    if (managed?.stopInFlight) return

    const chatSession = getChatIntegrationSession(integration.id, chatId)
    const sessionId = chatSession?.sessionId
    // Turn-lifecycle gate, NOT the indicator's BUSY_ACTIVITIES: a turn hung
    // mid-stream ('streaming') or parked on a question ('awaiting') is still an
    // in-flight turn the user must be able to stop - same any-time semantics as
    // the app's Stop button.
    if (!sessionId || !messagePersister.isSessionActive(sessionId)) {
      await connector.sendMessage(chatId, { text: '⏹ Nothing is running right now.' }).catch(() => {})
      return
    }

    // Bump the interrupt epoch (keyed by the stable chat key, NOT the mutable managed
    // connector which may be absent on a cold/reconnect path) so a concurrent normal-message
    // send abandons itself instead of resurrecting this stopped turn.
    this.stopEpochs.set(chatKey, (this.stopEpochs.get(chatKey) ?? 0) + 1)

    if (managed) {
      // The stop ack is this turn's terminal notice: a stale session_error may
      // already sit in the SSE queue, and the turnNotified latch keeps it from
      // sending a second, contradictory one.
      managed.stopInFlight = true
      managed.turnNotified = true
      cancelStallNudge(managed)
    }

    try {
      // Lazy import, same idiom as the send path's container-manager import.
      const { interruptAgentSession } = await import('@shared/lib/container/interrupt-session')
      await interruptAgentSession(integration.agentSlug, sessionId)
      // Clear the stopped turn's working indicator immediately, not on the next 1s tick — a
      // rapid stop-then-send would otherwise leave the stale indicator up to collide with the
      // new turn's messages.
      if (managed) clearIndicator(managed)
      // A question card left open would look answerable, but the turn is dead and
      // a tap after this fails silently - strip open cards best-effort.
      await connector.dismissOpenCards(chatId).catch(() => {})
      await connector.sendMessage(chatId, { text: '⏹ Stopped. Send a message to start again.' }).catch(() => {})
    } finally {
      // Release the latch so a later /stop on a NEW turn isn't blocked; a throw here (a
      // wedged interrupt past its 15s bound) must not strand the flag true forever.
      if (managed) managed.stopInFlight = false
    }
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

// ── Turn finalize ──────────────────────────────────────────────────────────

/**
 * Commit a turn's streamed text + settle pending tool pills. Indicator-free: the
 * terminal cases (session_idle / session_error) settle the indicator via their own
 * clearIndicator call before finalizing, so this only commits text. Idempotent.
 */
async function finalizeTurn(managed: ManagedConnector): Promise<void> {
  try {
    await finalizeStreaming(managed)
    await resolvePendingToolMessages(managed)
  } catch (err) {
    console.error('[ChatIntegrationManager] Failed to finalize turn:', err)
    reportError(err, 'finalize-turn', { integrationId: managed.integration.id, chatId: managed.chatId })
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

/**
 * Activities that show a placeholder ("busy"). 'idle' | 'awaiting' | 'streaming'
 * show none — the surface is owned by the reply or a request card, or there is
 * nothing to show.
 */
const BUSY_ACTIVITIES: ReadonlySet<SessionActivity> = new Set([
  'working', 'thinking', 'compacting', 'retrying',
])

/**
 * The ONE thing that PAINTS the working indicator: project the agent's activity
 * onto the connector. Busy activities show a labeled placeholder — re-painted on
 * EVERY call, because on Telegram that re-render is the keep-alive. Non-busy tears
 * it down idempotently. Driven by the per-session tick (the only paint) and the
 * cold-subscribe snapshot. The connector owns how each activity renders (Telegram
 * labels a draft, Slack reacts); the app draws its own indicator and is untouched.
 */
export function reconcileIndicator(managed: ManagedConnector, activity: SessionActivity): void {
  if (BUSY_ACTIVITIES.has(activity)) {
    managed.indicatorShown = true
    managed.connector.startWorking(managed.chatId, activity).catch(() => {})
  } else {
    clearIndicator(managed)
  }
}

/**
 * Idempotent clear: only call the connector when the indicator is currently shown,
 * so repeated clears (idle ticks, several clear events in a row) make ZERO connector
 * calls. Clearing is always EXPLICIT — stopping the tick never clears a persistent
 * draft, so the four immediate clears and the non-busy tick all route through here.
 */
export function clearIndicator(managed: ManagedConnector): void {
  if (!managed.indicatorShown) return
  managed.indicatorShown = false
  managed.connector.stopWorking(managed.chatId).catch(() => {})
}

/** Pull cadence for the indicator tick. At/under Telegram's draft expiry so drafts stay alive. */
export const INDICATOR_TICK_MS = 1000

/**
 * How long after the session settles non-busy the tick is allowed to stop. The sleep is
 * a debounce: any event re-arms (cancels) it, so it only fires after a genuine lull. When
 * it DOES fire it re-reads the live activity and only stops the tick if the session is
 * still non-busy — the same "re-read reality" rule the tick itself follows — so a stale or
 * type-mismatched sleep can never strand a working session.
 */
export const INDICATOR_SLEEP_MS = 10_000

/**
 * Ensure the per-session indicator tick is running, alive for the SSE subscription (NOT a
 * turn). Each tick re-reads the truth (getSessionActivity) and reconciles — the only PAINT,
 * and the self-healing backstop: a stuck or wrong indicator is corrected within one tick. The
 * tick also owns its own idle-sleep (arm on sustained non-busy, cancel on busy), so the settle
 * handlers stay dumb (clear only) and the sleep decision always reads live state.
 * CREATE-IF-ABSENT: a tick already running is left untouched — restarting it on every event
 * would keep pushing the interval back and starve it during a fast event burst, so the
 * Telegram draft would expire mid-turn. Records the sampled session and cancels any pending
 * sleep (activity means we stay awake). Returns true iff it created a new interval (a cold
 * arm) — the caller uses that to paint once immediately so a cold wake isn't blank for a tick.
 */
export function startIndicatorTick(managed: ManagedConnector, sessionId: string): boolean {
  managed.sessionId = sessionId
  cancelIndicatorSleep(managed)
  if (managed.indicatorTickTimer) return false
  managed.indicatorTickTimer = setInterval(() => {
    const activity = messagePersister.getSessionActivity(sessionId)
    reconcileIndicator(managed, activity)
    // The tick owns its own sleep: a busy read keeps it awake (cancel any pending stop), the
    // first of a sustained non-busy run starts the debounce. scheduleIndicatorSleep is arm-once,
    // so calling it every non-busy tick never pushes the deadline back.
    if (BUSY_ACTIVITIES.has(activity)) cancelIndicatorSleep(managed)
    else scheduleIndicatorSleep(managed)
  }, INDICATOR_TICK_MS)
  return true
}

/**
 * Arm the tick for a BUSY snapshot, painting once immediately on a cold arm. No-op when the
 * snapshot is non-busy — a per-session timer is created exactly when a busy state is observed,
 * never on a stray non-busy event (which would leave a tick running with nothing to sleep it).
 * The ONE arm primitive behind all three arm sites — subscribe, the per-event wake, and the
 * health-check backstop — so they share one rule: the tick is armed iff busy, and idle holds
 * zero per-session timers. Every busy transition emits a per-session broadcast, so a busy
 * snapshot is always observed in time.
 */
export function armIndicatorIfBusy(managed: ManagedConnector, sessionId: string, activity: SessionActivity): void {
  if (!BUSY_ACTIVITIES.has(activity)) return
  if (startIndicatorTick(managed, sessionId)) reconcileIndicator(managed, activity)
}

/**
 * Stop the per-session tick AND any pending sleep (resource cleanup at unsubscribe /
 * teardown). Clearing both here is what stops an orphaned sleep — scheduled before a
 * re-subscribe — from firing later and killing a freshly re-armed tick.
 */
export function stopIndicatorTick(managed: ManagedConnector): void {
  cancelIndicatorSleep(managed)
  if (managed.indicatorTickTimer) {
    clearInterval(managed.indicatorTickTimer)
    managed.indicatorTickTimer = null
  }
}

/** Cancel a pending idle-sleep, if any. */
export function cancelIndicatorSleep(managed: ManagedConnector): void {
  if (managed.sleepTimer) {
    clearTimeout(managed.sleepTimer)
    managed.sleepTimer = null
  }
}

// ── Stall nudge ─────────────────────────────────────────────────────────
//
// A silence timer, NOT an indicator timer: armed at turn dispatch, reset on every
// SSE event (synchronously, before the serialization queue), cancelled on terminal
// events and teardown. After STALL_NUDGE_MS of total silence it sends ONE
// informational message pointing at /stop. It never paints or clears the
// indicator - that stays 100% tick-driven.

/** Silence threshold before the one-per-turn stall nudge. Generous so that most
 * legitimately-silent long tools (builds, installs, browser waits) finish first. */
export const STALL_NUDGE_MS = 7 * 60_000

/** Frames /stop as optional and never asserts the agent died: a silent-but-alive
 * tool past the threshold is expected, so a false positive must read as harmless. */
export const STALL_NUDGE_TEXT =
  '⏳ Still working on this. Could be a long-running step, or the turn might be stuck. If it looks hung, send /stop to reset it and try again.'

/** Slack intercepts client-typed slash commands (they never reach the bot), so
 * its nudge cannot advertise /stop. */
export const STALL_NUDGE_TEXT_NO_COMMAND =
  '⏳ Still working on this. Could be a long-running step, or the turn might be stuck.'

/** Chat command matcher: accepts the bare command and the Telegram group form
 * "/cmd@botname" (the form Telegram autocompletes in groups); anything else,
 * e.g. "/stop now", stays a normal message for the agent. */
export function isChatCommand(text: string, command: string): boolean {
  return new RegExp(`^/${command}(@\\S+)?$`).test(text.trim().toLowerCase())
}

/**
 * (Re)arm the silence countdown for a turn. Captures sessionId so a fire after a
 * resubscribe/session swap is a no-op (checked against managed.sessionId).
 */
export function armStallNudge(managed: ManagedConnector, sessionId: string): void {
  if (managed.stallNudgeTimer) clearTimeout(managed.stallNudgeTimer)
  managed.stallNudgeTimer = setTimeout(() => onStallNudgeFired(managed, sessionId), STALL_NUDGE_MS)
}

/**
 * Arm-if-busy: the self-healing arm, mirroring armIndicatorIfBusy. Any event or
 * cold snapshot from a live agent-owed turn arms the countdown when none is
 * armed, and resets it when one is - so a turn that started or resumed outside
 * the dispatch points (a consumed question answer, a button resolve, a
 * container-queued follow-up, a restart re-subscribe) still gets stall
 * protection off its own events. 'awaiting' does not arm: the user owes input.
 */
export function armStallNudgeIfBusy(managed: ManagedConnector, sessionId: string, activity: SessionActivity): void {
  if (activity === 'idle' || activity === 'awaiting') return
  armStallNudge(managed, sessionId)
}

/** Cancel outright: terminal events, /stop, teardown, resubscribe. */
export function cancelStallNudge(managed: ManagedConnector): void {
  if (managed.stallNudgeTimer) clearTimeout(managed.stallNudgeTimer)
  managed.stallNudgeTimer = null
}

function onStallNudgeFired(managed: ManagedConnector, sessionId: string): void {
  managed.stallNudgeTimer = null
  // Stale timer: the managed session moved on (resubscribe/swap). Never nudge
  // the old session.
  if (managed.sessionId !== sessionId) return
  // At most once per turn.
  if (managed.stallNotified) return
  // Re-read reality: only nudge when the AGENT still owes progress. 'idle'
  // means the turn settled (a cancel raced this fire); 'awaiting' means the
  // USER owes input - a person pondering the agent's question is never nudged.
  // Everything else (working/thinking/compacting/retrying/streaming) is an
  // in-flight turn that has been silent the whole countdown - the hang signature.
  const activity = messagePersister.getSessionActivity(sessionId)
  if (activity === 'idle' || activity === 'awaiting') return
  // Latch BEFORE sending: a missed nudge is cheaper than a double nudge (the
  // deliberate opposite of the session_error notice, which re-opens its latch
  // on delivery failure).
  managed.stallNotified = true
  const text = managed.integration.provider === 'slack' ? STALL_NUDGE_TEXT_NO_COMMAND : STALL_NUDGE_TEXT
  managed.connector.sendMessage(managed.chatId, { text }).catch((err) => {
    console.error('[ChatIntegrationManager] Failed to send stall nudge:', err)
  })
}

/**
 * Start the debounce that stops the tick after INDICATOR_SLEEP_MS of confirmed non-busy.
 * ARM-ONCE: a no-op if a countdown is already pending, so the TICK can call this every
 * non-busy second without ever pushing the deadline back — it fires ~10s after the FIRST
 * non-busy tick. A busy tick cancels it (cancelIndicatorSleep), restarting the window. No-op
 * when no tick is running (nothing to sleep). When the timer fires it RE-READS the live
 * activity and stops the tick only if the session is STILL non-busy — so an auto-approved
 * script run (card shown but stays 'working'), or a fresh turn started during the debounce,
 * keeps its tick.
 */
export function scheduleIndicatorSleep(managed: ManagedConnector): void {
  if (!managed.indicatorTickTimer) return
  if (managed.sleepTimer) return
  const sessionId = managed.sessionId
  if (!sessionId) return
  managed.sleepTimer = setTimeout(() => {
    managed.sleepTimer = null
    if (!BUSY_ACTIVITIES.has(messagePersister.getSessionActivity(sessionId))) {
      // Clear before stopping: stopIndicatorTick only drops timers, so stopping a tick that
      // is somehow still showing a draft would strand it. Clearing first makes the guard
      // self-defending regardless of how the caller left indicatorShown.
      clearIndicator(managed)
      stopIndicatorTick(managed)
    }
  }, INDICATOR_SLEEP_MS)
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
      // First reply token → 'streaming' (non-busy): the streamed text owns the
      // reply surface, so settle the indicator now. Idempotent; the tick backstops.
      clearIndicator(managed)
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
      // The agent is now waiting on the user → 'awaiting' (non-busy). Settle the
      // indicator the moment the card is shown (the persister flips isAwaitingInput,
      // so the tick would clear within a tick anyway — this just makes it instant). The
      // tick then sleeps after the lull and re-checks activity at fire time, so an
      // auto-approved script run (card shown but the session stays 'working') keeps its tick.
      clearIndicator(managed)
      try {
        await managed.connector.sendUserRequestCard(managed.chatId, data as UserRequestEvent)
      } catch (err) {
        console.error(`[ChatIntegrationManager] Failed to send user request card (${eventType}):`, err)
        reportError(err, 'send-user-request-card', { integrationId: managed.integration.id, provider: managed.integration.provider, eventType })
      }
      break
    }

    case 'session_idle': {
      // Turn ended → settle the indicator instantly, then finalize the streamed text.
      // The tick sleeps itself once it reads the now-idle state.
      // Re-read truth before killing the stall timer: a STALE queued idle (it
      // waited behind a slow send while the next turn dispatched) must not
      // cancel the new turn's countdown. The persister settles isActive BEFORE
      // broadcasting terminals, so a real turn end always reads inactive here.
      if (!managed.sessionId || !messagePersister.isSessionActive(managed.sessionId)) {
        cancelStallNudge(managed)
        // A genuine turn boundary also reopens the nudge latch, so a turn that
        // self-arms outside the dispatch points (arm-if-busy) can nudge too.
        managed.stallNotified = false
      }
      clearIndicator(managed)
      await finalizeTurn(managed)
      break
    }

    case 'session_error': {
      // An errored turn emits session_error (NOT session_idle), and the host
      // suppresses the later authoritative idle. Settle the indicator instantly so
      // it never strands, finalize the turn the same way session_idle does, then
      // surface a curated error so the user isn't left staring at a frozen reply.
      // The tick sleeps itself once it reads the now-idle/non-busy state.
      // Same stale-event guard and latch-reopen as session_idle.
      if (!managed.sessionId || !messagePersister.isSessionActive(managed.sessionId)) {
        cancelStallNudge(managed)
        managed.stallNotified = false
      }
      clearIndicator(managed)
      await finalizeTurn(managed)
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
  // finalize (e.g. session_idle finalizing while a late stream_start also
  // finalizes) reads an empty buffer and can't double-send the same text. The
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
