import { describe, expect, it } from 'vitest'
import { isHostOnlyHostname, rewriteLoopbackForContainer } from './container-url'

describe('rewriteLoopbackForContainer', () => {
  it('rewrites localhost, IPv4 loopback, and bracketed IPv6 to the supplied host address', () => {
    expect(rewriteLoopbackForContainer('http://localhost:4000', 'host.docker.internal')).toBe(
      'http://host.docker.internal:4000',
    )
    expect(rewriteLoopbackForContainer('http://127.0.0.1:4000', 'host.docker.internal')).toBe(
      'http://host.docker.internal:4000',
    )
    expect(rewriteLoopbackForContainer('http://[::1]:11434', 'host.docker.internal')).toBe(
      'http://host.docker.internal:11434',
    )
  })

  it('leaves non-loopback URLs untouched', () => {
    expect(rewriteLoopbackForContainer('http://ollama.example.com:11434', 'host.docker.internal')).toBe(
      'http://ollama.example.com:11434',
    )
    // "localhost.mycorp.dev" is not the loopback hostname.
    expect(
      rewriteLoopbackForContainer('http://localhost.mycorp.dev:4000', 'host.docker.internal'),
    ).toBe('http://localhost.mycorp.dev:4000')
  })

  it('honors an explicit host address, including trailing slash', () => {
    expect(rewriteLoopbackForContainer('http://localhost:11434', '192.168.64.1')).toBe(
      'http://192.168.64.1:11434',
    )
    expect(rewriteLoopbackForContainer('http://[::1]:11434', '192.168.64.1')).toBe(
      'http://192.168.64.1:11434',
    )
    expect(rewriteLoopbackForContainer('http://localhost:11434/', '192.168.64.1')).toBe(
      'http://192.168.64.1:11434/',
    )
  })
})

describe('isHostOnlyHostname', () => {
  it('flags single-label hostnames (host-resolver-only names like Tailscale MagicDNS)', () => {
    expect(isHostOnlyHostname('iddo-gino-gputer')).toBe(true)
    expect(isHostOnlyHostname('gputer')).toBe(true)
  })

  it('accepts fully-qualified domain names', () => {
    expect(isHostOnlyHostname('iddo-gino-gputer.taila37989.ts.net')).toBe(false)
    expect(isHostOnlyHostname('ollama.local')).toBe(false)
  })

  it('accepts IP literals', () => {
    expect(isHostOnlyHostname('192.168.1.5')).toBe(false)
    expect(isHostOnlyHostname('[::1]')).toBe(false)
    expect(isHostOnlyHostname('[fe80::1]')).toBe(false)
  })

  it('accepts loopback names - the container rewrite handles those', () => {
    expect(isHostOnlyHostname('localhost')).toBe(false)
    expect(isHostOnlyHostname('127.0.0.1')).toBe(false)
  })
})
