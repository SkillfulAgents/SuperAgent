import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ErrorReportingProvider } from './types'

function recordingReporter(eventId: string) {
  const captured: unknown[] = []
  const reporter: ErrorReportingProvider = {
    captureException: (error) => { captured.push(error); return eventId },
    captureMessage: () => undefined,
    setUser: () => {},
    setTenantId: () => {},
    addBreadcrumb: () => {},
    setContext: () => {},
    setTag: () => {},
    flush: async () => true,
  }
  return { reporter, captured }
}

const identity = vi.hoisted(() => ({
  getTenantId: vi.fn<() => Promise<string>>(),
  getSettings: vi.fn<() => Promise<{ container: { containerRunner: string } }>>(),
  collectSettingsEnvironmentData: vi.fn<(settings: unknown) => Record<string, unknown>>(),
  probeSettingsEnvironmentData: vi.fn<(settings: unknown) => Promise<Record<string, unknown>>>(),
}))

vi.mock('../analytics/tenant-id', () => ({ getTenantId: identity.getTenantId }))
vi.mock('../config/settings', () => ({ getSettings: identity.getSettings }))
vi.mock('./environment', () => ({
  collectSettingsEnvironmentData: identity.collectSettingsEnvironmentData,
  probeSettingsEnvironmentData: identity.probeSettingsEnvironmentData,
}))

afterEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

describe('initErrorReporting', () => {
  it('reports through the reporter the entry point passed, and keeps the first one', async () => {
    const errorReporting = await import('./index')
    const workers = recordingReporter('event-workers')
    const later = recordingReporter('event-later')
    const error = new Error('Agent object failed to answer')

    errorReporting.initErrorReporting(workers.reporter)
    errorReporting.initErrorReporting(later.reporter)

    expect(errorReporting.captureException(error)).toBe('event-workers')
    expect(workers.captured).toEqual([error])
    expect(later.captured).toEqual([])
  })

  it('leaves reporting off when the reporter could not start', async () => {
    const errorReporting = await import('./index')

    errorReporting.initErrorReporting(null)

    expect(errorReporting.captureException(new Error('Agent object failed to answer'))).toBeUndefined()
    expect(errorReporting.getErrorReporter()).toBeNull()
  })
})

describe('attachErrorReportingIdentity', () => {
  function identityReporter() {
    const calls: unknown[][] = []
    const reporter: ErrorReportingProvider = {
      ...recordingReporter('event').reporter,
      setTenantId: (tenantId) => { calls.push(['tenant', tenantId]) },
      setContext: (name, context) => { calls.push([name, context]) },
    }
    return { reporter, calls }
  }

  const settings = { container: { containerRunner: 'docker' } }
  const known = { container_runner: 'docker' }
  const probed = { disk_free_gb: 12, docker_version: 'Docker version 29.8.2' }

  function identityIsReadable() {
    identity.getTenantId.mockResolvedValue('tenant-1')
    identity.getSettings.mockResolvedValue(settings)
    identity.collectSettingsEnvironmentData.mockReturnValue(known)
  }

  it('attaches what is known at once and does not wait for the disk or the container runner', async () => {
    const errorReporting = await import('./index')
    const { backgroundSettled } = await import('../background')
    const { reporter, calls } = identityReporter()
    identityIsReadable()
    let runnerAnswers: (data: Record<string, unknown>) => void = () => {}
    identity.probeSettingsEnvironmentData.mockReturnValue(new Promise((resolve) => { runnerAnswers = resolve }))
    errorReporting.initErrorReporting(reporter)

    // Returns while the runner's version command is still out.
    await errorReporting.attachErrorReportingIdentity()

    expect(calls).toEqual([['tenant', 'tenant-1'], ['environment_settings', known]])

    runnerAnswers(probed)
    await backgroundSettled()

    expect(calls[2]).toEqual(['environment_settings', { ...known, ...probed }])
    expect(identity.probeSettingsEnvironmentData).toHaveBeenCalledWith(settings)
  })

  it('collects once: a second call after a successful one reads and probes nothing', async () => {
    const errorReporting = await import('./index')
    const { backgroundSettled } = await import('../background')
    const { reporter, calls } = identityReporter()
    identityIsReadable()
    identity.probeSettingsEnvironmentData.mockResolvedValue(probed)
    errorReporting.initErrorReporting(reporter)

    await errorReporting.attachErrorReportingIdentity()
    await errorReporting.attachErrorReportingIdentity()
    await backgroundSettled()

    expect(identity.getTenantId).toHaveBeenCalledTimes(1)
    expect(identity.getSettings).toHaveBeenCalledTimes(1)
    expect(identity.collectSettingsEnvironmentData).toHaveBeenCalledTimes(1)
    expect(identity.probeSettingsEnvironmentData).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(3)
  })

  it('tries again when the first attempt could not read the identity', async () => {
    const errorReporting = await import('./index')
    const { backgroundSettled } = await import('../background')
    const { reporter, calls } = identityReporter()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    identity.getTenantId.mockRejectedValueOnce(new Error('Database is not open'))
    errorReporting.initErrorReporting(reporter)

    await errorReporting.attachErrorReportingIdentity()
    expect(calls).toEqual([])

    identityIsReadable()
    identity.probeSettingsEnvironmentData.mockResolvedValue(probed)
    await errorReporting.attachErrorReportingIdentity()
    await backgroundSettled()

    expect(calls).toEqual([
      ['tenant', 'tenant-1'],
      ['environment_settings', known],
      ['environment_settings', { ...known, ...probed }],
    ])
    warn.mockRestore()
  })
})
