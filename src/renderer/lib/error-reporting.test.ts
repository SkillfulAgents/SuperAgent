// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  setUser: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}))

vi.mock('./sentry-browser-provider', () => sentry)
vi.mock('./env', () => ({ isElectron: () => true }))

let reporting: typeof import('./error-reporting')

describe('renderer error reporting facade', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubEnv('DEV', false)
    reporting = await import('./error-reporting')
    reporting.setRendererErrorReportingEnabled(true)
  })

  it('initializes Sentry with the renderer environment and opt-out gate', async () => {
    reporting.initRendererErrorReporting()

    await vi.waitFor(() => expect(sentry.init).toHaveBeenCalledOnce())
    const options = sentry.init.mock.calls[0][0]
    expect(options).toMatchObject({
      environment: 'electron-renderer',
      release: expect.any(String),
      tracesSampleRate: 0,
    })
    expect(options.beforeSend({ id: 'event' })).toEqual({ id: 'event' })

    reporting.setRendererErrorReportingEnabled(false)
    expect(options.beforeSend({ id: 'event' })).toBeNull()
  })

  it('forwards user identity and caught exceptions without changing their context', async () => {
    const error = new Error('boom')
    const context = { tags: { source: 'test' }, extra: { attempt: 2 } }
    reporting.initRendererErrorReporting()
    await vi.waitFor(() => expect(sentry.init).toHaveBeenCalledOnce())
    vi.clearAllMocks()

    reporting.setRendererErrorReportingUser({ id: 'user-1', email: 'user@example.com' })
    reporting.captureRendererException(error, context)
    reporting.setRendererErrorReportingUser(null)

    await vi.waitFor(() => expect(sentry.captureException).toHaveBeenCalledOnce())
    expect(sentry.setUser).toHaveBeenNthCalledWith(1, {
      id: 'user-1',
      email: 'user@example.com',
    })
    expect(sentry.captureException).toHaveBeenCalledWith(error, context)
    expect(sentry.setUser).toHaveBeenNthCalledWith(2, null)
  })

  it('preserves user identity and exceptions reported before the provider loads', async () => {
    const error = new Error('early boom')
    const context = { tags: { phase: 'boot' }, extra: { attempt: 1 } }

    reporting.setRendererErrorReportingUser({ id: 'early-user', email: 'early@example.com' })
    reporting.captureRendererException(error, context)

    await vi.waitFor(() => expect(sentry.captureException).toHaveBeenCalledOnce())
    expect(sentry.init).toHaveBeenCalledOnce()
    expect(sentry.setUser).toHaveBeenCalledWith({
      id: 'early-user',
      email: 'early@example.com',
    })
    expect(sentry.captureException).toHaveBeenCalledWith(error, context)
  })

  it('forwards only caller-sanitized breadcrumbs through the facade', async () => {
    reporting.addRendererBreadcrumb({
      category: 'api.request',
      message: 'fetch-settings failed',
      data: { routeTemplate: '/api/settings', status: 503 },
    })

    await vi.waitFor(() => expect(sentry.addBreadcrumb).toHaveBeenCalledOnce())
    expect(sentry.addBreadcrumb).toHaveBeenCalledWith({
      category: 'api.request',
      message: 'fetch-settings failed',
      data: { routeTemplate: '/api/settings', status: 503 },
    })
  })

  it('never lets provider failures escape into the renderer', async () => {
    reporting.initRendererErrorReporting()
    await vi.waitFor(() => expect(sentry.init).toHaveBeenCalledOnce())
    vi.clearAllMocks()
    sentry.captureException.mockImplementationOnce(() => {
      throw new Error('provider failed')
    })

    expect(() => reporting.captureRendererException(new Error('app failed'))).not.toThrow()
    await vi.waitFor(() => expect(sentry.captureException).toHaveBeenCalledOnce())
  })
})
