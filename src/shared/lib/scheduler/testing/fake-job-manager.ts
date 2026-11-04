import type { Job, JobManager } from '../job-manager'

/** Records registered jobs and runs nothing on its own; a test calls `job.run()` itself. */
export interface FakeJobManager extends JobManager {
  jobs: Map<string, Job>
}

export function createFakeJobManager(): FakeJobManager {
  const jobs = new Map<string, Job>()
  return {
    jobs,
    register(job) {
      if (jobs.has(job.id)) return false
      jobs.set(job.id, job)
      return true
    },
    unregister(id) {
      jobs.delete(id)
    },
    list: () => [...jobs.values()].map((job) => ({ id: job.id, intervalMs: job.intervalMs, running: false, lastRunAt: null })),
  }
}
