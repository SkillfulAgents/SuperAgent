import { describe, expect, it } from 'vitest'
import { registrableDomain, siteOfOrigin, usernameKey, vaultFillsInto } from './site'

describe('siteOfOrigin', () => {
  it('keys an account by the exact host of the fields\' frame, without a leading www', () => {
    expect(siteOfOrigin('https://login.github.com')).toBe('login.github.com')
    expect(siteOfOrigin('https://accounts.google.com')).toBe('accounts.google.com')
    expect(siteOfOrigin('https://www.bbc.co.uk')).toBe('bbc.co.uk')
    expect(siteOfOrigin('https://GitHub.com')).toBe('github.com')
  })

  it('keeps tenants of a shared host apart, listed as a public suffix or not', () => {
    expect(siteOfOrigin('https://acme.myshopify.com')).toBe('acme.myshopify.com')
    // Not on the Public Suffix List: a registrable domain would make these one site.
    expect(siteOfOrigin('https://acme.okta.com')).toBe('acme.okta.com')
    expect(siteOfOrigin('https://evil.okta.com')).toBe('evil.okta.com')
    expect(siteOfOrigin('https://acme.slack.com')).not.toBe(siteOfOrigin('https://beta.slack.com'))
  })

  it('keeps a port that is not the scheme\'s own', () => {
    expect(siteOfOrigin('http://localhost:5173')).toBe('localhost:5173')
    expect(siteOfOrigin('http://127.0.0.1:8080')).toBe('127.0.0.1:8080')
    expect(siteOfOrigin('https://intranet.example:8443')).toBe('intranet.example:8443')
    expect(siteOfOrigin('https://github.com:443')).toBe('github.com')
  })

  it('has no site for anything but http(s)', () => {
    expect(siteOfOrigin('file:///etc/passwd')).toBeNull()
    expect(siteOfOrigin('chrome://settings')).toBeNull()
    expect(siteOfOrigin('not a url')).toBeNull()
  })
})

describe('registrableDomain', () => {
  it('names the domain a site is on, for telling its sign-in provider', () => {
    expect(registrableDomain('accounts.google.com')).toBe('google.com')
    expect(registrableDomain('login.live.com')).toBe('live.com')
    expect(registrableDomain('acme.myshopify.com')).toBe('acme.myshopify.com')
    expect(registrableDomain('localhost:5173')).toBe('localhost:5173')
    expect(registrableDomain('127.0.0.1:8080')).toBe('127.0.0.1:8080')
  })
})

describe('usernameKey', () => {
  it('compares usernames without case or surrounding space', () => {
    expect(usernameKey(' Iddo@Example.COM ')).toBe('iddo@example.com')
  })
})

describe('vaultFillsInto', () => {
  it('fills an encrypted page, and a plain-HTTP one only with what was saved over plain HTTP', () => {
    expect(vaultFillsInto('https://github.com', 'https://github.com')).toBe(true)
    expect(vaultFillsInto('http://intranet.example', 'https://intranet.example')).toBe(true)
    expect(vaultFillsInto('https://github.com', 'http://github.com')).toBe(false)
    expect(vaultFillsInto('http://intranet.example', 'http://intranet.example')).toBe(true)
    expect(vaultFillsInto('https://app.test', 'http://localhost:3000')).toBe(true)
  })
})
