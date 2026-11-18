import { WorkflowJournalTailer } from '@shared/lib/container/workflow-journal-tailer'
import { sessionFilePath, type SessionStore } from '../session-store'
import type { SessionEvent } from './session-channel'

/**
 * A session's running dynamic workflows, each followed through its journal
 * (the workflow's agents emit nothing on the SDK stream): the drawer and the
 * working indicator update live off what the tailers emit.
 */
export class WorkflowTailers {
  private readonly tailers = new Map<string, WorkflowJournalTailer>()

  constructor(
    private readonly store: SessionStore,
    private readonly sessionId: string,
    private readonly emit: (event: SessionEvent) => void,
  ) {}

  /** Start following a run's journal (once per run). */
  start(runId: string): void {
    if (this.tailers.has(runId)) return
    const tailer = new WorkflowJournalTailer({
      files: this.store.files,
      journalPath: sessionFilePath(this.store, this.sessionId, 'subagents', 'workflows', runId, 'journal.jsonl'),
      runId,
      emit: (update) => this.emit(update as unknown as SessionEvent),
    })
    this.tailers.set(runId, tailer)
    tailer.start()
  }

  stop(runId: string): void {
    this.tailers.get(runId)?.stop()
    this.tailers.delete(runId)
  }

  stopAll(): void {
    for (const tailer of this.tailers.values()) tailer.stop()
    this.tailers.clear()
  }
}
