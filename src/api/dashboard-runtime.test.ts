import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DASHBOARD_DISPATCH_ACK_TYPE,
  DASHBOARD_DISPATCH_REQUEST_TYPE,
  DASHBOARD_DISPATCH_RESULT_TYPE,
} from '@shared/lib/dashboard-dispatch-schema'
import {
  dashboardMountPath,
  dashboardResponseHeaders,
  getDashboardRuntimeJs,
  injectDashboardRuntime,
  rewriteDashboardCookiePath,
  rewriteDashboardLocation,
} from './dashboard-runtime'

interface RuntimeApi {
  basePath: string
  routerBasePath: string
  slug: string
  url(path?: string): string
  dispatchSession(request: { prompt?: unknown; agent?: unknown; title?: unknown }): Promise<unknown>
}

function runtimeHarness(
  documentHref: string,
  fallback: string,
  slug = 'slides',
  options?: { parentPostMessage?: (message: unknown, targetOrigin: string) => void },
) {
  const url = new URL(documentHref)
  const source = getDashboardRuntimeJs(fallback, slug)
  const messageListeners: Array<(event: unknown) => void> = []
  const windowObject: Record<string, unknown> = {
    location: { pathname: url.pathname },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (type === 'message') messageListeners.push(listener)
    },
  }
  // Default harness models a top-level window (parent === window); a dispatch
  // host is modeled by handing in a distinct parent with postMessage.
  windowObject.parent = options?.parentPostMessage
    ? { postMessage: options.parentPostMessage }
    : windowObject
  const documentObject = {
    querySelector: () => null,
  }
  new Function('window', 'document', source)(windowObject, documentObject)
  const deliverMessage = (data: unknown) => {
    for (const listener of messageListeners) listener({ data })
  }
  return { runtime: windowObject.__GAMUT_DASHBOARD__ as RuntimeApi, deliverMessage }
}

function runtimeFor(documentHref: string, fallback: string, slug = 'slides') {
  return runtimeHarness(documentHref, fallback, slug).runtime
}

describe('dashboard runtime injection', () => {
  it('builds a trailing-slash artifact mount', () => {
    expect(dashboardMountPath('agent-1', 'open-slide')).toBe(
      '/api/agents/agent-1/artifacts/open-slide/',
    )
  })

  it('injects the runtime and base before existing head assets', () => {
    const result = injectDashboardRuntime(
      '<!doctype html><html><head><script src="./assets/app.js"></script></head></html>',
      {
        basePath: '/api/agents/a/artifacts/slides/',
        slug: 'slides',
        polyfillJs: 'window.polyfillLoaded=true;',
      },
    )

    expect(result).toContain(
      '<head><base data-gamut-dashboard-base href="/api/agents/a/artifacts/slides/">',
    )
    expect(result.indexOf('__GAMUT_DASHBOARD__')).toBeLessThan(result.indexOf('./assets/app.js'))
    expect(result).toContain('window.polyfillLoaded=true;')
  })

  it('preserves an application-provided base element', () => {
    const result = injectDashboardRuntime(
      '<html><head><base href="/custom/"></head></html>',
      { basePath: '/api/agents/a/artifacts/slides/', slug: 'slides' },
    )
    expect(result.match(/<base\b/g)).toHaveLength(1)
    expect(result).toContain('<base href="/custom/">')
  })

  it('runs after a managed base and before existing dashboard scripts', () => {
    const result = injectDashboardRuntime(
      '<html><head><base data-gamut-dashboard-base href="/api/agents/a/artifacts/slides/"><script data-gamut-dashboard-fallback="true">window.fallback=true;</script><script src="./assets/app.js"></script></head></html>',
      { basePath: '/api/agents/a/artifacts/slides/', slug: 'slides' },
    )

    const baseAt = result.indexOf('<base data-gamut-dashboard-base')
    const runtimeAt = result.indexOf('var fallbackBasePath =')
    const fallbackAt = result.indexOf('data-gamut-dashboard-fallback')
    const assetAt = result.indexOf('./assets/app.js')
    expect(baseAt).toBeLessThan(runtimeAt)
    expect(runtimeAt).toBeLessThan(fallbackAt)
    expect(runtimeAt).toBeLessThan(assetAt)
  })

  it('uses the exact browser-visible prefix behind the desktop cloud proxy', () => {
    const runtime = runtimeFor(
      'http://127.0.0.1/cloud/KEY/api/agents/a/artifacts/slides/s/my-deck',
      '/api/agents/a/artifacts/slides/',
    )
    expect(runtime.basePath).toBe('/cloud/KEY/api/agents/a/artifacts/slides/')
    expect(runtime.routerBasePath).toBe('/cloud/KEY/api/agents/a/artifacts/slides')
    expect(runtime.url('assets/app.js')).toBe(
      '/cloud/KEY/api/agents/a/artifacts/slides/assets/app.js',
    )
  })

  it('falls back to server metadata outside an artifact URL', () => {
    const runtime = runtimeFor(
      'http://localhost:5000/',
      '/api/agents/a/artifacts/slides/',
    )
    expect(runtime.basePath).toBe('/api/agents/a/artifacts/slides/')
    expect(() => runtime.url('../escape')).toThrow(/cannot escape/)
    expect(() => runtime.url('nested/../../escape')).toThrow(/cannot escape/)
    expect(() => runtime.url('nested/%2e%2e/%2e%2e/escape')).toThrow(/cannot escape/)
    expect(runtime.url('api/data?limit=2#items')).toBe(
      '/api/agents/a/artifacts/slides/api/data?limit=2#items',
    )
  })
})

describe('dashboard session dispatch shim', () => {
  const href = 'http://127.0.0.1/api/agents/a/artifacts/slides/'
  const fallback = '/api/agents/a/artifacts/slides/'

  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses the message types the host-side schema defines', () => {
    const source = getDashboardRuntimeJs(fallback, 'slides')
    expect(source).toContain(`"${DASHBOARD_DISPATCH_REQUEST_TYPE}"`)
    expect(source).toContain(`"${DASHBOARD_DISPATCH_ACK_TYPE}"`)
    expect(source).toContain(`"${DASHBOARD_DISPATCH_RESULT_TYPE}"`)
  })

  it('rejects an empty prompt without posting anything', async () => {
    const posted: unknown[] = []
    const { runtime } = runtimeHarness(href, fallback, 'slides', {
      parentPostMessage: (message) => posted.push(message),
    })
    await expect(runtime.dispatchSession({ prompt: '   ' })).rejects.toThrow(/non-empty prompt/)
    expect(posted).toHaveLength(0)
  })

  it('rejects when there is no parent frame to host the dialog', async () => {
    const { runtime } = runtimeHarness(href, fallback)
    await expect(runtime.dispatchSession({ prompt: 'do it' })).rejects.toThrow(
      /not available in this window/,
    )
  })

  it('posts a request and resolves with the host result after an ack', async () => {
    const posted: Array<{ message: any; targetOrigin: string }> = []
    const { runtime, deliverMessage } = runtimeHarness(href, fallback, 'slides', {
      parentPostMessage: (message, targetOrigin) => posted.push({ message: message as any, targetOrigin }),
    })

    const pending = runtime.dispatchSession({ prompt: '/research-user jane', title: 'Research Jane' })
    expect(posted).toHaveLength(1)
    const request = posted[0].message
    expect(posted[0].targetOrigin).toBe('*')
    expect(request.type).toBe(DASHBOARD_DISPATCH_REQUEST_TYPE)
    expect(request.payload).toEqual({
      prompt: '/research-user jane',
      title: 'Research Jane',
    })

    deliverMessage({ type: DASHBOARD_DISPATCH_ACK_TYPE, id: request.id })
    deliverMessage({
      type: DASHBOARD_DISPATCH_RESULT_TYPE,
      id: request.id,
      result: { sessionId: 's-1', agentSlug: 'a' },
    })
    await expect(pending).resolves.toEqual({ sessionId: 's-1', agentSlug: 'a' })
  })

  it('rejects when the host reports an error result', async () => {
    const posted: any[] = []
    const { runtime, deliverMessage } = runtimeHarness(href, fallback, 'slides', {
      parentPostMessage: (message) => posted.push(message),
    })

    const pending = runtime.dispatchSession({ prompt: 'do it' })
    deliverMessage({ type: DASHBOARD_DISPATCH_ACK_TYPE, id: posted[0].id })
    deliverMessage({
      type: DASHBOARD_DISPATCH_RESULT_TYPE,
      id: posted[0].id,
      result: { error: 'A dispatch request is already awaiting the user', code: 'busy' },
    })
    await expect(pending).rejects.toThrow(/already awaiting/)
  })

  it('rejects when no host acks within the availability timeout', async () => {
    vi.useFakeTimers()
    const { runtime } = runtimeHarness(href, fallback, 'slides', {
      parentPostMessage: () => {},
    })

    const pending = runtime.dispatchSession({ prompt: 'do it' })
    const assertion = expect(pending).rejects.toThrow(/not available in this window/)
    vi.advanceTimersByTime(2001)
    await assertion
  })

  it('waits on the user decision indefinitely once acked', async () => {
    vi.useFakeTimers()
    const posted: any[] = []
    const { runtime, deliverMessage } = runtimeHarness(href, fallback, 'slides', {
      parentPostMessage: (message) => posted.push(message),
    })

    const pending = runtime.dispatchSession({ prompt: 'do it' })
    deliverMessage({ type: DASHBOARD_DISPATCH_ACK_TYPE, id: posted[0].id })
    vi.advanceTimersByTime(60_000)
    deliverMessage({
      type: DASHBOARD_DISPATCH_RESULT_TYPE,
      id: posted[0].id,
      result: { cancelled: true },
    })
    await expect(pending).resolves.toEqual({ cancelled: true })
  })
})

describe('dashboard response scoping', () => {
  const basePath = '/api/agents/a/artifacts/slides/'

  it('keeps redirects inside the dashboard mount', () => {
    expect(rewriteDashboardLocation('/login?next=%2F', basePath)).toBe(
      '/api/agents/a/artifacts/slides/login?next=%2F',
    )
    expect(rewriteDashboardLocation('https://example.com/callback', basePath)).toBe(
      'https://example.com/callback',
    )
    expect(rewriteDashboardLocation(basePath.slice(0, -1), basePath)).toBe(
      basePath.slice(0, -1),
    )
  })

  it('scopes default and explicit cookie paths', () => {
    expect(rewriteDashboardCookiePath('session=abc; HttpOnly', basePath)).toBe(
      'session=abc; HttpOnly; Path=/api/agents/a/artifacts/slides/',
    )
    expect(rewriteDashboardCookiePath('session=abc; Path=/; HttpOnly', basePath)).toBe(
      'session=abc; Path=/api/agents/a/artifacts/slides/; HttpOnly',
    )
    expect(rewriteDashboardCookiePath('session=abc; Path=/account; HttpOnly', basePath)).toBe(
      'session=abc; Path=/api/agents/a/artifacts/slides/account; HttpOnly',
    )
  })

  it('invalidates representation headers when HTML was injected', () => {
    const upstream = new Headers({
      'cache-control': 'public, max-age=31536000, immutable',
      'content-encoding': 'gzip',
      'content-length': '100',
      etag: '"old"',
      location: '/login',
      'set-cookie': 'session=abc; Path=/; HttpOnly',
    })
    const result = dashboardResponseHeaders(upstream, basePath, { transformedHtml: true })

    expect(result.get('cache-control')).toBe('no-cache')
    expect(result.has('content-encoding')).toBe(false)
    expect(result.has('content-length')).toBe(false)
    expect(result.has('etag')).toBe(false)
    expect(result.get('location')).toBe('/api/agents/a/artifacts/slides/login')
    expect(result.get('set-cookie')).toContain('Path=/api/agents/a/artifacts/slides/')
  })
})
