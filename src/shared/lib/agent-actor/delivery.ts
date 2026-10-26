/**
 * The actor's multi-step session ops: delivering a message, starting a
 * session, attaching its stream and stopping it. Each is one op because its
 * steps read and write the same live state: run as separate calls, a turn
 * could end between them (a model change then goes out mid-turn, a stale
 * `queued` is shown, a stop marks the turn that started after it).
 *
 * Composed from the agent's live sessions, its container client and its
 * session store, all inside the actor.
 */
import { background } from '@shared/lib/background'
import { MessageNotAcceptedError } from '@shared/lib/container/message-dispatch-error'
import type { ContainerSession, SendMessageOptions, SendMessageResult } from '@shared/lib/container/types'
import { getSettings } from '@shared/lib/config/settings'
import { sessionMetadataHolds } from '@shared/lib/services/session-metadata-holds'
import { isHiddenAutomatedSession } from '@shared/lib/services/session-visibility'
import type { SessionMetadata } from '@shared/lib/types/agent'
import { DeliveryError, StartError, type DeliveryErrorCode } from './delivery-errors'
import type { LiveSessions } from './live/live-sessions'
import type { LocalActorDeps } from './local-agent-actor'
import type { SessionStore } from './session-store'
import type {
  AgentSlug,
  DeliverRequest,
  DeliverResult,
  StartSessionRequest,
  StopSessionOptions,
  StopSessionResult,
  UserMessageEcho,
} from './types'

/** The selection fields a send may change; a change tells every window to refetch. */
const RUNTIME_SELECTION_KEYS = ['effort', 'speed', 'model', 'llmProviderId'] as const

export interface SessionDelivery {
  deliver(request: DeliverRequest): Promise<DeliverResult>
  start(request: StartSessionRequest): Promise<ContainerSession>
  attach(sessionId: string, options?: { metadata?: SessionMetadata | null; replayTerminal?: boolean }): Promise<void>
  stop(sessionId: string, options: StopSessionOptions): Promise<StopSessionResult>
}

export function createSessionDelivery(
  slug: AgentSlug,
  store: SessionStore,
  live: LiveSessions,
  deps: Pick<LocalActorDeps, 'containerHost' | 'sessionService' | 'recordSessionActivity' | 'reviewManager' | 'host'>,
): SessionDelivery {
  const runtime = () => deps.containerHost.runtime(slug)
  const client = () => runtime().getClient()

  const attach: SessionDelivery['attach'] = async (sessionId, options = {}) => {
    if (options.replayTerminal) return live.attachReplaying(sessionId, client(), options.metadata)
    if (live.isSubscribed(sessionId)) return
    await live.subscribe(sessionId, client(), sessionId, options.metadata)
  }

  const echo = (sessionId: string, uuid: string | undefined, queued: boolean, message: UserMessageEcho | undefined) => {
    if (message) live.emit(sessionId, { type: 'user_message', ...message, uuid, queued })
  }

  /**
   * What a send stores about the session once it went: its fields and the
   * runtime selection it ran with. Best effort: the message is sent, so a
   * failure here must not read as a failed delivery.
   */
  const storeSelection = async (
    sessionId: string,
    metadata: SessionMetadata | null,
    fields: Partial<SessionMetadata>,
    options: NonNullable<DeliverRequest['options']>,
    queued: boolean,
    sent: SendMessageResult,
  ) => {
    try {
      const updates: Partial<SessionMetadata> = { ...fields }
      // The container client resolves the pair, inherited fallback after a
      // deletion included: a stale request pair must not overwrite it.
      const effective = getSettings().llmDefault ? (sent.selection ?? metadata) : null
      if (!queued && effective?.model) {
        updates.model = effective.model
        updates.llmProviderId = effective.llmProviderId
      } else {
        if (options.model) updates.model = options.model
        if (options.llmProviderId !== undefined) updates.llmProviderId = options.llmProviderId
      }
      // Only a value the session does not hold yet costs a write: an
      // unchanged send writes nothing, and nothing is left over after the
      // client stored a changed binding.
      const stored = sent.metadataWritten ? { ...metadata, ...fields, ...sent.selection } : metadata
      if (!sessionMetadataHolds(stored, updates)) await deps.sessionService.updateSessionMetadata(store, sessionId, updates)
      // The composer re-sends its whole selection on every fresh turn, so
      // presence alone changes nothing. Other windows and devices may have
      // seeded their composer from the old values: they refetch before their
      // next send. A failed write tells nobody: they would refetch stale values.
      if (RUNTIME_SELECTION_KEYS.some((key) => updates[key] !== undefined && metadata?.[key] !== updates[key])) {
        live.emit(sessionId, { type: 'session_updated' })
        deps.host.send('global', { type: 'session_updated', sessionId, agentSlug: slug })
      }
    } catch (error) {
      console.error(`[SessionDelivery] Failed to store the selection of session ${sessionId}:`, error)
    }
  }

  const deliver: SessionDelivery['deliver'] = (request) => {
    const { sessionId, content, uuid } = request
    return live.inDeliveryTurn(sessionId, async (): Promise<DeliverResult> => {
      const options = { ...request.options }
      const append = options.shouldQuery === false

      // Read once for the whole send, in its turn: the promotion, the stream's
      // lifecycle, the provider check and the binding all work from it, and
      // no other send of the session can store a newer selection meanwhile.
      let metadata: SessionMetadata | null
      try {
        metadata = await deps.sessionService.getSessionMetadata(store, sessionId)
        // Before the send: a fast turn settles at once, and whether its
        // completion notifies is decided from the promotion.
        if (request.promote) metadata = await live.promoteAutomated(sessionId, metadata)
      } catch (error) {
        throw notSent('unavailable', error)
      }
      // An append keeps the running turn's runtime: its connection is never used.
      if (request.requireStoredProvider && !append && options.llmProviderId !== metadata?.llmProviderId) {
        throw new DeliveryError('provider-not-attached', 'The session no longer holds the selected provider connection')
      }

      if (request.coalesce && uuid && live.coalesceIfRecovering(sessionId, { uuid, text: content, ...(append ? { shouldQuery: false as const } : {}) })) {
        echo(sessionId, uuid, true, request.echo)
        return { status: 'coalesced' }
      }

      try {
        // Cheap while the container is known to run; a cached status gone
        // stale is checked with one health probe, so a container that died
        // behind it is started again instead of failing the send.
        await runtime().ensureRunning()
        await attach(sessionId, { metadata })
      } catch (error) {
        throw notSent('unavailable', error)
      }

      // A transcript-only append starts no turn: there is none to queue
      // behind, nothing to cancel, and an active mark would leave the session
      // "working" with no idle to clear it. It keeps the running turn's runtime.
      if (append) {
        echo(sessionId, uuid, false, request.echo)
        await send(sessionId, content, uuid, { shouldQuery: false, preserveRuntime: true }, null)
        // No stream frame follows an append: the summary is told directly.
        deps.recordSessionActivity(store, sessionId)
        return { status: 'sent', queued: false }
      }

      // Before the queued decision, so a stop it makes is reflected in it.
      if (request.cancelAwaiting) await live.cancelAwaitingInput(sessionId)
      // Decided with the mark, nothing awaited between: a turn that started
      // while this send waited its turn, or that the attach revealed, counts.
      const mark = live.markSending(sessionId)
      // A message joining a running turn must not carry the runtime: the
      // container treats a change as an interrupt and restart of the turn.
      if (mark.queued) {
        delete options.model
        delete options.llmProviderId
        delete options.effort
        delete options.speed
      }
      const fields: Partial<SessionMetadata> = {
        ...request.metadataUpdates,
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.speed ? { speed: options.speed } : {}),
      }
      echo(sessionId, uuid, mark.queued, request.echo)
      const sent = await send(sessionId, content, uuid, {
        ...options,
        ...(mark.queued ? { preserveRuntime: true } : {}),
        sessionMetadata: metadata,
        metadataUpdates: fields,
      }, mark)
      await storeSelection(sessionId, metadata, fields, options, mark.queued, sent)
      return { status: 'sent', queued: mark.queued }
    }).then((result) => {
      const provider = live.runtime(sessionId)?.provider
      return provider ? { ...result, provider } : result
    })
  }

  /** The POST. A failure undoes the send's mark when the message certainly did not go, or the session is not running. */
  const send = async (
    sessionId: string,
    content: string,
    uuid: string | undefined,
    options: SendMessageOptions,
    mark: { rollback(): void } | null,
  ): Promise<SendMessageResult> => {
    try {
      return await client().sendMessage(sessionId, content, uuid, options)
    } catch (error) {
      if (error instanceof MessageNotAcceptedError) {
        mark?.rollback()
        throw notAcceptedError(error)
      }
      // The container may have the message. A session it is not running is
      // idle whatever became of it; one it runs keeps the mark, and its
      // stream settles the rest.
      if (mark && (await runningInContainer(sessionId)) === false) mark.rollback()
      throw new DeliveryError('unknown', errorMessage(error), { cause: error })
    }
  }

  /** Whether the container runs the session's turn (one it does not know, it does not); undefined when it cannot say. */
  const runningInContainer = async (sessionId: string): Promise<boolean | undefined> => {
    try {
      return (await client().getSession(sessionId))?.isRunning ?? false
    } catch {
      return undefined
    }
  }

  const revoke = async (sessionId: string) => {
    live.unsubscribe(sessionId)
    try {
      await client().deleteSession(sessionId)
    } catch (error) {
      console.error(`[SessionDelivery] Failed to revoke session ${sessionId}:`, error)
    }
  }

  const start: SessionDelivery['start'] = async (request) => {
    const creating = client().createSession(request.create)
    let created: ContainerSession | typeof LATE
    try {
      created = await beforeDeadline(creating, request.notAfter)
    } catch (error) {
      throw new StartError('create-failed', false, errorMessage(error), { cause: error })
    }
    if (created === LATE) {
      // Answered at the deadline, when the caller may already be gone: the
      // session is revoked the moment it lands, not left running for the
      // caller's retry to duplicate.
      background(creating.then((late) => revoke(late.id), () => {}), { name: 'session-delivery.revoke-late-session' })
      throw new StartError('created-late', true, 'The session was not created before its deadline')
    }
    const session = created
    const sessionId = session.id

    const commands = session.slashCommands?.length ? session.slashCommands : undefined
    // Not stored for automations: every run would repeat the agent's whole
    // list in the one metadata document each later read parses.
    const stored = commands && !isHiddenAutomatedSession(request.metadata) ? { slashCommands: commands } : {}
    const metadata: Partial<SessionMetadata> = { ...request.metadata, ...stored }
    // Create started the turn. Marked first, so a result replayed during the
    // attach lands on an active session instead of reading as settled.
    live.markActive(sessionId)
    // The stream listens at once: what the running turn emits before it does
    // (a question, a host action) is not replayed, only a settled turn's last
    // frames are. Its frames wait for the registration, so an automation that
    // settles at once finds its status to finalize.
    const registering = deps.sessionService.registerSession(store, sessionId, request.name, metadata)
    const attaching = live.subscribe(sessionId, client(), sessionId, metadata, { holdFramesUntil: registering })
    // A failed registration revokes the session before the attach is awaited.
    attaching.catch(() => {})
    try {
      await registering
    } catch (error) {
      await revoke(sessionId)
      throw new StartError('register-failed', true, errorMessage(error), { cause: error })
    }
    try {
      await withTimeout(attaching, request.attachTimeoutMs)
    } catch (error) {
      // Nothing would persist the session's transcript: it would run unseen.
      await revoke(sessionId)
      // Registered: an automation's run ends here, or nothing would ever end it.
      try {
        await deps.sessionService.finalizeAutomationStatus(store, sessionId, 'failed')
      } catch (finalizeError) {
        console.error(`[SessionDelivery] Failed to end the run of revoked session ${sessionId}:`, finalizeError)
      }
      throw new StartError('attach-failed', true, errorMessage(error), { cause: error })
    }
    if (commands) live.setSlashCommands(sessionId, commands)
    return session
  }

  const stop: SessionDelivery['stop'] = async (sessionId, options) => {
    if (options.ifActive && !live.isActive(sessionId)) {
      return { path: 'skipped-idle', interrupted: false, processKept: false, escalated: false }
    }
    // A turn stop leaves background tasks running, but only ones the user
    // can see and stop one by one. With only untracked work open (a task a
    // subagent launched, say) it would leave the session pinned "working"
    // with nothing to stop it from.
    const escalated = options.scope === 'turn' && !!options.escalateUntracked && live.hasOnlyUntrackedBackgroundWork(sessionId)
    const scope = escalated ? 'all' : options.scope
    const finish = (result: StopSessionResult) => {
      if (options.denyReviews) deps.reviewManager.denyAllForAgent(slug)
      return result
    }
    if (runtime().getCachedInfo().status !== 'running') {
      // A crashed or restarted container: the session is stopped as far as anyone can tell.
      live.markInterrupted(sessionId)
      return finish({ path: 'not-running', interrupted: false, processKept: false, escalated })
    }
    // Read just before the interrupt: the session tells from it whether the
    // turn running afterwards is still the stopped one.
    const turnGenerationBefore = live.turnGeneration(sessionId)
    try {
      const { interrupted, processKept } = await client().interruptSession(sessionId, { scope })
      // processKept is the container's word, not the scope asked for: a turn
      // stop that fell back to a restart killed the background tasks.
      if (interrupted || !options.onlyIfConfirmed) live.markInterrupted(sessionId, { processKept, turnGenerationBefore })
      return finish({ path: 'interrupted', interrupted, processKept, escalated })
    } catch (error) {
      console.error(`[SessionDelivery] Interrupt failed for session ${sessionId}:`, error)
      if (!options.onlyIfConfirmed) live.markInterrupted(sessionId)
      return finish({ path: 'interrupt-failed', interrupted: false, processKept: false, escalated })
    }
  }

  return { deliver, start, attach, stop }
}

/**
 * The container client's certain refusal, as callers outside the actor read
 * it: what the delivery queue retries, and with the container's status, gives up on.
 */
export function notAcceptedError(error: MessageNotAcceptedError): DeliveryError {
  const status: unknown = Reflect.get(error, 'status')
  return new DeliveryError(error.reason, error.message, { cause: error, ...(typeof status === 'number' ? { status } : {}) })
}

function notSent(code: Exclude<DeliveryErrorCode, 'unknown'>, error: unknown): DeliveryError {
  return new DeliveryError(code, errorMessage(error), { cause: error })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const LATE = Symbol('late')

/** What the promise resolves to, or LATE when `notAfter` (epoch ms) passes first. */
async function beforeDeadline<T>(promise: Promise<T>, notAfter: number | undefined): Promise<T | typeof LATE> {
  if (notAfter === undefined) return promise
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<typeof LATE>((resolve) => {
    timer = setTimeout(() => resolve(LATE), Math.max(0, notAfter - Date.now()))
  })
  try {
    const value = await Promise.race([promise, late])
    return Date.now() > notAfter ? LATE : value
  } finally {
    clearTimeout(timer)
  }
}

async function withTimeout(promise: Promise<void>, ms: number | undefined): Promise<void> {
  if (ms === undefined) return promise
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out attaching to the session stream after ${ms}ms`)), ms)
  })
  // A stalled attach may still settle later; its rejection is not left unhandled.
  promise.catch(() => {})
  try {
    await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}
