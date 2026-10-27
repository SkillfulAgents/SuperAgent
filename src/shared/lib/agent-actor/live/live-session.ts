/**
 * One session's live state, while its container stream is attached: where
 * its turn is (active, waiting on the user, interrupted, recovering, waiting
 * on background work), what is streaming, and what clients and the host must
 * hear as frames arrive.
 *
 * A `LiveSession` belongs to one attachment of the stream. Reattaching (a
 * reconnect, a recovery) builds a new one from the old: what describes the
 * session carries over, what describes the stream starts over. The
 * constructor says which is which. Work that outlives a frame (a metadata
 * read, a container check) checks `ctx.isCurrent()` before acting, so a
 * replaced attachment never acts on its session.
 *
 * Frames come in through `frame()`. The turn lifecycle is here; the parts
 * with their own state are in the trackers: `MainStream` (the response
 * streaming now), `TurnResponse` (the answer and outcome), `Subagents`,
 * `BackgroundTasks`, `ToolCalls` (what a finished tool call sets in motion).
 */
import type { ContainerClient, SlashCommandInfo, StreamMessage } from '@shared/lib/container/types'
import type { SessionTurnOutcome } from '@shared/lib/container/session-turn-outcome-schema'
import type { SessionUsage, SessionActivity } from '@shared/lib/types/agent'
import type { CoalescedUserMessage } from '@shared/lib/container/runtime-death'
import type { AgentInputRequests } from '@shared/lib/tools/requests/agent-input-requests'
import type { UserInputRequestOutcome } from '@shared/lib/tools/requests/request-schema'
import type { AgentComputerUse } from '@shared/lib/computer-use/agent-permissions'
import { classifyResult } from '@shared/lib/container/result-classification'
import { inferOomSigkillFatal } from '@shared/lib/container/runtime-death'
import { parseBackgroundTasksChanged } from '@shared/lib/container/background-tasks-changed'
import { parseCommandLifecycle } from '@shared/lib/container/command-lifecycle'
import { mergeCanonicalSlashCommands } from '@shared/lib/container/slash-commands'
import { credentialSource } from '@shared/lib/llm-provider/connection-runtime'
import { getActiveLlmProvider, getLlmProvider, getModelContextWindow } from '@shared/lib/llm-provider'
import { captureException } from '@shared/lib/error-reporting'
import { background } from '@shared/lib/background'
import { isSyntheticPlaceholderMessage } from '@shared/lib/utils/synthetic-message'
import type { SubagentCapture } from '@shared/lib/container/subagent-capture'
import { appendInformationalEntry } from '@shared/lib/services/session-transcript-append'
import { finalizeAutomationStatus, recordErrorProvider, updateSessionMetadata } from '@shared/lib/services/session-service'
import {
  recordProvisionalSessionActivity,
  recordSessionActivity,
  revertSessionActivity,
  type SessionActivityMark,
} from '@shared/lib/services/session-summary-cache'
import { randomUUID } from 'crypto'
import { transcriptPath, type SessionStore } from '../session-store'
import type { HostPort } from '../host-port'
import type { HostRunActor } from '../host-runs'
import { computeActivity } from './activity'
import type { SessionModelRuntime } from './live-sessions'
import { BackgroundTasks, isTerminalTaskStatus, type ActiveBackgroundTaskSnapshot } from './background-tasks'
import { MainStream } from './main-stream'
import type { SessionEvent } from './session-channel'
import { Subagents, type ActiveSubagentSnapshot } from './subagents'
import { ToolCalls, type Capability } from './tool-calls'
import { TurnResponse, assistantTextOf } from './turn-response'
import { WorkflowTailers } from './workflow-tailers'
import type { OrderedSends } from '../ordered-sends'

/** What a session's container runtime offers its sessions. */
export interface SessionRuntime {
  /**
   * The agent process reported a fatal result: whether the runtime will try
   * to recover the turn (`defer_for_recovery`) or the session settles.
   */
  fatalResult(client: ContainerClient | undefined, kind: 'oom_sigkill'): 'settle' | 'defer_for_recovery'
  /** The runtime died under these sessions (all mid-turn ones when none is named): try to recover. */
  unexpectedDeath(sessionId?: string): void
  /** A fatal error ended the turn: stop the container. */
  stopAfterFatalError(): void
}

/** What a session needs from its agent's sessions and from the world. */
export interface LiveSessionContext {
  readonly agentSlug: string
  readonly sessionId: string
  readonly store: SessionStore
  readonly requests: AgentInputRequests
  readonly computerUse: AgentComputerUse
  readonly host: HostPort
  readonly runs: HostRunActor
  readonly runtime: SessionRuntime
  readonly capture: SubagentCapture | null
  /** To the session's own stream. */
  emit(event: SessionEvent): void
  /** Still the live state for its session (not replaced by a reattach, not torn down). */
  isCurrent(): boolean
  /** The model runtime the session's turns run on, when the container's callback has resolved it. */
  modelRuntime(): SessionModelRuntime | undefined
  /** The client the stream is attached through, when it is. */
  transport(): ContainerClient | undefined
  /** The session may be done with its stream: release it if nothing still needs it. */
  releaseTransportIfIdle(): void
  /** Close the stream (the socket is gone, or recovery owns it now). */
  detachTransport(): void
  /** Attach the stream again through the same client (the socket dropped mid-run). */
  reattachTransport(client: ContainerClient): void
  capabilityGranted(capability: Capability): boolean
  grantCapability(capability: Capability): void
  /**
   * Recompute the waiting state of whichever state holds the session now:
   * work that outlives this attachment (a lookup a reattach overtook) must
   * land on the live one, not on this.
   */
  resyncAwaiting(): void
  /**
   * The session's completion notifications, in the order its turns ended.
   * The session's own, not this attachment's: it outlives a reattach, and a
   * session forgotten and created again.
   */
  completions(): OrderedSends
  /** Promote an automated session to interactive: it started waiting on the user. */
  promote(): void
  /** The session's journal tailers: they belong to the session, not to one attachment. */
  readonly workflows: WorkflowTailers
}

/** A send in flight: the state it may have to roll back to. */
export interface SendSnapshot {
  readonly wasActive: boolean
  readonly turnGeneration: number
  readonly processInstanceId: string | null
  readonly outputGeneration: number
  readonly resultGeneration: number
  readonly lastResultSubtype: string | null
  readonly lastResultCleanSuccess: boolean
  readonly lastApiErrorCode: string | null
  readonly isInterrupted: boolean
  readonly settleAfterStopPending: boolean
  readonly waitingBackground: boolean
  /** What the send's own activity mark looked like right after it was made. */
  readonly activityGeneration: number
  readonly provisionalActivity: SessionActivityMark | null
}

/** A provisional active mark: what it looked like when made, so an undo owns only it. */
export interface ProvisionalMark {
  readonly activityGeneration: number
  readonly turnGeneration: number
  readonly outputGeneration: number
  readonly resultGeneration: number
  readonly provisionalActivity: SessionActivityMark | null
}

/**
 * A frame's content as the container relays it: the SDK's message, not
 * validated on the way (the handlers read the fields they need defensively).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FrameContent = any

/** Frames about the runtime rather than the turn: they land even after a Stop. */
const RUNTIME_FRAME_TYPES: ReadonlySet<string> = new Set([
  'result',
  'system',
  'command_lifecycle',
  'capability_review_cancelled',
  'connection_closed',
])

// How long a stopped task's wake turn gets to announce itself (`running`)
// before the session settles on its own. A subagent's wake came ~20ms after
// its stopped notification; a stopped Bash task never wakes the agent.
const SETTLE_AFTER_STOP_GRACE_MS = 1500

// How long a completion notification waits for the transcript's end before
// going without it.
const TRANSCRIPT_END_WAIT_MS = 1000

const CONNECTION_LOST_ERROR =
  'The agent stopped unexpectedly because the connection to its runtime was lost. ' +
  'The container may have crashed or run out of memory.'

export class LiveSession {
  // ---- The turn --------------------------------------------------------------
  /** From an accepted message until the session settles. */
  isActive: boolean
  /** The user stopped the turn: its own late frames are dropped. */
  isInterrupted = false
  /** The runtime's last published state ('idle' with background work open: parked on it). */
  runtimeState: 'idle' | 'running' | null
  /**
   * Turns the runtime has started (one per `running`). An interrupt reads it
   * first, so it can tell the turn it stopped from one that started since.
   */
  turnGeneration: number
  /**
   * The turn's output ended and only background work keeps the session
   * active (what `session_waiting_background` told live clients; a client
   * that connects now reads it from the snapshot). Cleared when a turn starts.
   */
  waitingBackground: boolean
  /** Waiting on the user: a cache of the request store's projection, kept by `syncAwaiting`. */
  isAwaitingInput: boolean
  /** Claimed by recovery after the runtime died mid-turn: errors wait until the resume fails. */
  isRecovering: boolean
  /** Messages sent while recovering, delivered with their uuids once it is done. */
  coalescedUserMessages: CoalescedUserMessage[] | undefined
  /**
   * The runtime publishes its session state (idle/running), so it decides
   * when the session settles: a result alone doesn't, since queued messages
   * and background work keep the runtime going and only it knows. Set by the
   * container's `capabilities` handshake, which precedes any relayed result,
   * or by the first state event (older builds).
   */
  stateEventsAuthority: boolean
  /** The latest result's subtype; null until this turn's result (a send clears it). */
  lastResultSubtype: string | null
  /** The latest result was a clean success; persisted as the automation's outcome only once the session settles. */
  lastResultCleanSuccess: boolean
  /** The SDK's error code from the latest assistant message (authentication_failed, rate_limit, …). */
  lastApiErrorCode: string | null = null
  /** The summary-cache write a send made ahead of the container confirming it; undone if the send fails. */
  provisionalActivity: SessionActivityMark | null
  // Generations a failed send's rollback compares, so it never undoes what a
  // later send, a runtime result or real output did meanwhile.
  activityGeneration: number
  resultGeneration: number
  outputGeneration: number
  /** Only an idle after this result proves the current transport settled. */
  private settledResultGeneration: number | undefined = undefined
  /** The process the container evicted while we were attached: a one-shot release. */
  private evictedProcessInstance: string | undefined = undefined
  private settleAfterStopTimer: ReturnType<typeof setTimeout> | null = null

  // ---- Automation stream policy ------------------------------------------------
  /** An unpromoted automation: its stream is released once the session settles. */
  releaseStreamWhenIdle: boolean
  /** A chat-integration session keeps its state when its stream is released. */
  retainStateOnStreamRelease: boolean
  /** Promoted to interactive: set synchronously, so a slower metadata read cannot undo it. */
  promotedToInteractive: boolean
  /** Not a cron/webhook session: the automation-status write is skipped from then on. */
  private notAutomation = false

  // ---- Everything else ---------------------------------------------------------
  slashCommands: SlashCommandInfo[]
  /**
   * Requests a decision settled while their transcript result is still held
   * back (parallel calls release every sibling's result only when the last
   * one settles). The messages route stamps these onto the transcript, so
   * history readers see a completed call. Cleared at turn boundaries.
   */
  readonly settledInputRequests: Map<string, UserInputRequestOutcome>
  readonly stream: MainStream
  readonly response: TurnResponse
  readonly subagents: Subagents
  readonly background: BackgroundTasks
  readonly toolCalls: ToolCalls

  constructor(private readonly ctx: LiveSessionContext, prior?: LiveSession) {
    // What describes the session carries over a reattach; what describes the
    // stream starts over. A send that marked the session active before the
    // subscribe (x-agent invoke), and a reconnect mid-run, keep their state.
    this.isActive = prior?.isActive ?? false
    this.runtimeState = prior?.runtimeState ?? null
    this.turnGeneration = prior?.turnGeneration ?? 0
    this.waitingBackground = prior?.waitingBackground ?? false
    // The awaiting cache only means something while its source survives,
    // which it does: the request store is the agent's.
    this.isAwaitingInput = prior?.isAwaitingInput ?? false
    this.isRecovering = prior?.isRecovering ?? false
    this.coalescedUserMessages = prior?.coalescedUserMessages
    this.stateEventsAuthority = prior?.stateEventsAuthority ?? false
    this.lastResultSubtype = prior?.lastResultSubtype ?? null
    this.lastResultCleanSuccess = prior?.lastResultCleanSuccess ?? false
    this.provisionalActivity = prior?.provisionalActivity ?? null
    this.activityGeneration = prior?.activityGeneration ?? 0
    this.resultGeneration = prior?.resultGeneration ?? 0
    this.outputGeneration = prior?.outputGeneration ?? 0
    // The verdict carries over until the new attachment's own read lands.
    this.releaseStreamWhenIdle = prior?.releaseStreamWhenIdle ?? false
    this.retainStateOnStreamRelease = prior?.retainStateOnStreamRelease ?? false
    this.promotedToInteractive = prior?.promotedToInteractive ?? false
    this.slashCommands = prior?.slashCommands ?? []
    this.settledInputRequests = prior?.settledInputRequests ?? new Map()
    this.response = TurnResponse.carriedOver(prior?.response, this.isActive)

    const emit = (event: SessionEvent) => this.ctx.emit(event)
    this.stream = new MainStream({
      emit,
      responseStarted: () => this.response.beginStreamedText(),
      textStreamed: (text) => this.response.appendStreamedText(text),
    })
    // The background work, and the process it belongs to, carry over with
    // the level set describing them: the incoming handshake decides whether
    // they are still valid. Being carried, its sink may only use what is the
    // session's rather than this attachment's: the session's wire, the host,
    // the session's tailers.
    this.background = prior?.background ?? new BackgroundTasks(
      { agentSlug: ctx.agentSlug, sessionId: ctx.sessionId },
      {
        emit: (event) => this.ctx.emit(event),
        publish: (event) => this.ctx.host.send('global', event),
        workflowStarted: (runId) => this.ctx.workflows.start(runId),
        workflowEnded: (runId) => this.ctx.workflows.stop(runId),
      },
    )
    this.subagents = new Subagents({
      emit,
      registerBackground: (agentId, toolUseId) => this.background.upsert(agentId, { isSubagent: true, toolUseId }),
      isBackgroundSubagent: (agentId) => this.background.get(agentId)?.isSubagent === true,
      ended: (parentToolId) => this.invalidateSubagentRequests(parentToolId),
    })
    this.toolCalls = new ToolCalls({
      agentSlug: ctx.agentSlug,
      sessionId: ctx.sessionId,
      requests: ctx.requests,
      computerUse: ctx.computerUse,
      host: ctx.host,
      runs: ctx.runs,
      emit,
      transport: () => this.ctx.transport(),
      resolveInput: (toolUseId, value) => this.answerInput(toolUseId, 'resolve', { value }),
      rejectInput: (toolUseId, reason) => this.answerInput(toolUseId, 'reject', { reason }),
      // A tool call's lookups can outlive this attachment.
      syncAwaiting: () => this.ctx.resyncAwaiting(),
      // The map is carried across a reattach, like the lookups.
      settled: (toolUseId, outcome) => this.settledInputRequests.set(toolUseId, outcome),
      capabilityGranted: (capability) => this.ctx.capabilityGranted(capability),
      grantCapability: (capability) => this.ctx.grantCapability(capability),
      trackSubagentLaunch: (toolUseId, input) => this.subagents.trackLaunch(toolUseId, input),
    }, prior?.toolCalls)
  }

  // ===========================================================================
  // Reads
  // ===========================================================================

  activity(): SessionActivity {
    return computeActivity({
      isActive: this.isActive,
      isAwaitingInput: this.isAwaitingInput,
      isCompacting: this.stream.isCompacting,
      isRetrying: this.stream.isRetrying,
      isThinking: this.stream.isThinking,
      isStreaming: this.stream.isStreaming,
      hasToolUse: this.stream.currentToolUse !== null,
    })
  }

  get turnOutcome(): SessionTurnOutcome | null {
    return this.response.outcome ?? null
  }

  get processInstanceId(): string | null {
    return this.background.processInstanceId
  }

  /** Active only for open background work: the turn's output ended. */
  isWaitingBackground(): boolean {
    return this.isActive && this.waitingBackground
  }

  backgroundTasks(): ActiveBackgroundTaskSnapshot[] {
    return this.background.list()
  }

  activeSubagents(): ActiveSubagentSnapshot[] {
    return this.subagents.snapshot()
  }

  /**
   * Background work keeps the session open, but none of it is a task clients
   * can see (ambient work: housekeeping, live-update watchers). A stop scoped
   * to the turn cannot end such a session, so callers stop everything instead.
   */
  hasOnlyUntrackedBackgroundWork(): boolean {
    return this.background.list().length === 0 && this.background.openCount() > 0
  }

  /**
   * The generation of the turn an interrupt sent now would stop. A send whose
   * `running` has not arrived yet counts as that turn, so its late `running`
   * is not mistaken for a new one.
   */
  currentTurnGeneration(): number {
    const startPending = this.isActive && this.lastResultSubtype === null && this.runtimeState !== 'running'
    return this.turnGeneration + (startPending ? 1 : 0)
  }

  /**
   * Whether the session is done with its stream: an unpromoted automation
   * that has truly settled (the runtime idle after this transport's result,
   * or its process evicted), with nothing parked and nothing in the
   * background. A result alone cannot prove the queue and background work drained.
   */
  canReleaseStream(): boolean {
    const settled = this.stateEventsAuthority && this.runtimeState === 'idle' &&
      this.lastResultSubtype !== null && this.settledResultGeneration === this.resultGeneration
    const evicted = this.evictedProcessInstance !== undefined && this.evictedProcessInstance === this.processInstanceId
    return this.releaseStreamWhenIdle && !this.promotedToInteractive &&
      !this.isActive && !this.isAwaitingInput && !this.isRecovering &&
      this.background.openCount() === 0 && (settled || evicted)
  }

  // ===========================================================================
  // Turn lifecycle
  // ===========================================================================

  /**
   * A message was accepted. Re-marking an ALREADY-active session is how a
   * queued or steering message joins a running turn: not a turn boundary.
   * What any accepted message invalidates is split from what only a new turn
   * ends, the way the app's session_active handler splits them, or the whole
   * reported status would collapse to "Working…" the moment a follow-up is
   * queued (SUP-736).
   */
  markActive(): void {
    const wasActive = this.isActive
    this.activityGeneration += 1
    this.isActive = true
    // Message-scoped: a queued message clears these as much as a new turn does.
    this.isInterrupted = false
    this.waitingBackground = false
    this.cancelSettleAfterStop()
    this.isAwaitingInput = false
    this.lastApiErrorCode = null
    // A late idle from a finished or interrupted run must not fire a stale
    // "success" notification against the turn this message starts.
    this.lastResultSubtype = null
    this.lastResultCleanSuccess = false
    if (wasActive) {
      this.response.messageQueued()
    } else {
      // Turn-scoped.
      this.subagents.clear()
      this.stream.newTurn()
      this.response.newTurn()
    }

    // The CLI appends the user's message as the turn starts, but the SDK
    // doesn't echo it, so the first frame here can be tens of seconds out.
    // Session lists rank by the summary cache, so the session moves up now;
    // provisionally, until the container answers (markIdle undoes it).
    this.provisionalActivity = recordProvisionalSessionActivity(this.ctx.store, this.ctx.sessionId, Date.now())

    // A queued message joins the response in progress; a new turn starts its own.
    if (!wasActive) this.response.beginStreamedText()
    this.settleTurnBoundaryRequests('started')
    // queuedMidTurn: the app keeps the turn-scoped state (compaction,
    // thinking, running subagents) a real boundary would clear.
    this.ctx.emit({ type: 'session_active', isActive: true, queuedMidTurn: wasActive })
    this.publish({ type: 'session_active', isActive: true })
    // The boundary settled the last turn's parked requests, so this picks up
    // only waits that survive a new message: an agent-scoped review.
    this.syncAwaiting()
  }

  /**
   * A host-initiated send failed before reaching the container: the turn never
   * started, so the session goes back to idle, and the recency it was
   * credited with is undone (a no-op if a frame arrived since: the turn was real).
   */
  markIdle(): void {
    if (!this.isActive) return
    if (this.provisionalActivity) revertSessionActivity(this.ctx.store, this.ctx.sessionId, this.provisionalActivity)
    this.provisionalActivity = null
    this.finalizeIdle()
  }

  /** A failed send rolls back only its own mark, as of this snapshot. */
  sendSnapshot(): SendSnapshot {
    return {
      wasActive: this.isActive,
      turnGeneration: this.turnGeneration,
      processInstanceId: this.processInstanceId,
      outputGeneration: this.outputGeneration,
      resultGeneration: this.resultGeneration,
      lastResultSubtype: this.lastResultSubtype,
      lastResultCleanSuccess: this.lastResultCleanSuccess,
      lastApiErrorCode: this.lastApiErrorCode,
      isInterrupted: this.isInterrupted,
      settleAfterStopPending: this.settleAfterStopTimer !== null,
      waitingBackground: this.waitingBackground,
      activityGeneration: this.activityGeneration,
      provisionalActivity: this.provisionalActivity,
    }
  }

  /**
   * A send marked the session active and then failed. Undo only what it did:
   * a later send, a stop, a recovery, a new runtime turn, or output that
   * arrived meanwhile owns the state from then on.
   *
   * `before` is the state ahead of the mark; `marked` right after it.
   */
  sendFailed(before: SendSnapshot, marked: SendSnapshot): void {
    if (
      this.activityGeneration !== marked.activityGeneration || this.turnGeneration !== before.turnGeneration ||
      this.processInstanceId !== before.processInstanceId || this.isInterrupted || this.isRecovering
    ) return
    const outputArrived = this.outputGeneration !== before.outputGeneration
    const activity = marked.provisionalActivity
    if ((before.wasActive || !outputArrived) && activity && this.provisionalActivity === activity) {
      revertSessionActivity(this.ctx.store, this.ctx.sessionId, activity)
      this.provisionalActivity = null
    }
    if (before.wasActive) {
      const resultArrived = this.resultGeneration !== before.resultGeneration
      // Take back only this queued message. If a result consumed its
      // boundary, there is no next answer to reset.
      this.response.queuedMessageWithdrawn()
      if (!resultArrived) {
        this.lastResultSubtype = before.lastResultSubtype
        this.lastResultCleanSuccess = before.lastResultCleanSuccess
        this.lastApiErrorCode = before.lastApiErrorCode
        this.isInterrupted = before.isInterrupted
      }
      // The final idle may have arrived while the failed send was in flight
      // and its result guard was cleared: apply it now.
      if (
        !resultArrived && (before.settleAfterStopPending || before.waitingBackground) &&
        this.isActive && this.runtimeState === 'idle' && this.background.openCount() === 0
      ) {
        // Keep the stopped background task's grace for a possible wake.
        this.scheduleSettleAfterStop()
      } else if (this.runtimeState === 'idle') {
        this.runtimeIdle()
      }
    } else if (!outputArrived) {
      this.markIdle()
      this.lastResultSubtype = before.lastResultSubtype
      this.lastResultCleanSuccess = before.lastResultCleanSuccess
    }
  }

  /** Admit terminal replay during recovery; `revertProvisional` undoes the returned mark. */
  markProvisionallyActive(): ProvisionalMark {
    this.markActive()
    const { activityGeneration, turnGeneration, outputGeneration, resultGeneration, provisionalActivity } = this
    return { activityGeneration, turnGeneration, outputGeneration, resultGeneration, provisionalActivity }
  }

  /**
   * Undo a provisional mark after a silent cold attach. The undo owns only
   * that mark: a new send, runtime turn, result or output took the state
   * over if any generation moved. The generations carry over a reattach, so
   * a mark made before a subscribe is still undone after it.
   */
  revertProvisional(mark: ProvisionalMark): void {
    if (this.provisionalActivity !== mark.provisionalActivity || this.activityGeneration !== mark.activityGeneration ||
      this.turnGeneration !== mark.turnGeneration || this.outputGeneration !== mark.outputGeneration ||
      this.resultGeneration !== mark.resultGeneration || this.isInterrupted || this.isRecovering) return
    this.markIdle()
  }

  /**
   * The user stopped the session (or the host is settling one it cannot reach).
   *
   * `processKept`: the container ended only the foreground turn and the CLI
   * process survived, so its background work is still running and keeps its
   * state here; the session then rests waiting on it, as a finished turn
   * would. Otherwise the process was replaced: every background task died
   * with it and no terminal signal will come, so their state is dropped.
   *
   * `turnGenerationBefore`: the container answers a soft stop only after the
   * stopped turn's result. A background task can settle in that window and
   * wake the agent; that new turn owns the state, so the stop leaves it be.
   */
  markInterrupted(options: { processKept?: boolean; turnGenerationBefore?: number } = {}): void {
    const processKept = options.processKept === true
    if (processKept && options.turnGenerationBefore !== undefined && this.turnGeneration > options.turnGenerationBefore) {
      console.log(`[LiveSession] Session ${this.ctx.sessionId} started a new turn after the stop; leaving it running`)
      return
    }

    // The flag first: frames already in the pipe are the stopped turn's.
    this.isInterrupted = true
    this.stream.stop()
    this.isAwaitingInput = false
    this.lastResultCleanSuccess = false
    this.isRecovering = false
    this.coalescedUserMessages = undefined
    let backgroundTasks: ActiveBackgroundTaskSnapshot[] = []
    if (processKept) {
      this.subagents.dropForeground()
      backgroundTasks = this.background.list()
      // Open background work keeps the session active, as after a finished
      // turn: the runtime wakes the agent when a task settles.
      this.isActive = this.background.openCount() > 0
    } else {
      this.isActive = false
      this.subagents.clear()
      this.background.forgetAll()
      this.ctx.workflows.stopAll()
    }

    if (this.isActive) {
      // Only the turn ended. The renderer resets its streaming state off this
      // frame as it does off session_idle, but keeps the task list.
      this.waitingBackground = true
      const turnOutcome = this.response.recordOutcome('cancelled')
      this.ctx.emit({
        type: 'session_waiting_background',
        interrupted: true,
        backgroundTaskCount: backgroundTasks.length,
        backgroundTasks,
        turnOutcome,
      })
      return
    }
    const turnOutcome = this.response.recordOutcome('cancelled')
    this.settleTurnBoundaryRequests('ended')
    this.ctx.emit({ type: 'session_idle', isActive: false, outcome: 'cancelled', turnOutcome })
    this.publish({ type: 'session_idle', isActive: false })
  }

  /**
   * The runtime is gone (its container stopped or died). A session that was
   * mid-turn and not stopped didn't finish: that is an error, not an idle,
   * which would read as the turn ending with no explanation.
   */
  markInactive(): void {
    const diedMidTurn = this.isActive && !this.isInterrupted
    this.stream.stop()
    this.isAwaitingInput = false
    this.subagents.clear()
    // Its background tasks went with it.
    this.background.forgetAll()
    this.ctx.workflows.stopAll()
    if (!diedMidTurn) {
      this.finalizeIdle()
      return
    }
    // Settled before the frame, so the terminal transition is one non-busy
    // emit, and session_error instead of session_idle (connectors finalize on either).
    this.isActive = false
    console.error(`[LiveSession] Session ${this.ctx.sessionId} died mid-turn (connection lost)`)
    this.persistAutomationStatus('failed')
    const turnOutcome = this.response.recordOutcome('failed', CONNECTION_LOST_ERROR)
    const error = { error: CONNECTION_LOST_ERROR, apiErrorCode: null, terminalReason: 'connection_lost', isActive: false }
    this.ctx.emit({ type: 'session_error', ...error, turnOutcome })
    this.publish({ type: 'session_error', ...error })
  }

  /** Recovery claims this session: it was mid-turn when the runtime died. */
  claimForRecovery(): boolean {
    if (!this.isActive || this.isInterrupted) return false
    this.isRecovering = true
    return true
  }

  /** Recovery resumed the turn. */
  recovered(): void {
    this.isRecovering = false
    this.coalescedUserMessages = undefined
  }

  /** Recovery failed: the turn ended with the runtime. */
  recoveryFailed(): void {
    this.isRecovering = false
    const dropped = this.coalescedUserMessages
    if (dropped?.length) {
      const messageLength = dropped.reduce((n, message) => n + message.text.length, 0)
      console.warn(
        `[LiveSession] Dropping ${dropped.length} user message(s) coalesced during failed recovery for ${this.ctx.sessionId} (length=${messageLength})`,
      )
      captureException(new Error('Coalesced user message dropped on recovery settle'), {
        tags: { area: 'container', op: 'runtime.recovery.dropCoalesced' },
        extra: { sessionId: this.ctx.sessionId, messageCount: dropped.length, messageLength },
      })
    }
    this.coalescedUserMessages = undefined
    if (this.isActive && !this.isInterrupted) this.markInactive()
  }

  /** Hold a message sent while recovering. False when not recovering (send it normally). */
  coalesce(message: CoalescedUserMessage): boolean {
    if (!this.isRecovering) return false
    const text = message.text.trim()
    if (!text) return true
    const entry: CoalescedUserMessage = { uuid: message.uuid, text }
    if (message.shouldQuery === false) entry.shouldQuery = false
    this.coalescedUserMessages = [...(this.coalescedUserMessages ?? []), entry]
    return true
  }

  takeCoalesced(): CoalescedUserMessage[] {
    const messages = this.coalescedUserMessages
    if (!messages?.length) return []
    this.coalescedUserMessages = undefined
    return messages
  }

  dropCoalesced(uuid: string): boolean {
    if (!this.coalescedUserMessages) return false
    const next = this.coalescedUserMessages.filter((message) => message.uuid !== uuid)
    if (next.length === this.coalescedUserMessages.length) return false
    this.coalescedUserMessages = next.length > 0 ? next : undefined
    return true
  }

  /**
   * The one idle finalizer: for the legacy result-driven idle, the runtime's
   * idle, a stop and a lost runtime.
   */
  private finalizeIdle(): void {
    const outcome = this.isInterrupted ? 'cancelled' : this.lastResultCleanSuccess ? 'completed' : undefined
    // Truly settled: persist a clean success as the automation's outcome.
    // (A failure was persisted at its result; a stop never sets the flag.)
    if (this.lastResultCleanSuccess) {
      this.lastResultCleanSuccess = false
      this.persistAutomationStatus('succeeded')
    }
    this.isActive = false
    // An inactive session is never waiting on the user; left set, the raw
    // bit would strand "needs input" on an idle session.
    this.isAwaitingInput = false
    const turnOutcome = outcome ? this.response.recordOutcome(outcome) : undefined
    this.settleTurnBoundaryRequests('ended')
    this.ctx.emit({ type: 'session_idle', isActive: false, outcome, ...(turnOutcome && { turnOutcome }) })
    this.publish({ type: 'session_idle', isActive: false })
    this.ctx.releaseTransportIfIdle()
  }

  /**
   * The runtime went idle (or a result settled a legacy runtime's turn). Only
   * an idle after a result counts: a bare one (a stale idle racing a fresh
   * message) must not fire a spurious session_idle and notification.
   */
  private runtimeIdle(): void {
    if (this.isActive && this.lastResultSubtype !== null) {
      const openBackgroundWork = this.background.openCount()
      if (openBackgroundWork > 0) {
        // Not settled: Bash run in the background and dynamic workflows go
        // idle at TURN end while still running, then wake the agent when
        // they finish. The session stays active, waiting on them.
        this.waitingBackground = true
        this.ctx.emit({
          type: 'session_waiting_background',
          backgroundTaskCount: openBackgroundWork,
          backgroundTasks: this.background.list(),
        })
        return
      }
      this.finalizeIdle()
      // Notify at the real end of the work; a resume-exit pauses, it doesn't finish.
      if (this.lastResultSubtype === 'success') this.notifyCompleted()
    } else if (!this.isActive && this.lastResultSubtype !== null) {
      // The error path already settled the turn.
      this.ctx.releaseTransportIfIdle()
    }
  }

  /**
   * A task the user stopped may end with its terminal frame and no wake turn
   * (a stopped Bash task; a stopped subagent does wake the agent). When it
   * was the last open work and the runtime is parked idle, give a wake a
   * moment to show up, then settle: nothing else ever would.
   */
  private scheduleSettleAfterStop(): void {
    this.cancelSettleAfterStop()
    this.settleAfterStopTimer = setTimeout(() => {
      this.settleAfterStopTimer = null
      if (!this.ctx.isCurrent()) return
      if (!this.isActive || this.runtimeState !== 'idle' || this.background.openCount() > 0) return
      console.log(`[LiveSession] Session ${this.ctx.sessionId}: last background task stopped while idle — settling`)
      this.finalizeIdle()
    }, SETTLE_AFTER_STOP_GRACE_MS)
  }

  private cancelSettleAfterStop(): void {
    if (this.settleAfterStopTimer) {
      clearTimeout(this.settleAfterStopTimer)
      this.settleAfterStopTimer = null
    }
  }

  /** The attachment is being dropped: nothing it scheduled may fire. */
  dispose(): void {
    this.cancelSettleAfterStop()
    // The session is gone: a sign-in the host is still deciding raises no card.
    this.toolCalls.dropLoginDecisions()
  }

  // ===========================================================================
  // Requests
  // ===========================================================================

  /**
   * Recompute whether the session waits on the user, from the request store,
   * and tell the global feed on the edges. An inactive session never waits:
   * its parked requests died with its turn, even when a stale entry or an
   * agent-scoped review is still open.
   */
  syncAwaiting(): void {
    const awaiting = this.isActive && this.ctx.requests.isSessionAwaiting(this.ctx.sessionId)
    if (awaiting === this.isAwaitingInput) return
    this.isAwaitingInput = awaiting
    if (!awaiting) {
      this.publish({ type: 'session_input_provided' })
      return
    }
    this.publish({ type: 'session_awaiting_input' })
    // A blocked automation surfaces in session lists and gets notified.
    this.ctx.promote()
  }

  /**
   * A turn boundary settles whatever the last turn left parked. Runs before
   * the boundary's own frame, so the requests' resolved frames precede it.
   */
  private settleTurnBoundaryRequests(boundary: 'started' | 'ended'): void {
    // The boundary lands held-back sibling results in the transcript.
    this.settledInputRequests.clear()
    // A new turn supersedes parked asks; an ended one cancels them.
    this.ctx.requests.clearSessionStreamRequests(this.ctx.sessionId, boundary === 'started' ? 'superseded' : 'cancelled')
    if (boundary === 'started') {
      // A new turn also supersedes computer-use approvals a previous turn
      // left. (An ended turn keeps them, so a still-parked approval survives
      // a reconnect.) Read as a live wait, a stale one would flag the fresh
      // turn as awaiting.
      for (const id of this.ctx.requests.getStoreIdsForSession(this.ctx.sessionId, 'computer_use')) {
        this.ctx.requests.resolveIfInStore(id, 'computer_use', 'superseded')
      }
    }
  }

  /**
   * A decision settled a request now, though its transcript result may still
   * be held back by parallel siblings (only the last one's settle releases
   * them). Without this the decided entry stays open: the snapshot keeps
   * serving it and a reload resurrects the card.
   */
  completeRequest(toolUseId: string, outcome: UserInputRequestOutcome): void {
    const settled = this.ctx.requests.resolveIfInStore(toolUseId, 'stream', outcome)
    if (settled) {
      this.settledInputRequests.set(toolUseId, outcome)
      // The tool_result path's frame: the resolving tab removed its card,
      // every other tab drops it off this (removal is idempotent).
      this.ctx.emit({
        type: 'tool_result',
        toolUseId,
        result: outcome === 'answered' ? 'User provided input' : 'User declined the request',
        isError: outcome !== 'answered',
      })
    }
    this.syncAwaiting()
  }

  /**
   * A decided capability review leaves at once: an approved launch runs for
   * minutes before its result, and meanwhile a reload would replay the card.
   */
  completeCapabilityReview(toolUseId: string, outcome: UserInputRequestOutcome): void {
    this.ctx.requests.resolveIfInStore(toolUseId, 'stream', outcome)
    this.syncAwaiting()
  }

  /** A computer-use approval was decided. */
  clearComputerUseRequest(toolUseId: string, outcome: UserInputRequestOutcome): void {
    this.ctx.requests.resolveIfInStore(toolUseId, 'computer_use', outcome)
    this.syncAwaiting()
  }

  /**
   * Re-register parked asks whose one-shot stream event was missed but whose
   * unanswered call the transcript shows, and recompute waiting.
   */
  recoverAwaitingInput(unresolved: Array<{ toolUseId: string; toolName: string }>): void {
    if (!this.isActive) return
    this.toolCalls.recoverParked(unresolved)
    this.syncAwaiting()
  }

  /**
   * A subagent ended: anything it left parked can never be answered. Settle
   * it, and fail the container's pending input so a late click lands nowhere.
   */
  private invalidateSubagentRequests(parentToolId: string): void {
    // Nor does a sign-in it asked for that the host is still deciding.
    this.toolCalls.dropLoginDecisions(parentToolId)
    const orphaned = this.ctx.requests.resolveRequestsByParent(parentToolId, 'invalidated')
    if (orphaned.length === 0) return
    for (const request of orphaned) {
      background(
        this.answerInput(request.id, 'reject', { reason: 'The subagent that asked for this input was terminated.' }).catch((error) =>
          console.error(`[LiveSession] dead-subagent reject failed for ${request.id}:`, error),
        ),
        { name: 'live-session.reject-orphaned-input' },
      )
    }
    this.syncAwaiting()
  }

  /** Answer one of the container's pending inputs. */
  private async answerInput(toolUseId: string, verb: 'resolve' | 'reject', body: { value: string } | { reason: string }): Promise<void> {
    await this.ctx.runs.container.fetch(`/inputs/${encodeURIComponent(toolUseId)}/${verb}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  // ===========================================================================
  // Frames
  // ===========================================================================

  /** One frame from the container's stream. */
  frame(message: StreamMessage): void {
    if (this.ctx.capture) background(this.ctx.capture.recordInput(this.ctx.sessionId, message), { name: 'live-session.capture-input' })
    const content = message.content

    // After a stop, the stopped turn's own content still in the pipe is
    // stale and dropped. What describes the runtime still lands: the result,
    // process_restarted (which runtime we talk to now), every system and
    // lifecycle frame (a kept process's background tasks finish, and their
    // wake turn's `running` clears the flag), and the frames of background
    // subagents the stop spared (their requests still wait on the user).
    if (this.isInterrupted && !RUNTIME_FRAME_TYPES.has(content?.type) && !this.subagents.isSparedFrame(content?.parent_tool_use_id)) {
      return
    }
    if (!content.replayed && ['assistant', 'user', 'result', 'stream_event'].includes(content.type)) {
      this.outputGeneration += 1
    }

    // A task's terminal notification, before the sidechain filter: a task
    // settling while the agent is idle wakes it with this frame. The level
    // set can name ids the map never held (a subagent's own background
    // agents notify onto the lead session), and those must retire here too.
    if (content.type === 'system') {
      if (typeof content.task_id === 'string' && typeof content.status === 'string') {
        this.background.retire(content.task_id, content.status)
      }
      if (
        content.subtype === 'task_notification' && content.status === 'stopped' && this.isActive &&
        this.runtimeState === 'idle' && this.lastResultSubtype !== null && this.background.openCount() === 0
      ) {
        this.scheduleSettleAfterStop()
      }
    }
    // A workflow's real run id arrives only in its tool result, the next
    // message after its task_started.
    this.background.wireWorkflowFromToolResult(content)

    // A subagent's frames don't touch the main stream's state, but its task
    // lifecycle frames describe a launch the main stream tracks.
    const isTaskLifecycle = content.type === 'system' &&
      ['task_started', 'task_progress', 'task_updated', 'task_notification'].includes(content.subtype)
    if (content.parent_tool_use_id != null && !isTaskLifecycle) {
      this.sidechainFrame(content)
      return
    }

    // Complete top-level frames are durable transcript writes: the session's
    // summary entry moves. Replayed catch-up frames don't (their arrival time
    // is not when they happened; the TTL reconciliation repairs a missed end).
    if (!content.replayed && ['assistant', 'user', 'result'].includes(content.type)) {
      recordSessionActivity(this.ctx.store, this.ctx.sessionId, message.timestamp)
      // The turn is real: the send's provisional mark no longer needs undoing.
      this.provisionalActivity = null
    }

    // Late-join catch-up: the runtime replays the last turn's terminal frames
    // when a socket attaches after it ended. Only a session that missed that
    // end (still active) acts on them; a settled one already did.
    if (content.replayed && !this.isActive) return
    // It missed its turn end, so nothing recorded that activity; the
    // transcript's mtime says when it happened.
    if (content.replayed && content.type === 'result') this.refreshActivityFromTranscript()

    switch (content.type) {
      case 'assistant':
        this.assistantFrame(content)
        return
      case 'user':
        this.userFrame(content)
        return
      case 'system':
        this.systemFrame(content)
        return
      case 'command_lifecycle': {
        // Per-command transitions, keyed by the message's own uuid: the
        // renderer joins terminal states back to its optimistic ghosts.
        const lifecycle = parseCommandLifecycle(content)
        if (!lifecycle) return
        this.ctx.emit({ type: 'command_lifecycle', commandUuid: lifecycle.commandUuid, state: lifecycle.state })
        // A discarded message never ran, so whoever it tagged is not told.
        if (lifecycle.state === 'discarded') {
          this.ctx.host.send('notification', {
            kind: 'message_discarded',
            agentSlug: this.ctx.agentSlug,
            sessionId: this.ctx.sessionId,
            messageUuid: lifecycle.commandUuid,
          })
        }
        return
      }
      case 'result':
        this.resultFrame(content)
        return
      case 'browser_active':
        this.ctx.emit({ type: 'browser_active', active: content.active })
        return
      case 'capability_review_cancelled':
        // The container's gate stopped waiting (its timeout, or the turn was
        // aborted): close the card everywhere rather than leave it dangling.
        if (typeof content.toolUseId === 'string' && this.toolCalls.reviewCancelled(content.toolUseId) === 'closed') {
          this.completeCapabilityReview(content.toolUseId, 'cancelled')
        }
        return
      case 'connection_closed':
        console.log(`[LiveSession] Connection closed for session ${this.ctx.sessionId}, checking container state`)
        this.connectionClosed()
        return
      default:
        // Stream events, wrapped or (sometimes) bare.
        if (content.event) this.streamEvent(content.event)
    }
  }

  private streamEvent(event: Parameters<MainStream['event']>[0]): void {
    const finished = this.stream.event(event)
    if (!finished) return
    this.toolCalls.mainToolUse(finished)
    this.stream.toolUseReady()
  }

  private assistantFrame(content: FrameContent): void {
    // The CLI's "No response requested." stand-in for a turn with no model
    // output: hidden in the transcript, so neither an answer nor a refetch.
    if (isSyntheticPlaceholderMessage(content)) return
    const text = this.response.assistantFrame(content)
    // Email and chat deliver only stream_delta: a finished answer that
    // streamed no deltas would show in the transcript and never be sent.
    if (text !== null && !content.error && !this.stream.streamedText && text) {
      this.response.appendStreamedText(text)
      this.ctx.emit({ type: 'stream_delta', text })
    }
    if (content.error) {
      this.lastApiErrorCode = content.error
      const provider = this.ctx.modelRuntime()?.provider
      if (provider && typeof content.uuid === 'string' && content.uuid) {
        background(recordErrorProvider(this.ctx.store, this.ctx.sessionId, content.uuid, provider).catch((error) => {
          console.error('[LiveSession] Failed to record error provider:', error)
        }), { name: 'live-session.record-error-provider' })
      }
      // Style what already streamed as a provider error at once, without
      // waiting for the transcript refetch: the code alone if text streamed,
      // the text with it otherwise.
      if (this.stream.currentText.length > 0) {
        this.ctx.emit({ type: 'stream_api_error', apiErrorCode: content.error })
      } else {
        const errorText = assistantTextOf(content)
        if (errorText) {
          this.response.appendStreamedText(errorText)
          this.ctx.emit({ type: 'stream_delta', text: errorText, apiErrorCode: content.error })
        }
      }
    }
    // The transcript has the message now.
    this.stream.messagePersisted()
    this.ctx.emit({ type: 'messages_updated' })
    if (content.message?.usage) this.stream.reportUsage(content.message.usage)
  }

  private userFrame(content: FrameContent): void {
    this.subagents.toolResults(content)
    // A Bash command sent to the background says so in its result.
    const backgroundTaskId = content.tool_use_result?.backgroundTaskId ?? content.tool_use_result?.background_task_id
    if (typeof backgroundTaskId === 'string' && backgroundTaskId) this.background.upsert(backgroundTaskId, {})
    // During a compaction the next user message is its summary. Position (a
    // compaction under way) is the primary signal: the flag on the message
    // is not always on the wire.
    if (this.stream.isCompacting || content.isCompactSummary) {
      this.stream.compactionEnded()
      return
    }
    // Tool results settle what each answers; the session waits only on what
    // is still open, so one answered parallel request doesn't drop the light.
    this.toolCalls.mainToolResults(content)
    // The persisted user message replaces the client's optimistic copy.
    this.ctx.emit({ type: 'messages_updated' })
  }

  private sidechainFrame(content: FrameContent): void {
    const parentToolId = this.subagents.routeFrame(content)
    if (content.event && (content.type === 'stream_event' || (content.type !== 'user' && content.type !== 'assistant'))) {
      const finished = this.subagents.streamEvent(parentToolId, content.event)
      if (finished) {
        this.toolCalls.subagentStreamedToolUse(finished, parentToolId)
        this.subagents.toolUseReady(parentToolId)
      }
      return
    }
    // A subagent's own result: it finished.
    if (content.type === 'result') {
      this.subagents.complete(parentToolId)
      return
    }
    if (content.type !== 'user' && content.type !== 'assistant') return
    // Complete subagent messages are in its transcript: clients refetch them.
    if (content.type === 'user') {
      // A subagent's tool results come here, not through the main path: an
      // answered request of its (a browser hand-off) settles here too.
      this.toolCalls.subagentToolResults(content)
      this.subagents.toolResults(content)
    } else {
      for (const toolUse of this.subagents.assistantMessage(parentToolId, content)) {
        this.toolCalls.subagentMessageToolUse(toolUse, parentToolId)
      }
    }
    this.subagents.messageUpdated(parentToolId)
  }

  private systemFrame(content: FrameContent): void {
    switch (content.subtype) {
      case 'init':
        // The executable names: they win over persisted display titles.
        if (Array.isArray(content.slash_commands)) {
          this.slashCommands = mergeCanonicalSlashCommands(
            content.slash_commands.filter((name: unknown): name is string => typeof name === 'string'),
            this.slashCommands,
          )
        }
        this.response.beginStreamedText()
        this.ctx.emit({ type: 'stream_start', slashCommands: this.slashCommands.length > 0 ? this.slashCommands : undefined })
        return
      case 'status':
        if (content.status === 'compacting') this.stream.compactionStarted()
        // The CLI is composing its next request, the moment it drains its
        // queue: queued messages it picked up are persisted with no stream
        // event of their own, so clients refetch to show them.
        if (content.status === 'requesting') this.ctx.emit({ type: 'messages_updated' })
        return
      case 'compact_boundary':
        // For SDK paths that announce compaction only with the boundary.
        this.stream.compactionStarted()
        return
      case 'api_retry':
        this.stream.retrying(content)
        return
      case 'task_started':
        this.subagents.taskStarted(content)
        // A dynamic workflow outlives its launch turn like a background Bash
        // command: the same tray rows, the same waiting. Its run id arrives
        // with the tool result (see wireWorkflowFromToolResult).
        if (content.task_type === 'local_workflow' && typeof content.task_id === 'string') {
          this.background.upsert(content.task_id, {
            isWorkflow: true,
            toolUseId: typeof content.tool_use_id === 'string' ? content.tool_use_id : undefined,
            workflowName: typeof content.workflow_name === 'string' ? content.workflow_name : undefined,
          })
        }
        return
      case 'task_progress':
        this.subagents.taskProgress(content)
        this.workflowProgress(content)
        return
      case 'task_updated': {
        // A background task that finishes while a foreground tool runs settles
        // as a task_updated patch, not a task_notification (that only comes
        // on the idle/wake path). 'stopped' answers a stop_task request.
        const status = (content.patch as { status?: unknown } | undefined)?.status
        if (typeof content.task_id === 'string' && isTerminalTaskStatus(status)) {
          this.background.retire(content.task_id, status)
          this.subagents.taskEnded(content.task_id)
        }
        return
      }
      case 'task_notification':
        this.subagents.taskNotification(content.tool_use_id, content.status, content.summary)
        return
      case 'process_evicted':
        if (typeof content.process_instance === 'string' && content.process_instance === this.processInstanceId) {
          // Kept across an in-flight send or metadata read: a failed delivery
          // must not lose this one-shot chance to release.
          this.evictedProcessInstance = content.process_instance
          this.ctx.releaseTransportIfIdle()
        }
        return
      case 'process_restarted':
        // The CLI process was replaced while we were attached (MCP injection,
        // a crash, an interrupt-driven respawn): its tasks are gone.
        this.background.processRestarted(content.process_instance)
        return
      case 'capabilities':
        // The container's stream contract, before any SDK message.
        if (content.session_state_events === true) this.stateEventsAuthority = true
        // It names the process too: the path that catches a replacement we
        // never saw (a cold resume announces it before anyone subscribes).
        this.background.adoptProcessInstance(content.process_instance)
        return
      case 'session_state_changed':
        this.runtimeStateChanged(content.state)
        return
      case 'background_tasks_changed': {
        // The full live task list (SDK >= 0.3.203). A frame that fails
        // validation is ignored: a partial parse could clear running tasks.
        const levelSet = parseBackgroundTasksChanged(content)
        if (levelSet) this.subagents.markBackground(this.background.applyLevelSet(levelSet))
        return
      }
      case 'memory_recall':
        this.ctx.emit({ type: 'memory_recall', memoryPaths: content.memory_paths || [] })
        return
      case 'informational':
        this.informational(content)
        return
    }
  }

  /**
   * The runtime's own session state. `idle` is the SDK's "fully settled"
   * (after held-back results flush and the background loop exits), so it
   * stays away while queued messages or background work keep the session
   * running; once a session emits these, they decide idle, not results.
   */
  private runtimeStateChanged(state: unknown): void {
    this.stateEventsAuthority = true
    if (state === 'idle' || state === 'running') this.runtimeState = state
    if (state === 'idle') {
      this.settledResultGeneration = this.resultGeneration
      this.runtimeIdle()
      return
    }
    if (state !== 'running') return
    this.turnGeneration += 1
    // A turn runs again: the stopped turn's frames can't still be in the pipe.
    // (After a soft stop the process lives on, and its next turn is the
    // background-task wake, with no send to clear this.)
    this.isInterrupted = false
    this.waitingBackground = false
    // The wake a stopped task was waiting for: the runtime settles it now.
    this.cancelSettleAfterStop()
    if (this.isActive) return
    // A turn we didn't start (a queued message picked up after an
    // out-of-order idle): heal. The prior result guard stays: some runtimes
    // emit a stray running → idle pair with no new result, and clearing it
    // would leave the session active until disconnect.
    this.isActive = true
    this.response.newTurn()
    this.response.beginStreamedText()
    this.settleTurnBoundaryRequests('started')
    this.ctx.emit({ type: 'session_active', isActive: true })
    this.publish({ type: 'session_active', isActive: true })
    // As in markActive: only waits that survive a new turn.
    this.syncAwaiting()
  }

  private resultFrame(content: FrameContent): void {
    this.resultGeneration += 1
    // Classification catches both error shapes: the legacy error subtypes
    // and a success subtype with is_error (terminal_reason api_error, …).
    const classification = classifyResult(content)
    const isError = classification.isError
    // A resume or a graceful stop pauses inside the turn: it neither ends a
    // queued turn nor resets that turn's answer early.
    if (!classification.isInterrupt && content.subtype !== 'resume') this.response.turnCompleted()
    this.stream.isStreaming = false

    if (isError && inferOomSigkillFatal(content) && this.ctx.runtime.fatalResult(this.ctx.transport(), 'oom_sigkill') === 'defer_for_recovery') {
      this.ctx.runtime.unexpectedDeath()
      return
    }
    // Every terminal flag settles before the one emit, so no in-between state
    // (active, nothing streaming) reads as working and races a connector.
    // The awaiting cache clears only where the session is actually settling;
    // a clean success can leave it active (the runtime owns idle, or
    // background work remains), so re-derive it instead.
    const openBackgroundWork = this.background.openCount()
    if (isError || (classification.isInterrupt && openBackgroundWork === 0)) {
      this.isActive = false
      this.isAwaitingInput = false
    } else if (classification.isInterrupt) {
      // Stopped, but background work is open: a soft stop spares it, so the
      // session waits on it. The Stop route settles the session if the
      // process was in fact replaced.
      this.isAwaitingInput = false
    } else if (this.stateEventsAuthority || openBackgroundWork > 0) {
      this.syncAwaiting()
    } else {
      // finalizeIdle below settles the turn.
      this.isAwaitingInput = false
    }
    this.stream.messagePersisted()
    this.lastResultSubtype = typeof content.subtype === 'string' ? content.subtype : null

    // A clean success with zero turns: the main loop never ran, the mark of a
    // hook blocking the prompt. The informational banner is the user's
    // surface; this is the operator's breadcrumb.
    if (!isError && !classification.isInterrupt && content.num_turns === 0 && content.subtype === 'success') {
      console.warn(`[LiveSession] Session ${this.ctx.sessionId}: turn ended with no model turns (num_turns=0) — possible hook-blocked prompt`)
    }

    this.resultUsage(content)
    // A failure is terminal now; a clean success only once the session
    // settles (queued messages or background work can still fail it).
    this.lastResultCleanSuccess = !isError && !classification.isInterrupt && content.subtype !== 'resume'
    if (isError) this.persistAutomationStatus('failed')

    // A deliberately stopped turn arrives error-shaped but is no error:
    // settle quietly. The Stop route owns the idle frame, and a
    // container-internal restart resumes with a continuation turn.
    if (classification.isInterrupt) {
      this.ctx.emit({ type: 'turn_output_complete' })
      return
    }
    if (isError) {
      this.turnFailed(classification)
      // A fatal error (OOM, say) stops the container.
      if (content.fatal) {
        console.log(`[LiveSession] Fatal error for agent ${this.ctx.agentSlug}, requesting container stop`)
        this.ctx.runtime.stopAfterFatalError()
      }
      return
    }

    if (content.subtype !== 'resume') this.trackResponse('agent_response_completed')
    // The output is complete whether or not the session settles: the
    // renderer reconciles what streamed against the transcript (whose write
    // can lag), or a follow-up turn's stream_start could blink it out.
    this.ctx.emit({ type: 'turn_output_complete' })
    // A UI hint: background tasks outlive the turn's output.
    const stillOpen = this.background.openCount()
    if (stillOpen > 0) {
      this.waitingBackground = true
      this.ctx.emit({ type: 'session_waiting_background', backgroundTaskCount: stillOpen, backgroundTasks: this.background.list() })
    }
    // A runtime that publishes its state decides when the session settles.
    if (this.stateEventsAuthority) return
    // Legacy containers: the result settles the turn.
    if (this.background.openCount() > 0) return
    this.finalizeIdle()
    // Whether to SHOW an OS notification is the renderer's call (focus,
    // per-user viewing, notifyWhenUnfocused). A resume-exit pauses.
    if (content.subtype !== 'resume') this.notifyCompleted()
  }

  private trackResponse(event: string, properties: Record<string, unknown> = {}): void {
    this.ctx.host.send('analytics', {
      event,
      properties: {
        agentSlug: this.ctx.agentSlug,
        session_id: this.ctx.sessionId,
        credential_source: credentialSource(this.ctx.modelRuntime()?.provider),
        ...properties,
      },
    })
  }

  private turnFailed(classification: ReturnType<typeof classifyResult>): void {
    const errorMessage = classification.errorText || 'An error occurred during execution'
    const apiErrorCode = this.lastApiErrorCode || null
    const { terminalReason, apiErrorStatus } = classification
    // The provider owns the copy for its own upstream errors (severity, icon,
    // message, link), so the UI never re-derives provider-specific copy.
    const runtimeProvider = this.ctx.modelRuntime()?.provider
    const turnProvider = runtimeProvider ? getLlmProvider(runtimeProvider) : getActiveLlmProvider()
    turnProvider.noteTurnError(apiErrorStatus ?? undefined, errorMessage)
    const errorPresentation = turnProvider.presentationForTurnError(apiErrorStatus ?? undefined, errorMessage, apiErrorCode)
    console.error(
      `[LiveSession] Session ${this.ctx.sessionId} error:`,
      errorMessage,
      apiErrorCode ? `(${apiErrorCode})` : '',
      terminalReason ? `[${terminalReason}]` : '',
    )
    const error = { error: errorMessage, apiErrorCode, errorPresentation, terminalReason, apiErrorStatus, isActive: false }
    this.trackResponse('agent_response_failed', { terminal_reason: terminalReason, api_error_status: apiErrorStatus })
    const turnOutcome = this.response.recordOutcome('failed', errorMessage)
    this.ctx.emit({ type: 'session_error', ...error, turnOutcome })
    this.publish({ type: 'session_error', ...error })
  }

  /**
   * The context window comes with the result: the model catalog's when it
   * has one (non-Claude models: the SDK reports a generic 200K for them),
   * the SDK's otherwise. The latest call's usage (not the result's sum over
   * the turn) goes out with it and onto the session's metadata.
   */
  private resultUsage(content: { modelUsage?: unknown }): void {
    try {
      let contextWindow: number | undefined
      const modelUsage = content.modelUsage
      if (modelUsage && typeof modelUsage === 'object') {
        const [modelId] = Object.keys(modelUsage)
        const reported = (modelUsage as Record<string, { contextWindow?: number } | undefined>)[modelId]
        const catalogWindow = modelId
          ? this.ctx.modelRuntime()?.modelContextWindows[modelId] ??
            getModelContextWindow(modelId, getActiveLlmProvider().id)
          : undefined
        contextWindow = catalogWindow || reported?.contextWindow || undefined
      }
      const lastUsage: SessionUsage | null = this.stream.settleUsage(contextWindow)
      if (lastUsage) {
        background(updateSessionMetadata(this.ctx.store, this.ctx.sessionId, { lastUsage }).catch((error) => {
          console.error('[LiveSession] Failed to persist lastUsage:', error)
        }), { name: 'live-session.persist-last-usage' })
      }
    } catch (error) {
      console.error('[LiveSession] Error handling result usage:', error)
    }
  }

  /**
   * A workflow's task_progress carries a live snapshot of its agent tree:
   * forwarded to the drawer once its run id is known.
   */
  private workflowProgress(content: FrameContent): void {
    const progress = content.workflow_progress
    const toolUseId = content.tool_use_id
    if (!Array.isArray(progress) || typeof toolUseId !== 'string') return
    // Not until the tool result named the run; the next tick carries it.
    const runId = this.background.workflowRunIdFor(toolUseId)
    if (!runId) return
    const agents = progress
      .filter((e: { type?: string }) => e?.type === 'workflow_agent')
      .map((e: Record<string, unknown>) => ({
        agentId: e.agentId as string,
        label: typeof e.label === 'string' ? e.label : undefined,
        phase: typeof e.phaseTitle === 'string' ? e.phaseTitle : null,
        model: typeof e.model === 'string' ? e.model : undefined,
        prompt: typeof e.promptPreview === 'string' ? e.promptPreview : undefined,
        state: typeof e.state === 'string' ? e.state : 'progress',
        tokens: typeof e.tokens === 'number' ? e.tokens : 0,
        toolCalls: typeof e.toolCalls === 'number' ? e.toolCalls : 0,
        lastTool: (typeof e.lastToolSummary === 'string' && e.lastToolSummary) ||
          (typeof e.lastToolName === 'string' && e.lastToolName) ||
          null,
      }))
      .filter((agent: { agentId?: string }) => typeof agent.agentId === 'string')
    const usage = content.usage as { total_tokens?: number; tool_uses?: number; duration_ms?: number } | undefined
    this.ctx.emit({
      type: 'workflow_progress',
      runId,
      agents,
      usage: usage ? { totalTokens: usage.total_tokens ?? 0, toolUses: usage.tool_uses ?? 0, durationMs: usage.duration_ms ?? 0 } : undefined,
    })
  }

  /**
   * The SDK's informational banner: the loop's generic text channel. The
   * shape that MUST surface is a hook block (a workspace hook rejecting a
   * prompt): the model never sees it and the CLI writes nothing, so without
   * this the session goes idle silently. Warnings are written to the
   * transcript (reload-safe), then clients refetch.
   */
  private informational(content: { uuid?: unknown; content?: unknown; level?: unknown; prevent_continuation?: unknown }): void {
    const isBlocking = content.prevent_continuation === true
    const isWarning = content.level === 'warning' || content.level === 'error'
    // Info-level chatter stays on the stream.
    if (!isBlocking && !isWarning) return
    const text = typeof content.content === 'string' ? content.content : ''
    if (!text) return
    background(
      appendInformationalEntry(this.ctx.store, this.ctx.sessionId, {
        uuid: (typeof content.uuid === 'string' && content.uuid) || randomUUID(),
        content: text,
        level: typeof content.level === 'string' ? content.level : undefined,
      })
        .then(() => this.ctx.emit({ type: 'messages_updated' }))
        .catch((error) => console.error('[LiveSession] Failed to persist informational banner:', error)),
      { name: 'live-session.persist-informational-banner' },
    )
  }

  /**
   * The socket to the container closed. Mid-turn and not stopped, the
   * runtime may have died: recovery decides. Otherwise ask the container
   * whether the session still runs, and reattach or settle. Settling
   * detaches the dead socket after the idle release, so the next send
   * subscribes again.
   */
  private connectionClosed(): void {
    if (this.isActive && !this.isInterrupted) {
      // Detached first, so recovery sees the truth and resubscribes.
      this.ctx.detachTransport()
      this.ctx.runtime.unexpectedDeath(this.ctx.sessionId)
      return
    }
    const client = this.ctx.transport()
    if (!client) {
      this.markInactive()
      return
    }
    background(
      client
        .getSession(this.ctx.sessionId)
        .then((session) => {
          if (!this.ctx.isCurrent()) return
          if (!session) {
            console.log(`[LiveSession] Session ${this.ctx.sessionId} not found in container, marking inactive`)
            this.markInactive()
            this.ctx.detachTransport()
          } else if ((session as { isRunning?: boolean }).isRunning) {
            console.log(`[LiveSession] Session ${this.ctx.sessionId} still running, re-subscribing`)
            this.ctx.reattachTransport(client)
          } else {
            console.log(`[LiveSession] Session ${this.ctx.sessionId} not running in container, marking inactive`)
            this.markInactive()
            this.ctx.detachTransport()
          }
        })
        .catch((error) => {
          if (!this.ctx.isCurrent()) return
          console.error(`[LiveSession] Failed to check container for session ${this.ctx.sessionId}:`, error)
          this.markInactive()
          this.ctx.detachTransport()
        }),
      { name: 'live-session.check-closed-session' },
    )
  }

  // ===========================================================================
  // Side effects
  // ===========================================================================

  /** An event about this session for the global feed. */
  private publish({ type, ...fields }: { type: string; [key: string]: unknown }): void {
    this.ctx.host.send('global', { type, sessionId: this.ctx.sessionId, agentSlug: this.ctx.agentSlug, ...fields })
  }

  /**
   * The turn finished. The transcript's end is read now, as the turn ends,
   * and sent once known, so the notification's context lookup stops where
   * this turn did; a read that takes too long is not waited for.
   */
  private notifyCompleted(): void {
    const { agentSlug, sessionId, store } = this.ctx
    const responseText = this.response.answer
    let timer: ReturnType<typeof setTimeout> | undefined
    const tooSlow = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), TRANSCRIPT_END_WAIT_MS)
    })
    const transcriptEnd = store.files
      .stat(transcriptPath(store, sessionId))
      .then((stat) => stat?.size ?? null)
      .catch(() => null)
    // Read at the turn's end, announced in turn order: a later turn whose
    // read finishes first waits for this one.
    this.ctx.completions().after(Promise.race([transcriptEnd, tooSlow]).finally(() => clearTimeout(timer)), (responseTranscriptEndOffset) => {
      this.ctx.host.send('notification', { kind: 'session_complete', agentSlug, sessionId, responseText, responseTranscriptEndOffset })
    })
  }

  /**
   * A cron/webhook session's outcome, on its metadata. Interactive sessions
   * pay the metadata read once: 'not-automation' is remembered.
   */
  private persistAutomationStatus(status: 'succeeded' | 'failed'): void {
    if (this.notAutomation) return
    background(
      finalizeAutomationStatus(this.ctx.store, this.ctx.sessionId, status)
        .then((result) => {
          if (result === 'not-automation') this.notAutomation = true
        })
        .catch((error) => console.error('[LiveSession] Failed to persist automation status:', error)),
      { name: 'live-session.persist-automation-status' },
    )
  }

  /** Refresh the session's summary entry from its transcript's real mtime (a missed turn end). */
  private refreshActivityFromTranscript(): void {
    const { store, sessionId } = this.ctx
    background(
      store.files
        .stat(transcriptPath(store, sessionId))
        .then((stat) => {
          if (stat) recordSessionActivity(store, sessionId, stat.mtimeMs)
        })
        .catch(() => {
          // Missing or unreadable: the TTL reconciliation repairs it.
        }),
      { name: 'live-session.refresh-activity-from-transcript' },
    )
  }

  /** The automation stream policy, from the session's metadata. */
  applyStreamPolicy(policy: { releaseStreamWhenIdle: boolean; retainStateOnStreamRelease: boolean }): void {
    // A promotion wins: it is set synchronously, and this read may be stale.
    if (this.promotedToInteractive) return
    this.releaseStreamWhenIdle = policy.releaseStreamWhenIdle
    this.retainStateOnStreamRelease = policy.retainStateOnStreamRelease
  }

  /** Promoted to interactive: the stream stays across settles, like any interactive session's. */
  promoted(): void {
    this.promotedToInteractive = true
    this.releaseStreamWhenIdle = false
  }
}
