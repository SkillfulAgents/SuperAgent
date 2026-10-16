/**
 * In-process jobs for rule work that takes longer than one request may:
 * writing a rule from plain English (several model calls), and an agent's
 * proposal (validation, an independent restatement, then a person's decision).
 *
 * Proxies in front of the app cut requests off at 30–60 s and pass the cut-off
 * on as a bare 502, while the work behind it carries on. So callers start a
 * job, get its id at once, and poll for the result with short waits.
 *
 * With a lease, a job nobody has polled for within the lease is abandoned: its
 * signal aborts, so a proposal whose agent stopped waiting withdraws its card
 * instead of saving a rule nobody will hear about. A finished job's result is
 * kept for a while, then dropped.
 */

export type JobState<T> =
  | { state: 'running' }
  | { state: 'done'; value: T }
  | { state: 'failed'; error: Error }

interface Job<T> {
  owner: string
  controller: AbortController
  outcome: JobState<T>
  finished: Promise<void>
  lease?: NodeJS.Timeout
  /** Taken by a use in progress (see claim). */
  claimed?: boolean
}

export interface RuleJobsOptions {
  /** Abandon a running job that has not been polled for this long. */
  leaseMs?: number
  /** Keep a finished job's result this long. */
  keepMs: number
  /** Running jobs one owner may have at once. */
  maxRunningPerOwner: number
}

export class TooManyJobsError extends Error {}

export class RuleJobs<T> {
  private readonly jobs = new Map<string, Job<T>>()

  constructor(private readonly options: RuleJobsOptions) {}

  /** Starts `run` and returns the job id. Throws TooManyJobsError over the owner's limit. */
  start(owner: string, run: (signal: AbortSignal) => Promise<T>): string {
    let running = 0
    for (const job of this.jobs.values()) {
      if (job.owner === owner && job.outcome.state === 'running') running++
    }
    if (running >= this.options.maxRunningPerOwner) throw new TooManyJobsError()

    const id = crypto.randomUUID()
    const controller = new AbortController()
    const job: Job<T> = { owner, controller, outcome: { state: 'running' }, finished: Promise.resolve() }
    job.finished = Promise.resolve()
      .then(() => run(controller.signal))
      .then(
        (value) => { job.outcome = { state: 'done', value } },
        (error: unknown) => {
          console.error('[proxy-rules] Job failed:', error)
          job.outcome = { state: 'failed', error: error instanceof Error ? error : new Error(String(error)) }
        },
      )
      .finally(() => {
        clearTimeout(job.lease)
        setTimeout(() => this.jobs.delete(id), this.options.keepMs).unref()
      })
    this.jobs.set(id, job)
    this.renewLease(job)
    return id
  }

  /**
   * Waits up to `maxWaitMs` for the job to finish. Undefined when there is no
   * such job for this owner (never started, someone else's, or expired).
   */
  async wait(id: string, owner: string, maxWaitMs: number, signal?: AbortSignal): Promise<JobState<T> | undefined> {
    const job = this.jobs.get(id)
    if (!job || job.owner !== owner) return undefined
    if (job.outcome.state === 'running') {
      this.renewLease(job)
      let timer: NodeJS.Timeout | undefined
      let onAbort: (() => void) | undefined
      await Promise.race([
        job.finished,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, maxWaitMs) }),
        new Promise<void>((resolve) => {
          if (!signal) return
          onAbort = resolve
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', onAbort, { once: true })
        }),
      ])
      clearTimeout(timer)
      if (onAbort) signal?.removeEventListener('abort', onAbort)
      this.renewLease(job)
    }
    return job.outcome
  }

  /**
   * Claims a finished value for one use. Until the claim is settled, further
   * claims get nothing. `consume()` drops the job (the use succeeded);
   * `release()` hands it back (the use failed and may be tried again).
   * Undefined while the job runs, or when it is gone or already claimed.
   */
  claim(id: string, owner: string): { value: T; consume(): void; release(): void } | undefined {
    const job = this.jobs.get(id)
    if (!job || job.owner !== owner || job.outcome.state !== 'done' || job.claimed) return undefined
    job.claimed = true
    return {
      value: job.outcome.value,
      consume: () => { this.jobs.delete(id) },
      release: () => { job.claimed = false },
    }
  }

  /** Aborts a running job. False when there is no such job for this owner. */
  cancel(id: string, owner: string): boolean {
    const job = this.jobs.get(id)
    if (!job || job.owner !== owner) return false
    job.controller.abort(new Error('cancelled'))
    return true
  }

  private renewLease(job: Job<T>): void {
    const { leaseMs } = this.options
    if (leaseMs === undefined || job.outcome.state !== 'running') return
    clearTimeout(job.lease)
    job.lease = setTimeout(() => job.controller.abort(new Error('abandoned')), leaseMs)
    job.lease.unref()
  }
}
