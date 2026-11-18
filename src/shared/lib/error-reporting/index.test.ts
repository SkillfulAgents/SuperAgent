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

afterEach(() => {
  vi.resetModules()
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
