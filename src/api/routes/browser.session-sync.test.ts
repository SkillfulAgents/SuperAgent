import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// ---------------------------------------------------------------------------
// /api/browser/session-sync — a container that just opened a page asks for a
// newer saved session of the account its browser holds on that site. The
// route must act for the token's agent only, check the body, and answer only
// whether a session went in.
// ---------------------------------------------------------------------------

const mockValidateProxyToken = vi.fn<(token: string) => Promise<string | null>>()
vi.mock('@shared/lib/proxy/token-store', () => ({
  validateProxyToken: (token: string) => mockValidateProxyToken(token),
}))

const mockSync = vi.fn<(input: { agentSlug: string; sessionId: string; url: string }) => Promise<boolean>>()
vi.mock('@shared/lib/browser-vault/session-host', () => ({
  syncSessionOnOpen: (input: { agentSlug: string; sessionId: string; url: string }) => mockSync(input),
}))

vi.mock('../../main/host-browser', () => ({
  getActiveProvider: () => null,
  setOnExternalClose: vi.fn(),
}))
vi.mock('@shared/lib/config/settings', () => ({ getSettings: () => ({ app: {} }) }))
vi.mock('@shared/lib/container/container-host', async () => {
  const { hostFromManagerMock } = await import('@shared/lib/agent-actor/testing/host-from-manager-mock')
  return { containerHost: hostFromManagerMock({ getClient: () => ({ fetch: vi.fn() }) }) }
})
// auth.ts dependencies — the REAL IsAgent() binds the token to its agent.
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => false }))
vi.mock('@shared/lib/platform-attribution', () => ({
  runWithRequestUser: (_id: string, fn: () => unknown) => fn(),
  runWithOptionalUser: (_id: string | null | undefined, fn: () => unknown) => fn(),
}))
vi.mock('@shared/lib/db', () => ({ db: {} }))
vi.mock('@shared/lib/db/schema', () => ({
  agentAcl: {}, connectedAccounts: {}, remoteMcpServers: {}, notifications: {},
}))

import browser from './browser'

function post(body: unknown, token = 'agent-a-token') {
  const app = new Hono()
  app.route('/api/browser', browser)
  return app.request('http://localhost/api/browser/session-sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidateProxyToken.mockImplementation(async (token) => (token === 'agent-a-token' ? 'agent-a' : null))
  mockSync.mockResolvedValue(true)
})

describe('POST /api/browser/session-sync', () => {
  it('syncs for the token\'s agent and says whether a session went in', async () => {
    const res = await post({ sessionId: 's-1', url: 'https://github.com/' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ restored: true })
    expect(mockSync).toHaveBeenCalledWith({ agentSlug: 'agent-a', sessionId: 's-1', url: 'https://github.com/' })
  })

  it('refuses a caller without an agent\'s token, and a malformed body', async () => {
    expect((await post({ sessionId: 's-1', url: 'https://github.com/' }, 'nope')).status).toBe(401)
    expect((await post({ sessionId: 's-1' })).status).toBe(400)
    expect((await post({ sessionId: 's-1', url: 'https://github.com/', agentSlug: 'agent-b' })).status).toBe(400)
    expect(mockSync).not.toHaveBeenCalled()
  })
})
