import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// ---------------------------------------------------------------------------
// /api/browser/report-launch-error — a container relays a browser-launch
// failure that happened on its side (after launch-host-browser succeeded) so
// the host can report it to Sentry. The route must:
//   - capture the relayed message with the token-bound agentId (never the raw
//     body agentId),
//   - reject cross-agent reports (body agentId ≠ token agent) without
//     capturing,
//   - reject malformed bodies without capturing.
// ---------------------------------------------------------------------------

const mockValidateProxyToken = vi.fn<(token: string) => Promise<string | null>>()
vi.mock('@shared/lib/proxy/token-store', () => ({
  validateProxyToken: (token: string) => mockValidateProxyToken(token),
}))

const mockCaptureException = vi.fn()
vi.mock('@shared/lib/error-reporting', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}))

vi.mock('../../main/host-browser', () => ({
  getActiveProvider: () => null,
  setOnExternalClose: vi.fn(),
}))

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({ app: {} }),
}))

vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: { getClient: () => ({ fetch: vi.fn() }) },
}))

vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: { broadcastGlobal: vi.fn() },
}))

// auth.ts dependencies — use the REAL IsAgent() so the token → slug binding is
// exercised end to end; these stubs keep its import graph light.
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => false }))
vi.mock('@shared/lib/platform-attribution', () => ({
  runWithRequestUser: (_id: string, fn: () => unknown) => fn(),
  runWithOptionalUser: (_id: string | null | undefined, fn: () => unknown) => fn(),
}))
vi.mock('@shared/lib/db', () => ({ db: {} }))
vi.mock('@shared/lib/db/schema', () => ({
  agentAcl: {}, connectedAccounts: {}, remoteMcpServers: {}, notifications: {},
}))

// Import after mocks.
import browser from './browser'

const TOKEN = 'agent-a-token'
const TOKEN_SLUG = 'agent-a'

function post(body: unknown) {
  const app = new Hono()
  app.route('/api/browser', browser)
  return app.request('http://localhost/api/browser/report-launch-error', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidateProxyToken.mockResolvedValue(TOKEN_SLUG)
})

describe('POST /api/browser/report-launch-error', () => {
  it('captures the relayed error under the token-bound agent', async () => {
    const res = await post({
      agentId: TOKEN_SLUG,
      stage: 'resolve-cdp-host',
      message: 'Failed to resolve host.docker.internal (ENOTFOUND)',
    })

    expect(res.status).toBe(200)
    expect(mockCaptureException).toHaveBeenCalledTimes(1)
    const [err, context] = mockCaptureException.mock.calls[0]
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('Failed to resolve host.docker.internal (ENOTFOUND)')
    expect(context).toEqual({
      tags: { component: 'browser', operation: 'container-launch-failure', stage: 'resolve-cdp-host' },
      extra: { agentId: TOKEN_SLUG },
    })
  })

  it('rejects a cross-agent report without capturing', async () => {
    const res = await post({
      agentId: 'agent-b',
      stage: 'resolve-cdp-host',
      message: 'spoofed',
    })

    expect(res.status).toBe(403)
    expect(mockCaptureException).not.toHaveBeenCalled()
  })

  it('rejects a malformed body without capturing', async () => {
    const res = await post({ stage: 'resolve-cdp-host' })

    expect(res.status).toBe(400)
    expect(mockCaptureException).not.toHaveBeenCalled()
  })
})
