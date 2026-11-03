import { getWebhookRelay } from '@shared/lib/webhook-relay'
import { accountSyncService } from './account-sync-service'
import { apiLogAutoDeleteMonitor } from './api-log-auto-delete-monitor'
import { sessionAutoDeleteMonitor } from './session-auto-delete-monitor'
import { taskScheduler } from './task-scheduler'
import { triggerManager } from './trigger-manager'

/**
 * Background work that repeats on a fixed interval. Each service's `start()` runs its job
 * from its own timer; a host that cannot keep timers alive between requests (one that only
 * gets a single wake-up call) runs `run()` itself once `intervalMs` has passed.
 * Org-wide jobs only: container health and status sync run where each agent's runtime lives.
 */
export interface PeriodicJob {
  name: string
  intervalMs: number
  /**
   * One pass. Never run two at once for the same job, in this process or another: a job guards
   * only against overlap in its own process (the task scheduler checks for a session it started,
   * then starts one, so two overlapping passes start the same task twice). A host on many processes
   * holds its claim on the job for the whole run, not only for the tick that started it.
   */
  run(): Promise<void>
}

export function periodicJobs(): PeriodicJob[] {
  const relay = getWebhookRelay()
  return [
    { name: 'task-scheduler', intervalMs: taskScheduler.pollIntervalMs, run: () => taskScheduler.executeOverdueTasks() },
    { name: 'account-sync', intervalMs: accountSyncService.pollIntervalMs, run: () => accountSyncService.syncAll() },
    { name: 'session-auto-delete', intervalMs: sessionAutoDeleteMonitor.pollIntervalMs, run: () => sessionAutoDeleteMonitor.cleanupAllAgents() },
    { name: 'api-log-auto-delete', intervalMs: apiLogAutoDeleteMonitor.pollIntervalMs, run: () => apiLogAutoDeleteMonitor.cleanupAllAgents() },
    // Before the relay's pass, so it claims for triggers created or cancelled since the last one.
    { name: 'webhook-triggers', intervalMs: relay.passIntervalMs, run: () => triggerManager.syncRegistrations() },
    // Delivers anything only when the relay was started with `timers: false`.
    { name: 'webhook-relay', intervalMs: relay.passIntervalMs, run: () => relay.runPass() },
  ]
}
