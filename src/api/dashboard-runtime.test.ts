import { describe, expect, it } from 'vitest'

import {
  dashboardMountPath,
  dashboardResponseHeaders,
  getDashboardRuntimeJs,
  injectDashboardRuntime,
  rewriteDashboardCookiePath,
  rewriteDashboardLocation,
} from './dashboard-runtime'

function runtimeFor(documentHref: string, fallback: string, slug = 'slides') {
  const url = new URL(documentHref)
  const source = getDashboardRuntimeJs(fallback, slug)
  const windowObject: Record<string, unknown> = {
    location: { pathname: url.pathname },
  }
  const documentObject = {
    querySelector: () => null,
  }
  new Function('window', 'document', source)(windowObject, documentObject)
  return windowObject.__GAMUT_DASHBOARD__ as {
    basePath: string
    routerBasePath: string
    slug: string
    url(path?: string): string
  }
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
