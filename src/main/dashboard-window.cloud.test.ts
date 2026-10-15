import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'

/**
 * Cloud dashboards load at the workspace's own address and main signs their
 * requests. Covered here: which requests are signed, how a signed response is
 * cleaned and retried, and where a popout opens, what it is keyed by and how it
 * is marked.
 */

type FakeWindow = {
  webContents: {
    id: number
    setWindowOpenHandler: ReturnType<typeof vi.fn>
    downloadURL: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
    executeJavaScript: ReturnType<typeof vi.fn>
  }
  loadURL: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  setTitle: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  removeMenu: ReturnType<typeof vi.fn>
  options: Record<string, any>
  handlers: Record<string, (...args: any[]) => void>
}

const { createdWindows, workspace, refresh } = vi.hoisted(() => ({
  createdWindows: [] as FakeWindow[],
  workspace: { current: null as { deploymentUrl: string; token: string } | null },
  refresh: vi.fn(),
}))

vi.mock('electron', () => {
  let nextId = 100
  const BrowserWindow = vi.fn(function (options: Record<string, any>) {
    const handlers: Record<string, (...args: any[]) => void> = {}
    const win: FakeWindow = {
      webContents: {
        id: nextId++,
        setWindowOpenHandler: vi.fn(),
        downloadURL: vi.fn(),
        on: vi.fn((event: string, cb: (...args: any[]) => void) => {
          handlers[`webContents:${event}`] = cb
        }),
        executeJavaScript: vi.fn(() => Promise.resolve()),
      },
      loadURL: vi.fn(),
      on: vi.fn((event: string, cb: (...args: any[]) => void) => {
        handlers[event] = cb
      }),
      setTitle: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      close: vi.fn(),
      isDestroyed: vi.fn(() => false),
      removeMenu: vi.fn(),
      options,
      handlers,
    }
    createdWindows.push(win)
    return win
  })
  return { BrowserWindow }
})

vi.mock('./safe-open-external', () => ({ safeOpenExternal: vi.fn() }))
vi.mock('@shared/lib/services/cloud-proxy-target', () => ({ refreshCloudProxyTarget: refresh }))

import {
  openDashboardWindow,
  closeAllDashboardWindows,
  installCloudDashboardAuth,
  shouldSignWorkspaceRequest,
} from './dashboard-window'

const LOCAL = 'http://localhost:3838'
const CLOUD = 'https://acme.ongamut.so'
const APP = 'file://'
const MAIN_ID = 1

beforeEach(() => {
  closeAllDashboardWindows()
  createdWindows.length = 0
  workspace.current = { deploymentUrl: CLOUD, token: 'tok-1' }
  refresh.mockReset()
})

describe('which requests carry the workspace token', () => {
  const request = (url: string, frameOrigins: string[], resourceType = 'script', method = 'GET') =>
    ({ url, frameOrigins, resourceType, method })

  it.each([
    ['a file the pane dashboard asks for', request(`${CLOUD}/api/agents/a/artifacts/d/main.tsx`, [CLOUD, APP]), 'main'],
    ['the pane dashboard document itself', request(`${CLOUD}/api/agents/a/artifacts/d/`, [APP, APP], 'subFrame'), 'main'],
    ['a pop-out\'s first navigation from its never-loaded top frame', request(`${CLOUD}/api/agents/a/artifacts/d/view`, ['null'], 'mainFrame'), 'cloud-popout'],
    ['a pop-out returning top-level from another site', request(`${CLOUD}/api/agents/a/artifacts/d/view`, ['https://accounts.example.com'], 'mainFrame'), 'cloud-popout'],
    ['the dashboard inside a pop-out wrapper', request(`${CLOUD}/api/agents/a/artifacts/d/`, [CLOUD], 'subFrame'), 'cloud-popout'],
    ['live reload over a WebSocket', request('wss://acme.ongamut.so/api/agents/a/artifacts/d/', [CLOUD, APP], 'webSocket'), 'main'],
    ['a frame navigating back from a same-site page', request(`${CLOUD}/api/agents/a/artifacts/d/`, ['https://ongamut.so', APP], 'subFrame'), 'main'],
    ['a frame navigating back from a same-site page on another port', request(`${CLOUD}/api/agents/a/artifacts/d/`, ['https://ongamut.so:8443', APP], 'subFrame'), 'main'],
  ] as const)('signs %s', (_name, req, window) => {
    expect(shouldSignWorkspaceRequest(req, CLOUD, window)).toBe(true)
  })

  it.each([
    ['an IP address', 'http://127.0.0.1:4000', 'http://10.0.0.1'],
    ['a localhost subdomain', 'http://acme.localhost:4000', 'http://other.localhost:4000'],
    ['an apex domain', 'https://gamut.example', 'https://other.example'],
  ])('treats a workspace at %s as its own site', (_name, workspaceOrigin, page) => {
    const navigation = request(`${workspaceOrigin}/api/agents/a/artifacts/d/`, [page, APP], 'subFrame')
    expect(shouldSignWorkspaceRequest(navigation, workspaceOrigin, 'main')).toBe(false)
  })

  it.each([
    ['another site', request('https://fonts.example.com/a.woff2', [CLOUD, APP]), 'main'],
    ['a host that only starts with the workspace name', request('https://acme.ongamut.so.evil.com/x', [CLOUD, APP]), 'main'],
    ['a frame navigating back from another site', request(`${CLOUD}/api/agents/a/artifacts/d/`, ['https://accounts.example.com', APP], 'subFrame'), 'main'],
    ['a frame navigating back from a host that only ends with the domain', request(`${CLOUD}/api/agents/a/artifacts/d/`, ['https://evilongamut.so', APP], 'subFrame'), 'main'],
    ['a frame navigating back from the same domain over http', request(`${CLOUD}/api/agents/a/artifacts/d/`, ['http://ongamut.so', APP], 'subFrame'), 'main'],
    ['a same-site page fetching from the workspace', request(`${CLOUD}/api/agents`, ['https://ongamut.so', APP]), 'main'],
    ['a same-site page above the navigating frame', request(`${CLOUD}/api/agents/a/artifacts/d/`, [CLOUD, 'https://ongamut.so', APP], 'subFrame'), 'main'],
    ['a local dashboard calling the workspace', request(`${CLOUD}/api/agents`, ['http://localhost:3838', APP]), 'main'],
    ['a sandboxed frame inside a workspace dashboard', request(`${CLOUD}/api/agents`, ['null', CLOUD, APP]), 'main'],
    ['an empty top frame in the main window', request(`${CLOUD}/api/agents`, ['null'], 'mainFrame'), 'main'],
    ['the main window navigating top-level from another site', request(`${CLOUD}/api/agents`, ['https://accounts.example.com'], 'mainFrame'), 'main'],
    ['a pop-out\'s top-level POST', request(`${CLOUD}/api/agents`, ['https://accounts.example.com'], 'mainFrame', 'POST'), 'cloud-popout'],
    ['a cross-site page in a pop-out fetching from the workspace', request(`${CLOUD}/api/agents`, ['https://accounts.example.com'], 'xhr'), 'cloud-popout'],
    ['a window the app does not own', request(`${CLOUD}/api/agents`, [CLOUD, APP]), null],
    ['a request with no frame', request(`${CLOUD}/api/agents`, []), 'main'],
  ] as const)('does not sign %s', (_name, req, window) => {
    expect(shouldSignWorkspaceRequest(req, CLOUD, window)).toBe(false)
  })
})

describe('signing the app\'s own workspace requests', () => {
  type Listener = (details: Record<string, any>, callback: (response: Record<string, any>) => void) => void
  const on: Record<string, Listener | ((d: { id: number }) => void)> = {}
  const fakeSession = {
    webRequest: {
      onBeforeSendHeaders: (l: Listener) => { on.send = l },
      onHeadersReceived: (l: Listener) => { on.receive = l },
      onCompleted: (l: (d: { id: number }) => void) => { on.completed = l },
      onErrorOccurred: (l: (d: { id: number }) => void) => { on.error = l },
    },
  }
  const frames = (...origins: string[]) =>
    origins.reduceRight<{ origin: string; parent: unknown } | null>((parent, origin) => ({ origin, parent }), null)
  let nextRequest = 1
  const LOGIN_REJECTED = { statusCode: 401, responseHeaders: { 'www-authenticate': ['Bearer realm="workspace"'] } }
  const paneFile = (extra: Record<string, any> = {}) => ({
    id: nextRequest++,
    url: `${CLOUD}/api/agents/a/artifacts/d/main.tsx`,
    webContentsId: MAIN_ID,
    resourceType: 'script',
    frame: frames(CLOUD, APP),
    requestHeaders: {},
    ...extra,
  })
  const run = (name: 'send' | 'receive', details: Record<string, any>) =>
    new Promise<Record<string, any>>((resolve) => (on[name] as Listener)(details, resolve))
  const signedThenAnswered = async (details: Record<string, any>, answer: Record<string, any>) => {
    await run('send', details)
    return run('receive', { ...details, ...answer })
  }

  beforeEach(() => {
    installCloudDashboardAuth(fakeSession as never, () => MAIN_ID, () => workspace.current)
  })

  it('adds the workspace token to the pane\'s workspace requests', async () => {
    const out = await run('send', paneFile({ requestHeaders: { Accept: '*/*' } }))
    expect(out.requestHeaders).toEqual({ Accept: '*/*', Authorization: 'Bearer tok-1' })
  })

  it('replaces any Authorization header the page set itself', async () => {
    const out = await run('send', paneFile({ requestHeaders: { authorization: 'Bearer page-token' } }))
    expect(out.requestHeaders).toEqual({ Authorization: 'Bearer tok-1' })
  })

  it('sends a request from a disposed frame unsigned instead of stalling it', async () => {
    const disposed = { get origin(): string { throw new Error('Render frame was disposed before WebFrameMain could be accessed') }, parent: null }
    const out = await run('send', paneFile({ frame: disposed }))
    expect(out.requestHeaders).toEqual({})
  })

  it('leaves requests from windows the app does not own untouched', async () => {
    const details = paneFile({ webContentsId: 999, requestHeaders: { Accept: '*/*' } })
    expect((await run('send', details)).requestHeaders).toEqual({ Accept: '*/*' })
    expect(await run('receive', { ...details, statusCode: 200, responseHeaders: { 'set-cookie': ['x'] } })).toEqual({})
  })

  it('signs nothing while the app is not driving a cloud workspace', async () => {
    workspace.current = null
    expect((await run('send', paneFile())).requestHeaders).toEqual({})
  })

  it('drops the token when a signed request is redirected away from the workspace', async () => {
    const details = paneFile()
    await run('send', details)
    const out = await run('send', { ...details, url: 'https://elsewhere.example/x', requestHeaders: { Authorization: 'Bearer tok-1' } })
    expect(out.requestHeaders).toEqual({})
  })

  it('keeps workspace credentials out of the app\'s cookie jar', async () => {
    const out = await signedThenAnswered(paneFile(), {
      statusCode: 200,
      responseHeaders: { 'Content-Type': ['text/javascript'], 'Set-Cookie': ['a=1'], 'set-auth-token': ['t'] },
    })
    expect(out.responseHeaders).toEqual({ 'Content-Type': ['text/javascript'] })
  })

  it('cleans a signed response even if the workspace disconnected meanwhile', async () => {
    const details = paneFile()
    await run('send', details)
    workspace.current = null
    const out = await run('receive', { ...details, statusCode: 200, responseHeaders: { 'set-cookie': ['a=1'] } })
    expect(out.responseHeaders).toEqual({})
  })

  it('retries a rejected request once a fresh token exists', async () => {
    refresh.mockResolvedValue({ deploymentUrl: CLOUD, token: 'tok-2' })
    const details = paneFile()
    const out = await signedThenAnswered(details, LOGIN_REJECTED)
    expect(out.statusLine).toBe('HTTP/1.1 307 Temporary Redirect')
    expect(out.responseHeaders.Location).toEqual([details.url])
  })

  it('retries a request sent with an older token after another request already refreshed it', async () => {
    const details = paneFile()
    await run('send', details)
    workspace.current = { deploymentUrl: CLOUD, token: 'tok-2' }
    refresh.mockResolvedValue({ deploymentUrl: CLOUD, token: 'tok-2' })
    const out = await run('receive', { ...details, ...LOGIN_REJECTED })
    expect(out.statusLine).toBe('HTTP/1.1 307 Temporary Redirect')
  })

  it('returns the second 401 instead of retrying again', async () => {
    refresh.mockResolvedValueOnce({ deploymentUrl: CLOUD, token: 'tok-2' }).mockResolvedValueOnce({ deploymentUrl: CLOUD, token: 'tok-3' })
    const details = paneFile()
    await signedThenAnswered(details, LOGIN_REJECTED)
    workspace.current = { deploymentUrl: CLOUD, token: 'tok-2' }
    const out = await signedThenAnswered(details, LOGIN_REJECTED)
    expect(out.statusLine).toBeUndefined()
    expect(refresh).toHaveBeenCalledOnce()
  })

  it.each([
    ['no challenge', {}],
    ['its own Bearer challenge', { 'WWW-Authenticate': ['Bearer realm="app"'] }],
  ])('returns a dashboard\'s own 401 with %s without refreshing', async (_name, responseHeaders) => {
    const out = await signedThenAnswered(paneFile(), { statusCode: 401, responseHeaders })
    expect(out.statusLine).toBeUndefined()
    expect(refresh).not.toHaveBeenCalled()
  })

  it.each([
    ['the refresh brings no new token', { deploymentUrl: CLOUD, token: 'tok-1' }],
    ['the refresh fails', null],
  ])('returns the 401 when %s', async (_name, fresh) => {
    refresh.mockResolvedValue(fresh)
    const out = await signedThenAnswered(paneFile(), LOGIN_REJECTED)
    expect(out.statusLine).toBeUndefined()
  })

  it('sends the retried request with the fresh token', async () => {
    refresh.mockResolvedValue({ deploymentUrl: CLOUD, token: 'tok-2' })
    const details = paneFile()
    await signedThenAnswered(details, LOGIN_REJECTED)
    workspace.current = { deploymentUrl: CLOUD, token: 'tok-2' }
    expect((await run('send', details)).requestHeaders.Authorization).toBe('Bearer tok-2')
  })

  it.each(['completed', 'error'] as const)('forgets a request once it has %s', async (event) => {
    const details = paneFile()
    await run('send', details)
    ;(on[event] as (d: { id: number }) => void)({ id: details.id })
    expect(await run('receive', { ...details, statusCode: 200, responseHeaders: { 'set-cookie': ['a=1'] } })).toEqual({})
  })

  it('does not earn a second retry through a redirect away and back', async () => {
    refresh.mockResolvedValue({ deploymentUrl: CLOUD, token: 'tok-2' })
    const details = paneFile()
    await signedThenAnswered(details, LOGIN_REJECTED)
    await run('send', { ...details, url: 'https://elsewhere.example/x' })
    workspace.current = { deploymentUrl: CLOUD, token: 'tok-2' }
    refresh.mockResolvedValue({ deploymentUrl: CLOUD, token: 'tok-3' })
    const out = await signedThenAnswered(details, LOGIN_REJECTED)
    expect(out.statusLine).toBeUndefined()
  })

})

describe('a cloud popout', () => {
  const sendFrom = async (webContentsId: number, method = 'GET') => {
    let send: ((d: Record<string, any>, cb: (r: Record<string, any>) => void) => void) | undefined
    installCloudDashboardAuth({
      webRequest: { onBeforeSendHeaders: (l: never) => { send = l }, onHeadersReceived: () => {}, onCompleted: () => {}, onErrorOccurred: () => {} },
    } as never, () => MAIN_ID, () => workspace.current)
    return new Promise<Record<string, any>>((resolve) => send!({
      id: 100_000 + webContentsId,
      url: `${CLOUD}/api/agents/sales/artifacts/weekly/view`,
      webContentsId,
      resourceType: 'mainFrame',
      method,
      frame: { origin: 'null', parent: null },
      requestHeaders: {},
    }, resolve))
  }

  it('opens the dashboard at the workspace\'s own address', () => {
    openDashboardWindow('sales', 'weekly', CLOUD, true)
    expect(createdWindows[0].loadURL).toHaveBeenCalledWith(`${CLOUD}/api/agents/sales/artifacts/weekly/view`)
    expect(createdWindows[0].options.webPreferences.partition).toBeUndefined()
  })

  it('is signed until it closes', async () => {
    openDashboardWindow('sales', 'weekly', CLOUD, true)
    const win = createdWindows[0]
    expect((await sendFrom(win.webContents.id)).requestHeaders.Authorization).toBe('Bearer tok-1')
    win.handlers.closed()
    expect((await sendFrom(win.webContents.id)).requestHeaders.Authorization).toBeUndefined()
  })

  it('does not sign another window while one is open', async () => {
    openDashboardWindow('sales', 'weekly', CLOUD, true)
    expect((await sendFrom(999)).requestHeaders.Authorization).toBeUndefined()
  })

  it('is not signed for a top-level POST', async () => {
    openDashboardWindow('sales', 'weekly', CLOUD, true)
    const out = await sendFrom(createdWindows[0].webContents.id, 'POST')
    expect(out.requestHeaders.Authorization).toBeUndefined()
  })

  it('is never signed when it shows a local dashboard', async () => {
    openDashboardWindow('sales', 'weekly', LOCAL)
    expect((await sendFrom(createdWindows[0].webContents.id)).requestHeaders.Authorization).toBeUndefined()
  })
})

describe('popout identity', () => {
  it('does not reuse a local window for a cloud dashboard of the same name', () => {
    // Two deployments can hold an agent of the same slug. Reusing the window
    // shows the wrong one's dashboard under the right one's name.
    openDashboardWindow('sales', 'weekly', LOCAL)
    openDashboardWindow('sales', 'weekly', CLOUD, true)

    expect(createdWindows).toHaveLength(2)
  })

  it('still reuses the window for a repeat request on the same target', () => {
    openDashboardWindow('sales', 'weekly', CLOUD, true)
    openDashboardWindow('sales', 'weekly', CLOUD, true)

    expect(createdWindows).toHaveLength(1)
    expect(createdWindows[0].focus).toHaveBeenCalled()
  })
})

describe('marking a cloud popout', () => {
  it('keeps the workspace visible in the title the dashboard sets', () => {
    // The wrapper replaces the generic title with the dashboard's own name, so
    // an unmarked cloud popout is indistinguishable from a local one.
    openDashboardWindow('sales', 'weekly', CLOUD, true)

    const event = { preventDefault: vi.fn() }
    createdWindows[0].handlers['page-title-updated'](event, 'Weekly — Gamut')

    expect(event.preventDefault).toHaveBeenCalled()
    expect(createdWindows[0].setTitle).toHaveBeenCalledWith('Cloud workspace — Weekly — Gamut')
  })

  it('leaves a local popout’s title to the dashboard', () => {
    openDashboardWindow('sales', 'weekly', LOCAL)
    expect(createdWindows[0].handlers['page-title-updated']).toBeUndefined()
  })
})

describe('dashboard popout chrome', () => {
  it('installs a draggable refresh control in each loaded wrapper document', () => {
    openDashboardWindow('sales', 'weekly', CLOUD, true)
    const win = createdWindows[0]

    expect(win.options.autoHideMenuBar).toBe(true)
    expect(win.handlers['webContents:dom-ready']).toBeTypeOf('function')

    win.handlers['webContents:dom-ready']()

    expect(win.webContents.executeJavaScript).toHaveBeenCalledOnce()
    const script = win.webContents.executeJavaScript.mock.calls[0][0] as string
    expect(script).toContain('gamut-dashboard-window-chrome')
    expect(script).toContain('-webkit-app-region: drag')
    expect(script).toContain('env(titlebar-area-x, 0px)')
    expect(script).toContain('env(titlebar-area-width, calc(100% - 138px))')
    expect(script).not.toContain('padding: 0 148px')
    expect(script).toContain("classList.add('is-refreshing')")

    // Exercise the injected script as JavaScript, not only as an opaque string:
    // the button should enter its spinner state and reload the outer lifecycle
    // wrapper so a stopped dashboard gets another chance to start.
    const elements: Array<Record<string, any>> = []
    const makeElement = (tagName: string) => {
      const listeners: Record<string, () => void> = {}
      const classes = new Set<string>()
      const element: Record<string, any> = {
        tagName,
        listeners,
        children: [] as unknown[],
        classList: { add: (name: string) => classes.add(name), contains: (name: string) => classes.has(name) },
        addEventListener: (event: string, callback: () => void) => { listeners[event] = callback },
        append(...children: unknown[]) { element.children.push(...children) },
        setAttribute(name: string, value: string) { element[name] = value },
      }
      elements.push(element)
      return element
    }
    const reload = vi.fn()
    const titleElement = makeElement('title')
    const observe = vi.fn()
    const document = {
      title: 'Weekly — Gamut',
      head: { appendChild: vi.fn() },
      body: { appendChild: vi.fn() },
      createElement: makeElement,
      getElementById: vi.fn(() => null),
      querySelector: vi.fn(() => titleElement),
    }

    runInNewContext(script, {
      document,
      window: { location: { reload } },
      MutationObserver: class { observe = observe },
    })

    const refresh = elements.find((element) => element.id === 'gamut-dashboard-refresh')
    const title = elements.find((element) => element.id === 'gamut-dashboard-window-title')
    expect(title?.textContent).toBe('Cloud workspace — Weekly — Gamut')
    expect(refresh).toBeDefined()
    refresh!.listeners.click()
    expect(refresh!.classList.contains('is-refreshing')).toBe(true)
    expect(refresh!.disabled).toBe(true)
    expect(refresh!['aria-busy']).toBe('true')
    expect(reload).toHaveBeenCalledOnce()
  })

  it('uses native window controls but removes the inherited menu on Windows', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      openDashboardWindow('sales', 'windows-dashboard', LOCAL)
      const win = createdWindows[0]

      expect(win.options.titleBarStyle).toBe('hidden')
      expect(win.options.titleBarOverlay).toEqual({
        color: '#111111',
        symbolColor: '#d4d4d4',
        height: 30,
      })
      expect(win.removeMenu).toHaveBeenCalledOnce()
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })
})
