// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DASHBOARD_CONTEXT_MENU_TYPE,
  DASHBOARD_HOST_FEATURES_TYPE,
  DASHBOARD_INSPECT_REQUEST_TYPE,
  DASHBOARD_INSPECT_RESULT_TYPE,
  DASHBOARD_LOG_CAPACITY,
  dashboardInspectResultSchema,
} from '@shared/lib/dashboard-inspect-schema'
import { getDashboardInspectorJs } from './dashboard-inspector'

type Listener = (event: Record<string, unknown>) => void

const ELECTRON_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Gamut/0.6.3 Chrome/140.0.0.0 Electron/45.0.0 Safari/537.36'
const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

/** A request whose outcome the test plays out: `finish(status)` or `abort()`, then loadend. */
class FakeXhr {
  static last: FakeXhr | null = null
  status = 0
  statusText = ''
  readyState = 1
  private handlers: Record<string, Array<() => void>> = {}
  open(_method: string, _url: string) { FakeXhr.last = this }
  send() {}
  addEventListener(type: string, handler: () => void) { (this.handlers[type] ??= []).push(handler) }
  emit(type: string) { this.handlers[type]?.forEach((handler) => handler()) }
  finish(status: number, statusText = '') { this.status = status; this.statusText = statusText; this.readyState = 4; this.emit('loadend') }
  abort() { this.readyState = 4; this.emit('abort'); this.emit('loadend') }
}

/** The inspector run against a stand-in window inside a parent frame, over jsdom's document. */
function harness(options: { fetch?: (...args: unknown[]) => Promise<unknown>; userAgent?: string } = {}) {
  const listeners: Record<string, Listener[]> = {}
  const posted: Array<{ message: Record<string, unknown>; target: string }> = []
  const parent = { postMessage: (message: Record<string, unknown>, target: string) => posted.push({ message, target }) }
  const original = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const fakeConsole = { ...original }
  const win: Record<string, unknown> = {
    parent,
    addEventListener: (type: string, listener: Listener) => { (listeners[type] ??= []).push(listener) },
    removeEventListener: (type: string, listener: Listener) => { listeners[type] = (listeners[type] ?? []).filter((l) => l !== listener) },
    fetch: options.fetch,
    XMLHttpRequest: FakeXhr,
    innerWidth: 800,
    innerHeight: 600,
    scrollX: 0,
    scrollY: 120,
    devicePixelRatio: 2,
    getSelection: () => document.getSelection(),
    __GAMUT_DASHBOARD__: { basePath: '/api/agents/a/artifacts/d/' },
  }
  const location = { href: 'http://localhost:47891/api/agents/a/artifacts/d/#/q3', origin: 'http://localhost:47891' }
  const navigator = { userAgent: options.userAgent ?? ELECTRON_UA }
  new Function('window', 'document', 'console', 'location', 'navigator', 'XMLHttpRequest', getDashboardInspectorJs())(
    win, document, fakeConsole, location, navigator, FakeXhr,
  )
  const fire = (type: string, event: Record<string, unknown>) => [...(listeners[type] ?? [])].forEach((listener) => listener(event))
  const ask = (point?: { x: number; y: number }, origin = 'file://', source: unknown = parent) =>
    fire('message', { source, origin, data: { type: DASHBOARD_INSPECT_REQUEST_TYPE, id: 'r1', ...(point ? { point } : {}) } })
  const announce = (comments: boolean, origin = 'file://') =>
    fire('message', { source: parent, origin, data: { type: DASHBOARD_HOST_FEATURES_TYPE, comments } })
  const lastSnapshot = () => dashboardInspectResultSchema.parse(posted.at(-1)?.message).snapshot
  return { win, console: fakeConsole, original, posted, fire, ask, announce, lastSnapshot, parent }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('dashboard inspector', () => {
  it('keeps console lines and still prints them', () => {
    const h = harness()
    h.console.error('boom', { code: 7 }, new Error('bad'))
    h.console.log('hello')
    expect(h.original.error).toHaveBeenCalledWith('boom', { code: 7 }, expect.any(Error))
    h.ask()
    const { logs } = h.lastSnapshot()
    expect(logs.map((entry) => [entry.level, entry.text.split('\n')[0]])).toEqual([
      ['error', 'boom {"code":7} Error: bad'],
      ['log', 'hello'],
    ])
  })

  it('serializes a huge object as a summary instead of all of it', () => {
    const h = harness()
    h.console.log(Array.from({ length: 5000 }, (_, i) => i))
    h.ask()
    expect(h.lastSnapshot().logs[0].text).toBe('Array(5000) (too large to show)')
  })

  it('keeps uncaught errors, rejections and failed assets', () => {
    const h = harness()
    h.fire('error', { target: h.win, message: 'Uncaught oops', filename: 'app.js', lineno: 3, colno: 9 })
    h.fire('unhandledrejection', { reason: new Error('nope') })
    const img = document.createElement('img')
    img.setAttribute('src', '/missing.png')
    h.fire('error', { target: img })
    h.ask()
    const texts = h.lastSnapshot().logs.map((entry) => `${entry.level}: ${entry.text.split('\n')[0]}`)
    expect(texts).toEqual([
      'error: Uncaught oops (app.js:3:9)',
      'error: Unhandled promise rejection: Error: nope',
      expect.stringMatching(/^resource: Failed to load <img> .*\/missing\.png$/),
    ])
  })

  it('keeps requests that failed or answered with an error', async () => {
    const responses = [{ status: 500, statusText: 'Server Error' }, { status: 200, statusText: 'OK' }]
    const h = harness({
      fetch: vi.fn(async (url: unknown) => {
        if (url === '/down') throw new TypeError('Failed to fetch')
        return responses.shift()
      }),
    })
    const fetch = h.win.fetch as (url: string, init?: { method?: string }) => Promise<unknown>
    await fetch('/api/data', { method: 'POST' })
    await fetch('/api/ok')
    await expect(fetch('/down')).rejects.toThrow('Failed to fetch')
    h.ask()
    expect(h.lastSnapshot().logs.map((entry) => entry.text)).toEqual([
      'POST /api/data -> 500 Server Error',
      'GET /down failed: Failed to fetch',
    ])
  })

  it('drops the oldest entries past its capacity and counts them', () => {
    const h = harness()
    for (let i = 0; i < DASHBOARD_LOG_CAPACITY + 5; i++) h.console.log(`line ${i}`)
    h.ask()
    const snapshot = h.lastSnapshot()
    expect(snapshot.logs).toHaveLength(DASHBOARD_LOG_CAPACITY)
    expect(snapshot.logs[0].text).toBe('line 5')
    expect(snapshot.droppedLogs).toBe(5)
  })

  it('answers the app with the page and what sits under the point', () => {
    document.body.innerHTML = '<main><div class="card revenue"><h2>Revenue this quarter</h2><span id="total">12</span></div></main>'
    const total = document.getElementById('total')!
    document.elementFromPoint = vi.fn(() => total)
    const h = harness()
    h.ask({ x: 40, y: 50 })

    expect(h.posted).toHaveLength(1)
    expect(h.posted[0].target).toBe('*')
    expect(h.posted[0].message).toMatchObject({ type: DASHBOARD_INSPECT_RESULT_TYPE, id: 'r1' })
    const snapshot = h.lastSnapshot()
    expect(snapshot).toMatchObject({
      url: 'http://localhost:47891/api/agents/a/artifacts/d/#/q3',
      basePath: '/api/agents/a/artifacts/d/',
      viewport: { width: 800, height: 600 },
      scroll: { x: 0, y: 120 },
      devicePixelRatio: 2,
    })
    expect(document.elementFromPoint).toHaveBeenCalledWith(40, 50)
    expect(snapshot.element).toMatchObject({
      tag: 'span#total',
      path: 'main > div.card.revenue > span#total',
      text: '12',
      context: 'Revenue this quarter12',
    })
  })

  it('answers the app at its origin: the same origin anywhere, file:// or localhost only inside the desktop app', () => {
    const desktop = harness()
    desktop.ask(undefined, 'http://localhost:47891')
    expect(desktop.posted.at(-1)?.target).toBe('http://localhost:47891')
    desktop.ask(undefined, 'http://localhost:5173')
    expect(desktop.posted.at(-1)?.target).toBe('http://localhost:5173')
    desktop.ask(undefined, 'file://')
    expect(desktop.posted.at(-1)?.target).toBe('*')
    expect(desktop.posted).toHaveLength(3)

    desktop.ask(undefined, 'https://evil.example')
    desktop.ask(undefined, 'null')
    desktop.ask(undefined, 'file://', { postMessage: vi.fn() })
    expect(desktop.posted).toHaveLength(3)

    // In a browser, a downloaded HTML file or another local dev server framing the dashboard gets nothing.
    const browser = harness({ userAgent: CHROME_UA })
    browser.ask(undefined, 'file://')
    browser.ask(undefined, 'http://localhost:5173')
    expect(browser.posted).toHaveLength(0)
    browser.ask(undefined, 'http://localhost:47891')
    expect(browser.posted).toHaveLength(1)
  })

  it('keeps failed and erroring XHRs, but not ones the page aborted', () => {
    const h = harness()
    const request = (url: string) => {
      const xhr = new (h.win.XMLHttpRequest as typeof FakeXhr)()
      xhr.open('GET', url)
      xhr.send()
      return xhr
    }
    request('/api/missing').finish(404, 'Not Found')
    request('/api/ok').finish(200, 'OK')
    request('/api/search?q=a').abort()
    request('/api/down').finish(0)
    h.ask()
    expect(h.lastSnapshot().logs.map((entry) => entry.text)).toEqual([
      'GET /api/missing -> 404 Not Found',
      'GET /api/down failed',
    ])
  })

  it('counts every entry by level, including ones that fell off the kept log', () => {
    const h = harness()
    for (let i = 0; i < 5; i++) h.console.error(`early ${i}`)
    for (let i = 0; i < DASHBOARD_LOG_CAPACITY; i++) h.console.log(`line ${i}`)
    h.ask()
    const snapshot = h.lastSnapshot()
    expect(snapshot.logs.some((entry) => entry.level === 'error')).toBe(false)
    expect(snapshot.counts).toEqual({ error: 5, log: DASHBOARD_LOG_CAPACITY })
  })

  it('hands a right-click to the app only once the app says it takes comments', () => {
    const h = harness()
    const plain = document.createElement('div')
    document.body.appendChild(plain)
    const rightClick = (target: Element, extra: Record<string, unknown> = {}) => {
      const event = { target, clientX: 30, clientY: 40, shiftKey: false, defaultPrevented: false, preventDefault: vi.fn(), ...extra }
      h.fire('contextmenu', event)
      return event
    }

    expect(rightClick(plain).preventDefault).not.toHaveBeenCalled()
    expect(h.posted).toHaveLength(0)

    h.announce(true)
    expect(rightClick(plain).preventDefault).toHaveBeenCalled()
    expect(h.posted.at(-1)).toEqual({ message: { type: DASHBOARD_CONTEXT_MENU_TYPE, x: 30, y: 40 }, target: '*' })

    // The page's own menu, a text field, and Shift keep the native menu.
    const input = document.createElement('input')
    document.body.appendChild(input)
    expect(rightClick(input).preventDefault).not.toHaveBeenCalled()
    expect(rightClick(plain, { shiftKey: true }).preventDefault).not.toHaveBeenCalled()
    expect(rightClick(plain, { defaultPrevented: true }).preventDefault).not.toHaveBeenCalled()
    expect(h.posted).toHaveLength(1)

    h.announce(false)
    expect(rightClick(plain).preventDefault).not.toHaveBeenCalled()
    expect(h.posted).toHaveLength(1)
  })

  it('lets the page\'s own window-level contextmenu handler run first and keep its menu', () => {
    const h = harness()
    const plain = document.createElement('div')
    document.body.appendChild(plain)
    // Added by the page's script, after the inspector loaded and before the app announced itself.
    const addListener = h.win.addEventListener as (type: string, listener: Listener) => void
    addListener('contextmenu', (event) => {
      event.defaultPrevented = true
      ;(event.preventDefault as () => void)()
    })
    h.announce(true)

    const event = { target: plain, clientX: 1, clientY: 2, shiftKey: false, defaultPrevented: false, preventDefault: vi.fn() }
    h.fire('contextmenu', event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(h.posted).toHaveLength(0)
  })
})
