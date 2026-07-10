import { z } from 'zod'

// Mirrors src/shared/lib/container/background-tasks-changed.ts — agent-container
// cannot import host shared/. Keep parsers in sync when the wire shape changes.

const backgroundTaskSchema = z.object({
  task_id: z.string(),
  task_type: z.string().optional().catch(undefined),
  description: z.string().optional().catch(undefined),
})

const backgroundTasksChangedSchema = z.object({
  tasks: z.array(backgroundTaskSchema),
})

export interface BackgroundTasksSnapshot {
  taskIds: Set<string>
  tasks: Array<{ task_id: string; task_type?: string; description?: string }>
}

// Parse background_tasks_changed. null → ignore the frame (fail-safe: never
// clear running tasks from a partial parse).
export function parseBackgroundTasksChanged(content: unknown): BackgroundTasksSnapshot | null {
  const parsed = backgroundTasksChangedSchema.safeParse(content)
  if (!parsed.success) return null
  return {
    taskIds: new Set(parsed.data.tasks.map((t) => t.task_id)),
    tasks: parsed.data.tasks,
  }
}

export interface BackgroundTaskLiveness {
  // Per-task registration (tool_use_result / local_workflow). Used alone on
  // older CLIs that never emit background_tasks_changed.
  incremental: Set<string>
  // Latest SDK snapshot (null until first valid frame).
  snapshot: Set<string> | null
}

export function createBackgroundTaskLiveness(): BackgroundTaskLiveness {
  return { incremental: new Set(), snapshot: null }
}

// Union of incremental + snapshot — same gate as message-persister.
export function openBackgroundWorkCount(state: BackgroundTaskLiveness): number {
  if (!state.snapshot) return state.incremental.size
  const union = new Set(state.incremental)
  for (const id of state.snapshot) union.add(id)
  return union.size
}

export function hasOpenBackgroundWork(state: BackgroundTaskLiveness): boolean {
  return openBackgroundWorkCount(state) > 0
}

function isTerminalStatus(status: string | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

function register(state: BackgroundTaskLiveness, taskId: string): void {
  state.incremental.add(taskId)
}

function clear(state: BackgroundTaskLiveness, taskId: string): void {
  state.incremental.delete(taskId)
}

// Apply one SDK stream message to liveness state. Matches message-persister
// registration paths; does not treat every task_started as background work.
export function trackBackgroundTaskMessage(
  state: BackgroundTaskLiveness,
  message: unknown
): void {
  const msg = message as {
    type?: string
    subtype?: string
    task_id?: string
    task_type?: string
    status?: string
    patch?: { status?: string }
    tool_use_result?: {
      backgroundTaskId?: unknown
      background_task_id?: unknown
      status?: unknown
      isAsync?: unknown
      agentId?: unknown
    }
  }

  if (msg.type === 'system') {
    if (msg.subtype === 'background_tasks_changed') {
      const snapshot = parseBackgroundTasksChanged(msg)
      if (!snapshot) return
      state.snapshot = snapshot.taskIds
      for (const taskId of [...state.incremental]) {
        if (!snapshot.taskIds.has(taskId)) clear(state, taskId)
      }
      return
    }

    if (msg.subtype === 'task_started' && msg.task_id) {
      // Persister only registers local_workflow from task_started. local_bash /
      // local_agent arrive via tool_use_result (backgroundTaskId / async_launched).
      if (msg.task_type === 'local_workflow') {
        register(state, msg.task_id)
      }
      return
    }

    if (msg.subtype === 'task_updated' && msg.task_id && isTerminalStatus(msg.patch?.status)) {
      clear(state, msg.task_id)
      return
    }

    if (msg.subtype === 'task_notification' && msg.task_id && isTerminalStatus(msg.status)) {
      clear(state, msg.task_id)
    }
    return
  }

  if (msg.type === 'user' && msg.tool_use_result) {
    const tur = msg.tool_use_result
    const bgId = tur.backgroundTaskId ?? tur.background_task_id
    if (typeof bgId === 'string') {
      register(state, bgId)
    }
    const isAsyncLaunch = tur.status === 'async_launched' || tur.isAsync === true
    if (isAsyncLaunch && typeof tur.agentId === 'string') {
      register(state, tur.agentId)
    }
  }
}
