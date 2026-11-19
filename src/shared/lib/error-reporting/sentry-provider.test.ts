import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeOptions } from '@sentry/node'
import { GrammyError, HttpError } from 'grammy'
import { CREDENTIAL_BODY_ROUTE, createServerProvider, redactBotTokens, scrubCredentialRequestBody } from './sentry-provider'
import { backgroundSettled } from '../background'

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
const environment = vi.hoisted(() => ({
  probeEnvironmentData: vi.fn<() => Promise<Record<string, unknown>>>(),
}))
vi.mock('./environment', () => ({
  collectEnvironmentData: () => ({ os_platform: 'test-platform' }),
  probeEnvironmentData: environment.probeEnvironmentData,
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

function beforeBreadcrumb() {
  const callback = initializationOptions().beforeBreadcrumb
  if (!callback) throw new Error('Breadcrumb redaction was not installed')
  return callback
}

describe('server error reporting provider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    settings.getSettings.mockResolvedValue({})
    environment.probeEnvironmentData.mockResolvedValue({})
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

  it('has the environment context before any program answers, and adds what one says later', async () => {
    let programAnswers: (data: Record<string, unknown>) => void = () => {}
    environment.probeEnvironmentData.mockReturnValue(new Promise((resolve) => { programAnswers = resolve }))

    initializeProvider()

    // An error reported now, during startup, carries the in-process part.
    expect(sentry.setContext.mock.calls).toEqual([['environment_info', { os_platform: 'test-platform' }]])

    programAnswers({ windows_build: 'Microsoft Windows [Version 10.0.26100.2314]' })
    await backgroundSettled()

    expect(sentry.setContext.mock.calls[1]).toEqual(['environment_info', {
      os_platform: 'test-platform',
      windows_build: 'Microsoft Windows [Version 10.0.26100.2314]',
    }])
  })

  it('sets the environment context once where no program has to be asked', async () => {
    initializeProvider()
    await backgroundSettled()

    expect(sentry.setContext).toHaveBeenCalledTimes(1)
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

  it('reports a busy or unreachable Telegram as a warning, and other errors as they are', async () => {
    initializeProvider()
    const busy = new GrammyError("Call to 'sendRichMessage' failed!", { ok: false, error_code: 502, description: 'Bad Gateway' }, 'sendRichMessage', {})

    expect(await beforeSend()({ type: undefined, level: 'error' }, { originalException: busy })).toEqual({ level: 'warning' })
    expect(await beforeSend()({ type: undefined, level: 'error' }, { originalException: new HttpError("Network request for 'getMe' failed!", undefined) })).toEqual({ level: 'warning' })
    expect(await beforeSend()({ type: undefined, level: 'error' }, { originalException: new Error('x') })).toEqual({ level: 'error' })
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

  it('matches the routes that take integration credentials: every integration route and the agent\'s add route', () => {
    for (const path of ['/api/agent-integrations/test-credentials', '/api/agent-integrations/agents/a1', 'http://localhost:47891/api/chat-integrations/i-1', '/api/agent-integrations?x=1', '/api/x-agent/chat/add']) {
      expect(CREDENTIAL_BODY_ROUTE.test(path)).toBe(true)
    }
    expect(CREDENTIAL_BODY_ROUTE.test('/api/x-agent/chat/send')).toBe(false)
  })

  it('keeps other bodies', () => {
    const event = { request: { url: '/api/agents/a1/sessions/s-1/messages', data: '{"content":"hi"}' } }
    expect(scrubCredentialRequestBody(event).request?.data).toBe('{"content":"hi"}')
  })
})

describe('Telegram bot tokens in error reports', () => {
  const token = '123456789:AAHfake-token_secret0123456789abcdef'
  const url = `https://api.telegram.org/bot${token}/sendMessage`
  const redactedUrl = 'https://api.telegram.org/bot123456789:[redacted]/sendMessage'

  beforeEach(() => {
    vi.clearAllMocks()
    settings.getSettings.mockResolvedValue({})
    environment.probeEnvironmentData.mockResolvedValue({})
    sentry.httpIntegration.mockReturnValue({ name: 'Http' })
  })

  it('redacts the secret in a bare token and in an API URL, keeping the bot id', () => {
    expect(redactBotTokens(url)).toBe(redactedUrl)
    expect(redactBotTokens(`{"botToken":"${token}"}`)).toBe('{"botToken":"123456789:[redacted]"}')
    expect(redactBotTokens('at 2026-11-16T15:19:34 run 4e7046fa0')).toBe('at 2026-11-16T15:19:34 run 4e7046fa0')
  })

  it('redacts every string of an allowed event before sending it', async () => {
    initializeProvider()
    const event = {
      type: undefined,
      exception: { values: [{ type: 'Error', value: `request to ${url} failed` }] },
      breadcrumbs: [{ category: 'http', data: { url, status_code: 502 } }],
      extra: { config: { botToken: token } },
    }

    expect(await beforeSend()(event, {})).toEqual({
      exception: { values: [{ type: 'Error', value: `request to ${redactedUrl} failed` }] },
      breadcrumbs: [{ category: 'http', data: { url: redactedUrl, status_code: 502 } }],
      extra: { config: { botToken: '123456789:[redacted]' } },
    })
  })

  it('redacts breadcrumbs as they are recorded, without touching the objects the app logged', () => {
    initializeProvider()
    const logged = new Error(`request to ${url} failed`)
    const consoleData = { arguments: ['rich send failed:', logged], logger: 'console' }

    expect(beforeBreadcrumb()({ category: 'console', message: `rich send failed: ${url}`, data: consoleData }, {})).toEqual({
      category: 'console',
      message: `rich send failed: ${redactedUrl}`,
      data: { logger: 'console' },
    })
    expect(consoleData.arguments[1]).toBe(logged)
    expect(beforeBreadcrumb()({ category: 'http', data: { url, status_code: 502 } }, {})).toEqual({
      category: 'http',
      data: { url: redactedUrl, status_code: 502 },
    })
    expect(beforeBreadcrumb()({ category: 'agent', message: 'turn started', data: { arguments: ['s-1'] } }, {})).toEqual({
      category: 'agent',
      message: 'turn started',
      data: { arguments: ['s-1'] },
    })
  })

  it('drops an event or breadcrumb it cannot redact instead of throwing', async () => {
    initializeProvider()
    const unreadable = Object.defineProperty({}, 'value', { enumerable: true, get: () => { throw new Error('unreadable') } })

    expect(await beforeSend()({ type: undefined, extra: { unreadable } }, {})).toBeNull()
    expect(beforeBreadcrumb()({ category: 'http', data: unreadable }, {})).toBeNull()
  })
})
