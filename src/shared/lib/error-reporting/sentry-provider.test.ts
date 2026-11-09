import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeOptions } from '@sentry/node'
import { CREDENTIAL_BODY_ROUTE, createServerProvider, scrubCredentialRequestBody } from './sentry-provider'

const sentry = vi.hoisted(() => ({
  init: vi.fn<(options: NodeOptions) => void>(),
  httpIntegration: vi.fn(),
  setContext: vi.fn(),
  setUser: vi.fn(),
  flush: vi.fn<(timeout: number) => Promise<boolean>>(),
}))
const settings = vi.hoisted(() => ({
  getSettings: vi.fn<() => Promise<{ shareErrorReports?: boolean }>>(),
}))

vi.mock('@sentry/node', () => sentry)
vi.mock('../config/settings', () => settings)
vi.mock('./environment', () => ({
  collectEnvironmentData: () => ({ os_platform: 'test-platform' }),
}))

function initializeProvider() {
  const provider = createServerProvider({ environment: 'web-server' })
  if (!provider) throw new Error('Error reporting provider failed to initialize')
  return provider
}

function initializationOptions() {
  const options = sentry.init.mock.calls[0]?.[0]
  if (!options) throw new Error('Error reporting was not initialized')
  return options
}

function beforeSend() {
  const callback = initializationOptions().beforeSend
  if (!callback) throw new Error('Error reporting consent gate was not installed')
  return callback
}

describe('server error reporting provider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    settings.getSettings.mockResolvedValue({})
    sentry.httpIntegration.mockReturnValue({ name: 'Http' })
    sentry.flush.mockResolvedValue(true)
  })

  it('preserves collection settings and environment context', () => {
    initializeProvider()

    expect(initializationOptions()).toMatchObject({
      environment: 'web-server',
      release: expect.any(String),
      tracesSampleRate: 0,
      enableLogs: false,
      streamGenAiSpans: false,
    })
    expect(sentry.setContext).toHaveBeenCalledWith('environment_info', {
      os_platform: 'test-platform',
    })
  })

  it('excludes credential bodies from HTTP collection while retaining other integrations', () => {
    initializeProvider()
    const integrations = initializationOptions().integrations
    if (typeof integrations !== 'function') throw new Error('HTTP integration was not configured')
    const otherIntegration = { name: 'Other' }
    const oldHttpIntegration = { name: 'Http' }
    const configured = integrations([otherIntegration, oldHttpIntegration])

    expect(configured).toEqual([otherIntegration, { name: 'Http' }])
    expect(configured).not.toContain(oldHttpIntegration)
    const { ignoreIncomingRequestBody } = sentry.httpIntegration.mock.calls[0][0]
    for (const path of ['fill-login', 'fill-login-credential', 'provide-secret', 'browser-credentials/verify']) {
      expect(ignoreIncomingRequestBody(`/api/agents/a1/sessions/s-1/${path}?source=login`)).toBe(true)
    }
    expect(ignoreIncomingRequestBody('/api/agents/a1/sessions/s-1/messages')).toBe(false)
  })

  it('reads current consent for every event, including opt-out and re-enabling', async () => {
    initializeProvider()
    const send = beforeSend()
    const event = { type: undefined, message: 'app error' }

    expect(await send(event, {})).toBe(event)
    settings.getSettings.mockResolvedValue({ shareErrorReports: false })
    expect(await send(event, {})).toBeNull()
    settings.getSettings.mockResolvedValue({ shareErrorReports: true })
    expect(await send(event, {})).toBe(event)
    expect(settings.getSettings).toHaveBeenCalledTimes(3)
  })

  it('scrubs credential bodies again before sending an allowed event', async () => {
    initializeProvider()
    const event = {
      type: undefined,
      request: {
        url: '/api/agents/a1/sessions/s-1/provide-secret',
        data: { value: 'test-secret' },
      },
    }

    expect(await beforeSend()(event, {})).toEqual({
      request: { url: '/api/agents/a1/sessions/s-1/provide-secret' },
    })
  })

  it('retains boot crash reports when settings cannot load without retaining credentials', async () => {
    initializeProvider()
    settings.getSettings.mockRejectedValue(new Error('Database is not open'))
    const event = {
      type: undefined,
      message: 'boot failed',
      request: {
        url: '/api/agents/a1/sessions/s-1/fill-login',
        data: { password: 'test-secret' },
      },
    }

    expect(await beforeSend()(event, {})).toEqual({
      message: 'boot failed',
      request: { url: '/api/agents/a1/sessions/s-1/fill-login' },
    })
  })

  it('returns to deployment identity after the signed-in user is cleared', () => {
    const provider = initializeProvider()

    provider.setUser(null)
    provider.setTenantId('tenant-1')
    provider.setUser({ id: 'user-1', email: 'user@example.com' })
    provider.setUser(null)

    expect(sentry.setUser.mock.calls).toEqual([
      [null],
      [{ id: 'tenant-1' }],
      [{ id: 'user-1', email: 'user@example.com' }],
      [{ id: 'tenant-1' }],
    ])
  })

  it('honors shutdown flush deadlines and reports incomplete delivery', async () => {
    const provider = initializeProvider()

    expect(await provider.flush()).toBe(true)
    sentry.flush.mockResolvedValue(false)
    expect(await provider.flush(250)).toBe(false)
    expect(sentry.flush.mock.calls).toEqual([[5000], [250]])
  })
})

describe('credential request bodies in error reports', () => {
  it('matches the routes whose bodies carry credentials', () => {
    for (const path of ['fill-login', 'fill-login-credential', 'provide-secret', 'browser-credentials/verify']) {
      expect(CREDENTIAL_BODY_ROUTE.test(`http://localhost:47891/api/agents/a1/sessions/s-1/${path}`)).toBe(true)
      expect(CREDENTIAL_BODY_ROUTE.test(`/api/agents/a1/sessions/s-1/${path}?x=1`)).toBe(true)
    }
    for (const path of ['messages', 'login-request', 'complete-login', 'browser-credentials']) {
      expect(CREDENTIAL_BODY_ROUTE.test(`/api/agents/a1/sessions/s-1/${path}`)).toBe(false)
    }
  })

  it('drops the body of an event raised while filling a sign-in form', () => {
    const event = { request: { url: '/api/agents/a1/sessions/s-1/fill-login', data: '{"values":["me","hunter2"]}' } }
    expect(scrubCredentialRequestBody(event).request).toEqual({ url: '/api/agents/a1/sessions/s-1/fill-login' })
  })

  it('keeps other bodies', () => {
    const event = { request: { url: '/api/agents/a1/sessions/s-1/messages', data: '{"content":"hi"}' } }
    expect(scrubCredentialRequestBody(event).request?.data).toBe('{"content":"hi"}')
  })
})
