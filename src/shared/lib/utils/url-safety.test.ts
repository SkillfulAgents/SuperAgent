import { describe, it, expect } from 'vitest'
import {
  isLocalhostHost,
  isPrivateHost,
  isHostOrSubdomain,
  tryParseUrl,
  validateHttpUrl,
  validateSafeCloneUrl,
} from './url-safety'

describe('isLocalhostHost', () => {
  it.each([
    'localhost',
    'foo.localhost',
    '127.0.0.1',
    '127.5.5.5',
    '0.0.0.0',
    '::1',
    'ip6-localhost',
    'ip6-loopback',
    '::ffff:127.0.0.1',
  ])('flags %s as localhost', (host) => {
    expect(isLocalhostHost(host)).toBe(true)
  })

  it.each([
    'example.com',
    '10.0.0.1',
    '192.168.1.1',
    '172.16.0.1',
    '169.254.169.254',
    '8.8.8.8',
    'box.local',
    'fd00::1',
    'fe80::1',
  ])('does not flag %s as localhost', (host) => {
    expect(isLocalhostHost(host)).toBe(false)
  })
})

describe('isPrivateHost', () => {
  it.each([
    'localhost',
    'foo.localhost',
    'box.local',
    '127.0.0.1',
    '127.5.5.5',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fd00::1',
    'fe80::1',
    'fea0::1', // fe80::/10 (not just fe80::/16)
    'febf::1',
    '::ffff:10.0.0.1',
  ])('flags %s as private', (host) => {
    expect(isPrivateHost(host)).toBe(true)
  })

  it.each([
    'example.com',
    'github.com',
    'api.platform.example',
    '8.8.8.8',
    '1.1.1.1',
    '172.15.0.1', // just outside the private range
    '172.32.0.1',
    '192.167.0.1',
  ])('does not flag %s', (host) => {
    expect(isPrivateHost(host)).toBe(false)
  })
})

describe('isHostOrSubdomain', () => {
  it.each([
    ['slack.com', 'slack.com'],
    ['files.slack.com', 'slack.com'],
    ['a.b.slack.com', 'slack.com'],
    ['SLACK.COM', 'slack.com'],
  ])('matches %s against %s', (host, domain) => {
    expect(isHostOrSubdomain(host, domain)).toBe(true)
  })

  it.each([
    ['evilslack.com', 'slack.com'],
    ['slack.com.evil.com', 'slack.com'],
    ['notslack.com', 'slack.com'],
    ['slackXcom', 'slack.com'],
    ['', 'slack.com'],
  ])('does not match %s against %s', (host, domain) => {
    expect(isHostOrSubdomain(host, domain)).toBe(false)
  })
})

describe('tryParseUrl', () => {
  it('parses absolute URLs', () => {
    expect(tryParseUrl('https://example.com/x')?.host).toBe('example.com')
  })

  it('resolves relative inputs against a base', () => {
    const base = new URL('https://files.slack.com/a/b')
    expect(tryParseUrl('/c/d', base)?.toString()).toBe('https://files.slack.com/c/d')
  })

  it('returns null on malformed input', () => {
    expect(tryParseUrl('not a url')).toBeNull()
    expect(tryParseUrl('/relative-without-base')).toBeNull()
  })
})

describe('validateHttpUrl', () => {
  it('accepts https and http', () => {
    expect(() => validateHttpUrl('https://example.com')).not.toThrow()
    expect(() => validateHttpUrl('http://example.com')).not.toThrow()
  })

  it('rejects other schemes', () => {
    expect(() => validateHttpUrl('ssh://git@example.com/foo.git')).toThrow(/Unsafe URL protocol/)
    expect(() => validateHttpUrl('file:///etc/passwd')).toThrow(/Unsafe URL protocol/)
    expect(() => validateHttpUrl('javascript:alert(1)')).toThrow(/Unsafe URL protocol/)
  })

  it('rejects malformed URLs', () => {
    expect(() => validateHttpUrl('not a url')).toThrow(/Invalid URL/)
  })
})

describe('validateSafeCloneUrl', () => {
  it('accepts public https URLs', () => {
    expect(() => validateSafeCloneUrl('https://github.com/foo/bar.git')).not.toThrow()
  })

  it('rejects private hosts', () => {
    expect(() => validateSafeCloneUrl('http://127.0.0.1/foo.git')).toThrow(/Unsafe clone URL host/)
    expect(() => validateSafeCloneUrl('http://192.168.1.1/foo.git')).toThrow(/Unsafe clone URL host/)
    expect(() => validateSafeCloneUrl('http://localhost/foo.git')).toThrow(/Unsafe clone URL host/)
  })

  it('rejects non-http schemes', () => {
    expect(() => validateSafeCloneUrl('git://github.com/foo.git')).toThrow(/Unsafe URL protocol/)
  })

  it('honors allowedHostPrefixes', () => {
    expect(() => validateSafeCloneUrl('https://platform.example/foo.git', {
      allowedHostPrefixes: ['https://platform.example'],
    })).not.toThrow()

    expect(() => validateSafeCloneUrl('https://github.com/foo.git', {
      allowedHostPrefixes: ['https://platform.example'],
    })).toThrow(/not on an allowed host/)
  })
})
