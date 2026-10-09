import { randomUUID } from 'node:crypto'
import { executionEnded, type SessionExecution } from './session-execution-schema'

/**
 * Retains the host's execution verdict across renderer reconnects. Only the
 * lifecycle owner may finish work; a text boundary or empty task list cannot.
 * Kept with StreamingState, including when its container transport reattaches.
 */
export class SessionExecutionTracker {
  private value: SessionExecution = {
    epoch: randomUUID(), revision: 0, turnId: null, phase: 'idle',
    backgroundTaskCount: 0, responseText: '', error: null,
  }

  get snapshot(): SessionExecution { return this.value }

  /** A rejected send restores the prior work without rolling back wire ordering. */
  restore(snapshot: SessionExecution) { this.patch(snapshot) }

  private patch(patch: Partial<SessionExecution>) {
    if (Object.entries(patch).every(([key, value]) => this.value[key as keyof SessionExecution] === value)) return
    this.value = { ...this.value, ...patch, revision: this.value.revision + 1 }
  }

  start() {
    const fresh = this.value.phase === 'idle' || executionEnded(this.value)
    this.patch({ phase: 'running', error: null, ...(fresh && { turnId: randomUUID(), responseText: '' }) })
  }

  outputStart() { this.start(); this.patch({ responseText: '' }) }
  output(text: string) { this.start(); this.patch({ responseText: this.value.responseText + text }) }
  outputComplete() {
    if (this.value.phase === 'running') this.patch({ phase: 'finishing' })
  }
  waitForBackground() {
    if (!executionEnded(this.value)) this.patch({ phase: 'waiting_background' })
  }
  backgroundTasks(count: number) { this.patch({ backgroundTaskCount: count }) }

  finish(outcome: 'completed' | 'cancelled' | 'failed', responseText?: string, error: string | null = null) {
    // Duplicate terminal frames and heartbeat reads retain the same receipt.
    // Idle after an error/cancel must never rewrite it into a successful turn.
    if (executionEnded(this.value) && (this.value.phase !== 'completed' || outcome === 'completed')) return
    this.patch({
      turnId: this.value.turnId ?? randomUUID(), phase: outcome,
      responseText: responseText ?? this.value.responseText, error,
    })
  }

  idle() {
    if (!executionEnded(this.value)) this.patch({ phase: 'idle' })
  }
}
