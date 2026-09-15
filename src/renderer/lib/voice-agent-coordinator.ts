import type { VoiceAgentCommand, VoiceAgentEvent, VoiceAgentSnapshot, VoiceAgentState, VoiceCommandResult } from './voice-conversation'

export const VOICE_TURN_START_TIMEOUT_MS = 15_000
export const VOICE_INTERRUPT_TIMEOUT_MS = 10_000

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

  constructor(private dependencies: CoordinatorDependencies) {
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
    this.warning = false
    this.dependencies.onIssue(null)
    this.dependencies.onEvent({ type: 'reset' })
    this.fedText = ''
    this.fedComplete = false
    this.segment++
    this.staleText = this.dependencies.snapshot().text
    this.clearWait()
    this.awaiting = command.type === 'submit'
    if (command.type === 'submit') this.followingTurn = true
    if (command.type === 'cancel') this.cancelled = true
    this.publishState()
    // Run the first operation immediately. Later commands wait for its result,
    // including a cancellation requested while a submission is in flight.
    const queued = this.queue
    if (!queued) this.cancellationError = null
    const pending = queued
      ? queued.then(() => this.execute(command))
      : this.execute(command)
    this.queue = pending
    void pending.then(() => { if (this.queue === pending) this.queue = null })
    return pending
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
      // An already-queued replacement must not pass a failed cancellation.
      if (this.cancellationError) {
        const message = this.cancellationError
        throw new Error(message)
      }
      this.awaiting = true
      const before = this.dependencies.snapshot()
      this.previousStart = before.startedAt
      this.sawIdle = !before.active
      const alreadyCancelled = this.cancelled && before.startedAt === this.cancelledStart
      if ((before.active || this.pendingAccepted) && !alreadyCancelled) await this.interruptWork()
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
      if (command.type === 'cancel') {
        this.cancellationError = message
        this.cancelled = false
      }
      this.awaiting = false
      if (!this.closed) this.dependencies.onIssue(message)
      return { accepted: false, error: message }
    } finally {
      this.commands--
      if (!this.closed && this.commands === 0) {
        this.update(this.dependencies.snapshot())
        this.armWait()
      }
    }
  }

  private async interruptWork() {
    const controller = new AbortController()
    this.interruptAbort = controller
    const timeout = setTimeout(() => controller.abort(), VOICE_INTERRUPT_TIMEOUT_MS)
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
      this.cancelled = false
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
    if (paused) return
    const snapshot = this.dependencies.snapshot()
    // Observe acknowledgment before marking paused output as already seen.
    this.acknowledge(snapshot)
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
      this.latest = this.dependencies.snapshot()
      if (!this.latest.active) {
        this.warning = true
        this.dependencies.onIssue('Your request was sent, but no agent activity has arrived yet.')
      }
      this.publishState()
    }, VOICE_TURN_START_TIMEOUT_MS)
  }

  private clearWait() { clearTimeout(this.waitTimer) }

  close() {
    this.closed = true
    this.interruptAbort?.abort()
    this.clearWait()
  }
}
