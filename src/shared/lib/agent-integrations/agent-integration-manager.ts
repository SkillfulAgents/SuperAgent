import { syncRemoteMcpAgents } from '../services/connection-sync-service'
/**
 * Application-wide integration lifecycle, serialized input, and actor sessions.
 * Families decide routing, authorization policy, context, and delivery. The
 * coordinator owns subscriptions, runtime invocation, recovery, and persistence.
 * Each (installation ID, family-resolved external ID) owns one active session.
 */

import { onIntegrationAuthorizationLost, type IntegrationAuthorizationLost } from './lifecycle'
import { integrationRequestEventSchema } from './runtime-schema'
import type { AgentIntegration } from './agent-integration'
import type { AgentIntegrationRecord, IntegrationStatus, IntegrationInputEvent, IntegrationRoute, IntegrationSessionContext, IntegrationOutput, IntegrationResponseEvent, PreparedIntegrationInput } from './types'
import { agentIntegrationRegistry, type AgentIntegrationRegistry } from './registry'
import { agentRegistry, type AgentActor } from '@shared/lib/agent-actor'
import {
  listStartupIntegrations,
  getIntegration,
  updateIntegrationStatus,
  getIntegrationSession,
  getIntegrationSessionBySessionId,
  createIntegrationSession,
  updateIntegrationSessionName,
  archiveIntegrationSession,
  touchIntegrationSession,
  listIntegrationSessions,
  listActiveIntegrationSessions,
  resolveActiveSession,
  getLastDisplayName,
} from './store'
import { resolveRuntimeInherit } from '@shared/lib/container/runtime-options'
import { messagePersister } from '@shared/lib/container/message-persister'
import { runWithOptionalUser } from '@shared/lib/platform-attribution'
import { captureException, addErrorBreadcrumb } from '@shared/lib/error-reporting'
// ── Sentry helpers ─────────────────────────────────────────────────────

const COMPONENT = 'agent-integration'

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

// ── Constants ───────────────────────────────────────────────────────────

const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000
const HEALTH_CHECK_ERROR_THRESHOLD_MS = 5 * 60 * 1000
const HEALTH_CHECK_MAX_CONSECUTIVE_FAILURES = 15

// ── Types ───────────────────────────────────────────────────────────────

/** Integration-level connection: one connector per integration. */
interface IntegrationConnection {
  connector: AgentIntegration
  integration: AgentIntegrationRecord
  eventUnsubscribe: (() => void) | null
  errorUnsubscribe: (() => void) | null
}

interface ManagedSession {
  connector: AgentIntegration
  integration: AgentIntegrationRecord
  chatId: string
  sessionId?: string
  context: IntegrationSessionContext
  sseUnsubscribe: (() => void) | null
  recovery?: Promise<void>
  recovered?: boolean
  recoveryReported?: boolean
  recoveryTimer?: ReturnType<typeof setTimeout>
}

// ── Manager ─────────────────────────────────────────────────────────────

export class AgentIntegrationManager {
  constructor(private readonly registry: AgentIntegrationRegistry = agentIntegrationRegistry) {}

  // Integration-level: one connector per integration
  private connections: Map<string, IntegrationConnection> = new Map()
  // Per-chat session: one streaming context per (integrationId, externalId)
  private chatSessions: Map<string, ManagedSession> = new Map() // key: `${integrationId}:${chatId}`
  private isRunning = false
  private authorizationUnsubscribe?: () => void
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
  // Invalidate connects immediately, then serialize status writes so an already
  // executing resume/error write cannot land after a completed pause.
  private pausedIds = new Set<string>()
  private statusWrites = new Map<string, Promise<unknown>>()
  // Bumped synchronously each time a chat session is cleared (see noteSessionClear).
  private sessionClears = 0
  // Session row ids whose clear has begun (see noteSessionClear); the row may
  // still read as active until the archive lands.
  private clearedSessionRows = new Set<string>()
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

  private async context(integrationId: string, externalId: string): Promise<IntegrationSessionContext | undefined> {
    const integration = await getIntegration(integrationId)
    return integration ? { integration, externalId } : undefined
  }

  private async isAllowed(integrationId: string, externalId: string): Promise<boolean> {
    const context = await this.context(integrationId, externalId)
    return !!context && !!(await this.connections.get(integrationId)?.connector.isAllowed(context))
  }

  private async deliver(integrationId: string, externalId: string, output: IntegrationOutput, sessionId?: string): Promise<void> {
    const connector = this.connections.get(integrationId)?.connector
    const context = await this.context(integrationId, externalId)
    if (!connector || !context || !(await connector.isAllowed(context))) return
    const managed = this.chatSessions.get(this.getChatSessionKey(integrationId, externalId))
    const routed = managed && (!sessionId || managed.sessionId === sessionId) ? managed.context : context
    await connector.deliver(this.withActivity({ ...routed, integration: context.integration, sessionId: sessionId ?? routed.sessionId }, managed), output)
  }

  describeTarget(provider: string, externalId: string) { return this.registry.describeTarget(provider, externalId) }

  getDefinition(provider: string) { return this.registry.getDefinition(provider) }

  // ── Lifecycle ───────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true
    this.authorizationUnsubscribe = onIntegrationAuthorizationLost(change => {
      void this.authorizationLost(change).catch(error => reportError(error, 'authorization-lost', { integrationId: change.integrationId }))
    })

    const integrations = await listStartupIntegrations()

    for (const integration of integrations) {
      const generation = this.bumpGeneration(integration.id)
      try {
        const connected = await this.connectIntegration(integration, generation)
        // Clear error status on successful reconnect
        if (connected && integration.status === 'error') {
          try { await this.writeStatus(integration.id, generation, 'active', null) } catch { /* best-effort */ }
        }
      } catch (err) {
        console.error(`[AgentIntegrationManager] Failed to connect integration ${integration.id}:`, err)
        reportError(err, 'start-connect', { integrationId: integration.id, provider: integration.provider, agentSlug: integration.agentSlug })
        try { await this.writeStatus(integration.id, generation, 'error', String(err)) } catch { /* best-effort */ }
      }
    }

    this.healthCheckInterval = setInterval(() => {
      this.runHealthChecks().catch((err) => {
        console.error('[AgentIntegrationManager] Health check error:', err)
        reportError(err, 'health-check')
      })
    }, HEALTH_CHECK_INTERVAL_MS)

    this.subscribeGlobalNotifications()

    // Positive start signal: startup.ts only logs start() FAILURES, so without
    // this a dead manager is indistinguishable from a healthy idle one.
    console.log(`[AgentIntegrationManager] Started (${integrations.length} startup integration(s))`)
  }

  stop(): void {
    this.authorizationUnsubscribe?.()
    this.authorizationUnsubscribe = undefined
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
    this.pausedIds.clear()
    this.sessionClears = 0
    this.clearedSessionRows.clear()
    this.messageQueues.clear()
    this.isRunning = false
  }

  private async authorizationLost(change: IntegrationAuthorizationLost): Promise<void> {
    const generation = this.generationOf(change.integrationId)
    const row = await getIntegration(change.integrationId)
    if (!this.isRunning || !row || row.config !== change.config || !['disconnected', 'paused'].includes(row.status) || this.generationOf(row.id) !== generation) return
    this.bumpGeneration(row.id)
    this.disconnectedSince.delete(row.id)
    this.consecutiveFailures.delete(row.id)
    await this.teardownConnection(row.id)
    await this.syncMcpEnvironment(row)
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

  private async writeStatus(id: string, generation: number, ...update: [status: IntegrationStatus, error?: string | null, expectedConfig?: string]): Promise<boolean | undefined> {
    const previous = this.statusWrites.get(id) ?? Promise.resolve()
    const write = previous.catch(() => {}).then(async () => {
      if (this.generationOf(id) !== generation || (this.pausedIds.has(id) && update[0] !== 'paused')) return
      // A credential invalidation can originate outside this connector (MCP).
      // It must not be overwritten by an in-flight transport error/recovery.
      return updateIntegrationStatus(id, ...update)
    })
    this.statusWrites.set(id, write)
    try { return await write }
    finally { if (this.statusWrites.get(id) === write) this.statusWrites.delete(id) }
  }

  // ── Chat clears ─────────────────────────────────────────────────────

  /**
   * Recorded synchronously the moment a chat session clear begins. A restore
   * that issued its row lookup before the clear can otherwise get the
   * pre-clear row back after the clear has completed; a lookup that a clear
   * overlapped is repeated. Counted for the whole manager: a clear by session
   * id does not know its chat until it has looked the row up itself.
   */
  private noteSessionClear(rowId?: string): void {
    this.sessionClears += 1
    if (rowId) this.clearedSessionRows.add(rowId)
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

    console.log('[AgentIntegrationManager] Reconnecting all integrations (system resume)')
    this.resumeReconcile = (async () => {
      try {
        do {
          this.resumeQueued = false
          await this.reconcileIntegrations({ force: true })
          // The force pass races the network coming back up, so failures are
          // expected; they're no longer orphans, but the next regular tick is up
          // to 5 minutes out — too long right after opening the lid. Run a few
          // quick follow-ups while anything is still down.
          for (const delayMs of AgentIntegrationManager.RESUME_RETRY_DELAYS_MS) {
            if (this.resumeQueued) break // a fresh wake wants a full force pass instead
            if (!(await this.hasDisconnectedIntegrations())) break
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

  private async hasDisconnectedIntegrations(): Promise<boolean> {
    return (await listStartupIntegrations()).some(
      (i) => !(this.connections.get(i.id)?.connector.isConnected() ?? false),
    )
  }

  async addIntegration(id: string): Promise<void> {
    // Claim the integration before the read: a pause or removal that lands
    // while the row is being read must win, not be undone by this connect.
    const generation = this.bumpGeneration(id)
    const integration = await getIntegration(id)
    if (!integration) throw new Error(`Chat integration ${id} not found`)
    if (this.generationOf(id) !== generation || integration.status === 'paused') return
    // Setup/re-authorization can persist active credentials before calling add.
    // That explicit activation supersedes our prior local pause intent.
    this.pausedIds.delete(id)
    await this.connectIntegration(integration, generation)
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
        new Promise<void>((resolve) => { timer = setTimeout(resolve, AgentIntegrationManager.DISCONNECT_TIMEOUT_MS) }),
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
    const integration = await getIntegration(integrationId)
    if (!integration) throw new Error(`Chat integration ${integrationId} not found`)
    // An outbound send may finish while its connection is being rebuilt. Access
    // and session policy still come from the current persisted installation.
    if (!(await this.registry.isAllowed({ integration, externalId: chatId }))) throw new Error(`Chat ${chatId} is not allowed for integration ${integrationId}`)

    const displayName = await getLastDisplayName(integrationId, chatId)
    const policy = this.registry.sessionPolicy(integration, { externalId: chatId, displayName: displayName ?? undefined })
    const existing = await resolveActiveSession(
      integrationId, chatId, policy.timeoutHours,
      (archivedId) => {
        void this.teardownManagedSession(integrationId, chatId)
        this.lastSessionTouch.delete(archivedId)
      },
    )
    if (existing) return existing.sessionId

    const actor = agentRegistry.get(integration.agentSlug)

    const sessionId = crypto.randomUUID()
    await actor.sessions.register(sessionId, policy.name)
    await actor.sessions.updateMetadata(sessionId, {
      ...policy.metadata,
      isAgentIntegrationSession: true,
      agentIntegrationId: integration.id,
      ...(integration.createdByUserId ? { createdByUserId: integration.createdByUserId } : {}),
    })

    await createIntegrationSession({
      integrationId,
      externalId: chatId,
      sessionId,
      displayName,
    })

    return sessionId
  }

  async pauseIntegration(id: string): Promise<void> {
    const generation = this.bumpGeneration(id)
    this.pausedIds.add(id)
    await this.writeStatus(id, generation, 'paused')
    if (this.generationOf(id) !== generation) return
    await this.teardownConnection(id)
    const record = await getIntegration(id)
    if (record) await this.syncMcpEnvironment(record)
  }

  async resumeIntegration(id: string): Promise<void> {
    // Same claim-before-read as addIntegration: the row read and the status
    // write are both windows in which a pause can land.
    const generation = this.bumpGeneration(id)
    this.pausedIds.delete(id)
    const integration = await getIntegration(id)
    if (!integration) throw new Error(`Chat integration ${id} not found`)
    if (this.generationOf(id) !== generation) return
    // A token invalidation or replacement after the read must win this activation.
    if (await this.writeStatus(id, generation, 'active', null, integration.config) === false) return
    if (this.generationOf(id) !== generation) return
    await this.connectIntegration({ ...integration, status: 'active' }, generation)
  }

  getConnector(integrationId: string): AgentIntegration | undefined {
    return this.connections.get(integrationId)?.connector
  }

  /**
   * Introduce the agent as a saveable phone contact, once, at integration creation.
   *
   * Never called on connect: `connectIntegration` also fires on every boot, every
   * reconnect backoff, and every reconcile cycle, so a connect hook would re-send
   * forever and would need a once-only flag that the creation hook does not.
   *
   * Fire-and-forget by design — a missing contact card is cosmetic, a failed setup
   * is not, so this never throws.
   */
  async integrationCreated(integrationId: string): Promise<void> {
    try {
      const integration = await getIntegration(integrationId)
      if (integration) await this.getConnector(integrationId)?.onCreated(integration)
    } catch (err) {
      reportError(err, 'integration-created', { integrationId })
    }
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
   * `expectedGeneration` is passed by callers that claimed the integration
   * before their own reads (add, resume, rebuild); a call that omits it takes
   * ownership here via a bump.
   */
  private async connectIntegration(integration: AgentIntegrationRecord, expectedGeneration?: number): Promise<boolean> {
    const id = integration.id
    const generation = expectedGeneration ?? this.bumpGeneration(id)
    if (this.generationOf(id) !== generation || this.pausedIds.has(id)) return false

    if (this.connections.has(id)) {
      await this.teardownConnection(id)
      // A newer lifecycle operation landed while we waited on the teardown.
      if (this.generationOf(id) !== generation) return false
    }

    const connector = await this.createConnector(integration)
    // Another window: creating the connector can await.
    if (this.generationOf(id) !== generation) return false

    connector.bindHost({ session: async externalId => this.connections.get(id)?.connector === connector
      ? this.recoverSessionContext(id, externalId, generation) : undefined })

    const conn: IntegrationConnection = {
      connector,
      integration,
      eventUnsubscribe: null,
      errorUnsubscribe: null,
    }

    conn.eventUnsubscribe = connector.onEvent(async event => {
      try {
        if (event.type === 'input') this.enqueueMessage(integration.id, event)
        else if (event.type === 'cancel') {
          if (!(await this.isAllowed(integration.id, event.externalId))) return
          const session = await getIntegrationSession(integration.id, event.externalId)
          if (session && (await agentRegistry.get(integration.agentSlug).messages.interrupt(session.sessionId)).interrupted) event.onInterrupted?.()
        }
        else if (event.type === 'response') await this.handleInteractiveResponse(integration.id, event)
        else if ((await this.isAllowed(integration.id, event.externalId))) this.preWarmContainer(integration.agentSlug)
      } catch (error) {
        // Processing failures concern this event, not the health of the transport.
        console.error(`[AgentIntegrationManager] Failed to handle ${event.type} event for ${integration.id}:`, error)
        reportError(error, 'event-handler', { integrationId: integration.id, provider: integration.provider, eventType: event.type, externalId: event.externalId })
      }
    })

    conn.errorUnsubscribe = connector.onError(async (error) => {
      console.error(`[AgentIntegrationManager] Connector error for ${integration.id}:`, error)
      reportError(error, 'connector-error', { integrationId: integration.id, provider: integration.provider, agentSlug: integration.agentSlug })
      try { await this.writeStatus(integration.id, generation, 'error', error.message) } catch { /* best-effort */ }
      this.emitNotification(integration, 'error', error.message)
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
    const existingSessions = await listActiveIntegrationSessions(integration.id)
    for (const session of existingSessions) {
      if (!(await this.isAllowed(integration.id, session.externalId))) continue
      // The access check is a window in which the chat can be cleared and its
      // row archived: only a row that is still the live one is re-subscribed,
      // and only while this connect still owns the integration. The lookup is
      // a window too: a clear that completes while it is in flight can leave
      // it answering with the row it read before, so a lookup that a clear
      // overlapped is repeated.
      let live: Awaited<ReturnType<typeof getIntegrationSession>> | undefined
      for (let attempt = 0; attempt < 3 && live === undefined; attempt++) {
        const clearsBefore = this.sessionClears
        const row = await getIntegrationSession(integration.id, session.externalId)
        if (this.sessionClears === clearsBefore) live = row
      }
      // A clear whose archive is still pending can leave the row reading as
      // active through every retry; the row id it marked at the start says so.
      if (live?.sessionId !== session.sessionId || this.clearedSessionRows.has(live.id)) continue
      if (this.generationOf(id) !== generation) return false
      this.subscribeChatSession(integration.id, session.externalId, session.sessionId)
    }
    // Recovery is bounded to work the family declares unfinished, and runs off
    // the boot/connect critical path so one slow container cannot block others.
    void connector.sessionsToRecover().then(async sessions => {
      for (const session of sessions) {
        if (this.connections.get(id) !== conn || this.generationOf(id) !== generation) return
        await this.recoverSessionContext(id, session.externalId, generation, session.sessionId)
      }
    }).catch(error => reportError(error, 'restore-sessions', { integrationId: id }))
    await this.syncMcpEnvironment(integration)
    return this.generationOf(id) === generation
  }

  private async syncMcpEnvironment(integration: AgentIntegrationRecord): Promise<void> {
    if (!this.registry.getDefinition(integration.provider)?.capabilities.includes('mcp')) return
    try { await syncRemoteMcpAgents([integration.agentSlug]) }
    catch (error) { reportError(error, 'sync-mcp', { integrationId: integration.id }) }
  }

  private async createConnector(integration: AgentIntegrationRecord): Promise<AgentIntegration> {
    return this.registry.create(integration)
  }

  private disconnectConnection(conn: IntegrationConnection): Promise<void> {
    conn.eventUnsubscribe?.()
    conn.errorUnsubscribe?.()
    return conn.connector.disconnect().catch((err) => {
      console.error(`[AgentIntegrationManager] Error disconnecting:`, err)
      reportError(err, 'disconnect', { integrationId: conn.integration.id, provider: conn.integration.provider })
    })
  }

  // ── Chat session management ────────────────────────────────────────

  private getChatSessionKey(integrationId: string, chatId: string): string {
    return `${integrationId}:${chatId}`
  }

  private getOrCreateChatSession(integrationId: string, chatId: string): ManagedSession | null {
    const key = this.getChatSessionKey(integrationId, chatId)
    const existing = this.chatSessions.get(key)
    if (existing) return existing

    const conn = this.connections.get(integrationId)
    if (!conn) return null

    const session: ManagedSession = {
      connector: conn.connector, integration: conn.integration, chatId,
      context: { integration: conn.integration, externalId: chatId }, sseUnsubscribe: null,
    }
    this.chatSessions.set(key, session)
    return session
  }

  private subscribeChatSession(integrationId: string, chatId: string, sessionId: string): void {
    const session = this.getOrCreateChatSession(integrationId, chatId)
    if (!session) return
    const agentSlug = session.integration.agentSlug

    session.sseUnsubscribe?.()
    if (session.sessionId && session.sessionId !== sessionId) {
      session.connector.releaseSession(session.context)
      clearTimeout(session.recoveryTimer)
      session.recoveryTimer = undefined
      session.recovery = undefined
      session.recovered = false
      session.recoveryReported = false
    }
    session.sessionId = sessionId
    session.context = this.withActivity({ ...session.context, sessionId }, session)
    const actor = agentRegistry.get(agentSlug)
    session.sseUnsubscribe = actor.messages.subscribe(sessionId, (event: unknown) => {
      this.enqueueSSEEvent(integrationId, chatId, event, sessionId, session)
    })
    session.connector.observeSession(session.context)
  }

  private withActivity(context: IntegrationSessionContext, managed?: ManagedSession): IntegrationSessionContext {
    return { ...context, get activity() {
      if (!context.sessionId || !managed || managed.sessionId !== context.sessionId) return 'unknown'
      const activity = agentRegistry.get(context.integration.agentSlug).sessions.activity(context.sessionId)
      // Busy is already proven by the host; default idle is not proof after restart.
      return managed.recovered || activity !== 'idle' ? activity : 'unknown'
    }, get pendingRequests() {
      return context.sessionId ? agentRegistry.get(context.integration.agentSlug).inputs.open(context.sessionId).filter(request => request.scope.sessionId === context.sessionId) : []
    } }
  }

  /** One owner for runtime recovery, including pause/clear races and retry. */
  private async recoverSessionContext(integrationId: string, externalId: string, generation: number, expectedSessionId?: string): Promise<IntegrationSessionContext | undefined> {
    const conn = this.connections.get(integrationId)
    if (!conn || !this.isRunning || this.generationOf(integrationId) !== generation) return
    const clears = this.sessionClears
    const row = await getIntegrationSession(integrationId, externalId)
    if (!row || (expectedSessionId && row.sessionId !== expectedSessionId) || this.clearedSessionRows.has(row.id) || clears !== this.sessionClears) return
    if (!(await this.isAllowed(integrationId, externalId)) || this.connections.get(integrationId) !== conn || this.generationOf(integrationId) !== generation || clears !== this.sessionClears) return
    let managed = this.chatSessions.get(this.getChatSessionKey(integrationId, externalId))
    if (!managed || managed.sessionId !== row.sessionId) {
      this.subscribeChatSession(integrationId, externalId, row.sessionId)
      managed = this.chatSessions.get(this.getChatSessionKey(integrationId, externalId))
    }
    if (!managed) return
    const session = managed
    const current = () => this.isRunning && this.connections.get(integrationId) === conn && this.generationOf(integrationId) === generation && this.isCurrentSession(integrationId, externalId, session, row.sessionId)
    const actor = agentRegistry.get(conn.integration.agentSlug)
    const lostActiveStream = !actor.sessions.isStreamSubscribed(row.sessionId) && actor.sessions.activity(row.sessionId) !== 'idle'
    if ((!session.recovered || lostActiveStream) && !session.recovery) {
      session.recovery = (async () => {
        if (!actor.sessions.isStreamSubscribed(row.sessionId) || actor.sessions.activity(row.sessionId) === 'idle') {
          if (!actor.sessions.isStreamSubscribed(row.sessionId)) await actor.container.start()
          if (!current() || !(await this.isAllowed(integrationId, externalId)) || !current()) return
          // Cold hosts otherwise discard terminal replay as already settled.
          // Only an explicit recovery demand reaches here; idle historical
          // mappings are never marked active or attached on their own.
          if (actor.sessions.activity(row.sessionId) === 'idle') actor.sessions.markActive(row.sessionId)
          // Host delivery is already listening; the handshake can replay idle/error.
          await actor.sessions.subscribeStream(row.sessionId, row.sessionId)
        }
        if (!current()) return
        session.recovered = true
        session.recoveryReported = false
        clearTimeout(session.recoveryTimer)
        session.recoveryTimer = undefined
        session.connector.observeSession(session.context)
      })().catch(error => {
        if (!current()) return
        if (this.isSessionGoneError(error)) {
          session.recovered = true
          // Clear the provisional activity without delivering a false successful
          // completion for the missing session. The next input owns reattachment.
          session.sseUnsubscribe?.()
          session.sseUnsubscribe = null
          actor.sessions.markIdle(row.sessionId)
          this.enqueueSSEEvent(integrationId, externalId, { type: 'session_error', error: 'The runtime session is no longer available.' }, row.sessionId)
          return
        }
        if (!session.recoveryReported) reportError(error, 'restore-stream', { integrationId, sessionId: row.sessionId })
        session.recoveryReported = true
        clearTimeout(session.recoveryTimer)
        session.recoveryTimer = setTimeout(() => {
          session.recoveryTimer = undefined
          void this.recoverSessionContext(integrationId, externalId, generation, row.sessionId)
            .catch(error => reportError(error, 'restore-stream', { integrationId }))
        }, 30_000)
        session.recoveryTimer.unref()
      }).finally(() => { if (session.sessionId === row.sessionId) session.recovery = undefined })
    }
    await session.recovery
    return current() ? session.context : undefined
  }

  // `observe` is the chat session to mark live before the event is handled.
  // The access check behind it is a database read, so it runs on the queue:
  // the broadcaster's callback stays synchronous, events keep the order they
  // arrived in, and a failed check lands in the error boundary below instead
  // of escaping as an unhandled rejection.
  private enqueueSSEEvent(integrationId: string, chatId: string, event: unknown, sessionId: string, observe?: ManagedSession): void {
    const queueKey = `sse:${integrationId}:${chatId}`
    const current = this.messageQueues.get(queueKey) ?? Promise.resolve()
    const next = current.then(async () => {
      try {
        if (observe && (await this.isAllowed(integrationId, chatId)) && this.isCurrentSession(integrationId, chatId, observe, sessionId)) {
          observe.connector.observeSession(observe.context)
        }
        await this.handleSSEEvent(integrationId, chatId, event, sessionId)
      } catch (err) {
        console.error(`[AgentIntegrationManager] Error handling SSE event:`, err)
        reportError(err, 'sse-event', { integrationId, chatId, eventType: (event as any)?.type })
      }
    })
    this.messageQueues.set(queueKey, next)
    this.scheduleQueueEviction(queueKey, next)
  }

  /**
   * Whether `session` is still the live chat session for this chat, bound to
   * `sessionId`. A queued observation waits behind earlier events; if the
   * chat was cleared or re-pointed meanwhile, observing would revive a
   * session the connector has already released.
   */
  private isCurrentSession(integrationId: string, chatId: string, session: ManagedSession, sessionId: string | undefined): boolean {
    const live = this.chatSessions.get(this.getChatSessionKey(integrationId, chatId))
    return live === session && live.sessionId === sessionId
  }

  // ── Health monitoring ───────────────────────────────────────────────

  private async runHealthChecks(): Promise<void> {
    for (const session of [...this.chatSessions.values()]) {
      if (!(await this.isAllowed(session.integration.id, session.chatId))) continue
      // The access check is a window in which the chat can be cleared.
      if (!this.isCurrentSession(session.integration.id, session.chatId, session, session.sessionId)) continue
      session.connector.observeSession(session.context)
      if (session.sessionId) {
        const actor = agentRegistry.get(session.integration.agentSlug)
        if (actor.sessions.activity(session.sessionId) !== 'idle' && !actor.sessions.isStreamSubscribed(session.sessionId)) {
          void this.recoverSessionContext(session.integration.id, session.chatId, this.generationOf(session.integration.id), session.sessionId)
            .catch(error => reportError(error, 'restore-stream', { integrationId: session.integration.id }))
        }
      }
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
    for (const integration of await listStartupIntegrations()) {
      // A stop() mid-pass (app shutdown) must not resurrect connections it
      // just tore down.
      if (!this.isRunning) return
      const id = integration.id
      const generation = this.generationOf(id)
      if (this.reconcilingIds.has(id) || this.pausedIds.has(id)) continue

      const conn = this.connections.get(id)
      const connected = conn?.connector.isConnected() ?? false

      if (connected && !opts.force) {
        this.disconnectedSince.delete(id)
        this.consecutiveFailures.delete(id)
        if (integration.status === 'error') {
          // The connector recovered on its own — clear the stale error badge.
          try { await this.writeStatus(id, generation, 'active', null) } catch { /* best-effort */ }
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
      const integration = await getIntegration(id)
      if (!integration || integration.status === 'paused') return
      // The read is a window in which a user operation can take ownership; a
      // teardown now would kill the connection that operation just made.
      if (!this.isRunning || this.generationOf(id) !== generation) return

      // The teardown wipes the failure counter (correct for user-initiated
      // removal); capture it first so retry accounting survives.
      const prevFailures = this.consecutiveFailures.get(id) ?? 0
      try {
        await this.teardownConnection(id)
        // Re-read after the teardown await — a user operation may have landed
        // in the gap, and the manager may have been stopped.
        if (!this.isRunning || this.generationOf(id) !== generation) return
        const fresh = await getIntegration(id)
        if (!fresh || fresh.status === 'paused') return
        if (!this.isRunning || this.generationOf(id) !== generation) return

        const connected = await this.connectIntegration(fresh, generation)
        if (!connected) return // ownership lost mid-connect — cancelled, not successful
        this.disconnectedSince.delete(id)
        this.consecutiveFailures.delete(id)
        if (fresh.status === 'error') {
          try { await this.writeStatus(id, generation, 'active', null) } catch { /* best-effort */ }
        }
      } catch (err) {
        // A cancelled rebuild reports nothing: the failure was (or may have
        // been) caused by the user's own operation tearing our connect down,
        // and an 'error' write would flip their fresh 'paused' back to a
        // startup-eligible status.
        if (!this.isRunning || this.generationOf(id) !== generation) return
        const failures = prevFailures + 1
        this.consecutiveFailures.set(id, failures)
        console.error(`[AgentIntegrationManager] Reconnect failed for ${id} (attempt ${failures}):`, err)
        reportError(err, operation, { integrationId: id, provider: integration.provider, attempt: failures })

        if (failures >= HEALTH_CHECK_MAX_CONSECUTIVE_FAILURES) {
          console.error(`[AgentIntegrationManager] ${id}: ${failures} consecutive reconnect failures — pausing`)
          reportError(new Error(`Auto-paused after ${failures} failures`), 'health-check-auto-pause', { integrationId: id, provider: integration.provider, failures }, 'warning')
          try {
            await this.writeStatus(id, generation, 'paused', `Auto-paused after ${failures} failed reconnection attempts`)
            if (this.isRunning && this.generationOf(id) === generation) await this.syncMcpEnvironment(integration)
          } catch { /* best-effort */ }
          this.emitNotification(integration, 'error', `Auto-paused after ${failures} failed reconnect attempts`)
          this.disconnectedSince.delete(id)
          this.consecutiveFailures.delete(id)
          return
        }

        try { await this.writeStatus(id, generation, 'error', `Reconnect failed (attempt ${failures}): ${err}`) } catch { /* best-effort */ }
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

  private enqueueMessage(integrationId: string, message: IntegrationInputEvent): void {
    const connector = this.connections.get(integrationId)?.connector
    if (!connector) return
    const route = connector.resolveRoute(message)
    if (!route.externalId) return
    const queueKey = `${integrationId}:${route.externalId}`
    const current = this.messageQueues.get(queueKey) ?? Promise.resolve()
    const next = current.then(() =>
      this.handleIncomingMessage(integrationId, message, route).catch((err) => {
        console.error(`[AgentIntegrationManager] Error handling incoming message:`, err)
        reportError(err, 'incoming-message', { integrationId, chatId: message.externalId })
      })
    )
    this.messageQueues.set(queueKey, next)
    this.scheduleQueueEviction(queueKey, next)
  }

  // ── Incoming message handling ─────────────────────────────────────

  private async handleIncomingMessage(integrationId: string, message: IntegrationInputEvent, route?: IntegrationRoute): Promise<void> {
    const integration = await getIntegration(integrationId)
    if (!integration) return
    return runWithOptionalUser(integration.createdByUserId ?? undefined, () =>
      this.handleIncomingMessageInner(integrationId, message, integration, route),
    )
  }

  private async handleIncomingMessageInner(
    integrationId: string,
    message: IntegrationInputEvent,
    integration: AgentIntegrationRecord,
    resolvedRoute?: IntegrationRoute,
  ): Promise<void> {
    const conn = this.connections.get(integrationId)
    if (!conn) return

    const route = resolvedRoute ?? conn.connector.resolveRoute(message)
    const chatId = route.externalId
    if (!chatId) return
    const context = { integration, externalId: chatId, interactionId: route.interactionId, replyTarget: route.replyTarget }
    if (!await conn.connector.authorize(context, message)) return
    if (!(await this.isAllowed(integrationId, chatId))) return
    if (route.notice) await this.deliver(integrationId, chatId, { type: 'message', text: route.notice })
    if (route.action === 'ignore') return
    if (route.action === 'reset') {
      await this.clearChatSession(integrationId, chatId)
      return
    }

    // Lazy import to avoid circular dependencies
    const { agentExists } = await import('@shared/lib/services/agent-service')

    // Verify agent exists
    if (!(await agentExists(integration.agentSlug))) {
      await this.deliver(integrationId, chatId, { type: 'message',
        text: 'Error: The agent no longer exists.',
      })
      try { await this.writeStatus(integrationId, this.generationOf(integrationId), 'error', 'Agent no longer exists') } catch { /* best-effort */ }
      return
    }

    // Revoke can land mid-flight (during the awaits above). Re-check before spending.
    if (!(await this.isAllowed(integrationId, chatId))) return

    // Ensure container is running
    const actor = agentRegistry.get(integration.agentSlug)
    try {
      await actor.container.start()
    } catch (err) {
      console.error(`[AgentIntegrationManager] Container startup failed for ${integration.agentSlug}:`, err)
      reportError(err, 'container-startup', { integrationId, agentSlug: integration.agentSlug, provider: integration.provider })
      await this.deliver(integrationId, chatId, { type: 'message', inputId: message.id, retryable: true, text: 'Error: Failed to start the agent container. Please try again.' }).catch(() => {})
      return
    }

    // Look up existing session, rotating if timed out
    const chatSession = await resolveActiveSession(
      integrationId, chatId, conn.connector.sessionPolicy(integration, route).timeoutHours,
      (archivedId) => {
        breadcrumb('Session timed out, rotating', { integrationId, chatId, timeoutHours: conn.connector.sessionPolicy(integration, route).timeoutHours })
        void this.teardownManagedSession(integrationId, chatId)
        this.lastSessionTouch.delete(archivedId)
      },
    )

    if (!chatSession) {
      // New chat — create a new agent session
      try {
        const input = await conn.connector.prepareInput(message, { ...context, actor })
        if (input.skip) return

        // Revoke can land mid-flight (during the awaits above). Re-check before spending.
        if (!(await this.isAllowed(integrationId, chatId))) return

        await this.startNewChatSession(integration, actor, route, input)
        return // initialMessage already sent via createSession
      } catch (err) {
        console.error(`[AgentIntegrationManager] Failed to create new session for ${integrationId}:`, err)
        // This path recovers and prompts the user to retry. A dead container
        // ("Container is not running") is expected and self-healing here, so
        // report it as a warning rather than an error to cut Sentry noise.
        reportError(err, 'create-session', { integrationId, agentSlug: integration.agentSlug, provider: integration.provider, chatId }, isContainerNotRunning(err) ? 'warning' : 'error')
        await this.deliver(integrationId, chatId, { type: 'message', inputId: message.id, text: 'Error: Failed to start a new session. Please try again.' }).catch(() => {})
        return
      }
    }

    // Update display name if we now have a better one
    // (covers the case where resolveUserName failed on first message but succeeds later)
    const resolvedName = route.displayName
    if (resolvedName && resolvedName !== chatSession.displayName && conn.connector.shouldUpdateDisplayName(chatSession.displayName)) {
      try { await updateIntegrationSessionName(chatSession.id, resolvedName) } catch { /* best-effort */ }
    }

    const sessionId = chatSession.sessionId

    // Hoisted so the catch can reuse it for self-heal without re-downloading.
    let input: PreparedIntegrationInput | undefined
    try {
      // Attach delivery before reconnecting the runtime stream: subscribeStream can replay immediately.
      this.subscribeChatSession(integrationId, chatId, sessionId)
      if (!actor.sessions.isStreamSubscribed(sessionId)) {
        await actor.sessions.subscribeStream(sessionId, sessionId)
      }

      const observed = this.chatSessions.get(this.getChatSessionKey(integrationId, chatId))
      if (observed?.sessionId === sessionId) observed.recovered = true
      input = await conn.connector.prepareInput(message, { ...context, actor, sessionId })
      if (input.skip) return

      // Revoke can land mid-flight (during the awaits above). Re-check before spending.
      if (!(await this.isAllowed(integrationId, chatId))) return

      // A plain-text reply to an open single-question card continues the same turn as the
      // free-form "Other" answer; anything else cancels the pending request (and strips its
      // now-abandoned card) so this message starts a fresh turn instead of deadlocking. No-op
      // when not awaiting. Mirrors the app send-message route.
      const consumed = await conn.connector.consumeInput(message, { ...context, actor, sessionId }, input)
      if (consumed) return

      const managed = this.chatSessions.get(this.getChatSessionKey(integrationId, chatId))
      if (managed) managed.context = this.withActivity({ ...context, sessionId }, managed)
      await this.deliver(integrationId, chatId, { type: 'turn-started' }, sessionId)
      await actor.messages.withSend(sessionId, () => actor.messages.send(sessionId, input!.text))
      const now = Date.now()
      const lastTouch = this.lastSessionTouch.get(chatSession.id) ?? 0
      if (now - lastTouch > 60_000) {
        try { await touchIntegrationSession(chatSession.id) } catch { /* best-effort */ }
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
        console.warn(`[AgentIntegrationManager] Agent session ${sessionId} gone in container; rotating chat ${chatId} to a fresh session`)
        breadcrumb('Chat agent session gone, self-healing', { integrationId, chatId, sessionId })
        await this.teardownManagedSession(integrationId, chatId, { archive: chatSession.id })
        try {
          // messageText is already built unless we failed before it (e.g. the
          // subscribe threw); rebuild in that rare case so the message isn't lost.
          input ??= await conn.connector.prepareInput(message, { ...context, actor })
          if (input.skip) return
          // Revoke can land mid-flight (during the awaits above). Re-check before spending.
          if (!(await this.isAllowed(integrationId, chatId))) return
          await this.startNewChatSession(integration, actor, route, input)
          return
        } catch (healErr) {
          console.error(`[AgentIntegrationManager] Self-heal failed for ${integrationId}/${chatId}:`, healErr)
          reportError(healErr, 'send-message-selfheal', { integrationId, chatId, provider: integration.provider }, isContainerNotRunning(healErr) ? 'warning' : 'error')
          await this.deliver(integrationId, chatId, { type: 'message', inputId: message.id, text: 'Error: Failed to send your message to the agent. Please try again.' }).catch(() => {})
          return
        }
      }

      console.error(`[AgentIntegrationManager] Failed to send message for ${integrationId}/${sessionId}:`, err)
      // Recovered path (user is told to retry); a dead container is expected and
      // self-healing, so downgrade it to a warning to cut Sentry noise.
      reportError(err, 'send-message', { integrationId, sessionId, provider: integration.provider, chatId }, isContainerNotRunning(err) ? 'warning' : 'error')
      await this.deliver(integrationId, chatId, { type: 'message', inputId: message.id, text: 'Error: Failed to send your message to the agent. Please try again.' }).catch(() => {})
      return
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
    integration: AgentIntegrationRecord,
    actor: AgentActor,
    route: IntegrationRoute,
    input: PreparedIntegrationInput,
  ): Promise<void> {
    const { getEffectiveModels } = await import('@shared/lib/config/settings')
    const { getSecretEnvVars } = await import('@shared/lib/services/secrets-service')
    const { readAgentPreferences } = await import('@shared/lib/services/agent-preferences-service')

    const connector = this.connections.get(integration.id)?.connector
    if (!connector) return
    const chatId = route.externalId
    const availableEnvVars = await getSecretEnvVars(integration.agentSlug)
    // Provider-specific session context (DM vs channel vs thread, delivery
    // semantics) — owned by each connector class, not the manager.
    const systemPrompt = input.systemPrompt
    // Model/effort/speed preference order: integration override > agent default > global default.
    const models = getEffectiveModels()
    const agentPrefs = await readAgentPreferences(integration.agentSlug)
    const resolved = resolveRuntimeInherit(
      { model: integration.model, effort: integration.effort, speed: integration.speed },
      agentPrefs,
      models,
    )

    const containerSession = await actor.sessions.create({
      availableEnvVars: availableEnvVars.length > 0 ? availableEnvVars : undefined,
      initialMessage: input.text,
      model: resolved.model,
      browserModel: models.browserModel,
      dashboardBuilderModel: models.dashboardBuilderModel,
      effort: resolved.effort,
      ...(resolved.speed ? { speed: resolved.speed } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
    })

    const sessionId = containerSession.id
    breadcrumb('New chat session created', { integrationId: integration.id, sessionId, provider: integration.provider })

    const displayName = route.displayName
    const policy = connector.sessionPolicy(integration, route)
    await actor.sessions.register(sessionId, policy.name)
    await actor.sessions.updateMetadata(sessionId, {
      ...policy.metadata,
      isAgentIntegrationSession: true,
      agentIntegrationId: integration.id,
      ...(integration.createdByUserId ? { createdByUserId: integration.createdByUserId } : {}),
    })

    await createIntegrationSession({
      integrationId: integration.id,
      externalId: chatId,
      sessionId,
      displayName,
    })

    // createSession already started this turn. Observe it and wire chat delivery
    // before attaching, so even a fast turn's replay is consumed and forwarded.
    const managed = this.getOrCreateChatSession(integration.id, chatId)
    if (managed) managed.context = this.withActivity({ integration, externalId: chatId, sessionId, interactionId: route.interactionId, replyTarget: route.replyTarget }, managed)
    await this.deliver(integration.id, chatId, { type: 'turn-started' }, sessionId)
    actor.sessions.markActive(sessionId)
    this.subscribeChatSession(integration.id, chatId, sessionId)
    await actor.sessions.subscribeStream(sessionId, sessionId)
    if (managed) managed.recovered = true
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
  private stopSession(session: ManagedSession): void {
    clearTimeout(session.recoveryTimer)
    session.sseUnsubscribe?.()
    session.connector.releaseSession(session.context)
  }

  private async teardownManagedSession(integrationId: string, chatId: string, opts?: { archive?: string }): Promise<void> {
    this.noteSessionClear(opts?.archive)
    const key = this.getChatSessionKey(integrationId, chatId)
    const managed = this.chatSessions.get(key)
    if (managed) this.stopSession(managed)
    this.chatSessions.delete(key)
    if (opts?.archive) {
      this.lastSessionTouch.delete(opts.archive)
      try { await archiveIntegrationSession(opts.archive) } catch { /* best-effort */ }
    }
  }

  private async clearChatSession(
    integrationId: string,
    chatId: string,
  ): Promise<void> {
    try {
      const chatSession = await getIntegrationSession(integrationId, chatId)
      if (chatSession) {
        await this.teardownManagedSession(integrationId, chatId, { archive: chatSession.id })
      }
    } catch (err) {
      console.error('[AgentIntegrationManager] Error during session clear:', err)
      reportError(err, 'clear-session', { integrationId, chatId })
    }

    await this.deliver(integrationId, chatId, { type: 'session-reset' }).catch(() => {})
  }

  /** Clear a chat session by its DB row ID (called from API route). */
  async clearSessionById(sessionId: string): Promise<void> {
    this.noteSessionClear(sessionId)
    for (const [key, managed] of this.chatSessions) {
      const { id: integrationId } = managed.integration
      const chatId = managed.chatId
      const chatSession = await getIntegrationSession(integrationId, chatId)
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
  async notifyAccessApproved(integrationId: string, externalId: string): Promise<void> {
    const conn = this.connections.get(integrationId)
    if (!conn) return
    try {
      await this.deliver(integrationId, externalId, { type: 'access-approved' })
    } catch (e) {
      captureException(e, { tags: { component: COMPONENT, operation: 'approve-notice' }, level: 'warning' })
    }
  }

  /**
   * Tear down the managed chat session for a revoked external chat:
   * unsubscribes SSE delivery and archives the DB session row.
   */
  async releaseExternalSession(integrationId: string, externalId: string): Promise<void> {
    const session = await getIntegrationSession(integrationId, externalId)
    if (!session) return
    await this.teardownManagedSession(integrationId, externalId)
    await archiveIntegrationSession(session.id)
  }

  /**
   * Reconcile running sessions against current access (called when approval is
   * enabled). Tears down any active session whose chat is no longer allowed, so
   * a flip to require-approval immediately gates previously-public conversations.
   */
  async reconcileAccess(integrationId: string): Promise<void> {
    const sessions = await listIntegrationSessions(integrationId)
    for (const session of sessions) {
      if (session.archivedAt) continue
      if (!(await this.isAllowed(integrationId, session.externalId))) {
        await this.releaseExternalSession(integrationId, session.externalId)
      }
    }
  }

  /** Pre-warm the agent container so it's ready when the user's message arrives. */
  private preWarmContainer(agentSlug: string): void {
    agentRegistry.get(agentSlug).container.start().catch(() => {
      // Best-effort — if it fails, the normal message flow will handle the error
    })
  }

  // ── Global notification handling (proxy review requests) ─────────

  /**
   * Review requests may be agent-scoped without a session SSE stream. This
   * subscription routes their Allow/Deny cards; resolutions use the session stream.
   * Idempotent so a harness that drives integrations without start() can arm
   * it without risking a double-send.
   */
  private subscribeGlobalNotifications(): void {
    if (this.globalNotificationUnsubscribe) return
    this.globalNotificationUnsubscribe = messagePersister.addGlobalNotificationClient((event: unknown) => {
      this.handleGlobalNotification(event).catch((err) => {
        console.error('[AgentIntegrationManager] Error handling global notification:', err)
        reportError(err, 'global-notification')
      })
    })
  }

  private async handleGlobalNotification(event: unknown): Promise<void> {
    const data = event as Record<string, unknown>
    // Review cards use this global wire because their scope may omit a session.
    // Resolutions with a session scope already arrive on that session's stream;
    // forwarding them here as well would deliver each resolution twice.
    if (data.type !== 'user_request_created') return
    const parsed = integrationRequestEventSchema.safeParse(event)
    if (!parsed.success || parsed.data.type !== 'user_request_created') return
    const request = parsed.data.request
    if (request.scope.sessionId) return

    // Non-review kinds return null here and are left to the session stream —
    // they arrive on BOTH wires, so rendering them here too would double-send.
    const isReview = request.kind === 'proxy_review' || request.kind === 'x_agent_review'
    const agentSlug = request.scope.agentSlug
    if (!isReview || !agentSlug) return

    // A proxied call carries no session of its own, so the scope has none to
    // route by; the agent's active session is the same fallback the review
    // notification uses, and it is what gives the card's link a live session
    // to open rather than the agent home.
    const sessionId =
      request.scope.sessionId ?? agentRegistry.get(agentSlug).sessions.activeIds()[0]

    // If we know the sessionId, send only to the chat session that owns it
    if (sessionId) {
      try {
        const chatSession = await getIntegrationSessionBySessionId(agentSlug, sessionId)
        if (chatSession) {
          const key = `${chatSession.integrationId}:${chatSession.externalId}`
          const managed = this.chatSessions.get(key)
          if (managed && (managed.connector.definition.family === 'chat' || request.scope.sessionId === managed.sessionId)) {
            await this.deliver(managed.integration.id, managed.chatId, { type: 'request-opened', request }, sessionId)
            return
          }
        }
      } catch (err) {
        console.error('[AgentIntegrationManager] Error routing approval to session:', err)
        reportError(err, 'route-approval', { agentSlug, sessionId })
      }
    }

    // Fallback: no sessionId match — send to first active session for this agent
    for (const [, conn] of this.connections) {
      if (conn.integration.agentSlug !== agentSlug || conn.connector.definition.family !== 'chat') continue
      for (const [key, session] of this.chatSessions) {
        if (!key.startsWith(`${conn.integration.id}:`)) continue
        try {
          await this.deliver(session.integration.id, session.chatId, { type: 'request-opened', request })
        } catch (err) {
          console.error('[AgentIntegrationManager] Failed to send approval card:', err)
        }
        return // Only send to first match
      }
    }
  }

  // ── SSE event handling ────────────────────────────────────────────

  private async handleSSEEvent(integrationId: string, chatId: string, event: unknown, sessionId: string): Promise<void> {
    const key = this.getChatSessionKey(integrationId, chatId)
    const session = this.chatSessions.get(key)
    if (!session) return

    // Fail closed: never forward agent output to a chat that is no longer allowed.
    // Teardown normally unsubscribes on revoke/deny, but this guards the window
    // where an event is already in flight when access is revoked.
    if (!(await this.isAllowed(integrationId, chatId))) return

    if (session.sessionId !== sessionId) return // discard output queued before rotation
    const integration = await getIntegration(integrationId)
    if (!integration) return
    // Both awaits above are windows in which the chat can be cleared; the
    // session captured before them must still be the live one.
    if (!this.isCurrentSession(integrationId, chatId, session, sessionId)) return
    const eventType = (event as { type?: string } | null)?.type
    if (eventType === 'session_active' || eventType === 'session_idle' || eventType === 'session_error') session.recovered = true
    const context = this.withActivity({ ...session.context, integration }, session)
    if (eventType === 'user_request_created' || eventType === 'user_request_resolved') {
      const parsed = integrationRequestEventSchema.safeParse(event)
      if (!parsed.success) return
      const data = parsed.data
      const scope = data.type === 'user_request_created' ? data.request.scope : data.scope
      if (scope.agentSlug !== integration.agentSlug || scope.sessionId !== sessionId) return
      await session.connector.deliver(context, data.type === 'user_request_created'
        ? { type: 'request-opened', request: data.request }
        : { ...data, type: 'request-resolved' })
      return
    }
    const type = eventType === 'session_idle' ? 'turn-completed' : eventType === 'session_error' ? 'turn-failed' : 'runtime'
    await session.connector.deliver(context, { type, event })
  }

  // ── Interactive response handling ─────────────────────────────────

  private async handleInteractiveResponse(
    integrationId: string,
    event: IntegrationResponseEvent,
  ): Promise<void> {
    const { requestId: toolUseId, externalId: chatId, value: response } = event
    if (!(await this.isAllowed(integrationId, chatId ?? ''))) return // revoked/stale keyboard, or missing identity → fail closed

    const integration = await getIntegration(integrationId)
    if (!integration) return

    // Handle proxy review decisions (tool approval requests)
    if (event.requestKind === 'review') {
      const reviewId = toolUseId
      if (response !== 'allow' && response !== 'deny') return
      const decision = response

      try {
        // Bound to this integration's agent: the id rides in from a chat
        // client, and submit returns false for a review that is
        // settled, of another kind, or another agent's.
        const settled = agentRegistry.get(integration.agentSlug).inputs.reviews.submit(reviewId, decision as 'allow' | 'deny')
        if (!settled) await this.replyAlreadyHandled(integrationId, chatId)
      } catch (err) {
        console.error(`[AgentIntegrationManager] Failed to submit review decision:`, err)
        reportError(err, 'review-decision', { integrationId, reviewId, decision })
      }
      return
    }

    // The same gate for container inputs. A card whose request was settled
    // elsewhere — answered in the app, cancelled by the next turn, invalidated
    // with a dead subagent — keeps live-looking buttons in chat; without this
    // the press buffers an earlyResult in the container that nothing will ever
    // consume, and the user walks away believing they answered. Not-open and
    // not-this-agent's collapse to the same reply on purpose: both mean the
    // button did nothing, and distinguishing them would confirm to one chat
    // that another agent holds that id.
    //
    // CLAIM it rather than merely reading it: everything below yields (the
    // dynamic import, ensureRunning, the resolve call), so a plain "is it
    // open?" read is check-then-act — a second press observes the same open
    // request and both proceed. claimRequest is a synchronous check-and-mark,
    // so exactly one presser wins.
    const actor = agentRegistry.get(integration.agentSlug)
    const open = actor.inputs.claim(toolUseId)
    if (!open || open.scope.agentSlug !== integration.agentSlug) {
      // Wrong agent: release immediately, we never had the right to hold it.
      if (open) actor.inputs.releaseClaim(toolUseId)
      await this.replyAlreadyHandled(integrationId, chatId)
      return
    }

    try {
      await actor.container.start()

      // Re-check with NO await between here and the container call. The claim
      // only excludes another chat press; a decision on another surface settles
      // the registry directly, and if that landed while ensureRunning was in
      // flight the container has nothing parked — resolving now would buffer an
      // earlyResult nothing will ever collect, which is the phantom this gate
      // exists to prevent. What remains after this is the container round trip
      // itself, which only the container can arbitrate.
      if (!(await this.isAllowed(integrationId, chatId)) || !actor.inputs.get(toolUseId)) {
        await this.replyAlreadyHandled(integrationId, chatId)
        return
      }


      const resolveResponse = await actor.container.fetch(
        `/inputs/${encodeURIComponent(toolUseId)}/resolve`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: response }),
        },
      )
      if (!resolveResponse.ok) {
        const text = await resolveResponse.text().catch(() => '')
        console.error(`[AgentIntegrationManager] Failed to resolve input ${toolUseId}:`, text)
        reportError(new Error(`Resolve input failed: ${resolveResponse.status}`), 'resolve-input', { integrationId, toolUseId, status: resolveResponse.status })
      } else {
        actor.inputs.complete(undefined, toolUseId, 'answered')
        event.onAnswered?.()
      }
    } catch (err) {
      console.error(`[AgentIntegrationManager] Failed to handle interactive response:`, err)
      reportError(err, 'interactive-response-resolve', { integrationId, toolUseId })
    } finally {
      // Unconditional: on the success path the claim is already gone (resolve
      // drops it with the entry), so this only matters for the paths that bail
      // — a container that never came up, a failed resolve, a settle that beat
      // us. A leaked claim would make the request undecidable forever, which is
      // worse than the race it guards.
      actor.inputs.releaseClaim(toolUseId)
    }
  }

  /**
   * Tell the chat that the button it just pressed is dead. Best-effort and
   * deliberately vague about why: silence is the failure mode this replaces —
   * a user who pressed Allow and got nothing back has no way to know whether
   * the agent is thinking or the press was swallowed.
   */
  private async replyAlreadyHandled(integrationId: string, chatId?: string): Promise<void> {
    if (!chatId) return
    const connector = this.connections.get(integrationId)?.connector
    if (!connector) return
    try {
      await this.deliver(integrationId, chatId, { type: 'request-settled' })
    } catch (err) {
      console.error('[AgentIntegrationManager] Failed to send already-handled notice:', err)
    }
  }

  // ── Notifications ──────────────────────────────────────────────────

  private emitNotification(
    integration: AgentIntegrationRecord,
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

// One application-wide coordinator. Legacy imports re-export this same instance.
const globalForManager = globalThis as unknown as { agentIntegrationManager?: AgentIntegrationManager }
export const agentIntegrationManager = globalForManager.agentIntegrationManager ?? new AgentIntegrationManager()
if (process.env.NODE_ENV !== 'production') globalForManager.agentIntegrationManager = agentIntegrationManager
