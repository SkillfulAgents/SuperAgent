import { describe, expect, it } from 'vitest'

import {
  dashboardWebSocketForwardHeaders,
  dashboardWebSocketUpstreamPath,
  parseDashboardProxyRoute,
  requestedWebSocketProtocols,
} from './dashboard-proxy'

describe('dashboard proxy route', () => {
  it('strips the container artifact prefix for a dashboard WebSocket', () => {
    expect(parseDashboardProxyRoute('/artifacts/open-slide/__vite_hmr')).toEqual({
      slug: 'open-slide',
      subPath: '/__vite_hmr',
    })
    expect(parseDashboardProxyRoute('/artifacts/open-slide')).toEqual({
      slug: 'open-slide',
      subPath: '/',
    })
  })

  it('rejects invalid slugs and unrelated paths', () => {
    expect(parseDashboardProxyRoute('/sessions/a/stream')).toBeNull()
    expect(parseDashboardProxyRoute('/artifacts/../socket')).toBeNull()
    expect(parseDashboardProxyRoute('/artifacts/OpenSlide/socket')).toBeNull()
  })
})

describe('dashboard WebSocket headers', () => {
  it('preserves proxy metadata but removes both handshake and host secrets', () => {
    const request = {
      headers: {
        cookie: 'dashboard=abc',
        'x-forwarded-prefix': '/api/agents/a/artifacts/slides',
        'x-superagent-host-token': 'secret',
        'sec-websocket-key': 'key',
        'sec-websocket-protocol': 'vite-hmr, second',
        upgrade: 'websocket',
      },
    } as any

    expect(dashboardWebSocketForwardHeaders(request)).toEqual({
      cookie: 'dashboard=abc',
      'x-forwarded-prefix': '/api/agents/a/artifacts/slides',
    })
    expect(requestedWebSocketProtocols(request)).toEqual(['vite-hmr', 'second'])
  })
})

describe('dashboard WebSocket upstream path', () => {
  const basePath = '/api/agents/agent-1/artifacts/open-slide/'

  it('restores the public Vite base for HMR handshakes', () => {
    expect(dashboardWebSocketUpstreamPath('/', ['vite-hmr'], basePath)).toBe(basePath)
    expect(dashboardWebSocketUpstreamPath('/custom-hmr', ['vite-ping'], basePath)).toBe(
      `${basePath}custom-hmr`,
    )
  })

  it('leaves application WebSocket paths stripped', () => {
    expect(dashboardWebSocketUpstreamPath('/socket', ['dashboard-v1'], basePath)).toBe('/socket')
    expect(dashboardWebSocketUpstreamPath('/socket', ['vite-hmr'], null)).toBe('/socket')
  })
})
