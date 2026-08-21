import { describe, expect, it } from 'vitest'

// The copied dashboard template is plain ESM JavaScript by design.
// @ts-expect-error -- it intentionally ships without a declaration file.
import {
  gamutDashboard,
  getGamutDashboardRuntimeFallbackJs,
} from '../skills/dashboards/templates/react-vite/gamut-dashboard.js'

function runtimeFor(pathname: string) {
  const windowObject: Record<string, unknown> = { location: { pathname } }
  const source = getGamutDashboardRuntimeFallbackJs('slides')
  new Function('window', 'URL', source)(windowObject, URL)
  return windowObject.__GAMUT_DASHBOARD__ as {
    basePath: string
    routerBasePath: string
    slug: string
    url(path?: string): string
  }
}

describe('dashboard template runtime fallback', () => {
  it('supports the documented direct-local validation flow', () => {
    const runtime = runtimeFor('/')

    expect(runtime).toMatchObject({
      basePath: '/',
      routerBasePath: '/',
      slug: 'slides',
    })
    expect(runtime.url('api/data')).toBe('/api/data')
  })

  it('derives an artifact mount when opened at its public path', () => {
    const runtime = runtimeFor('/api/agents/a/artifacts/slides/s/deck')

    expect(runtime.basePath).toBe('/api/agents/a/artifacts/slides/')
    expect(runtime.url('assets/app.js')).toBe(
      '/api/agents/a/artifacts/slides/assets/app.js',
    )
  })

  it('normalizes joins before rejecting mount traversal', () => {
    const runtime = runtimeFor('/api/agents/a/artifacts/slides/')

    expect(() => runtime.url('nested/../../escape')).toThrow(/cannot escape/)
    expect(() => runtime.url('nested/%2e%2e/%2e%2e/escape')).toThrow(/cannot escape/)
  })

  it('injects the fallback before Vite application scripts', () => {
    const plugin = gamutDashboard()
    const tags = plugin.transformIndexHtml()

    expect(tags).toHaveLength(1)
    expect(tags[0]).toMatchObject({
      tag: 'script',
      attrs: { 'data-gamut-dashboard-fallback': 'true' },
      injectTo: 'head-prepend',
    })
    expect(tags[0].children).toContain('__GAMUT_DASHBOARD__')
  })
})
