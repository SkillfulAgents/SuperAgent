import { containerHost, HEALTH_CHECK_INTERVAL_MS, STATUS_SYNC_INTERVAL_MS } from '@shared/lib/container/container-host'
import { accountSyncService } from './account-sync-service'
import { apiLogAutoDeleteMonitor } from './api-log-auto-delete-monitor'
import { sessionAutoDeleteMonitor } from './session-auto-delete-monitor'
import { taskScheduler } from './task-scheduler'

/**
 * Background work that repeats on a fixed interval. Each service's `start()` runs its job
 * from its own timer; a host that cannot keep timers alive between requests (one that only
 * gets a single wake-up call) runs `run()` itself once `intervalMs` has passed.
 */
export interface PeriodicJob {
  name: string
  intervalMs: number
  run(): Promise<void>
}

export function periodicJobs(): PeriodicJob[] {
  return [
    { name: 'task-scheduler', intervalMs: taskScheduler.pollIntervalMs, run: () => taskScheduler.executeOverdueTasks() },
    { name: 'container-health', intervalMs: HEALTH_CHECK_INTERVAL_MS, run: () => containerHost.runHealthChecks() },
    { name: 'container-status-sync', intervalMs: STATUS_SYNC_INTERVAL_MS, run: () => containerHost.syncAllStatuses() },
    { name: 'account-sync', intervalMs: accountSyncService.pollIntervalMs, run: () => accountSyncService.syncAll() },
    { name: 'session-auto-delete', intervalMs: sessionAutoDeleteMonitor.pollIntervalMs, run: () => sessionAutoDeleteMonitor.cleanupAllAgents() },
    { name: 'api-log-auto-delete', intervalMs: apiLogAutoDeleteMonitor.pollIntervalMs, run: () => apiLogAutoDeleteMonitor.cleanupAllAgents() },
  ]
}
