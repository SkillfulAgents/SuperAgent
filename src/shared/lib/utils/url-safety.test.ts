import { describe, it, expect } from 'vitest'
import { isPrivateHost, validateHttpUrl, validateSafeCloneUrl } from './url-safety'

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
