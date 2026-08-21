import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const mockGetSettings = vi.fn()

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
}))

import favicon from './favicon'

function createApp() {
  const app = new Hono()
  app.route('/api/favicon', favicon)
  return app
}

describe('favicon route', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSettings.mockReturnValue({ app: {} })
    app = createApp()
  })

  it('serves the default SVG favicon', async () => {
    const res = await app.request('http://localhost/api/favicon')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
    expect(res.headers.get('cache-control')).toContain('no-cache')
    expect(await res.text()).toContain('<svg')
  })

  it('serves a configured image favicon', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    mockGetSettings.mockReturnValue({
      app: {
        faviconDataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
      },
    })

    const res = await app.request('http://localhost/api/favicon')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes)
  })

  it('falls back to the default favicon when the saved value is invalid', async () => {
    mockGetSettings.mockReturnValue({
      app: {
        faviconDataUrl: 'data:text/html;base64,PGgxPk5vcGU8L2gxPg==',
      },
    })

    const res = await app.request('http://localhost/api/favicon')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
  })
})
