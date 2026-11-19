/**
 * The background work a session's CLI process has open: backgrounded Bash
 * commands, background subagents and dynamic workflows. It outlives the turn
 * that started it, keeps the session active (the runtime wakes the agent when
 * a task settles), and is what the activity tray's rows and the Stop dialog
 * list.
 *
 * Two sources describe it, and either may lead the other:
 *
 * - per-task signals: `task_started`, a launching tool's result, and the
 *   terminal `task_notification` / `task_updated` frames;
 * - the SDK's level set (`background_tasks_changed`, SDK >= 0.3.203): the full
 *   list of live task ids, re-sent on every membership change.
 *
 * Liveness is the UNION of the two, so neither a missed registration nor a
 * missed terminal signal decides it alone; and each side retires what the
 * other has finished, so the union cannot pin the session forever.
 */
import type { BackgroundTasksSnapshot } from '@shared/lib/container/background-tasks-changed'
import type { SessionEvent } from './session-channel'

export interface BackgroundTaskInfo {
  startedAt: number
  isWorkflow?: boolean
  isSubagent?: boolean
  /** The SDK's task_type from its level set (local_bash, local_agent, local_workflow, …). */
  taskType?: string
  /** The SDK's description from its level set: the label when the transcript has none. */
  description?: string
  /** A subagent task's type from the level set (SDK >= 0.3.293). */
  subagentType?: string
  /**
   * The SDK's `ambient` flag (>= 0.3.284): a housekeeping task or live-update
   * watcher. Live work for settling, but never a row: the SDK says hosts
   * exclude these from activity.
   */
  ambient?: boolean
  /** The launching tool call. */
  toolUseId?: string
  workflowName?: string
  /** A workflow's on-disk run id (`wf_…`), learned from its tool result; distinct from the task id. */
  runId?: string
}

/** A live background task as clients see it (session frames and the snapshot). */
export interface ActiveBackgroundTaskSnapshot {
  taskId: string
  startedAt: number
  isWorkflow?: boolean
  isSubagent?: boolean
  taskType?: string
  description?: string
  subagentType?: string
}

/** Where the tracker reports what clients and the session must hear. */
export interface BackgroundTaskSink {
  /** A frame for the session's own stream. */
  emit(event: SessionEvent): void
  /** A frame for the global feed. */
  publish(event: { type: string; [key: string]: unknown }): void
  /** A workflow's run id is known: its journal can be followed. */
  workflowStarted(runId: string): void
  /** A workflow ended: stop following its journal. */
  workflowEnded(runId: string): void
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'killed', 'stopped'])

export function isTerminalTaskStatus(status: unknown): status is string {
  return typeof status === 'string' && TERMINAL_STATUSES.has(status)
}

function snapshotOf(taskId: string, info: BackgroundTaskInfo): ActiveBackgroundTaskSnapshot {
  return {
    taskId,
    startedAt: info.startedAt,
    isWorkflow: info.isWorkflow,
    isSubagent: info.isSubagent,
    taskType: info.taskType,
    description: info.description,
    subagentType: info.subagentType,
  }
}

export class BackgroundTasks {
  private readonly tasks = new Map<string, BackgroundTaskInfo>()
  /**
   * The latest level set: every live task id. Null until the first one
   * arrives (older runtimes never send it; liveness then rests on the map
   * alone). It may briefly name a task the map has not registered yet (the
   * level set leads task_started), and its removal led the terminal signals
   * up to CLI 2.1.284 and trails them since 2.1.296.
   */
  private levelSet: Set<string> | null = null
  /**
   * The CLI process the tasks belong to, from the container's handshake.
   * Background tasks are process-local: when it changes, every id held here
   * can never be retired, so they are dropped.
   */
  private processInstance: string | null = null

  constructor(
    private readonly session: { agentSlug: string; sessionId: string },
    private readonly sink: BackgroundTaskSink,
  ) {}

  get processInstanceId(): string | null {
    return this.processInstance
  }

  get(taskId: string): BackgroundTaskInfo | undefined {
    return this.tasks.get(taskId)
  }

  /**
   * The whole list as clients see it, sent with every frame that changes it:
   * clients replace their copy rather than apply the change, so one they
   * missed cannot leave a stale row. Ambient tasks are live work, not
   * activity, so they never appear.
   */
  list(): ActiveBackgroundTaskSnapshot[] {
    return [...this.tasks].filter(([, info]) => !info.ambient).map(([taskId, info]) => snapshotOf(taskId, info))
  }

  /** How many tasks keep the session from settling: the union of the map and the level set. */
  openCount(): number {
    if (!this.levelSet) return this.tasks.size
    const union = new Set(this.tasks.keys())
    for (const id of this.levelSet) union.add(id)
    return union.size
  }

  /**
   * Register a live task, or merge what a later signal knows into the entry an
   * earlier one created: the level set and the per-task launch signals each
   * know part of a task, and either may arrive first. Clients hear of it when
   * it is new, or when something they render changed.
   */
  upsert(taskId: string, patch: Omit<BackgroundTaskInfo, 'startedAt'>): void {
    const existing = this.tasks.get(taskId)
    const next: BackgroundTaskInfo = { ...existing, startedAt: existing?.startedAt ?? Date.now() }
    for (const [key, value] of Object.entries(patch) as Array<[keyof typeof patch, unknown]>) {
      if (value !== undefined) (next as unknown as Record<string, unknown>)[key] = value
    }
    this.tasks.set(taskId, next)

    // An ambient task is live work (it counts toward settling) but not a row:
    // one turning ambient leaves the client list, one turning back joins it.
    const wasShown = !!existing && !existing.ambient
    const isShown = !next.ambient
    if (!wasShown && !isShown) return
    if (wasShown && !isShown) {
      this.emitEnded(taskId)
      return
    }
    const snapshot = snapshotOf(taskId, next)
    if (wasShown) {
      const before = snapshotOf(taskId, existing)
      const changed = (Object.keys(snapshot) as Array<keyof ActiveBackgroundTaskSnapshot>).some(
        (key) => snapshot[key] !== before[key],
      )
      if (changed) this.sink.emit({ type: 'background_task_updated', ...snapshot, backgroundTasks: this.list() })
      return
    }
    this.sink.emit({ type: 'background_task_started', ...snapshot, backgroundTasks: this.list() })
    this.sink.publish({ type: 'background_task_started', sessionId: this.session.sessionId, agentSlug: this.session.agentSlug, taskId })
  }

  /**
   * A per-task terminal signal, weighed against the level set. A `completed`
   * for a task the level set still lists waits for the level set: up to CLI
   * 2.1.284 a subagent reported `completed` when its own turn ended but stayed
   * a live task while work it started (a dev server, say) kept running, and
   * retiring it here hid it while the union still counted it. Since 2.1.296
   * the level set drops a finished task right after this signal, so a listed
   * task is normally retired by the very next frame. The other terminal
   * statuses end the task outright.
   */
  retire(taskId: string, status: string): void {
    if (status === 'completed' && this.levelSet?.has(taskId)) {
      console.log(`[LiveSession] ${taskId} reported completed while the SDK still lists it — retiring it with the snapshot`)
      return
    }
    this.clear(taskId)
  }

  /**
   * A task finished: drop it from both sides (the freshest information must
   * win, or a removal frame that never comes pins the session), and tell
   * clients. Returns whether the map held it.
   */
  clear(taskId: string): boolean {
    this.levelSet?.delete(taskId)
    const info = this.tasks.get(taskId)
    if (!info) return false
    this.tasks.delete(taskId)
    // An ambient task was never shown, so its end is not news to clients.
    if (!info.ambient) this.emitEnded(taskId)
    if (info.isWorkflow && info.runId) {
      this.sink.emit({ type: 'workflow_completed', runId: info.runId })
      this.sink.workflowEnded(info.runId)
    }
    return true
  }

  /**
   * A new level set. A task the map holds that it no longer lists has
   * finished (its own terminal signal normally follows and finds nothing to
   * do; if that signal is missed, this is what retires it). Every task it
   * lists is a task the user can see and stop, whether or not a launch signal
   * of ours registered it (a subagent's own background command, say), so each
   * gets a row, labelled by the SDK's type and description.
   *
   * Returns the ids it names as subagents, for the caller to mark them background.
   */
  applyLevelSet(levelSet: BackgroundTasksSnapshot): string[] {
    this.levelSet = levelSet.taskIds
    for (const taskId of [...this.tasks.keys()]) {
      if (!levelSet.taskIds.has(taskId)) {
        console.log(`[LiveSession] background_tasks_changed: clearing ${taskId} (no longer in SDK snapshot)`)
        this.clear(taskId)
      }
    }
    const subagentIds: string[] = []
    for (const task of levelSet.tasks) {
      this.upsert(task.task_id, {
        taskType: task.task_type,
        description: task.description,
        subagentType: task.subagent_type,
        isSubagent: task.task_type === 'local_agent' ? true : undefined,
        isWorkflow: task.task_type === 'local_workflow' ? true : undefined,
        // Always set: the level set is the authority on the flag, and a flip
        // back to activity may arrive as an absent field.
        ambient: task.ambient === true,
      })
      if (task.task_type === 'local_agent') subagentIds.push(task.task_id)
    }
    return subagentIds
  }

  /**
   * The container said the CLI process was replaced (`process_restarted`):
   * reset, whether or not we had recorded the outgoing process.
   */
  processRestarted(instance: unknown): void {
    this.dropProcessLocal()
    if (typeof instance === 'string' && instance !== '') this.processInstance = instance
  }

  /**
   * The handshake names the process we are attached to. A first sighting is
   * not a restart, only the first time we were told; reset only when the name
   * changes. A plain reattach re-announces the SAME process with its tasks
   * still running, and resetting then would drop a live indicator. A
   * container too old to send the field is a no-op.
   */
  adoptProcessInstance(instance: unknown): void {
    if (typeof instance !== 'string' || instance === '') return
    if (this.processInstance === instance) return
    const isReplacement = this.processInstance !== null
    this.processInstance = instance
    if (isReplacement) this.dropProcessLocal()
  }

  /**
   * The runtime is gone (or replaced without telling us), and its tasks with
   * it: forget them without telling clients, who reset their list from the
   * frame that ends the session.
   */
  forgetAll(): void {
    this.tasks.clear()
    this.levelSet = null
  }

  /**
   * A workflow's tool result names its real run id (`wf_…`): the on-disk
   * `subagents/workflows/<runId>` directory, distinct from the task id, and
   * the only key the tree route and the journal tailer can use. Matched to its
   * task by the launching tool call.
   */
  wireWorkflowFromToolResult(content: unknown): void {
    const message = content as {
      tool_use_result?: { taskType?: string; runId?: string }
      message?: { content?: unknown }
    } | undefined
    const result = message?.tool_use_result
    let runId = result?.taskType === 'local_workflow' && typeof result.runId === 'string' ? result.runId : undefined
    const blocks = message?.message?.content
    if (!Array.isArray(blocks)) return
    const toolResult = blocks.find((b: { type?: string }) => b?.type === 'tool_result') as
      | { tool_use_id?: string; content?: unknown }
      | undefined
    const toolUseId = toolResult?.tool_use_id
    if (!toolUseId) return
    // Without the structured field, the run id is in the result text.
    if (!runId) {
      const text = typeof toolResult?.content === 'string' ? toolResult.content : ''
      runId = (text.match(/Run ID:\s*(wf_[A-Za-z0-9_-]+)/) || text.match(/workflows\/(wf_[A-Za-z0-9_-]+)/))?.[1]
    }
    if (!runId) return
    for (const info of this.tasks.values()) {
      if (info.isWorkflow && info.toolUseId === toolUseId && !info.runId) {
        info.runId = runId
        this.sink.emit({ type: 'workflow_started', toolUseId, runId, name: info.workflowName, startedAt: info.startedAt })
        this.sink.workflowStarted(runId)
        return
      }
    }
  }

  /** The run id of the workflow a tool call launched, once its tool result named it. */
  workflowRunIdFor(toolUseId: string): string | undefined {
    for (const info of this.tasks.values()) {
      if (info.isWorkflow && info.toolUseId === toolUseId) return info.runId
    }
    return undefined
  }

  /** Drop every task this process held, telling clients: a fresh process emits no level set to retire them. */
  private dropProcessLocal(): void {
    for (const taskId of [...this.tasks.keys()]) this.clear(taskId)
    this.levelSet = null
  }

  private emitEnded(taskId: string): void {
    this.sink.emit({ type: 'background_task_completed', taskId, backgroundTasks: this.list() })
    this.sink.publish({ type: 'background_task_completed', sessionId: this.session.sessionId, agentSlug: this.session.agentSlug, taskId })
  }
}
