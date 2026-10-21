/**
 * An agent's live sessions: the state of every session whose container
 * stream the agent follows, the streams themselves, and the listeners each
 * session's events go to. One per agent, owned by its actor (see
 * `AgentState`) and released with it.
 *
 * Per session it keeps:
 * - the `LiveSession` (the turn's state), replaced on every reattach;
 * - the stream attachment: the client and its unsubscribe, a subscribe in
 *   flight, the sends in flight (which hold the stream open);
 * - the session's listeners (`SessionChannel`), independent of any attachment;
 * - "allow for this session" capability grants and the workflow tailers.
 *
 * Every map here is keyed by session id alone: the actor is the agent, so a
 * session of another agent is simply not here.
 */
import type { ContainerClient, SlashCommandInfo, StreamMessage } from '@shared/lib/container/types'
import type { SessionTurnOutcome } from '@shared/lib/container/session-turn-outcome-schema'
import type { CoalescedUserMessage } from '@shared/lib/container/runtime-death'
import type { SubagentCapture } from '@shared/lib/container/subagent-capture'
import type { SessionActivity, SessionMetadata } from '@shared/lib/types/agent'
import type { AgentInputRequests, UserInputRequestTransition } from '@shared/lib/tools/requests/agent-input-requests'
import {
  isReplayableUserInputRequest,
  type PendingUserInputRequest,
  type UserInputRequestOutcome,
} from '@shared/lib/tools/requests/request-schema'
import type { AgentComputerUse } from '@shared/lib/computer-use/agent-permissions'
import { getSessionMetadata, updateSessionMetadata } from '@shared/lib/services/session-service'
import { isAgentIntegrationSession, isHiddenAutomatedSession } from '@shared/lib/services/session-visibility'
import { captureException } from '@shared/lib/error-reporting'
import { z } from 'zod'
import { sessionFilePath, type SessionStore } from '../session-store'
import type { HostPort } from '../host-port'
import { rejectInput, type HostRunActor } from '../host-runs'
import type { ActiveBackgroundTaskSnapshot } from './background-tasks'
import { LiveSession, type LiveSessionContext, type SessionRuntime } from './live-session'
import type { SessionEvent, SessionListener, WireFrame } from './session-channel'
import { SessionChannels, wireFrame } from './session-channels'
import { repairLegacySlashCommands } from '@shared/lib/container/slash-commands'
import type { ActiveSubagentSnapshot } from './subagents'
import type { Capability } from './tool-calls'
import { WorkflowTailers } from './workflow-tailers'
import { waitForIdle, type WaitForIdleOptions } from './wait-for-idle'
import { OrderedSends } from '../ordered-sends'

/** The agent's container runtime, as its sessions need it. */
export interface SessionsRuntime extends SessionRuntime {
  /** The agent's current container client. */
  client(): ContainerClient
}

export interface LiveSessionsDeps {
  readonly slug: string
  readonly store: SessionStore
  readonly requests: AgentInputRequests
  readonly computerUse: AgentComputerUse
  readonly host: HostPort
  readonly runtime: SessionsRuntime
  /** The agent, as an approved computer-use or script run needs it (see `createAgentState`). */
  readonly runs: HostRunActor
  /** Dev-only frame capture for building fixture replays. */
  readonly capture?: SubagentCapture | null
}

// Body of the container's POST /sessions/:id/interrupt.
const interruptResponseSchema = z.object({ processKept: z.boolean().optional() })

/** A send's active mark (see `LiveSessions.markSending`). */
export interface SendingMark {
  /** The message joins a running turn. */
  readonly queued: boolean
  /** Undo only this mark: the send was not accepted. */
  rollback(): void
}

export interface PendingComputerUseRequest {
  toolUseId: string
  method: string
  params: Record<string, unknown>
  permissionLevel: string
  appName?: string
}

export class LiveSessions {
  private readonly states = new Map<string, LiveSession>()
  private readonly channels = new SessionChannels()
  private readonly clients = new Map<string, ContainerClient>()
  private readonly subscriptions = new Map<string, () => void>()
  /** Subscribes in flight: concurrent subscribes share one. */
  private readonly connecting = new Map<string, Promise<void>>()
  /** Sends in flight. A send can outlive a turn's idle or a reattach, so it holds the stream on its own. */
  private readonly sendsInFlight = new Map<string, number>()
  /** Delivery attempts run one at a time: a failed one is rolled back before the next looks at the state. */
  private readonly sending = new Map<string, Promise<void>>()
  /**
   * "Allow for this session" grants. Display bookkeeping only: the container
   * enforces them (and persists its own copy), and once granted, launches
   * proceed there with no request, so no card may be shown for them.
   */
  private readonly capabilityGrants = new Map<string, Set<Capability>>()
  private readonly workflows = new Map<string, WorkflowTailers>()
  /** Each session's completion notifications, in turn order; let go once a queue has sent everything. */
  private readonly completions = new Map<string, OrderedSends>()
  /** Sessions whose events are being tagged `provisional` (see `attachReplaying`). */
  private readonly provisionalSessions = new Set<string>()

  constructor(private readonly deps: LiveSessionsDeps) {}

  // ===========================================================================
  // Reads
  // ===========================================================================

  activity(sessionId: string): SessionActivity {
    return this.states.get(sessionId)?.activity() ?? 'idle'
  }

  isActive(sessionId: string): boolean {
    return this.states.get(sessionId)?.isActive ?? false
  }

  isAwaitingInput(sessionId: string): boolean {
    return this.states.get(sessionId)?.isAwaitingInput ?? false
  }

  isWaitingBackground(sessionId: string): boolean {
    return this.states.get(sessionId)?.isWaitingBackground() ?? false
  }

  hasOnlyUntrackedBackgroundWork(sessionId: string): boolean {
    return this.states.get(sessionId)?.hasOnlyUntrackedBackgroundWork() ?? false
  }

  turnGeneration(sessionId: string): number {
    return this.states.get(sessionId)?.currentTurnGeneration() ?? 0
  }

  turnOutcome(sessionId: string): SessionTurnOutcome | null {
    return this.states.get(sessionId)?.turnOutcome ?? null
  }

  backgroundTasks(sessionId: string): ActiveBackgroundTaskSnapshot[] {
    return this.states.get(sessionId)?.backgroundTasks() ?? []
  }

  activeSubagents(sessionId: string): ActiveSubagentSnapshot[] {
    return this.states.get(sessionId)?.activeSubagents() ?? []
  }

  slashCommands(sessionId: string): SlashCommandInfo[] {
    return this.states.get(sessionId)?.slashCommands ?? []
  }

  /** The commands the container listed when it created the session. */
  setSlashCommands(sessionId: string, commands: SlashCommandInfo[]): void {
    const state = this.states.get(sessionId)
    if (state) state.slashCommands = commands
  }

  /** Requests decided while their transcript result is still held back; the messages route stamps them. */
  settledRequests(sessionId: string): Map<string, UserInputRequestOutcome> {
    return this.states.get(sessionId)?.settledInputRequests ?? new Map()
  }

  isRecovering(sessionId: string): boolean {
    return this.states.get(sessionId)?.isRecovering === true
  }

  /** Attached: its stream is subscribed and the handshake is done (a connect in flight is not yet). */
  isSubscribed(sessionId: string): boolean {
    return this.subscriptions.has(sessionId) && !this.connecting.has(sessionId)
  }

  /** The agent's active sessions: agent-scoped asks (proxy reviews) are attributed to these. */
  activeIds(): string[] {
    return [...this.states].filter(([, state]) => state.isActive).map(([sessionId]) => sessionId)
  }

  hasActive(): boolean {
    return [...this.states.values()].some((state) => state.isActive)
  }

  hasAwaitingInput(): boolean {
    return [...this.states.values()].some((state) => state.isAwaitingInput)
  }

  /** Open computer-use approvals the user must answer (an auto-approved one is already running). */
  pendingComputerUse(sessionId: string): PendingComputerUseRequest[] {
    return this.deps.requests
      .getOpenRequestsForSession(sessionId)
      .filter((request) => request.kind === 'computer_use' && !request.autoApproved)
      .map((request) => {
        const payload = request.payload as { method?: string; params?: Record<string, unknown>; permissionLevel?: string; appName?: string }
        return {
          toolUseId: request.id,
          method: payload.method ?? '',
          params: payload.params ?? {},
          permissionLevel: payload.permissionLevel ?? '',
          appName: payload.appName,
        }
      })
  }

  capabilityGranted(sessionId: string, capability: Capability): boolean {
    return this.capabilityGrants.get(sessionId)?.has(capability) ?? false
  }

  // ===========================================================================
  // Listeners
  // ===========================================================================

  /** Listen to a session's events; returns the unsubscribe. */
  listen(sessionId: string, listener: SessionListener): () => void {
    return this.channels.listen(sessionId, listener)
  }

  /**
   * A viewer's wire for the session (see `SessionChannels.follow`): the
   * frames it missed since `after`, or a snapshot of the session, then every
   * event, each frame carrying its id. Resolves once attached; returns the
   * unsubscribe.
   */
  async follow(sessionId: string, after: string | undefined, onFrame: (frame: WireFrame) => void): Promise<() => void> {
    // A cold session's commands come from its metadata: read before the
    // snapshot, which is then built from live state in the attach itself.
    const stored = this.slashCommands(sessionId).length > 0 ? null : await this.storedSlashCommands(sessionId)
    const release = this.channels.follow(
      sessionId,
      { after, snapshot: (lastId) => [this.connectedFrame(sessionId, lastId, stored)] },
      onFrame,
    )
    // The app the agent has grabbed is agent state, not one of this
    // session's events (it has no id): every viewer is told, once its icon is
    // read, unless another grab or a release has gone out meanwhile. A follow
    // that fails leaves nothing attached.
    try {
      const app = this.deps.computerUse.grabbed()
      if (app) {
        const icon = await this.appIcon(app)
        if (this.deps.computerUse.grabbed() === app) {
          onFrame(wireFrame({ type: 'computer_use_grab_changed', app, ...(icon && { appIcon: icon }) }))
        }
      }
    } catch (error) {
      release()
      throw error
    }
    return release
  }

  /** An event for a session's listeners. */
  emit(sessionId: string, event: SessionEvent): void {
    const tagged = this.provisionalSessions.has(sessionId) ? { ...event, provisional: true } : event
    void this.deps.capture?.recordOutput(sessionId, tagged)
    this.channels.emit(sessionId, tagged)
  }

  /** The session as a viewer starting from nothing needs it: it stands for every event up to `lastId`. */
  private connectedFrame(sessionId: string, lastId: string, stored: SlashCommandInfo[] | null): WireFrame {
    const live = this.slashCommands(sessionId)
    const slashCommands = live.length > 0 ? live : (stored ?? [])
    return wireFrame(
      {
        type: 'connected',
        isActive: this.isActive(sessionId),
        turnOutcome: this.turnOutcome(sessionId),
        // A background task can run while the turn is still streaming, so
        // the task list alone does not say whether the turn's output ended.
        isWaitingBackground: this.isWaitingBackground(sessionId),
        slashCommands: slashCommands.length > 0 ? slashCommands : undefined,
        // Always the array, even empty: an absent list reads as "unchanged"
        // to a reconnecting client, which would keep tasks that ended while
        // it was away.
        backgroundTasks: this.backgroundTasks(sessionId),
        activeSubagents: this.activeSubagents(sessionId),
      },
      lastId,
    )
  }

  /** The commands the session's metadata kept (after a container restart, say), repaired once. */
  private async storedSlashCommands(sessionId: string): Promise<SlashCommandInfo[]> {
    const meta = await getSessionMetadata(this.deps.store, sessionId)
    if (!meta?.slashCommands || meta.slashCommands.length === 0) return []
    const repaired = repairLegacySlashCommands(meta.slashCommands)
    this.setSlashCommands(sessionId, repaired.commands)
    if (repaired.changed) {
      updateSessionMetadata(this.deps.store, sessionId, { slashCommands: repaired.commands }).catch(console.error)
    }
    return repaired.commands
  }

  private async appIcon(app: string): Promise<string | null> {
    try {
      return await this.deps.host.call('computerUseAppIcon', { app })
    } catch (error) {
      console.error(`[LiveSessions] Failed to read the icon of ${app}:`, error)
      return null
    }
  }

  // ===========================================================================
  // The stream attachment
  // ===========================================================================

  /**
   * Follow a session's container stream. Resolves once the container has
   * attached the listener and replayed the last turn's terminal frames.
   * Concurrent calls share one attach. `metadata` is the session's entry as
   * the caller just read it (null: it has none), so working out the stream's
   * lifecycle reads nothing. `holdFramesUntil`: the stream listens at once,
   * and its frames wait, in order, until that settles (see `SessionDelivery.start`).
   */
  subscribe(
    sessionId: string,
    client: ContainerClient,
    containerSessionId: string,
    metadata?: SessionMetadata | null,
    options: { holdFramesUntil?: Promise<unknown> } = {},
  ): Promise<void> {
    const inFlight = this.connecting.get(sessionId)
    if (inFlight) return inFlight
    return this.trackConnecting(sessionId, this.attach(sessionId, client, containerSessionId, metadata, options.holdFramesUntil))
  }

  /** Stop following the session and forget it: its parked requests die with it. */
  unsubscribe(sessionId: string): void {
    this.subscriptions.get(sessionId)?.()
    this.subscriptions.delete(sessionId)
    this.states.get(sessionId)?.dispose()
    this.states.delete(sessionId)
    this.workflows.get(sessionId)?.stopAll()
    this.workflows.delete(sessionId)
    this.deps.requests.dropSessionRequests(sessionId, 'invalidated')
    this.clients.delete(sessionId)
    // The container's persisted grants are authoritative: a resubscribed
    // session repopulates this with one lookup at its next launch.
    this.capabilityGrants.delete(sessionId)
  }

  /** Close the stream and keep the session's state (a reattach brings it back). */
  detach(sessionId: string): void {
    this.subscriptions.get(sessionId)?.()
    this.subscriptions.delete(sessionId)
    this.clients.delete(sessionId)
  }

  private trackConnecting(sessionId: string, ready: Promise<void>): Promise<void> {
    const promise = ready.finally(() => {
      if (this.connecting.get(sessionId) !== promise) return
      this.connecting.delete(sessionId)
      // Replayed terminal frames can settle an automation while it attaches;
      // its release waits for the attach, or closing before the container's
      // acknowledgement would fail a subscribe that otherwise succeeded.
      this.releaseIfIdle(sessionId)
    })
    this.connecting.set(sessionId, promise)
    return promise
  }

  private async attach(
    sessionId: string,
    client: ContainerClient,
    containerSessionId: string,
    metadata?: SessionMetadata | null,
    holdFramesUntil?: Promise<unknown>,
  ): Promise<void> {
    // Only the transport goes: the session's requests and grants outlive a
    // reattach of its stream.
    this.subscriptions.get(sessionId)?.()
    this.subscriptions.delete(sessionId)
    const prior = this.states.get(sessionId)
    prior?.dispose()
    const state = this.create(sessionId, prior)
    this.resolveStreamPolicy(sessionId, state, metadata)
    this.clients.set(sessionId, client)
    const frame = (message: StreamMessage) => this.states.get(sessionId)?.frame(message)
    let held: StreamMessage[] | null = holdFramesUntil ? [] : null
    if (holdFramesUntil) {
      void holdFramesUntil.then(() => undefined, () => undefined).then(() => {
        const waiting = held ?? []
        held = null
        for (const message of waiting) frame(message)
      })
    }
    const { unsubscribe, ready } = client.subscribeToStream(containerSessionId, (message) => {
      if (held) held.push(message)
      else frame(message)
    })
    this.subscriptions.set(sessionId, unsubscribe)

    const capture = this.deps.capture
    if (capture) {
      await capture.snapshotSubagentsDir(sessionId, this.deps.store.files, sessionFilePath(this.deps.store, sessionId, 'subagents'), 'subscribe')
      await capture.recordNote(sessionId, 'subscribe', { agentSlug: this.deps.slug, containerSessionId })
    }
    // A rejected handshake must not leave the session reading as subscribed
    // to a dead stream. A replacement subscription owns its own cleanup.
    try {
      await ready
    } catch (error) {
      if (this.subscriptions.get(sessionId) === unsubscribe) this.detach(sessionId)
      throw error
    }
  }

  /**
   * The socket dropped while the session still runs in the container:
   * subscribe again through the same client, keeping the session's state.
   */
  private reattach(sessionId: string, client: ContainerClient): void {
    const { unsubscribe, ready } = client.subscribeToStream(sessionId, (message) => this.states.get(sessionId)?.frame(message))
    this.subscriptions.set(sessionId, unsubscribe)
    // A failed reattach comes back through the stream as a synthesized
    // connection_closed; this only keeps the rejection from going unhandled.
    this.trackConnecting(sessionId, ready).catch((error) => {
      console.error(`[LiveSessions] Re-subscribe failed for session ${sessionId}:`, error)
    })
  }

  /**
   * Whether the session is an unpromoted automation (cron, webhook, x-agent,
   * chat): its stream is released once it settles. An unresolved read keeps
   * the stream rather than guess.
   */
  private resolveStreamPolicy(sessionId: string, state: LiveSession, known?: SessionMetadata | null): void {
    void (known !== undefined ? Promise.resolve(known) : getSessionMetadata(this.deps.store, sessionId))
      .then((meta) => {
        // A reattach replaced the state and resolves its own policy.
        if (this.states.get(sessionId) !== state) return
        state.applyStreamPolicy({
          releaseStreamWhenIdle: isHiddenAutomatedSession(meta),
          retainStateOnStreamRelease: isAgentIntegrationSession(meta),
        })
        this.releaseIfIdle(sessionId)
      })
      .catch((error) => {
        console.warn('[LiveSessions] Failed to resolve automation stream policy:', error)
        captureException(error, {
          tags: { area: 'container', op: 'resolveStreamReleasePolicy' },
          extra: { sessionId, agentSlug: this.deps.slug },
        })
      })
  }

  /**
   * Release the stream of a session that is done with it (see
   * `LiveSession.canReleaseStream`) once no subscribe or send needs it. A
   * chat session keeps its state for its next message; other automations
   * are forgotten, so finished runs don't accumulate.
   */
  private releaseIfIdle(sessionId: string): void {
    const state = this.states.get(sessionId)
    if (!state?.canReleaseStream()) return
    if (this.sendsInFlight.has(sessionId) || this.connecting.has(sessionId) || !this.subscriptions.has(sessionId)) return
    console.log(`[LiveSessions] Releasing idle automation stream for session ${sessionId}`)
    if (state.retainStateOnStreamRelease) this.detach(sessionId)
    else this.unsubscribe(sessionId)
  }

  // ===========================================================================
  // Turn lifecycle
  // ===========================================================================

  /** A message was accepted for the session (see `LiveSession.markActive`). */
  markActive(sessionId: string): void {
    this.stateOrCreate(sessionId).markActive()
  }

  /** A host-initiated send failed before reaching the container. */
  markIdle(sessionId: string): void {
    this.states.get(sessionId)?.markIdle()
  }

  /**
   * Attach again so the container replays the last turn's terminal frames to
   * a listener that lost track of the session. An idle session is marked
   * active around the attach, or the replay would be discarded as already
   * settled; the mark is undone on whichever state holds the session then
   * (the attach replaces it), unless a send, a turn or output took it over.
   * The mark's and the undo's events are tagged `provisional`: they are no
   * turn starting or ending, and a listener that counts turns skips them.
   * Attached and busy, there is nothing to replay that the stream has not
   * carried, so it is left as it is.
   */
  async attachReplaying(sessionId: string, client: ContainerClient, metadata?: SessionMetadata | null): Promise<void> {
    if (this.isSubscribed(sessionId) && this.activity(sessionId) !== 'idle') return
    const mark = this.activity(sessionId) === 'idle'
      ? this.provisionally(sessionId, () => this.stateOrCreate(sessionId).markProvisionallyActive())
      : undefined
    try {
      await this.subscribe(sessionId, client, sessionId, metadata)
    } finally {
      if (mark) this.provisionally(sessionId, () => this.states.get(sessionId)?.revertProvisional(mark))
    }
  }

  /** Run `change`, tagging the session events it emits `provisional`. */
  private provisionally<T>(sessionId: string, change: () => T): T {
    this.provisionalSessions.add(sessionId)
    try {
      return change()
    } finally {
      this.provisionalSessions.delete(sessionId)
    }
  }

  /** The user stopped the session (see `LiveSession.markInterrupted`). */
  markInterrupted(sessionId: string, options?: { processKept?: boolean; turnGenerationBefore?: number }): void {
    const state = this.states.get(sessionId)
    if (state) {
      state.markInterrupted(options)
      return
    }
    // Nothing live to stop, but its viewers still hear that it is idle.
    this.emit(sessionId, { type: 'session_idle', isActive: false, outcome: 'cancelled' })
    this.deps.host.send('global', { type: 'session_idle', sessionId, agentSlug: this.deps.slug, isActive: false })
  }

  /**
   * The container stopped. Every session's stream goes; a session mid-turn
   * ends (see `LiveSession.markInactive`); a recovering one is left to its
   * recovery, or settled with it when the stop ends the recovery too.
   */
  markAllInactive(options?: { settleRecovering?: boolean }): void {
    for (const [sessionId, state] of [...this.states]) {
      if (state.isRecovering) {
        if (options?.settleRecovering) this.settleRecovering([sessionId])
        else this.detach(sessionId)
        continue
      }
      if (state.isActive) {
        console.log(`[LiveSessions] Marking session ${sessionId} inactive (container stopped)`)
        state.markInactive()
      }
      this.detach(sessionId)
    }
  }

  /** Claim for recovery the sessions that were mid-turn when the runtime died. */
  claimMidTurnForRecovery(restrictToSessionIds?: string[]): string[] {
    const restrict = restrictToSessionIds ? new Set(restrictToSessionIds) : null
    const claimed: string[] = []
    for (const [sessionId, state] of this.states) {
      if (restrict && !restrict.has(sessionId)) continue
      if (state.claimForRecovery()) claimed.push(sessionId)
    }
    return claimed
  }

  /** Recovery resumed these sessions. */
  markRecovered(sessionIds: string[]): void {
    for (const sessionId of sessionIds) this.states.get(sessionId)?.recovered()
  }

  /** Recovery failed for these sessions: their turns ended with the runtime. */
  settleRecovering(sessionIds: string[]): void {
    for (const sessionId of sessionIds) {
      const state = this.states.get(sessionId)
      if (!state) continue
      state.recoveryFailed()
      this.detach(sessionId)
    }
  }

  coalesceIfRecovering(sessionId: string, message: CoalescedUserMessage): boolean {
    return this.states.get(sessionId)?.coalesce(message) ?? false
  }

  takeCoalesced(sessionId: string): CoalescedUserMessage[] {
    return this.states.get(sessionId)?.takeCoalesced() ?? []
  }

  dropCoalesced(sessionId: string, uuid: string): boolean {
    return this.states.get(sessionId)?.dropCoalesced(uuid) ?? false
  }

  /**
   * The session's delivery turn (see `messages.deliver`): `work` runs after
   * the session's earlier deliveries and any attach in flight, one at a
   * time, so a failed one is rolled back before the next looks at the state
   * and the selection one stores is the next one's to read. Its stream is
   * held open meanwhile. Recovery's sends take the same turn.
   */
  async inDeliveryTurn<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.sending.get(sessionId)
    let finished!: () => void
    const done = new Promise<void>((resolve) => {
      finished = resolve
    })
    this.sending.set(sessionId, done)
    this.sendsInFlight.set(sessionId, (this.sendsInFlight.get(sessionId) ?? 0) + 1)
    try {
      if (previous) await previous
      const connecting = this.connecting.get(sessionId)
      if (connecting) await connecting.catch(() => {})
      return await work()
    } finally {
      finished()
      if (this.sending.get(sessionId) === done) this.sending.delete(sessionId)
      const remaining = (this.sendsInFlight.get(sessionId) ?? 1) - 1
      if (remaining > 0) this.sendsInFlight.set(sessionId, remaining)
      else this.sendsInFlight.delete(sessionId)
      this.releaseIfIdle(sessionId)
    }
  }

  /**
   * Mark the session active for a message about to be sent, in its delivery
   * turn. `queued`: the message joins a running turn. `rollback` undoes only
   * this mark, for a send that was not accepted: a later send, a stop, a
   * recovery, a new runtime turn or output that arrived meanwhile owns the
   * state from then on.
   */
  markSending(sessionId: string): SendingMark {
    const state = this.stateOrCreate(sessionId)
    const before = state.sendSnapshot()
    state.markActive()
    const marked = state.sendSnapshot()
    return { queued: before.wasActive, rollback: () => this.states.get(sessionId)?.sendFailed(before, marked) }
  }

  /** Resolve once the session is no longer active; see `waitForIdle`. */
  waitForIdle(sessionId: string, opts?: WaitForIdleOptions): Promise<void> {
    return waitForIdle(() => this.isActive(sessionId), opts)
  }

  // ===========================================================================
  // Requests
  // ===========================================================================

  /** Recompute every session's waiting state: an agent-scoped ask (a proxy review) blocks them all. */
  syncAwaiting(): void {
    for (const state of this.states.values()) state.syncAwaiting()
  }

  /** Re-register parked asks the transcript shows but the stream event for was missed. */
  recoverAwaitingInput(sessionId: string, unresolved: Array<{ toolUseId: string; toolName: string }>): void {
    this.states.get(sessionId)?.recoverAwaitingInput(unresolved)
  }

  /** "Allow for this session": later launches of the capability get no card. */
  grantCapability(sessionId: string, capability: Capability): void {
    const grants = this.capabilityGrants.get(sessionId) ?? new Set()
    grants.add(capability)
    this.capabilityGrants.set(sessionId, grants)
  }

  /**
   * A decision settled a request (see `LiveSession.completeRequest`).
   * `sessionId` undefined: the request's own scope says (chat connectors only know the id).
   */
  completeRequest(sessionId: string | undefined, toolUseId: string, outcome: UserInputRequestOutcome): void {
    const target = sessionId ?? this.deps.requests.getOpenRequest(toolUseId)?.scope.sessionId
    if (!target) return
    const state = this.states.get(target)
    if (state) {
      state.completeRequest(toolUseId, outcome)
      return
    }
    // No live state (the stream was released): settle it and tell the tabs all the same.
    if (this.deps.requests.resolveIfInStore(toolUseId, 'stream', outcome)) {
      this.emit(target, {
        type: 'tool_result',
        toolUseId,
        result: outcome === 'answered' ? 'User provided input' : 'User declined the request',
        isError: outcome !== 'answered',
      })
    }
  }

  completeCapabilityReview(sessionId: string, toolUseId: string, outcome: UserInputRequestOutcome = 'answered'): void {
    this.states.get(sessionId)?.completeCapabilityReview(toolUseId, outcome)
  }

  clearComputerUseRequest(sessionId: string, toolUseId: string, outcome: UserInputRequestOutcome = 'answered'): void {
    const state = this.states.get(sessionId)
    if (state) state.clearComputerUseRequest(toolUseId, outcome)
    else this.deps.requests.resolveIfInStore(toolUseId, 'computer_use', outcome)
  }

  /**
   * A new message arrives while the session waits on the user: cancel what
   * it waits on, so the message starts a fresh turn instead of queueing
   * behind a parked tool.
   *
   * The turn is stopped FIRST, aborting the parked query outright, and only
   * then is each request rejected on the container. In the other order the
   * reject would return a tool result and RESUME the turn, and the model
   * would answer with filler the user's message then reads as a reply to.
   * Stopped at the parked point, the model never gets a result. The stop
   * also unwinds a subagent's parked Task, so every kind takes this path;
   * after it, the reject only clears the container's pending entry, so a
   * late click can't land on an abandoned request.
   *
   * A no-op when the session isn't waiting. Failures are swallowed: a
   * best-effort cancel must never block the message.
   */
  async cancelAwaitingInput(sessionId: string): Promise<void> {
    if (!this.isAwaitingInput(sessionId)) return
    // Taken before the stop: the stop's idle clears the stream store, and
    // computer-use approvals survive that boundary on purpose. Recovered
    // stubs are included: their container-side pending may well be live.
    const streamIds = this.deps.requests.getStoreIdsForSession(sessionId, 'stream')
    const computerUseIds = this.pendingComputerUse(sessionId).map((request) => request.toolUseId)

    // The container keeps its background tasks across this stop, and so do
    // we, unless it says it restarted.
    const turnGenerationBefore = this.turnGeneration(sessionId)
    const { processKept } = await this.interruptContainer(sessionId).catch((error) => {
      console.error(`[LiveSessions] cancelAwaitingInput interrupt failed for ${sessionId}:`, error)
      return { processKept: false }
    })
    this.markInterrupted(sessionId, { processKept, turnGenerationBefore })

    // The idle only cleared the stream store: a leftover approval would come
    // back as a phantom card on reconnect.
    for (const id of computerUseIds) this.deps.requests.resolveIfInStore(id, 'computer_use', 'superseded')
    for (const toolUseId of [...streamIds, ...computerUseIds]) {
      await rejectInput(this.deps.runs, toolUseId, 'Superseded: the user sent a new message.').catch((error) =>
        console.error(`[LiveSessions] cancelAwaitingInput reject failed for ${toolUseId}:`, error),
      )
    }
  }

  /**
   * Stop the session's turn through the container's interrupt endpoint (the
   * explicit interrupt route's own). A session whose only background work is
   * untracked cannot be settled by a turn stop, so that one stops everything.
   */
  private async interruptContainer(sessionId: string): Promise<{ processKept: boolean }> {
    const scope = this.hasOnlyUntrackedBackgroundWork(sessionId) ? 'all' : 'turn'
    const response = await this.deps.runtime.client().fetch(`/sessions/${encodeURIComponent(sessionId)}/interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope }),
    })
    if (!response?.ok) return { processKept: false }
    // A container that predates the field always restarted the process.
    const body = interruptResponseSchema.safeParse(await response.json().catch(() => null))
    return { processKept: body.success && body.data.processKept === true }
  }

  /**
   * Make an automated session (cron, webhook, chat, x-agent) a regular one,
   * so it shows in session lists and notifies on completion. Done when it
   * starts waiting on the user, and when a human messages it. `metadata` is
   * the entry as the caller just read it; resolves to the entry afterwards.
   */
  async promoteAutomated(sessionId: string, metadata?: SessionMetadata | null): Promise<SessionMetadata | null> {
    const meta = metadata !== undefined ? metadata : await getSessionMetadata(this.deps.store, sessionId)
    if (!isHiddenAutomatedSession(meta)) return meta
    await updateSessionMetadata(this.deps.store, sessionId, { promotedToInteractive: true })
    const state = this.states.get(sessionId)
    state?.promoted()
    console.log(`[LiveSessions] Promoted automated session ${sessionId} to interactive (agent: ${this.deps.slug})`)
    // Clients echo session_awaiting_input into their caches as a statement
    // (working and waiting), so it goes out only when that is true: a human
    // messaging a settled automation promotes it too. session_updated is the
    // statement-free nudge to refetch.
    const type = state?.isActive && state.isAwaitingInput ? 'session_awaiting_input' : 'session_updated'
    this.deps.host.send('global', { type, sessionId, agentSlug: this.deps.slug })
    return { ...meta, promotedToInteractive: true } as SessionMetadata
  }

  /**
   * A transition of one of the agent's requests. This is the one wire for
   * requests: a typed event to the global feed, and to the session's stream
   * when it has one. Emitted from the store's single funnel, so no mutation
   * path can settle a request silently. A 'created' also notifies, once per
   * request id however many paths carried its tool call.
   */
  requestTransition(transition: UserInputRequestTransition): void {
    const { request } = transition
    if (!isReplayableUserInputRequest(request)) return
    // agentSlug at the top level: the auth-mode global stream admits events
    // by that field alone. (The store stamps it on every request.)
    const event: SessionEvent =
      transition.type === 'created'
        ? { type: 'user_request_created', agentSlug: request.scope.agentSlug, request }
        : {
            type: 'user_request_resolved',
            agentSlug: request.scope.agentSlug,
            requestId: request.id,
            kind: request.kind,
            outcome: transition.outcome,
            scope: request.scope,
          }
    this.deps.host.send('global', event)
    if (request.scope.sessionId) this.emit(request.scope.sessionId, event)
    if (transition.type === 'created') this.notifyRequest(request)
  }

  private notifyRequest(request: PendingUserInputRequest): void {
    // An auto-approved request is already running; a non-blocking one is
    // for automations. Neither needs the user.
    if (!request.blocking || request.autoApproved) return
    const agentSlug = this.deps.slug
    if (request.kind === 'proxy_review' || request.kind === 'x_agent_review') {
      // Agent-scoped: attributed to the first active session, the awaiting
      // projection's heuristic. With none (a dashboard-triggered review) the
      // dashboard panel is the surface.
      const sessionId = request.scope.sessionId ?? this.activeIds()[0]
      if (!sessionId) return
      const payload = request.payload as { displayText?: unknown }
      this.deps.host.send('notification', {
        kind: 'api_review_waiting',
        agentSlug,
        sessionId,
        reviewId: request.id,
        displayText: typeof payload.displayText === 'string' ? payload.displayText : 'API request review',
        reviewKind: request.kind === 'x_agent_review' ? 'agent_action' : 'api_request',
      })
      return
    }
    // Agent-scoped reviews and re-auth requests have no session to notify
    // for; their in-app cards are the prompt.
    const sessionId = request.scope.sessionId
    if (!sessionId) return
    if (request.kind === 'account_reauth_required' || request.kind === 'mcp_reauth_required') return
    this.deps.host.send('notification', {
      kind: 'session_waiting_input',
      agentSlug,
      sessionId,
      request: { kind: request.kind, payload: request.payload },
    })
  }

  /**
   * The agent is gone from this process: drop every stream and timer. A
   * session still mid-turn is ended first, as a container stop ends it (the
   * app stops the container before it lets an agent go, so this is the
   * backstop, not the usual path).
   */
  dispose(): void {
    this.markAllInactive({ settleRecovering: true })
    for (const unsubscribe of this.subscriptions.values()) unsubscribe()
    this.subscriptions.clear()
    for (const state of this.states.values()) state.dispose()
    this.states.clear()
    for (const tailers of this.workflows.values()) tailers.stopAll()
    this.workflows.clear()
    this.clients.clear()
    this.channels.dispose()
  }

  // ===========================================================================

  private stateOrCreate(sessionId: string): LiveSession {
    const existing = this.states.get(sessionId)
    if (existing) return existing
    const state = this.create(sessionId)
    const capture = this.deps.capture
    if (capture) {
      const { store } = this.deps
      capture.snapshotSubagentsDir(sessionId, store.files, sessionFilePath(store, sessionId, 'subagents'), 'state-created').catch(() => {})
      capture.recordNote(sessionId, 'state_created', { agentSlug: this.deps.slug }).catch(() => {})
    }
    return state
  }

  private create(sessionId: string, prior?: LiveSession): LiveSession {
    let state!: LiveSession
    const { slug, store, requests, computerUse, host, runtime, capture } = this.deps
    const ctx: LiveSessionContext = {
      agentSlug: slug,
      sessionId,
      store,
      requests,
      computerUse,
      host,
      runs: this.deps.runs,
      runtime,
      capture: capture ?? null,
      emit: (event) => this.emit(sessionId, event),
      isCurrent: () => this.states.get(sessionId) === state,
      transport: () => this.clients.get(sessionId),
      releaseTransportIfIdle: () => this.releaseIfIdle(sessionId),
      detachTransport: () => this.detach(sessionId),
      reattachTransport: (client) => this.reattach(sessionId, client),
      capabilityGranted: (capability) => this.capabilityGranted(sessionId, capability),
      grantCapability: (capability) => this.grantCapability(sessionId, capability),
      resyncAwaiting: () => this.states.get(sessionId)?.syncAwaiting(),
      completions: () => this.completionsOf(sessionId),
      promote: () => {
        this.promoteAutomated(sessionId).catch((error) => {
          console.error('[LiveSessions] Failed to promote automated session:', error)
        })
      },
      workflows: this.workflowsOf(sessionId),
    }
    state = new LiveSession(ctx, prior)
    this.states.set(sessionId, state)
    return state
  }

  private completionsOf(sessionId: string): OrderedSends {
    let sends = this.completions.get(sessionId)
    if (!sends) {
      const created: OrderedSends = new OrderedSends(() => {
        if (this.completions.get(sessionId) === created) this.completions.delete(sessionId)
      })
      sends = created
      this.completions.set(sessionId, sends)
    }
    return sends
  }

  private workflowsOf(sessionId: string): WorkflowTailers {
    let tailers = this.workflows.get(sessionId)
    if (!tailers) {
      tailers = new WorkflowTailers(this.deps.store, sessionId, (event) => this.emit(sessionId, event))
      this.workflows.set(sessionId, tailers)
    }
    return tailers
  }
}
