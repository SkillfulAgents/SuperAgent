import * as path from 'path'
import { promises as fs } from 'fs'
import { JournalLineSchema, displayAgentResult } from '../workflows/workflow-schemas'

/**
 * The SSE event a tailer emits when a workflow agent transitions. The renderer
 * patches its per-run agent-status map by `agentId`.
 */
export interface WorkflowAgentUpdate {
  type: 'workflow_agent_updated'
  runId: string
  agentId: string
  status: 'running' | 'done'
  result: string | null
}

/**
 * A dynamic workflow's internal agents emit nothing on the SDK wire — their
 * lifecycle is written only to `journal.jsonl` on disk. This host-side tailer
 * cheaply polls that one local file while the workflow runs and pushes a
 * `workflow_agent_updated` SSE per new `started`/`result` line, so the drawer +
 * working indicator update live without the renderer polling an HTTP route.
 *
 * Re-reads the whole (tiny) journal each poll and dedupes by `(type, agentId)`,
 * which sidesteps partial-trailing-line issues from a concurrently-appended file.
 */
export class WorkflowJournalTailer {
  private timer: ReturnType<typeof setInterval> | null = null
  private polling = false
  private readonly seen = new Set<string>()
  private readonly journalPath: string

  constructor(
    private readonly opts: {
      sessionsDir: string
      sessionId: string
      runId: string
      emit: (update: WorkflowAgentUpdate) => void
      intervalMs?: number
    }
  ) {
    this.journalPath = path.join(
      opts.sessionsDir,
      opts.sessionId,
      'subagents',
      'workflows',
      opts.runId,
      'journal.jsonl'
    )
  }

  start(): void {
    if (this.timer) return
    void this.pollOnce()
    this.timer = setInterval(() => void this.pollOnce(), this.opts.intervalMs ?? 1000)
    // Don't let the poll interval keep the process alive on shutdown.
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    // Final flush: the workflow's completion event (which triggers stop) can beat the
    // last journal `result` line through our 1s poll, so drain once more — otherwise the
    // last agent(s) stay stuck "running" in the UI.
    void this.pollOnce()
  }

  /** One read+emit pass. Public so tests can drive it without timers. */
  async pollOnce(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      let raw: string
      try {
        raw = await fs.readFile(this.journalPath, 'utf8')
      } catch {
        return // journal not written yet (agent just launched) — try again next tick
      }
      if (typeof raw !== 'string') return
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let json: unknown
        try {
          json = JSON.parse(trimmed)
        } catch {
          continue // half-written trailing line — it'll be whole next tick
        }
        const parsed = JournalLineSchema.safeParse(json)
        if (!parsed.success) continue
        const entry = parsed.data
        const key = `${entry.type}:${entry.agentId}`
        if (this.seen.has(key)) continue
        this.seen.add(key)
        this.opts.emit({
          type: 'workflow_agent_updated',
          runId: this.opts.runId,
          agentId: entry.agentId,
          status: entry.type === 'result' ? 'done' : 'running',
          result: entry.type === 'result' ? displayAgentResult(entry.result) : null,
        })
      }
    } catch {
      // A tailer must never throw into its `void pollOnce()` caller (the persister).
    } finally {
      this.polling = false
    }
  }
}
