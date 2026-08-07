import { describe, it, expect } from 'vitest'
import { buildUpstreamHeaders, buildClientHeaders } from './forward-headers'

describe('buildUpstreamHeaders', () => {
  it('forwards only content-type, accept, and prefer', () => {
    const request = new Request('https://host.example/api/services/replicate/x', {
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        prefer: 'wait',
        authorization: 'Bearer agent-proxy-token',
        host: 'host.example',
        cookie: 'session=abc',
        connection: 'keep-alive',
        'x-custom': 'nope',
      },
    })

    const headers = buildUpstreamHeaders(request, 'platform-token')

    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.get('prefer')).toBe('wait')
    expect(headers.get('authorization')).toBe('Bearer platform-token')
    expect(headers.get('host')).toBeNull()
    expect(headers.get('cookie')).toBeNull()
    expect(headers.get('connection')).toBeNull()
    expect(headers.get('x-custom')).toBeNull()
  })

  it('sets Authorization last and never forwards inbound Authorization', () => {
    const request = new Request('https://host.example/x', {
      headers: {
        authorization: 'Bearer inbound',
      },
    })

    const headers = buildUpstreamHeaders(request, 'token::member')

    expect(headers.get('authorization')).toBe('Bearer token::member')
    expect([...headers.keys()]).toEqual(['authorization'])
  })

  it('omits allowlisted headers that were not present', () => {
    const request = new Request('https://host.example/x')
    const headers = buildUpstreamHeaders(request, 't')
    expect(headers.get('content-type')).toBeNull()
    expect(headers.get('accept')).toBeNull()
    expect(headers.get('prefer')).toBeNull()
    expect(headers.get('authorization')).toBe('Bearer t')
  })
})

describe('buildClientHeaders', () => {
  it('strips framing, credentials, and access-control headers', () => {
    const upstream = new Headers({
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'content-length': '12',
      'transfer-encoding': 'chunked',
      connection: 'keep-alive',
      'keep-alive': 'timeout=5',
      upgrade: 'websocket',
      'set-cookie': 'a=1',
      'set-auth-token': 'secret',
      authorization: 'Bearer leaked',
      'www-authenticate': 'Bearer',
      'access-control-allow-origin': '*',
      'x-request-id': 'req-1',
    })

    const headers = buildClientHeaders({ headers: upstream })

    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('x-request-id')).toBe('req-1')
    expect(headers.get('content-encoding')).toBeNull()
    expect(headers.get('content-length')).toBeNull()
    expect(headers.get('transfer-encoding')).toBeNull()
    expect(headers.get('connection')).toBeNull()
    expect(headers.get('keep-alive')).toBeNull()
    expect(headers.get('upgrade')).toBeNull()
    expect(headers.get('set-cookie')).toBeNull()
    expect(headers.get('set-auth-token')).toBeNull()
    expect(headers.get('authorization')).toBeNull()
    expect(headers.get('www-authenticate')).toBeNull()
    expect(headers.get('access-control-allow-origin')).toBeNull()
  })
})
