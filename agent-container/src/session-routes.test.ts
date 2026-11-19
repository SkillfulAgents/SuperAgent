import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionBundle } from './browser-session-schema'

vi.mock('./browser-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-session')>()
  return { ...actual, captureSession: vi.fn(), restoreSession: vi.fn() }
})
const session = await import('./browser-session')
const { registerSessionRoutes } = await import('./session-routes')
const { browserCommand } = await import('./browser-gate')

const cdp = { close: vi.fn() }
const deps = {
  hostAuthEnabled: vi.fn(() => true),
  validateSession: vi.fn((): string | null => null),
  browserActive: vi.fn(() => true),
  connectBrowser: vi.fn(async () => cdp as never),
  activeTabId: vi.fn(async (): Promise<string | null> => 'tab-1'),
  keepActiveTab: vi.fn(<T>(work: () => Promise<T>) => work()),
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
const NOTHING_OUTSIDE = { outside: [], tabSite: null }

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
  deps.keepActiveTab.mockImplementation(<T>(work: () => Promise<T>) => work())
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

  it('return a capture with its fingerprint, or the fingerprint alone, and close the connection', async () => {
    vi.mocked(session.captureSession).mockResolvedValueOnce({ hash: 'h', unsupported: [], ...NOTHING_OUTSIDE })
    const unchanged = await post('/browser/session/capture', { ...scope, unlessHash: 'h' })
    expect(await unchanged.json()).toEqual({ hash: 'h' })
    expect(session.captureSession).toHaveBeenCalledWith(cdp, { site: 'github.com', origin: 'https://github.com' }, { unlessHash: 'h', peek: undefined, tabId: 'tab-1' })
    expect(cdp.close).toHaveBeenCalled()
    expect(unchanged.headers.get('cache-control')).toBe('no-store')

    vi.mocked(session.captureSession).mockResolvedValueOnce({ hash: 'h2', bundle: BUNDLE, unsupported: [], ...NOTHING_OUTSIDE })
    expect(await (await post('/browser/session/capture', { ...scope, peek: true })).json()).toEqual({ hash: 'h2', bundle: BUNDLE })
    expect(vi.mocked(session.captureSession).mock.lastCall?.[2]).toMatchObject({ peek: true })
  })

  it('take a site written as a URL\'s host is, a container name or an IPv6 address', async () => {
    vi.mocked(session.captureSession).mockResolvedValue({ hash: 'h', unsupported: [], ...NOTHING_OUTSIDE })
    expect((await post('/browser/session/capture', { ...scope, site: 'web_1:8000', origin: 'http://web_1:8000' })).status).toBe(200)
    expect((await post('/browser/session/capture', { ...scope, site: '[::1]:3000', origin: 'http://[::1]:3000' })).status).toBe(200)
  })

  it('log what changed outside the site since the sign-in step, each change once, and send none of it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const signIn = { sessionId: 's-1', site: 'sso.accounts.dowjones.com', origin: 'https://sso.accounts.dowjones.com' }
    const app = (valueHash: string) => [{ key: '["www.wsj.com","/","wsj_session",null]', domain: 'www.wsj.com', valueHash }]
    const tracker = { key: '[".adnxs.com","/","uuid2",null]', domain: '.adnxs.com', valueHash: 't1' }
    vi.mocked(session.captureSession)
      .mockResolvedValueOnce({ hash: 'h', unsupported: [], outside: [], tabSite: 'sso.accounts.dowjones.com' })
      .mockResolvedValueOnce({ hash: 'h', unsupported: [], outside: app('v1'), tabSite: 'wsj.com' })
      .mockResolvedValueOnce({ hash: 'h', unsupported: [], outside: app('v1'), tabSite: 'wsj.com' })
      .mockResolvedValueOnce({ hash: 'h', unsupported: [], outside: [...app('v2'), tracker], tabSite: 'wsj.com' })

    await post('/browser/session/capture', { ...signIn, peek: true })
    const look = await post('/browser/session/capture', { ...signIn, unlessHash: 'h' })
    await post('/browser/session/capture', { ...signIn, unlessHash: 'h' })
    await post('/browser/session/capture', { ...signIn, unlessHash: 'h' })

    expect(await look.json()).toEqual({ hash: 'h' })
    const lines = log.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith('[Session] Outside'))
    // The last look: the app's cookie is still one new since the step, and a tracker's alone moved: no second line.
    expect(lines).toEqual([
      '[Session] Outside sso.accounts.dowjones.com since the sign-in step: on the tab\'s site wsj.com: www.wsj.com 1 new · no other domain',
    ])
    expect(lines.join('\n')).not.toContain('wsj_session')
    log.mockRestore()
  })

  it('log nothing outside a site no sign-in step peeked at', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.mocked(session.captureSession).mockResolvedValueOnce({
      hash: 'h', unsupported: [], outside: [{ key: 'k', domain: 'www.wsj.com', valueHash: 'v' }], tabSite: 'wsj.com',
    })

    await post('/browser/session/capture', { ...scope, sessionId: 's-other', unlessHash: 'h' })

    expect(log.mock.calls.some(([line]) => String(line).startsWith('[Session] Outside'))).toBe(false)
    log.mockRestore()
  })

  it('keep agent-browser on the agent\'s tab while a capture or a restore runs', async () => {
    const order: string[] = []
    deps.keepActiveTab.mockImplementation(async <T>(work: () => Promise<T>) => {
      order.push('pin')
      try {
        return await work()
      } finally {
        order.push('unpin')
      }
    })
    vi.mocked(session.captureSession).mockImplementationOnce(async () => {
      order.push('capture')
      return { hash: 'h', unsupported: [], ...NOTHING_OUTSIDE }
    })
    vi.mocked(session.restoreSession).mockImplementationOnce(async () => {
      order.push('restore')
      return { skippedRecords: 0, settled: null }
    })

    expect((await post('/browser/session/capture', scope)).status).toBe(200)
    expect((await post('/browser/session/restore', { ...scope, bundle: BUNDLE })).status).toBe(200)
    expect(order).toEqual(['pin', 'capture', 'unpin', 'pin', 'restore', 'unpin'])
  })

  it('say a capture too large to keep is that', async () => {
    vi.mocked(session.captureSession).mockRejectedValueOnce(new session.SessionTooLargeError('too much'))
    expect((await post('/browser/session/capture', scope)).status).toBe(413)
  })

  it('restore into the agent\'s tab and report where the page is once it settled, never the session', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.mocked(session.restoreSession).mockResolvedValueOnce({ skippedRecords: 0, settled: { waitedMs: 3_420, movedTo: 'github.com' } })
    const response = await post('/browser/session/restore', { ...scope, bundle: BUNDLE })
    const body = await response.json()
    expect(body).toEqual({ restored: true, skippedRecords: 0, observation: { digest: { url: 'https://github.com/', navigated: true } } })
    expect(JSON.stringify(body)).not.toContain('the-secret')
    expect(session.restoreSession).toHaveBeenCalledWith(cdp, { site: 'github.com', origin: 'https://github.com' }, BUNDLE, 'tab-1')
    expect(deps.pageReplaced).toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('[Session] Restored github.com; the tab settled 3.4 s after loading, gone on to github.com')
    log.mockRestore()
  })

  it('say whether a failed restore moved the page, changed the site and emptied it', async () => {
    vi.mocked(session.restoreSession).mockRejectedValueOnce(new session.SessionRestoreError('IndexedDB.open: failed', true, true, true))
    const failed = await post('/browser/session/restore', { ...scope, bundle: BUNDLE })
    expect(failed.status).toBe(500)
    expect(await failed.json()).toMatchObject({ touched: true, changed: true, cleared: true })

    deps.activeTabId.mockResolvedValueOnce(null)
    expect(await (await post('/browser/session/restore', { ...scope, bundle: BUNDLE })).json()).toMatchObject({ touched: false, changed: false, cleared: false })
    deps.connectBrowser.mockRejectedValueOnce(new Error('Could not connect to the browser'))
    expect(await (await post('/browser/session/restore', { ...scope, bundle: BUNDLE })).json()).toMatchObject({ touched: false, changed: false, cleared: false })
  })

  it('run one operation at a time, and none while an agent-browser command runs', async () => {
    let release = () => {}
    vi.mocked(session.restoreSession).mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ skippedRecords: 0, settled: null }) }))
    vi.mocked(session.captureSession).mockResolvedValueOnce({ hash: 'h', unsupported: [], ...NOTHING_OUTSIDE })
    const restoring = post('/browser/session/restore', { ...scope, bundle: BUNDLE })
    await vi.waitFor(() => expect(session.restoreSession).toHaveBeenCalled())
    const capturing = post('/browser/session/capture', scope)
    let commandRan = false
    const command = browserCommand(async () => { commandRan = true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(session.captureSession).not.toHaveBeenCalled()
    expect(commandRan).toBe(false)
    release()
    await Promise.all([restoring, capturing, command])
    expect(session.captureSession).toHaveBeenCalled()
    expect(commandRan).toBe(true)
  })

  it('check again that the browser is the session\'s once the request\'s turn comes', async () => {
    let release = () => {}
    vi.mocked(session.restoreSession).mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ skippedRecords: 0, settled: null }) }))
    const restoring = post('/browser/session/restore', { ...scope, bundle: BUNDLE })
    await vi.waitFor(() => expect(session.restoreSession).toHaveBeenCalled())
    const capturing = post('/browser/session/capture', scope)
    const restoringAgain = post('/browser/session/restore', { ...scope, bundle: BUNDLE })
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Another session took the browser while these waited.
    deps.validateSession.mockReturnValue('Browser is owned by session s-2')
    release()
    await restoring
    expect((await capturing).status).toBe(409)
    const refused = await restoringAgain
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ touched: false, changed: false, cleared: false })
    expect(session.captureSession).not.toHaveBeenCalled()
    expect(session.restoreSession).toHaveBeenCalledTimes(1)
  })
})
