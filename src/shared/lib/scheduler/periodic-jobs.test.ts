import { describe, expect, it, vi } from 'vitest'

const service = (pollIntervalMs: number, pass: string) => ({ pollIntervalMs, [pass]: vi.fn().mockResolvedValue(undefined) })

vi.mock('@shared/lib/container/container-host', () => ({
  HEALTH_CHECK_INTERVAL_MS: 30_000,
  STATUS_SYNC_INTERVAL_MS: 300_000,
  containerHost: { runHealthChecks: vi.fn().mockResolvedValue(undefined), syncAllStatuses: vi.fn().mockResolvedValue(undefined) },
}))
vi.mock('./task-scheduler', () => ({ taskScheduler: service(60_000, 'executeOverdueTasks') }))
vi.mock('./account-sync-service', () => ({ accountSyncService: service(300_000, 'syncAll') }))
vi.mock('./session-auto-delete-monitor', () => ({ sessionAutoDeleteMonitor: service(14_400_000, 'cleanupAllAgents') }))
vi.mock('./api-log-auto-delete-monitor', () => ({ apiLogAutoDeleteMonitor: service(14_400_000, 'cleanupAllAgents') }))

const { periodicJobs } = await import('./periodic-jobs')
const { containerHost } = await import('@shared/lib/container/container-host')
const { taskScheduler } = await import('./task-scheduler')
const { accountSyncService } = await import('./account-sync-service')
const { sessionAutoDeleteMonitor } = await import('./session-auto-delete-monitor')
const { apiLogAutoDeleteMonitor } = await import('./api-log-auto-delete-monitor')

describe('periodicJobs', () => {
  it('takes each interval from the service that owns the job', () => {
    expect(periodicJobs().map(({ name, intervalMs }) => [name, intervalMs])).toEqual([
      ['task-scheduler', 60_000],
      ['container-health', 30_000],
      ['container-status-sync', 300_000],
      ['account-sync', 300_000],
      ['session-auto-delete', 14_400_000],
      ['api-log-auto-delete', 14_400_000],
    ])
  })

  it('runs one pass of each service per run()', async () => {
    for (const job of periodicJobs()) await job.run()

    for (const pass of [
      taskScheduler.executeOverdueTasks,
      containerHost.runHealthChecks,
      containerHost.syncAllStatuses,
      accountSyncService.syncAll,
      sessionAutoDeleteMonitor.cleanupAllAgents,
      apiLogAutoDeleteMonitor.cleanupAllAgents,
    ]) expect(pass).toHaveBeenCalledTimes(1)
  })
})
