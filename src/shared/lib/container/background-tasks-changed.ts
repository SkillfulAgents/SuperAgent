import { z } from 'zod'

// system/background_tasks_changed (claude-agent-sdk >= 0.3.203): the SDK emits
// the FULL set of the session's live background tasks on every membership
// change. Observed wire ordering (see the sdk206-* fixtures): each snapshot
// LEADS its per-task signal — the frame announcing an addition arrives just
// before task_started, the frame announcing a removal just before the
// terminal task_notification/task_updated. The snapshot covers only the lead
// session's own tasks (a subagent's inner tasks never appear), which matches
// exactly what the persister tracks.

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

/**
 * Parse a background_tasks_changed payload. Returns null when the frame does
 * not validate — the caller must then IGNORE the frame entirely (status quo
 * bookkeeping), because acting on a partially-parsed snapshot could clear
 * tasks that are still running. Fail-safe direction: a dropped frame costs
 * nothing (the next membership change re-announces the full set); a wrong
 * clear un-gates auto-sleep mid-job.
 */
export function parseBackgroundTasksChanged(content: unknown): BackgroundTasksSnapshot | null {
  const parsed = backgroundTasksChangedSchema.safeParse(content)
  if (!parsed.success) return null
  return {
    taskIds: new Set(parsed.data.tasks.map((t) => t.task_id)),
    tasks: parsed.data.tasks,
  }
}
