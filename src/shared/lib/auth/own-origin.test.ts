import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const trusted = vi.hoisted(() => ({ origins: [] as string[] }))
vi.mock('./trusted-origins', () => ({ getTrustedOrigins: () => trusted.origins }))

const { isLocalHostname, isOwnOrigin } = await import('./own-origin')

describe('isOwnOrigin', () => {
  const env = { ...process.env }

  beforeEach(() => {
    trusted.origins = []
    process.env.PORT = '47891'
    delete process.env.HOST
    delete process.env.HOST_PUBLIC_URL
  })

  afterEach(() => {
    process.env = { ...env }
  })

  describe('behind a TLS proxy at https://app.example.com', () => {
    const request = ['https://app.example.com', 'https://app.example.com/api/agents/a/sessions/s/login-request']

    beforeEach(() => {
      trusted.origins = ['https://app.example.com', 'https://agents.example.org']
    })

    it.each([
      ['the address containers reach the host at', 'http://host.docker.internal:47891'],
      ['Podman\'s name for the host', 'http://host.containers.internal:47891'],
      ['a container gateway address', 'http://192.168.64.1:47891'],
      ['the public host with a trailing dot', 'https://app.example.com.'],
      ['the public host on another port', 'http://app.example.com:47891'],
      ['another trusted origin', 'https://agents.example.org'],
      ['a *.localhost name', 'http://app.localhost:47891'],
      ['localhost with a trailing dot', 'http://localhost.:47891'],
      ['another loopback address', 'http://127.0.0.2:47891'],
      ['IPv6 loopback', 'http://[::1]:47891'],
      ['an IPv4-mapped loopback', 'http://[::ffff:127.0.0.1]:47891'],
      ['the uppercased public host', 'https://APP.EXAMPLE.COM'],
    ])('is this app: %s', (_name, origin) => {
      expect(isOwnOrigin(origin, request)).toBe(true)
    })

    it.each([
      ['a third-party site', 'https://github.com'],
      ['a sibling subdomain', 'https://www.example.com'],
      ['a local dev server on another port', 'http://host.docker.internal:3000'],
      ['a private-network service on another port', 'http://192.168.1.20:8080'],
    ])('is not this app: %s', (_name, origin) => {
      expect(isOwnOrigin(origin, request)).toBe(false)
    })
  })

  it('knows the address this request reached it at, on a desktop install with no configuration', () => {
    process.env.PORT = '47896'
    expect(isOwnOrigin('http://localhost:47896', [undefined, 'http://localhost:47896/api/agents/a'])).toBe(true)
    expect(isOwnOrigin('http://host.docker.internal:47896', [undefined, 'http://localhost:47896/api/agents/a'])).toBe(true)
    expect(isOwnOrigin('http://localhost:5173', [undefined, 'http://localhost:47896/api/agents/a'])).toBe(false)
  })

  it('knows HOST_PUBLIC_URL and HOST, whatever the request came through', () => {
    process.env.HOST_PUBLIC_URL = 'https://tunnel.example.net'
    process.env.HOST = 'server.example.org'
    expect(isOwnOrigin('https://tunnel.example.net', ['http://localhost:47891/api'])).toBe(true)
    expect(isOwnOrigin('https://server.example.org', ['http://localhost:47891/api'])).toBe(true)
  })

  it('takes nothing that is not a URL for an address', () => {
    expect(isOwnOrigin('not a url', ['http://localhost:47891'])).toBe(false)
    expect(isOwnOrigin('https://github.com', ['garbage', undefined])).toBe(false)
  })
})

describe('isLocalHostname', () => {
  it.each(['localhost', 'LOCALHOST.', 'app.localhost', 'host.docker.internal', 'gateway', '127.8.0.1', '10.0.0.5', '172.20.1.1', '192.168.0.1',
    '169.254.1.1', '100.100.1.1', '0.0.0.0', '[::1]', '::1', 'fd00::1', 'fe80::1', '[::ffff:7f00:1]'])('%s is local', (name) => {
    expect(isLocalHostname(name)).toBe(true)
  })

  it.each(['github.com', '172.32.0.1', '192.169.0.1', '8.8.8.8', '2001:4860::8888', 'example.internal.com'])('%s is not', (name) => {
    expect(isLocalHostname(name)).toBe(false)
  })
})
