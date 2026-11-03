import { LocalJobManager } from './local-job-manager'

/** Background work that repeats on a fixed interval. */
export interface Job {
  /** Unique per manager: a second job registered with the same id is ignored. */
  readonly id: string
  readonly intervalMs: number
  /** How long after registration the first run waits, to keep startup light. Defaults to 0. */
  readonly startDelayMs?: number
  /**
   * One pass. The job reports its own failures. A manager never starts a second pass of a job
   * while one runs; a manager that spans processes holds its claim on the job for the whole pass.
   */
  run(): Promise<void>
}

export interface JobInfo {
  id: string
  intervalMs: number
  running: boolean
  lastRunAt: number | null
}

/**
 * Runs registered jobs on their intervals. By default on process timers; a host whose
 * process does not live between requests supplies one that keeps the schedule itself.
 */
export interface JobManager {
  /** False when a job with this id is already registered. */
  register(job: Job): boolean
  unregister(id: string): void
  list(): JobInfo[]
}

let manager: JobManager | null = null

export function getJobManager(): JobManager {
  manager ??= new LocalJobManager()
  return manager
}

/** Call before services start. Null restores the process-timer manager. */
export function setJobManager(next: JobManager | null): void {
  manager = next
}
