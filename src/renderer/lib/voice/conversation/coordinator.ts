import type { VoiceAgentCommand, VoiceAgentEvent, VoiceAgentSnapshot, VoiceAgentState, VoiceCommandResult, VoiceTurnPolicy } from '../contracts/conversation'

export const VOICE_TURN_START_TIMEOUT_MS = 15_000
export const VOICE_INTERRUPT_TIMEOUT_MS = 10_000
/** Strict ordering: a request never passes an unconfirmed interrupt. */
export const DEFAULT_TURN_POLICY: VoiceTurnPolicy = {
  interruptTimeoutMs: VOICE_INTERRUPT_TIMEOUT_MS,
  turnStartTimeoutMs: VOICE_TURN_START_TIMEOUT_MS,
  sendAfterFailedInterrupt: false,
}

interface CoordinatorDependencies {
  snapshot(): VoiceAgentSnapshot
  send(text: string): Promise<boolean>
  interrupt(signal?: AbortSignal): Promise<void>
  onEvent(event: VoiceAgentEvent): void
  onState(state: VoiceAgentState): void
  onIssue(message: string | null): void
}

/** One owner for ordering agent commands, acknowledging turns, and filtering stale replies. */
export class VoiceAgentCoordinator {
  private closed = false
  private paused = false
  private cancelled = false
  private cancelledStart: number | null = null
  private followingTurn = false
  private awaiting = false
  private pendingAccepted = false
  private lastError: string | null = null
  private warning = false
  private toolsUsed = false
  private sawIdle = false
  private previousStart: number | null
  private staleText: string | null
  private fedText = ''
  private fedComplete = false
  private segment = 0
  private commands = 0
  private queue: Promise<VoiceCommandResult> | null = null
  private cancellationError: string | null = null
  private interruptAbort: AbortController | null = null
  private waitTimer: ReturnType<typeof setTimeout> | undefined
  private latest: VoiceAgentSnapshot
  private readonly policy: VoiceTurnPolicy
  // The agent had the floor when a request card went up. Back from the card
  // with the turn not yet resumed, it keeps the floor for a bounded, silent wait.
  private floorAtPause = false
  private resumeWait = false

  constructor(private dependencies: CoordinatorDependencies, policy: Partial<VoiceTurnPolicy> = {}) {
    this.policy = { ...DEFAULT_TURN_POLICY, ...policy }
    this.latest = dependencies.snapshot()
    this.followingTurn = this.latest.active
    this.previousStart = this.latest.startedAt
    this.staleText = this.latest.text
    this.sawIdle = !this.latest.active
  }

  start(expectTurn: boolean) {
    this.followingTurn ||= expectTurn
    this.awaiting = expectTurn && !this.latest.active
    this.update(this.latest)
    this.armWait()
  }

  command(command: VoiceAgentCommand): Promise<VoiceCommandResult> {
    if (this.closed || this.paused) return Promise.resolve({ accepted: false })
    this.commands++
    // Queued words join the running turn: no interrupt, no reply reset, and no
    // new acknowledgment wait. A cancelled or unconfirmed turn takes the strict path.
    const steer = command.type === 'submit' && command.queue === true && !this.cancelled && !this.cancellationError
      && (this.dependencies.snapshot().active || this.pendingAccepted)
    if (!steer) {
      this.warning = false
      this.dependencies.onIssue(null)
      this.dependencies.onEvent({ type: 'reset' })
      this.fedText = ''
      this.fedComplete = false
      this.segment++
      this.staleText = this.dependencies.snapshot().text
      this.clearWait()
      this.resumeWait = false
      this.awaiting = command.type === 'submit'
      if (command.type === 'submit') this.followingTurn = true
      if (command.type === 'cancel') this.cancelled = true
      this.publishState()
    }
    // Run the first operation immediately. Later commands wait for its result,
    // including a cancellation requested while a submission is in flight.
    const queued = this.queue
    if (!queued) this.cancellationError = null
    const run = () => steer ? this.steer(command.text) : this.execute(command)
    const pending = queued ? queued.then(run) : run()
    this.queue = pending
    void pending.then(() => { if (this.queue === pending) this.queue = null })
    return pending
  }

  private async steer(text: string): Promise<VoiceCommandResult> {
    try {
      if (this.closed || this.paused) return { accepted: false }
      if (!await this.dependencies.send(text)) throw new Error('Could not send that. Please say it again.')
      return { accepted: true }
    } catch (reason) {
      if (this.closed) return { accepted: false }
      const message = reason instanceof Error ? reason.message : 'Could not send the voice request.'
      this.dependencies.onIssue(message)
      return { accepted: false, error: message }
    } finally {
      this.settle()
    }
  }

  private async execute(command: VoiceAgentCommand): Promise<VoiceCommandResult> {
    try {
      if (this.closed || this.paused) {
        this.awaiting = this.pendingAccepted
        if (command.type === 'cancel') this.cancelled = false
        return { accepted: false }
      }
      if (command.type === 'cancel') {
        this.awaiting = false
        if (this.dependencies.snapshot().active || this.pendingAccepted) await this.interruptWork()
        this.cancelledStart = this.dependencies.snapshot().startedAt
        return { accepted: true }
      }
      // An already-queued replacement must not pass a failed cancellation,
      // unless the engine keeps chained speech's send-anyway contract.
      if (this.cancellationError) {
        if (!this.policy.sendAfterFailedInterrupt) throw new Error(this.cancellationError)
        this.cancellationError = null
      }
      this.awaiting = true
      const before = this.dependencies.snapshot()
      this.previousStart = before.startedAt
      this.sawIdle = !before.active
      const alreadyCancelled = this.cancelled && before.startedAt === this.cancelledStart
      if ((before.active || this.pendingAccepted) && !alreadyCancelled) {
        try {
          await this.interruptWork()
        } catch (error) {
          // A bounded wait, then the words go out: losing them is worse than
          // the server discarding a message queued into a turn it is ending.
          if (!this.policy.sendAfterFailedInterrupt) throw error
          this.cancellationError = null
        }
      }
      if (this.closed || this.paused) {
        this.awaiting = this.pendingAccepted
        return { accepted: false }
      }
      this.staleText = this.dependencies.snapshot().text
      this.cancelled = false
      this.pendingAccepted = false
      this.toolsUsed = false
      const accepted = await this.dependencies.send(command.text)
      if (this.closed) return { accepted: false }
      if (!accepted) throw new Error('Could not send that. Please say it again.')
      this.pendingAccepted = true
      return { accepted: true }
    } catch (reason) {
      if (this.closed) return { accepted: false }
      const message = reason instanceof Error ? reason.message : 'Could not send the voice request.'
      // Chained speech: the reader already stopped and the next utterance
      // retries the interrupt, so a failed cancel is not the person's problem.
      const quietCancel = command.type === 'cancel' && this.policy.sendAfterFailedInterrupt
      if (command.type === 'cancel') {
        this.cancellationError = message
        if (!quietCancel) this.cancelled = false
      }
      this.awaiting = false
      if (!this.closed && !quietCancel) this.dependencies.onIssue(message)
      return { accepted: false, error: message }
    } finally {
      this.settle()
    }
  }

  private settle() {
    this.commands--
    if (!this.closed && this.commands === 0) {
      this.update(this.dependencies.snapshot())
      this.armWait()
    }
  }

  private async interruptWork() {
    const controller = new AbortController()
    this.interruptAbort = controller
    const timeout = setTimeout(() => controller.abort(), this.policy.interruptTimeoutMs)
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('Could not confirm the agent stopped. Please try again.')), { once: true })
    })
    try {
      await Promise.race([this.dependencies.interrupt(controller.signal), aborted])
      this.cancellationError = null
      this.pendingAccepted = false
      this.cancelled = true
      this.cancelledStart = this.dependencies.snapshot().startedAt
    } catch (error) {
      this.cancellationError = error instanceof Error ? error.message : 'Could not stop the agent.'
      // Strict engines re-expose the still-running turn; chained speech keeps
      // suppressing it, as the person asked, and retries on the next utterance.
      if (!this.policy.sendAfterFailedInterrupt) this.cancelled = false
      throw error
    } finally {
      clearTimeout(timeout)
      if (this.interruptAbort === controller) this.interruptAbort = null
    }
  }

  update(snapshot: VoiceAgentSnapshot) {
    if (this.closed) return
    this.latest = snapshot
    if (!snapshot.active) this.sawIdle = true
    if (this.commands > 0) return
    // Pausing speech does not pause backend execution or acknowledgment.
    this.acknowledge(snapshot)
    if (this.paused) { this.publishState(); return }
    const newTurn = snapshot.startedAt !== null && snapshot.startedAt !== this.previousStart
    if (newTurn) {
      this.previousStart = snapshot.startedAt
      this.toolsUsed = false
      if (this.fedText) {
        this.staleText = this.fedText
        this.fedText = ''
        this.fedComplete = false
        this.segment++
      }
    }
    if (snapshot.error) {
      this.clearWait()
      this.awaiting = false
      this.dependencies.onIssue(snapshot.error)
      if (snapshot.error !== this.lastError) this.dependencies.onEvent({ type: 'error', message: snapshot.error })
      this.lastError = snapshot.error
      this.publishState()
      return
    }
    this.lastError = null
    if (this.cancelled) { this.publishState(); return }
    if (snapshot.active) this.followingTurn = true
    if (!this.followingTurn) {
      // Persisted history can arrive after entering an idle conversation.
      // It is context, not newly generated speech.
      this.staleText = snapshot.text
      this.publishState()
      return
    }
    const freshText = !!snapshot.text && snapshot.text !== this.staleText
    if (snapshot.active && snapshot.toolsRunning) this.toolsUsed = true
    // Publish the final text before the idle state: adapters may finish their
    // playback stream as soon as they observe an idle agent.
    if (!this.awaiting) {
      if (snapshot.text !== this.staleText) {
        this.staleText = null
        const complete = !snapshot.active
        if (snapshot.text !== this.fedText || complete !== this.fedComplete) {
          if (this.fedText && !snapshot.text.startsWith(this.fedText)) this.segment++
          this.fedText = snapshot.text
          this.fedComplete = complete
          this.dependencies.onEvent({ type: 'reply', segment: this.segment, text: snapshot.text, complete })
        }
      }
    }
    this.publishState()
    // Only clear the recoverable handoff warning; execution errors belong to
    // their command and are cleared by the next command, not arbitrary tokens.
    if (snapshot.active || freshText) this.clearWarning()
  }

  private acknowledge(snapshot: VoiceAgentSnapshot) {
    if (this.cancelled) return
    const freshText = !!snapshot.text && snapshot.text !== this.staleText
    if (snapshot.active || freshText) this.clearWarning()
    if (!this.awaiting) return
    const newTurn = snapshot.startedAt !== null && snapshot.startedAt !== this.previousStart
    if (snapshot.error || freshText || (snapshot.active && (this.sawIdle || newTurn))) {
      this.awaiting = false
      this.pendingAccepted = false
      this.resumeWait = false
      this.clearWait()
    }
  }

  private clearWarning() {
    if (!this.warning) return
    this.warning = false
    this.dependencies.onIssue(null)
  }

  private publishState() {
    const next = { active: !this.cancelled && this.latest.active, awaiting: this.awaiting, toolsUsed: this.toolsUsed }
    this.dependencies.onState(next)
    this.dependencies.onEvent({ type: 'state', state: next })
  }

  setPaused(paused: boolean) {
    if (this.closed || this.paused === paused) return
    this.paused = paused
    this.clearWait()
    if (paused) {
      const now = this.dependencies.snapshot()
      this.floorAtPause = !this.cancelled && (now.active || this.awaiting)
      return
    }
    const snapshot = this.dependencies.snapshot()
    // Observe acknowledgment before marking paused output as already seen.
    this.acknowledge(snapshot)
    // A card answered mid-turn: the turn resumes shortly. Between steps the
    // stream can read idle with nothing new said, so keep the agent's floor
    // for a bounded, silent wait rather than handing it to the person at once.
    // A reply that arrived during the pause means the turn is over.
    const replyArrived = !!snapshot.text && snapshot.text !== this.staleText && snapshot.text !== this.fedText
    if (this.floorAtPause && !snapshot.active && !this.awaiting && !replyArrived && !snapshot.error) {
      this.awaiting = true
      this.resumeWait = true
      this.sawIdle = true
      this.previousStart = snapshot.startedAt
    }
    this.floorAtPause = false
    this.staleText = snapshot.text
    this.fedText = ''
    this.fedComplete = false
    this.segment++
    this.update(snapshot)
    this.armWait()
  }

  private armWait() {
    this.clearWait()
    if (!this.awaiting || this.paused || this.closed) return
    this.waitTimer = setTimeout(() => {
      if (this.closed) return
      this.awaiting = false
      // Waiting on a turn to resume after a card is not a sent request: give
      // the floor back without a warning.
      const silent = this.resumeWait
      this.resumeWait = false
      this.latest = this.dependencies.snapshot()
      if (!this.latest.active && !silent) {
        this.warning = true
        this.dependencies.onIssue('Your request was sent, but no agent activity has arrived yet.')
      }
      this.publishState()
    }, this.policy.turnStartTimeoutMs)
  }

  private clearWait() { clearTimeout(this.waitTimer) }

  close() {
    this.closed = true
    this.interruptAbort?.abort()
    this.clearWait()
  }
}
