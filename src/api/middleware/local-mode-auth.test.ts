import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

const mockIsAuthMode = vi.fn<() => boolean>()
vi.mock('@shared/lib/auth/mode', () => ({
  isAuthMode: () => mockIsAuthMode(),
}))

const mockGetConnInfo = vi.fn<() => { remote: { address?: string } }>()
vi.mock('@hono/node-server/conninfo', () => ({
  getConnInfo: () => mockGetConnInfo(),
}))

// Import after mocks
import { LocalModeAuth, isContainerFacingPath } from './local-mode-auth'

// ---------------------------------------------------------------------------
// isContainerFacingPath — the bypass list. This is the actual regression
// surface: x-agent calls 403'd on WSL2 because /api/x-agent/ was omitted here.
// ---------------------------------------------------------------------------

describe('isContainerFacingPath', () => {
  it('bypasses every container→host endpoint', () => {
    expect(isContainerFacingPath('/api/proxy/agent-1/foo')).toBe(true)
    expect(isContainerFacingPath('/api/mcp-proxy/agent-1/call')).toBe(true)
    expect(isContainerFacingPath('/api/browser/agent-1/screenshot')).toBe(true)
  })

  // Regression: cross-agent calls (list/invoke/get-sessions and x-agent/chat)
  // are container-facing and authenticate via the proxy bearer token. Omitting
  // them here made LocalModeAuth 403 every call from a non-loopback container
  // (WSL2's 172.x NAT gateway), even with all cross-agent permissions Allowed.
  it('bypasses x-agent routes (main router and chat)', () => {
    expect(isContainerFacingPath('/api/x-agent/list')).toBe(true)
    expect(isContainerFacingPath('/api/x-agent/invoke')).toBe(true)
    expect(isContainerFacingPath('/api/x-agent/get-sessions')).toBe(true)
    expect(isContainerFacingPath('/api/x-agent/chat/send')).toBe(true)
  })

  // Regression: the web-search route is container-facing (the in-container tool
  // RPCs to it via the proxy bearer token), so it must bypass the localhost check
  // like the other container→host routes.
  it('bypasses the web-search route', () => {
    expect(isContainerFacingPath('/api/web-search/search')).toBe(true)
  })

  it('does NOT bypass browser-facing API routes', () => {
    expect(isContainerFacingPath('/api/agents')).toBe(false)
    expect(isContainerFacingPath('/api/agents/foo/x-agent-policies')).toBe(false)
    expect(isContainerFacingPath('/api/settings')).toBe(false)
    expect(isContainerFacingPath('/api/connected-accounts')).toBe(false)
  })

  it('respects the prefix boundary (no lookalike-path leakage)', () => {
    // A route that merely starts with the prefix string but isn't under it.
    expect(isContainerFacingPath('/api/x-agentstuff')).toBe(false)
    expect(isContainerFacingPath('/api/proxydashboard')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// LocalModeAuth — the localhost IP restriction itself.
// ---------------------------------------------------------------------------

describe('LocalModeAuth', () => {
  const originalProcessType = (process as { type?: string }).type

  beforeEach(() => {
    vi.clearAllMocks()
    // Simulate the packaged Electron main process, where the restriction is
    // actually active. In the Vite dev server process.type is undefined.
    ;(process as { type?: string }).type = 'browser'
    mockIsAuthMode.mockReturnValue(false)
  })

  afterEach(() => {
    if (originalProcessType === undefined) {
      delete (process as { type?: string }).type
    } else {
      ;(process as { type?: string }).type = originalProcessType
    }
  })

  function buildApp() {
    const app = new Hono()
    app.use('*', LocalModeAuth())
    app.get('/', (c) => c.json({ ok: true }))
    return app
  }

  it('allows loopback callers in Electron local mode', async () => {
    for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      mockGetConnInfo.mockReturnValue({ remote: { address: addr } })
      const res = await buildApp().request('/')
      expect(res.status, `addr ${addr}`).toBe(200)
    }
  })

  // The WSL2 case: container reaches the host across the NAT bridge, so the
  // host sees the distro's 172.x gateway IP — not loopback.
  it('blocks a non-loopback (container/WSL2) caller with 403 Forbidden', async () => {
    mockGetConnInfo.mockReturnValue({ remote: { address: '172.22.192.5' } })
    const res = await buildApp().request('/')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
  })

  it('blocks when the remote address is missing', async () => {
    mockGetConnInfo.mockReturnValue({ remote: {} })
    const res = await buildApp().request('/')
    expect(res.status).toBe(403)
  })

  it('skips the restriction entirely in auth mode', async () => {
    mockIsAuthMode.mockReturnValue(true)
    mockGetConnInfo.mockReturnValue({ remote: { address: '172.22.192.5' } })
    const res = await buildApp().request('/')
    expect(res.status).toBe(200)
  })

  // The Vite dev server / web deployment: not the Electron main process, so the
  // IP restriction is off (infra handles network security). This is why the bug
  // was invisible in `npm run dev`.
  it('skips the restriction when not in the Electron main process', async () => {
    delete (process as { type?: string }).type
    mockGetConnInfo.mockReturnValue({ remote: { address: '172.22.192.5' } })
    const res = await buildApp().request('/')
    expect(res.status).toBe(200)
  })
})
