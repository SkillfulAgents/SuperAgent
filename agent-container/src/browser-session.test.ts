import { describe, expect, it } from 'vitest'
import { candidateOrigins, cookieFromSitePort, cookieInScope, hashSession, originInScope, toSessionCookie } from './browser-session'

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
    // The parent host's own cookie (no leading dot) is never sent to the site.
    expect(cookieInScope('okta.com', 'acme.okta.com')).toBe(false)
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
    expect(originInScope('http://app.intranet.test:8080', 'intranet.test:8080')).toBe(true)
    expect(originInScope('http://app.intranet.test:9090', 'intranet.test:8080')).toBe(false)
    expect(originInScope('https://app.example.com:8443', 'example.com')).toBe(false)
    expect(originInScope('chrome://settings', 'settings')).toBe(false)
  })

  it('looks for storage on the sign-in origin, subdomains its cookies name, and what the tabs show and went through', () => {
    expect(candidateOrigins(
      { site: 'example.com', origin: 'https://example.com' },
      [{ domain: '.example.com' }, { domain: 'app.example.com' }, { domain: '.other.com' }],
      ['https://www.example.com/feed?x=1', 'https://accounts.example.com/sso', 'https://other.com/', 'chrome://newtab/'],
    )).toEqual(['https://accounts.example.com', 'https://app.example.com', 'https://example.com', 'https://www.example.com'])
  })

  it('looks for a subdomain\'s storage on the sign-in\'s scheme and port', () => {
    expect(candidateOrigins({ site: 'intranet.test:8080', origin: 'http://intranet.test:8080' }, [{ domain: 'app.intranet.test' }], []))
      .toEqual(['http://app.intranet.test:8080', 'http://intranet.test:8080'])
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

describe('hashSession', () => {
  const cookies = [toSessionCookie(cdpCookie())!, toSessionCookie(cdpCookie({ name: 'device', value: 'd' }))!]
  const origins = [
    { origin: 'https://acme.okta.com', localStorage: [['a', '1'], ['b', '2']] as Array<[string, string]>, indexedDB: [] },
    { origin: 'https://app.acme.okta.com', localStorage: [['token', 't']] as Array<[string, string]>, indexedDB: [] },
  ]

  it('changes with a cookie value, not with order or an expiry pushed out', () => {
    const hash = hashSession({ cookies, origins })
    expect(hashSession({ cookies: [...cookies].reverse(), origins: [...origins].reverse() })).toBe(hash)
    expect(hashSession({ cookies: cookies.map((cookie) => ({ ...cookie, expires: 2_100_000_000 })), origins })).toBe(hash)
    expect(hashSession({ cookies: [{ ...cookies[0], value: 'rotated' }, cookies[1]], origins })).not.toBe(hash)
    expect(hashSession({ cookies: [cookies[0]], origins })).not.toBe(hash)
  })

  it('changes with what the site stored, not with the order it was read in', () => {
    const hash = hashSession({ cookies, origins })
    expect(hashSession({ cookies, origins: [{ ...origins[0], localStorage: [['b', '2'], ['a', '1']] }, origins[1]] })).toBe(hash)
    expect(hashSession({ cookies, origins: [origins[0], { ...origins[1], localStorage: [['token', 'signed-in']] }] })).not.toBe(hash)
    expect(hashSession({ cookies, origins: [origins[0]] })).not.toBe(hash)
  })
})
