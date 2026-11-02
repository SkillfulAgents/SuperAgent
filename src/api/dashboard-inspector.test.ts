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

/** The inspector run against a stand-in window inside a parent frame, over jsdom's document. */
function harness(options: { fetch?: (...args: unknown[]) => Promise<unknown> } = {}) {
  const listeners: Record<string, Listener[]> = {}
  const posted: Array<{ message: Record<string, unknown>; target: string }> = []
  const parent = { postMessage: (message: Record<string, unknown>, target: string) => posted.push({ message, target }) }
  const original = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const fakeConsole = { ...original }
  const win: Record<string, unknown> = {
    parent,
    addEventListener: (type: string, listener: Listener) => { (listeners[type] ??= []).push(listener) },
    fetch: options.fetch,
    innerWidth: 800,
    innerHeight: 600,
    scrollX: 0,
    scrollY: 120,
    devicePixelRatio: 2,
    getSelection: () => document.getSelection(),
    __GAMUT_DASHBOARD__: { basePath: '/api/agents/a/artifacts/d/' },
  }
  const location = { href: 'http://localhost:47891/api/agents/a/artifacts/d/#/q3', origin: 'http://localhost:47891' }
  new Function('window', 'document', 'console', 'location', getDashboardInspectorJs())(win, document, fakeConsole, location)
  const fire = (type: string, event: Record<string, unknown>) => listeners[type]?.forEach((listener) => listener(event))
  const ask = (point?: { x: number; y: number }, origin = 'file://', source: unknown = parent) =>
    fire('message', { source, origin, data: { type: DASHBOARD_INSPECT_REQUEST_TYPE, id: 'r1', ...(point ? { point } : {}) } })
  const lastSnapshot = () => dashboardInspectResultSchema.parse(posted.at(-1)?.message).snapshot
  return { win, console: fakeConsole, original, posted, fire, ask, lastSnapshot, parent }
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

  it('answers a same-origin or localhost parent at its origin, and nobody else', () => {
    const h = harness()
    h.ask(undefined, 'http://localhost:47891')
    expect(h.posted.at(-1)?.target).toBe('http://localhost:47891')
    h.ask(undefined, 'http://localhost:5173')
    expect(h.posted.at(-1)?.target).toBe('http://localhost:5173')
    expect(h.posted).toHaveLength(2)

    h.ask(undefined, 'https://evil.example')
    h.ask(undefined, 'null')
    h.ask(undefined, 'file://', { postMessage: vi.fn() })
    expect(h.posted).toHaveLength(2)
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

    h.fire('message', { source: h.parent, origin: 'file://', data: { type: DASHBOARD_HOST_FEATURES_TYPE, comments: true } })
    expect(rightClick(plain).preventDefault).toHaveBeenCalled()
    expect(h.posted.at(-1)).toEqual({ message: { type: DASHBOARD_CONTEXT_MENU_TYPE, x: 30, y: 40 }, target: '*' })

    // The page's own menu, a text field, and Shift keep the native menu.
    const input = document.createElement('input')
    document.body.appendChild(input)
    expect(rightClick(input).preventDefault).not.toHaveBeenCalled()
    expect(rightClick(plain, { shiftKey: true }).preventDefault).not.toHaveBeenCalled()
    expect(rightClick(plain, { defaultPrevented: true }).preventDefault).not.toHaveBeenCalled()
    expect(h.posted).toHaveLength(1)

    h.fire('message', { source: h.parent, origin: 'file://', data: { type: DASHBOARD_HOST_FEATURES_TYPE, comments: false } })
    expect(rightClick(plain).preventDefault).not.toHaveBeenCalled()
  })
})
