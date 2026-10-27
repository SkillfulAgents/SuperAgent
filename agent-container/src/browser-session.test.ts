import { describe, expect, it } from 'vitest'
import { candidateOrigins, cookieFromSitePort, cookieInScope, hashCookies, originInScope, toSessionCookie } from './browser-session'

const cdpCookie = (overrides: Record<string, unknown> = {}) => ({
  name: 'sid', value: 'v', domain: 'acme.okta.com', path: '/', expires: 2_000_000_000,
  httpOnly: true, secure: true, session: false, sameSite: 'Lax' as const, ...overrides,
})

describe('the scope of a saved session', () => {
  it('takes cookies set for the site\'s host, a subdomain or a parent domain, never a sibling\'s', () => {
    expect(cookieInScope('acme.okta.com', 'acme.okta.com')).toBe(true)
    expect(cookieInScope('.ACME.okta.com', 'acme.okta.com')).toBe(true)
    expect(cookieInScope('login.acme.okta.com', 'acme.okta.com')).toBe(true)
    expect(cookieInScope('.okta.com', 'acme.okta.com')).toBe(true)
    expect(cookieInScope('beta.okta.com', 'acme.okta.com')).toBe(false)
    expect(cookieInScope('notacme.okta.com', 'acme.okta.com')).toBe(false)
    expect(cookieInScope('acme.okta.com.evil.com', 'acme.okta.com')).toBe(false)
    // Cookies carry no port: a site on one has its host's.
    expect(cookieInScope('172.17.0.1', '172.17.0.1:8101')).toBe(true)
  })

  it('keeps a site on a port to the cookies its port set: dev servers on one host share cookies otherwise', () => {
    expect(cookieFromSitePort(8101, '172.17.0.1:8101')).toBe(true)
    expect(cookieFromSitePort(8102, '172.17.0.1:8101')).toBe(false)
    // Chrome does not always know (-1), and a site without a port takes them all.
    expect(cookieFromSitePort(-1, '172.17.0.1:8101')).toBe(true)
    expect(cookieFromSitePort(undefined, '172.17.0.1:8101')).toBe(true)
    expect(cookieFromSitePort(8443, 'github.com')).toBe(true)
  })

  it('takes the storage of the site\'s host and subdomains only, port included', () => {
    expect(originInScope('https://acme.okta.com', 'acme.okta.com')).toBe(true)
    expect(originInScope('https://www.example.com', 'example.com')).toBe(true)
    expect(originInScope('https://okta.com', 'acme.okta.com')).toBe(false)
    expect(originInScope('https://beta.okta.com', 'acme.okta.com')).toBe(false)
    expect(originInScope('http://172.17.0.1:8101', '172.17.0.1:8101')).toBe(true)
    expect(originInScope('http://172.17.0.1:8102', '172.17.0.1:8101')).toBe(false)
    expect(originInScope('chrome://settings', 'settings')).toBe(false)
  })

  it('looks for storage on the sign-in origin, subdomains its cookies name, and what the tabs show and went through', () => {
    expect(candidateOrigins(
      { site: 'example.com', origin: 'https://example.com' },
      [{ domain: '.example.com' }, { domain: 'app.example.com' }, { domain: '.other.com' }],
      ['https://www.example.com/feed?x=1', 'https://accounts.example.com/sso', 'https://other.com/', 'chrome://newtab/'],
    )).toEqual(['https://accounts.example.com', 'https://app.example.com', 'https://example.com', 'https://www.example.com'])
  })
})

describe('toSessionCookie', () => {
  it('keeps every attribute setCookies takes, with no expiry for a session cookie', () => {
    const partitionKey = { topLevelSite: 'https://top.com', hasCrossSiteAncestor: true }
    expect(toSessionCookie(cdpCookie({ session: true, expires: -1, partitionKey, sourcePort: 443, sourceScheme: 'Secure' }))).toEqual({
      name: 'sid', value: 'v', domain: 'acme.okta.com', path: '/', httpOnly: true, secure: true, sameSite: 'Lax',
      sourceScheme: 'Secure', sourcePort: 443, partitionKey,
    })
    expect(toSessionCookie(cdpCookie())?.expires).toBe(2_000_000_000)
  })

  it('leaves out a cookie whose partition key it does not know the form of', () => {
    expect(toSessionCookie(cdpCookie({ partitionKey: 'https://top.com' }))).toBeNull()
  })
})

describe('hashCookies', () => {
  const base = [toSessionCookie(cdpCookie())!, toSessionCookie(cdpCookie({ name: 'device', value: 'd' }))!]

  it('changes with a value, not with order or an expiry pushed out', () => {
    const hash = hashCookies(base)
    expect(hashCookies([...base].reverse())).toBe(hash)
    expect(hashCookies(base.map((cookie) => ({ ...cookie, expires: 2_100_000_000 })))).toBe(hash)
    expect(hashCookies([{ ...base[0], value: 'rotated' }, base[1]])).not.toBe(hash)
    expect(hashCookies([base[0]])).not.toBe(hash)
  })
})
