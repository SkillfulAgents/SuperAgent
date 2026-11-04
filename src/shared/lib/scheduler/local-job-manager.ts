import { background } from '../background'
import type { Job, JobInfo, JobManager } from './job-manager'

interface Entry {
  job: Job
  delay: ReturnType<typeof setTimeout> | null
  interval: ReturnType<typeof setInterval> | null
  running: boolean
  lastRunAt: number | null
}

/** Runs each job on process timers: first after `startDelayMs`, then every `intervalMs`. */
export class LocalJobManager implements JobManager {
  private readonly entries = new Map<string, Entry>()

  register(job: Job): boolean {
    if (this.entries.has(job.id)) return false
    const entry: Entry = { job, delay: null, interval: null, running: false, lastRunAt: null }
    this.entries.set(job.id, entry)
    entry.delay = setTimeout(() => {
      entry.delay = null
      entry.interval = setInterval(() => this.run(entry), job.intervalMs)
      this.run(entry)
    }, job.startDelayMs ?? 0)
    return true
  }

  unregister(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    if (entry.delay) clearTimeout(entry.delay)
    if (entry.interval) clearInterval(entry.interval)
    this.entries.delete(id)
  }

  list(): JobInfo[] {
    return [...this.entries.values()].map(({ job, running, lastRunAt }) => ({
      id: job.id,
      intervalMs: job.intervalMs,
      running,
      lastRunAt,
    }))
  }

  private run(entry: Entry): void {
    if (entry.running) return
    entry.running = true
    entry.lastRunAt = Date.now()
    background(entry.job.run().finally(() => { entry.running = false }), { name: `job.${entry.job.id}` })
  }
}
