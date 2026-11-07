/**
 * Scheduled work, as a backend can run it. A Task is one kind of work; a
 * schedule says which Task, when, and with what payload, in values a backend
 * could store. See docs/background-work.md.
 *
 * Times are UTC epoch milliseconds.
 */
import type { z } from 'zod'

export interface TaskContext {
  readonly jobId: string
  /** The same across the retries of one occurrence, in this runtime. */
  readonly executionId: string
  /** 1 for an occurrence's first run. */
  readonly attempt: number
  /** Aborted when the job is cancelled or dispatch stops. A job replaced by a newer schedule is not aborted. */
  readonly signal: AbortSignal
  now(): number
}

export type TaskResult<P> =
  /** A one-off is finished. A recurring job waits for its next pass, which the manager arranges. */
  | { kind: 'done' }
  /** Run this occurrence again at `at`. */
  | { kind: 'retry'; at: number; reason?: string }
  /** The next occurrence of a one-off job, such as a cron's next time. Not for a recurring job. */
  | { kind: 'next'; at: number; payload: P }

/** What the manager does when `execute` throws. Without a policy, the failure is reported and the occurrence ends. */
export interface RetryPolicy {
  /** Waits before the second attempt, the third, and so on; the last repeats. */
  delaysMs: readonly number[]
  /** All attempts, the first included. Defaults to one more than `delaysMs` has entries. */
  maxAttempts?: number
}

/**
 * One kind of work: one class handles every instance of it, told apart by
 * payload. Dependencies go in the constructor; state about one execution
 * belongs in the context or with the domain's own owner.
 *
 * A task runs outside the scope of whoever scheduled it, as it would on a
 * backend that runs it later elsewhere. A task that acts for a user carries who
 * in its payload and enters that scope itself.
 */
export abstract class Task<P = unknown> {
  abstract readonly type: string
  abstract readonly payloadSchema: z.ZodType<P>
  readonly retryPolicy?: RetryPolicy
  abstract execute(payload: P, ctx: TaskContext): Promise<TaskResult<P>>
}

export interface TaskSpec<P> {
  taskType: string
  payload: P
}

export interface PeriodicOptions {
  intervalMs: number
  /** Before the first pass. Defaults to `intervalMs`, as with an interval timer. */
  initialDelayMs?: number
  /** Varies each wait by up to this fraction of `intervalMs`, either way. */
  jitterRatio?: number
}

/**
 * Runs Tasks at times and on intervals. Local dispatch is in-process timers
 * (LocalTaskManager); another backend keeps the same interface and does its own
 * persistence, recovery and coordination.
 *
 * The methods are async so a backend can do I/O. Resolving means the backend has
 * the schedule, which promises no more than that backend does: for
 * LocalTaskManager, that it is registered in this process.
 */
export abstract class TaskManager {
  /** Handlers are registered in code; a later registration of a type replaces the handler. */
  abstract register<P>(task: Task<P>): void
  /** Whether a handler is registered for this task type. */
  abstract handles(taskType: string): boolean
  /** Replaces whatever is scheduled under `id`. */
  abstract at<P>(runAt: number, id: string, task: TaskSpec<P>): Promise<void>
  /** Keeps one recurring job under `id`. A job already recurring there is left as it is. */
  abstract ensureEvery<P>(id: string, task: TaskSpec<P>, options: PeriodicOptions): Promise<void>
  abstract cancel(id: string): Promise<void>
  /** Starts dispatch. */
  abstract start(): Promise<void>
  /** Stops dispatch. It is not cancelling: domain schedules stay as they are, for the next start to rebuild. */
  abstract stop(): Promise<void>
}
