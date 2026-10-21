import { describe, expect, it } from 'vitest'
import vm from 'node:vm'
import { RULE_HELPERS_SOURCE } from './helpers-source'

interface Address { name: string; address: string; local: string; domain: string; group: string | null }
interface Helpers {
  decodeBase64(s: unknown): string | null
  parseMessage(raw: unknown): { headers: Array<{ name: string; value: string }>; body: string; header(n: string): string | null; headerAll(n: string): string[] } | null
  parseAddressList(v: unknown): Address[] | null
  recipients(m: unknown): Address[] | null
  domainOf(a: unknown): string | null
  domainMatches(d: unknown, b: unknown, o?: { subdomains?: boolean }): boolean
  toNumber(v: unknown): number | null
}

const h = vm.runInNewContext(RULE_HELPERS_SOURCE) as Helpers
const domains = (value: string) => h.parseAddressList(value)?.map((a) => a.domain) ?? null
const addresses = (value: string) => h.parseAddressList(value)?.map((a) => a.address) ?? null

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url')
}

describe('parseAddressList', () => {
  it('parses plain, named and quoted mailboxes', () => {
    expect(addresses('a@acme.com, "Bob, Jr." <bob@acme.com>, Carol <carol@sub.acme.com>')).toEqual([
      'a@acme.com', 'bob@acme.com', 'carol@sub.acme.com',
    ])
    expect(h.parseAddressList('"Bob, Jr." <bob@acme.com>')?.[0].name).toBe('Bob, Jr.')
  })

  it('uses the angle address, never a lookalike display name', () => {
    expect(addresses('"ceo@acme.com" <x@evil.com>')).toEqual(['x@evil.com'])
    expect(domains('ceo@acme.com <x@evil.com>')).toBeNull() // unquoted @ in a phrase is not understood
  })

  it('ignores comments', () => {
    expect(addresses('x@evil.com(acme.com)')).toEqual(['x@evil.com'])
    expect(addresses('(note (nested)) a@acme.com')).toEqual(['a@acme.com'])
  })

  it('flattens groups, including empty ones', () => {
    expect(addresses('team: a@acme.com, b@evil.com;, c@acme.com')).toEqual(['a@acme.com', 'b@evil.com', 'c@acme.com'])
    expect(h.parseAddressList('undisclosed-recipients:;')).toEqual([])
  })

  it('lowercases domains and keeps exact labels', () => {
    expect(domains('A@ACME.COM')).toEqual(['acme.com'])
    expect(domains('a@acme.com.evil.com')).toEqual(['acme.com.evil.com'])
  })

  it('returns [] for empty and null for anything it does not understand', () => {
    expect(h.parseAddressList('')).toEqual([])
    expect(h.parseAddressList(undefined)).toEqual([])
    for (const bad of [
      'a@[127.0.0.1]', // domain literal
      '<@route.com:a@acme.com>', // source route
      'a@acme', // single-label domain
      'a@b@acme.com',
      '"unterminated <a@acme.com>',
      'a@acme.com>',
      '<a@acme.com',
      'team: a@acme.com', // unterminated group
      'a@ac_me.com',
      'a@ácme.com',
      42,
    ]) {
      expect(h.parseAddressList(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})

describe('domainMatches', () => {
  it('matches exactly unless subdomains are allowed', () => {
    expect(h.domainMatches('acme.com', 'acme.com')).toBe(true)
    expect(h.domainMatches('ACME.com', 'acme.COM')).toBe(true)
    expect(h.domainMatches('evilacme.com', 'acme.com', { subdomains: true })).toBe(false)
    expect(h.domainMatches('mail.acme.com', 'acme.com')).toBe(false)
    expect(h.domainMatches('mail.acme.com', 'acme.com', { subdomains: true })).toBe(true)
    expect(h.domainMatches('acme.com.evil.com', 'acme.com', { subdomains: true })).toBe(false)
    expect(h.domainMatches(null, 'acme.com')).toBe(false)
  })
})

describe('decodeBase64 + parseMessage + recipients', () => {
  const message = [
    'From: me@acme.com',
    'To: Alice <alice@acme.com>,',
    ' bob@partner.io',
    'Cc: "ceo@acme.com" <x@evil.com>',
    'Bcc: hidden@evil.com',
    'Subject: hi',
    '',
    'body text To: not-a-header@evil.com',
  ].join('\r\n')

  it('round-trips base64url and plain base64', () => {
    expect(h.decodeBase64(base64url(message))).toBe(message)
    expect(h.decodeBase64(Buffer.from('héllo').toString('base64'))).toBe('héllo')
    expect(h.decodeBase64('***')).toBeNull()
    expect(h.decodeBase64(null)).toBeNull()
  })

  it('decodes padding, line breaks and the url-safe alphabet, and rejects anything else', () => {
    const bytes = Buffer.from([0xfb, 0xff, 0xbf, 0x00, 0x41])
    expect(h.decodeBase64(bytes.toString('base64'))).toBe(String.fromCharCode(0xfb, 0xff, 0xbf, 0x00, 0x41))
    expect(h.decodeBase64(bytes.toString('base64url'))).toBe(String.fromCharCode(0xfb, 0xff, 0xbf, 0x00, 0x41))
    expect(h.decodeBase64('aGVs\r\nbG8=')).toBe('hello')
    expect(h.decodeBase64('aGVsbG8')).toBe('hello')
    expect(h.decodeBase64('aGVsbG8=x')).toBeNull()
    expect(h.decodeBase64('a')).toBeNull()
    expect(h.decodeBase64('aGVs€bG8=')).toBeNull()
  })

  it('decodes a multi-megabyte message quickly', () => {
    const big = 'To: a@acme.com\r\n\r\n' + 'x'.repeat(4 * 1024 * 1024)
    const encoded = base64url(big)
    const started = performance.now()
    expect(h.decodeBase64(encoded)).toBe(big)
    // Catches a super-linear decoder (minutes at this size). Linear takes
    // ~40 ms alone but up to ~480 ms on CI, under coverage on a loaded runner.
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  it('unfolds headers and stops at the body', () => {
    const parsed = h.parseMessage(message)
    expect(parsed?.header('TO')).toBe('Alice <alice@acme.com>, bob@partner.io')
    expect(parsed?.body).toBe('body text To: not-a-header@evil.com')
  })

  it('collects To, Cc, Bcc and duplicates, never the body', () => {
    const withDuplicate = message.replace('Subject: hi', 'Subject: hi\r\nTo: second@evil.com')
    expect(h.recipients(withDuplicate)?.map((a) => a.address)).toEqual([
      'alice@acme.com', 'bob@partner.io', 'second@evil.com', 'x@evil.com', 'hidden@evil.com',
    ])
  })

  it('fails closed on malformed headers or addresses', () => {
    expect(h.recipients('To: a@acme.com\r\nnot a header\r\n\r\nbody')).toBeNull()
    expect(h.recipients('To: a@[1.2.3.4]\r\n\r\n')).toBeNull()
    expect(h.recipients(' folded-first-line\r\n\r\n')).toBeNull()
  })

  it('returns [] for a message with no recipient headers', () => {
    expect(h.recipients('Subject: none\r\n\r\nbody')).toEqual([])
  })
})

describe('toNumber', () => {
  it('accepts numbers and plain decimals only', () => {
    expect(h.toNumber(5000)).toBe(5000)
    expect(h.toNumber('4999.99')).toBe(4999.99)
    expect(h.toNumber(' -12 ')).toBe(-12)
    for (const bad of ['1e4', '', '5,000', 'NaN', NaN, Infinity, null, {}, '0x10']) {
      expect(h.toNumber(bad), String(bad)).toBeNull()
    }
  })
})
