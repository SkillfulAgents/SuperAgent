import { describe, expect, it } from 'vitest'
import { isHostOnlyHostname, rewriteLoopbackForContainer } from './container-url'

describe('rewriteLoopbackForContainer', () => {
  it('rewrites the bracketed IPv6 loopback literal (URL.hostname keeps brackets)', () => {
    expect(rewriteLoopbackForContainer('http://[::1]:11434')).toBe('http://host.docker.internal:11434')
  })

  it('rewrites localhost and IPv4 loopback', () => {
    expect(rewriteLoopbackForContainer('http://localhost:4000')).toBe('http://host.docker.internal:4000')
    expect(rewriteLoopbackForContainer('http://127.0.0.1:4000')).toBe('http://host.docker.internal:4000')
  })

  it('leaves non-loopback URLs untouched', () => {
    expect(rewriteLoopbackForContainer('http://ollama.example.com:11434')).toBe('http://ollama.example.com:11434')
  })

  // Apple Container has no --add-host; the runtime's gateway IP is the only
  // host-reachable address inside the guest (SUP-447).
  it('rewrites to an explicit host address when one is supplied', () => {
    expect(rewriteLoopbackForContainer('http://localhost:11434', '192.168.64.1')).toBe(
      'http://192.168.64.1:11434',
    )
  })

  it('honors an explicit host address for IPv6 loopback and trailing slash', () => {
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

  it('accepts loopback names — the container rewrite handles those', () => {
    expect(isHostOnlyHostname('localhost')).toBe(false)
    expect(isHostOnlyHostname('127.0.0.1')).toBe(false)
  })
})
