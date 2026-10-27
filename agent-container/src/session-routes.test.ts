import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionBundle } from './browser-session-schema'

vi.mock('./browser-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-session')>()
  return { ...actual, captureSession: vi.fn(), restoreSession: vi.fn() }
})
const session = await import('./browser-session')
const { registerSessionRoutes } = await import('./session-routes')

const cdp = { close: vi.fn() }
const deps = {
  hostAuthEnabled: vi.fn(() => true),
  validateSession: vi.fn((): string | null => null),
  browserActive: vi.fn(() => true),
  connectBrowser: vi.fn(async () => cdp as never),
  activeTabId: vi.fn(async (): Promise<string | null> => 'tab-1'),
  observeUrl: vi.fn(async () => ({ url: 'https://github.com/', navigated: true })),
  pageReplaced: vi.fn(),
}

const BUNDLE: SessionBundle = {
  version: 1,
  site: 'github.com',
  capturedAt: '2026-10-26T00:00:00.000Z',
  cookies: [{ name: 'user_session', value: 'the-secret-session', domain: 'github.com', path: '/', httpOnly: true, secure: true }],
  origins: [{ origin: 'https://github.com', localStorage: [['token', 'the-secret-token']], indexedDB: [] }],
}

const scope = { sessionId: 's-1', site: 'github.com', origin: 'https://github.com' }

let app: Hono
const post = (path: string, body: unknown) => app.request(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

beforeEach(() => {
  vi.clearAllMocks()
  deps.hostAuthEnabled.mockReturnValue(true)
  deps.validateSession.mockReturnValue(null)
  deps.browserActive.mockReturnValue(true)
  deps.activeTabId.mockResolvedValue('tab-1')
  app = new Hono()
  registerSessionRoutes(app, deps)
})

describe('session routes', () => {
  it('answer only the host', async () => {
    deps.hostAuthEnabled.mockReturnValue(false)
    expect((await post('/browser/session/capture', scope)).status).toBe(503)
    expect((await post('/browser/session/restore', { ...scope, bundle: BUNDLE })).status).toBe(503)
    expect(session.captureSession).not.toHaveBeenCalled()
  })

  it('refuse a request for another site, without echoing what it carried', async () => {
    for (const body of [
      { ...scope, origin: 'https://evil.com' },
      { ...scope, site: 'GitHub.com' },
      { ...scope, extra: true },
      { ...scope, bundle: { ...BUNDLE, site: 'gitlab.com' } },
      null,
    ]) {
      const path = body && 'bundle' in body ? '/browser/session/restore' : '/browser/session/capture'
      const response = await post(path, body)
      expect(response.status).toBe(400)
      expect(await response.text()).not.toContain('the-secret')
    }
    expect(session.restoreSession).not.toHaveBeenCalled()
  })

  it('refuse a session that does not hold the browser, or a closed browser', async () => {
    deps.validateSession.mockReturnValue('Browser is owned by session s-2')
    expect((await post('/browser/session/capture', scope)).status).toBe(409)
    deps.validateSession.mockReturnValue(null)
    deps.browserActive.mockReturnValue(false)
    const refused = await post('/browser/session/restore', { ...scope, bundle: BUNDLE })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ touched: false })
  })

  it('return a capture, or that nothing changed, and close the connection', async () => {
    vi.mocked(session.captureSession).mockResolvedValueOnce({ unchanged: true, cookieHash: 'h' })
    const unchanged = await post('/browser/session/capture', { ...scope, unlessCookieHash: 'h' })
    expect(await unchanged.json()).toEqual({ unchanged: true, cookieHash: 'h' })
    expect(session.captureSession).toHaveBeenCalledWith(cdp, { site: 'github.com', origin: 'https://github.com' }, { unlessCookieHash: 'h' })
    expect(cdp.close).toHaveBeenCalled()
    expect(unchanged.headers.get('cache-control')).toBe('no-store')
  })

  it('say a capture too large to keep is that', async () => {
    vi.mocked(session.captureSession).mockRejectedValueOnce(new session.SessionTooLargeError('too much'))
    expect((await post('/browser/session/capture', scope)).status).toBe(413)
  })

  it('restore into the agent\'s tab and report where the page is, never the session', async () => {
    vi.mocked(session.restoreSession).mockResolvedValueOnce({ skippedRecords: 0, cookieHash: 'h' })
    const response = await post('/browser/session/restore', { ...scope, bundle: BUNDLE })
    const body = await response.json()
    expect(body).toEqual({ restored: true, skippedRecords: 0, cookieHash: 'h', observation: { digest: { url: 'https://github.com/', navigated: true } } })
    expect(JSON.stringify(body)).not.toContain('the-secret')
    expect(session.restoreSession).toHaveBeenCalledWith(cdp, { site: 'github.com', origin: 'https://github.com' }, BUNDLE, 'tab-1')
    expect(deps.pageReplaced).toHaveBeenCalled()
  })

  it('say whether a failed restore changed the browser and emptied the site', async () => {
    vi.mocked(session.restoreSession).mockRejectedValueOnce(new session.SessionRestoreError('IndexedDB.open: failed', true, true))
    const failed = await post('/browser/session/restore', { ...scope, bundle: BUNDLE })
    expect(failed.status).toBe(500)
    expect(await failed.json()).toMatchObject({ touched: true, cleared: true })

    deps.activeTabId.mockResolvedValueOnce(null)
    expect(await (await post('/browser/session/restore', { ...scope, bundle: BUNDLE })).json()).toMatchObject({ touched: false, cleared: false })
    deps.connectBrowser.mockRejectedValueOnce(new Error('Could not connect to the browser'))
    expect(await (await post('/browser/session/restore', { ...scope, bundle: BUNDLE })).json()).toMatchObject({ touched: false, cleared: false })
  })

  it('run one operation at a time', async () => {
    let release = () => {}
    vi.mocked(session.restoreSession).mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ skippedRecords: 0, cookieHash: 'h' }) }))
    vi.mocked(session.captureSession).mockResolvedValueOnce({ unchanged: true, cookieHash: 'h' })
    const restoring = post('/browser/session/restore', { ...scope, bundle: BUNDLE })
    await vi.waitFor(() => expect(session.restoreSession).toHaveBeenCalled())
    const capturing = post('/browser/session/capture', scope)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(session.captureSession).not.toHaveBeenCalled()
    release()
    await restoring
    await capturing
    expect(session.captureSession).toHaveBeenCalled()
  })
})
