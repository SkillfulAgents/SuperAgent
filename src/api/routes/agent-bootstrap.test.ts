import { describe, it, expect, vi, beforeEach } from 'vitest'

const validateProxyToken = vi.fn(async (_token: string): Promise<string | null> => null)
const broadcastGlobal = vi.fn()
vi.mock('@shared/lib/proxy/token-store', () => ({
  validateProxyToken: (t: string) => validateProxyToken(t),
}))
const isSessionActive = vi.fn(() => false)
const isSubscribed = vi.fn(() => false)
vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    broadcastGlobal: (...args: unknown[]) => broadcastGlobal(...args),
    isSessionActive: (...args: unknown[]) => isSessionActive(...(args as [])),
    isSubscribed: (...args: unknown[]) => isSubscribed(...(args as [])),
  },
}))
const captureException = vi.fn()
vi.mock('@shared/lib/error-reporting', () => ({
  captureException: (...args: unknown[]) => captureException(...args),
}))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({ container: { containerRunner: 'apple-container' } }),
}))

import agentBootstrap from './agent-bootstrap'
import { setBootstrapEnv, clearBootstrapEnv, resetBootstrapEnvStoreForTests } from '@shared/lib/container/agent-bootstrap-env-store'

function get(path: string, headers: Record<string, string> = {}) {
  return agentBootstrap.request(path, { headers })
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return agentBootstrap.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  validateProxyToken.mockReset().mockResolvedValue(null)
  broadcastGlobal.mockReset()
  captureException.mockReset()
  isSessionActive.mockReset().mockReturnValue(false)
  isSubscribed.mockReset().mockReturnValue(false)
  resetBootstrapEnvStoreForTests()
})

describe('GET /:agentSlug/env', () => {
  it('returns the stashed env for a valid token matching the agent', async () => {
    validateProxyToken.mockResolvedValue('agent-1')
    setBootstrapEnv('agent-1', { FOO: 'bar', PROXY_TOKEN: 'synth_x' })
    const res = await get('/agent-1/env', { Authorization: 'Bearer synth_x' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ env: { FOO: 'bar', PROXY_TOKEN: 'synth_x' } })
  })

  it('401 when the Authorization header is missing', async () => {
    setBootstrapEnv('agent-1', { FOO: 'bar' })
    expect((await get('/agent-1/env')).status).toBe(401)
  })

  it('401 when the token is invalid', async () => {
    validateProxyToken.mockResolvedValue(null)
    setBootstrapEnv('agent-1', { FOO: 'bar' })
    expect((await get('/agent-1/env', { Authorization: 'Bearer nope' })).status).toBe(401)
  })

  it('403 when the token resolves to a different agent', async () => {
    validateProxyToken.mockResolvedValue('agent-2')
    setBootstrapEnv('agent-1', { FOO: 'bar' })
    expect((await get('/agent-1/env', { Authorization: 'Bearer synth_other' })).status).toBe(403)
  })

  it('404 when no env is stashed', async () => {
    validateProxyToken.mockResolvedValue('agent-1')
    expect((await get('/agent-1/env', { Authorization: 'Bearer synth_x' })).status).toBe(404)
  })

  it('is re-fetchable: a retried boot fetch still gets the env', async () => {
    validateProxyToken.mockResolvedValue('agent-1')
    setBootstrapEnv('agent-1', { FOO: 'bar' })
    expect((await get('/agent-1/env', { Authorization: 'Bearer synth_x' })).status).toBe(200)
    expect((await get('/agent-1/env', { Authorization: 'Bearer synth_x' })).status).toBe(200)
  })

  it('404 once the env is cleared on agent teardown', async () => {
    validateProxyToken.mockResolvedValue('agent-1')
    setBootstrapEnv('agent-1', { FOO: 'bar' })
    expect((await get('/agent-1/env', { Authorization: 'Bearer synth_x' })).status).toBe(200)
    clearBootstrapEnv('agent-1')
    expect((await get('/agent-1/env', { Authorization: 'Bearer synth_x' })).status).toBe(404)
  })
})

describe('POST /:agentSlug/events/dashboard-screenshot-ready', () => {
  it('broadcasts an authenticated screenshot event to renderer clients', async () => {
    validateProxyToken.mockResolvedValue('agent-1')

    const res = await post(
      '/agent-1/events/dashboard-screenshot-ready',
      { dashboardSlug: 'sales-dashboard' },
      { Authorization: 'Bearer synth_x' },
    )

    expect(res.status).toBe(204)
    expect(broadcastGlobal).toHaveBeenCalledWith({
      type: 'dashboard_screenshot_ready',
      agentSlug: 'agent-1',
      dashboardSlug: 'sales-dashboard',
    })
  })

  it('rejects a token belonging to another agent', async () => {
    validateProxyToken.mockResolvedValue('agent-2')

    const res = await post(
      '/agent-1/events/dashboard-screenshot-ready',
      { dashboardSlug: 'sales-dashboard' },
      { Authorization: 'Bearer synth_other' },
    )

    expect(res.status).toBe(403)
    expect(broadcastGlobal).not.toHaveBeenCalled()
  })

  it('rejects unsafe dashboard slugs', async () => {
    validateProxyToken.mockResolvedValue('agent-1')

    const res = await post(
      '/agent-1/events/dashboard-screenshot-ready',
      { dashboardSlug: '../sales' },
      { Authorization: 'Bearer synth_x' },
    )

    expect(res.status).toBe(400)
    expect(broadcastGlobal).not.toHaveBeenCalled()
  })
})

describe('POST /:agentSlug/events/dashboard-status-changed', () => {
  it('broadcasts an authenticated status event to renderer clients', async () => {
    validateProxyToken.mockResolvedValue('agent-1')

    const res = await post(
      '/agent-1/events/dashboard-status-changed',
      { dashboardSlug: 'sales-dashboard', status: 'running' },
      { Authorization: 'Bearer synth_x' },
    )

    expect(res.status).toBe(204)
    expect(broadcastGlobal).toHaveBeenCalledWith({
      type: 'dashboard_status_changed',
      agentSlug: 'agent-1',
      dashboardSlug: 'sales-dashboard',
      status: 'running',
    })
  })

  it('rejects a token belonging to another agent', async () => {
    validateProxyToken.mockResolvedValue('agent-2')

    const res = await post(
      '/agent-1/events/dashboard-status-changed',
      { dashboardSlug: 'sales-dashboard', status: 'running' },
      { Authorization: 'Bearer synth_other' },
    )

    expect(res.status).toBe(403)
    expect(broadcastGlobal).not.toHaveBeenCalled()
  })

  it('rejects non-terminal statuses', async () => {
    validateProxyToken.mockResolvedValue('agent-1')

    const res = await post(
      '/agent-1/events/dashboard-status-changed',
      { dashboardSlug: 'sales-dashboard', status: 'starting' },
      { Authorization: 'Bearer synth_x' },
    )

    expect(res.status).toBe(400)
    expect(broadcastGlobal).not.toHaveBeenCalled()
  })

  it('rejects unsafe dashboard slugs', async () => {
    validateProxyToken.mockResolvedValue('agent-1')

    const res = await post(
      '/agent-1/events/dashboard-status-changed',
      { dashboardSlug: '../sales', status: 'running' },
      { Authorization: 'Bearer synth_x' },
    )

    expect(res.status).toBe(400)
    expect(broadcastGlobal).not.toHaveBeenCalled()
  })
})

describe('POST /:agentSlug/events/undelivered-turn', () => {
  const report = {
    sessionId: 'session-1',
    resultSubtype: 'success',
    closeCode: 1006,
    closeReason: '',
    closedAt: '2026-09-29T17:00:00.000Z',
    msSinceClose: 4200,
    socketAgeMs: 900_000,
    idleMsBeforeClose: 120_000,
    socketError: 'ECONNRESET',
  }

  it('reports a turn the host is still stuck on', async () => {
    validateProxyToken.mockResolvedValue('agent-1')
    isSessionActive.mockReturnValue(true)
    isSubscribed.mockReturnValue(true)

    const res = await post('/agent-1/events/undelivered-turn', report, { Authorization: 'Bearer synth_x' })

    expect(res.status).toBe(204)
    expect(captureException).toHaveBeenCalledTimes(1)
    const [err, context] = captureException.mock.calls[0]
    expect((err as Error).message).toBe('Session turn ended after its stream socket dropped')
    expect(isSessionActive).toHaveBeenCalledWith('agent-1', 'session-1')
    expect(context).toEqual({
      tags: {
        component: 'container',
        operation: 'undelivered-turn',
        containerRunner: 'apple-container',
        closeCode: '1006',
      },
      extra: {
        agentId: 'agent-1',
        sessionId: 'session-1',
        resultSubtype: 'success',
        closeReason: '',
        closedAt: '2026-09-29T17:00:00.000Z',
        msSinceClose: 4200,
        socketAgeMs: 900_000,
        idleMsBeforeClose: 120_000,
        socketError: 'ECONNRESET',
      },
    })
  })

  it.each([
    { active: false, subscribed: true },
    { active: true, subscribed: false },
    { active: false, subscribed: false },
  ])('does not report when the host is not stuck (%j)', async ({ active, subscribed }) => {
    validateProxyToken.mockResolvedValue('agent-1')
    isSessionActive.mockReturnValue(active)
    isSubscribed.mockReturnValue(subscribed)

    const res = await post('/agent-1/events/undelivered-turn', report, { Authorization: 'Bearer synth_x' })

    expect(res.status).toBe(204)
    expect(captureException).not.toHaveBeenCalled()
  })

  it('accepts a report from an older agent image without the socket details', async () => {
    validateProxyToken.mockResolvedValue('agent-1')
    isSessionActive.mockReturnValue(true)
    isSubscribed.mockReturnValue(true)

    const res = await post(
      '/agent-1/events/undelivered-turn',
      { sessionId: 'session-1', resultSubtype: 'success', closeCode: 1006, closeReason: '', msSinceClose: 4200 },
      { Authorization: 'Bearer synth_x' },
    )

    expect(res.status).toBe(204)
    expect(captureException).toHaveBeenCalledTimes(1)
  })

  it('rejects a token belonging to another agent', async () => {
    validateProxyToken.mockResolvedValue('agent-2')

    const res = await post('/agent-1/events/undelivered-turn', report, { Authorization: 'Bearer synth_other' })

    expect(res.status).toBe(403)
    expect(captureException).not.toHaveBeenCalled()
  })

  it('rejects a malformed report', async () => {
    validateProxyToken.mockResolvedValue('agent-1')

    const res = await post('/agent-1/events/undelivered-turn', { sessionId: 'session-1' }, { Authorization: 'Bearer synth_x' })

    expect(res.status).toBe(400)
    expect(captureException).not.toHaveBeenCalled()
  })
})
