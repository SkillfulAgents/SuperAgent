import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ErrorReportingProvider } from './types'

const createServerProvider = vi.fn()
vi.mock('./sentry-provider', () => ({ createServerProvider }))

function recordingReporter() {
  const captured: unknown[] = []
  const reporter: ErrorReportingProvider = {
    captureException: (error) => { captured.push(error); return 'event-1' },
    captureMessage: () => undefined,
    setUser: () => {},
    addBreadcrumb: () => {},
    setContext: () => {},
    setTag: () => {},
    flush: async () => true,
  }
  return { reporter, captured }
}

afterEach(() => {
  vi.resetModules()
  createServerProvider.mockReset()
})

describe('setErrorReportingProvider', () => {
  it('reports through the deployment reporter, and startup keeps it instead of starting Sentry for Node', async () => {
    const errorReporting = await import('./index')
    const { reporter, captured } = recordingReporter()

    errorReporting.setErrorReportingProvider(reporter)
    errorReporting.initErrorReporting({ environment: 'web' })
    const error = new Error('Agent object failed to answer')

    expect(errorReporting.captureException(error)).toBe('event-1')
    expect(captured).toEqual([error])
    expect(createServerProvider).not.toHaveBeenCalled()
  })

  it('starts Sentry for Node when no deployment reporter is set', async () => {
    const errorReporting = await import('./index')
    createServerProvider.mockReturnValue(recordingReporter().reporter)

    errorReporting.initErrorReporting({ environment: 'web' })

    expect(createServerProvider).toHaveBeenCalledWith({ environment: 'web' })
  })
})
