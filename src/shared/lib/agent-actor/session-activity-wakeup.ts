/**
 * The wakeup a session index in this process stores its recorded activity
 * on (see `SessionIndexDeps.storeActivityLater`): one task-manager job per
 * index, set again for each interval in which activity is recorded.
 *
 * A task on its own, with no service around it. It registers itself on the
 * manager in use the first time an index asks, so every entry point and
 * every test that records activity has it without naming it.
 */
import { z } from 'zod'
import { background } from '@shared/lib/background'
import { Task, taskManager, type TaskManager, type TaskResult } from '@shared/lib/background-work'

const STORE_ACTIVITY_TASK_TYPE = 'session-index.store-activity'

const payloadSchema = z.object({ indexId: z.string() }).strict()
type Payload = z.infer<typeof payloadSchema>

/**
 * What each index with a wakeup set does when it comes due. A function
 * cannot go in a payload, so the payload names the index and this holds the
 * call. On `globalThis`, like the manager whose jobs name its keys: a handler
 * registered by one instance of this module (before a dev-server reload, or
 * a test's `vi.resetModules()`) serves the indexes of another.
 */
const DUE = Symbol.for('superagent.session-index.store-activity')
const due = ((globalThis as Record<symbol, Map<string, () => Promise<void>> | undefined>)[DUE] ??= new Map())

class StoreSessionActivityTask extends Task<Payload> {
  readonly type = STORE_ACTIVITY_TASK_TYPE
  readonly payloadSchema = payloadSchema

  async execute({ indexId }: Payload): Promise<TaskResult<Payload>> {
    const store = due.get(indexId)
    // Before the store, which sets the next wakeup itself if it fails.
    due.delete(indexId)
    await store?.()
    return { kind: 'done' }
  }
}

const storeSessionActivityTask = new StoreSessionActivityTask()

/**
 * Have `store` called at about `atMs`, replacing the wakeup set before under
 * `indexId`. True only when the wakeup will come. False when no task manager
 * is installed (a script that opens the database and nothing else), and
 * false once dispatch has stopped, when the manager would take the wakeup
 * and drop it: a write recorded during shutdown (a transcript append that
 * was in flight when the agents were released) is then stored by the index
 * as it is recorded, not left in memory for a wakeup that never runs.
 *
 * A wakeup set before dispatch stopped is dropped with it. The index stores
 * what it holds when its actor is released at shutdown, and stops waiting
 * for a wakeup that is an interval late.
 */
export function storeSessionActivityAt(indexId: string, atMs: number, store: () => Promise<void>): boolean {
  let manager: TaskManager
  try {
    manager = taskManager()
  } catch {
    return false
  }
  if (!manager.accepts()) return false
  if (!manager.handles(STORE_ACTIVITY_TASK_TYPE)) manager.register(storeSessionActivityTask)
  due.set(indexId, store)
  background(
    manager.at(atMs, `${STORE_ACTIVITY_TASK_TYPE}:${indexId}`, { taskType: STORE_ACTIVITY_TASK_TYPE, payload: { indexId } }),
    { name: 'session-index.set-store-wakeup' },
  )
  return true
}
