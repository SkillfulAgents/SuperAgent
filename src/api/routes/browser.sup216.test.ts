import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// ---------------------------------------------------------------------------
// SUP-216 — Electron host-browser routes must bind the IsAgent token to the
// agent it acts on. The /api/browser/* routes authenticate with IsAgent() (any
// valid container proxy token) but then trust the attacker-controlled
// body.agentId. A container holding agent-a's token must NOT be able to
// launch/stop/inspect agent-b's host browser by sending { agentId: 'agent-b' }.
//
// These tests mount the REAL browser routes and the REAL IsAgent() middleware,
// with validateProxyToken mocked to resolve the bearer token to 'agent-a' and
// getActiveProvider() returning a spy provider. The secure contract is: for a
// cross-agent request the route either returns 403, OR it operates strictly on
// the token's own agent ('agent-a') and NEVER passes the attacker's 'agent-b'
// to provider.launch/stop/getDebugInfo.
// ---------------------------------------------------------------------------

// validateProxyToken resolves the bearer token to an agent slug (real shape:
// string | null). IsAgent() must stash that slug on the Hono context.
const mockValidateProxyToken = vi.fn<(token: string) => Promise<string | null>>()
vi.mock('@shared/lib/proxy/token-store', () => ({
  validateProxyToken: (token: string) => mockValidateProxyToken(token),
}))

// Spy host-browser provider — records exactly which instanceId/agentId reaches it.
const mockProvider = {
  launch: vi.fn(),
  stop: vi.fn(),
  getDebugInfo: vi.fn(),
}
const mockGetActiveProvider = vi.fn<() => typeof mockProvider | null>(() => mockProvider)
vi.mock('../../main/host-browser', () => ({
  getActiveProvider: () => mockGetActiveProvider(),
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

// auth.ts dependencies — we deliberately use the REAL IsAgent() so the token →
// slug binding is exercised end to end. IsAgent() never touches the db / auth
// mode, so these are minimal stubs to keep the import graph light.
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => false }))
vi.mock('@shared/lib/platform-attribution', () => ({
  runWithRequestUser: (_id: string, fn: () => unknown) => fn(),
}))
vi.mock('@shared/lib/db', () => ({ db: {} }))
vi.mock('@shared/lib/db/schema', () => ({
  agentAcl: {}, connectedAccounts: {}, remoteMcpServers: {}, notifications: {},
}))

// Import after mocks.
import browser from './browser'
import { IsAgent } from '../middleware/auth'

const TOKEN = 'agent-a-token'
const TOKEN_SLUG = 'agent-a'
const ATTACKER_AGENT = 'agent-b'

function appWithBrowser() {
  const app = new Hono()
  app.route('/api/browser', browser)
  return app
}

function post(path: string, body: unknown, token = TOKEN) {
  return appWithBrowser().request(`http://localhost/api/browser/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
}

/** The attacker-supplied agent id must never reach the provider in any call. */
function expectNeverActedOnAgent(spy: typeof mockProvider.launch, badAgentId: string) {
  for (const call of spy.mock.calls) {
    expect(call).not.toContain(badAgentId)
  }
}

/** When the route does act, it must act strictly on the token's own agent. */
function expectActedOnlyOnTokenAgent(spy: typeof mockProvider.launch) {
  expect(spy).toHaveBeenCalled()
  for (const call of spy.mock.calls) {
    expect(call[0]).toBe(TOKEN_SLUG)
  }
}

describe('SUP-216: host-browser routes bind IsAgent token to the acted-on agent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetActiveProvider.mockReturnValue(mockProvider)
    mockProvider.launch.mockResolvedValue({ port: 9222 })
    mockProvider.stop.mockResolvedValue(undefined)
    mockProvider.getDebugInfo.mockResolvedValue({ pages: [] })
    // Token resolves to agent-a regardless of the requested agentId.
    mockValidateProxyToken.mockResolvedValue(TOKEN_SLUG)
  })

  // -------------------------------------------------------------------------
  // Cross-agent IDOR: attacker token (agent-a) + body { agentId: 'agent-b' }
  // -------------------------------------------------------------------------

  it('launch-host-browser: must not launch another agent\'s browser via body.agentId', async () => {
    const res = await post('launch-host-browser', { agentId: ATTACKER_AGENT })

    expectNeverActedOnAgent(mockProvider.launch, ATTACKER_AGENT)
    if (res.status !== 403) {
      expectActedOnlyOnTokenAgent(mockProvider.launch)
    }
  })

  it('stop-host-browser: must not stop another agent\'s browser via body.agentId', async () => {
    const res = await post('stop-host-browser', { agentId: ATTACKER_AGENT })

    expectNeverActedOnAgent(mockProvider.stop, ATTACKER_AGENT)
    if (res.status !== 403) {
      expectActedOnlyOnTokenAgent(mockProvider.stop)
    }
  })

  it('debug-info: must not leak another agent\'s CDP/screencast info via body.agentId', async () => {
    const res = await post('debug-info', { agentId: ATTACKER_AGENT })

    expectNeverActedOnAgent(mockProvider.getDebugInfo, ATTACKER_AGENT)
    if (res.status !== 403) {
      expectActedOnlyOnTokenAgent(mockProvider.getDebugInfo)
    }
  })

  // -------------------------------------------------------------------------
  // Positive / regression: legitimate container drives ITS OWN agent.
  // -------------------------------------------------------------------------

  it('launch-host-browser: acts on the token agent when body.agentId matches', async () => {
    const res = await post('launch-host-browser', { agentId: TOKEN_SLUG })
    expect(res.status).toBe(200)
    expectActedOnlyOnTokenAgent(mockProvider.launch)
  })

  it('launch-host-browser: acts on the token agent when body.agentId is omitted', async () => {
    const res = await post('launch-host-browser', {})
    expect(res.status).toBe(200)
    expectActedOnlyOnTokenAgent(mockProvider.launch)
    expectNeverActedOnAgent(mockProvider.launch, 'default')
  })

  it('debug-info: returns the token agent\'s debug info when body.agentId matches', async () => {
    const res = await post('debug-info', { agentId: TOKEN_SLUG })
    expect(res.status).toBe(200)
    expectActedOnlyOnTokenAgent(mockProvider.getDebugInfo)
  })

  it('rejects requests without a valid proxy token (IsAgent gate intact)', async () => {
    mockValidateProxyToken.mockResolvedValue(null)
    const res = await post('launch-host-browser', { agentId: TOKEN_SLUG })
    expect(res.status).toBe(401)
    expect(mockProvider.launch).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Middleware companion: IsAgent() stashes the resolved slug on context.
  // -------------------------------------------------------------------------

  it('IsAgent() stashes the resolved agent slug on the Hono context', async () => {
    mockValidateProxyToken.mockResolvedValue(TOKEN_SLUG)
    let captured: unknown = null
    const app = new Hono()
    app.get('/probe', IsAgent(), (c) => {
      captured = c.get('agentSlug' as never)
      return c.json({ ok: true })
    })

    const res = await app.request('http://localhost/probe', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })

    expect(res.status).toBe(200)
    expect(captured).toBe(TOKEN_SLUG)
  })
})
