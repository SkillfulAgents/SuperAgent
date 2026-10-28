import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'events'

import {
  artifactWebSocketForwardHeaders,
  parseArtifactWebSocketRoute,
} from './artifact-stream-proxy'

function request(headers: Record<string, string>) {
  return {
    headers,
    socket: Object.assign(new EventEmitter(), {
      encrypted: false,
      remoteAddress: '127.0.0.1',
    }),
  } as any
}

describe('artifact WebSocket route', () => {
  it('maps the public dashboard path to the container proxy path', () => {
    expect(
      parseArtifactWebSocketRoute('/api/agents/agent-1/artifacts/open-slide/__vite_hmr'),
    ).toEqual({
      routeAgentId: 'agent-1',
      artifactSlug: 'open-slide',
      publicBasePath: '/api/agents/agent-1/artifacts/open-slide/',
      containerPath: '/artifacts/open-slide/__vite_hmr',
    })
  })

  it('rejects malformed and invalid artifact paths', () => {
    expect(parseArtifactWebSocketRoute('/api/agents/a/browser/stream')).toBeNull()
    expect(parseArtifactWebSocketRoute('/api/agents/a/artifacts/../hmr')).toBeNull()
    expect(parseArtifactWebSocketRoute('/api/agents/a/artifacts/OpenSlide/hmr')).toBeNull()
  })
})

describe('artifact WebSocket forwarding headers', () => {
  it('adds the mount contract and strips handshake/host-auth internals', () => {
    const result = artifactWebSocketForwardHeaders(
      request({
        host: 'gamut.example',
        origin: 'https://gamut.example',
        cookie: 'dashboard=abc',
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'secret',
        'x-superagent-host-token': 'do-not-forward',
      }),
      '/api/agents/a/artifacts/slides/',
    )

    expect(result['x-forwarded-prefix']).toBe('/api/agents/a/artifacts/slides')
    expect(result['x-forwarded-host']).toBe('gamut.example')
    expect(result['x-forwarded-proto']).toBe('https')
    expect(result['x-forwarded-for']).toBe('127.0.0.1')
    expect(result.cookie).toBe('dashboard=abc')
    expect(result).not.toHaveProperty('sec-websocket-key')
    expect(result).not.toHaveProperty('x-superagent-host-token')
  })
})
