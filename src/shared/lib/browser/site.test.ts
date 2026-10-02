import { describe, expect, it } from 'vitest'
import { siteOf } from './site'

describe('siteOf', () => {
  it.each([
    ['https://www.linkedin.com/feed/', 'linkedin.com'],
    ['https://app.foo.co.uk/login', 'foo.co.uk'],
    ['https://alice.github.io/page', 'alice.github.io'],
    ['http://Accounts.Example.COM:8080/', 'example.com'],
  ])('%s -> %s', (url, site) => {
    expect(siteOf(url)).toBe(site)
  })

  it.each([
    'http://localhost:3000/',
    'http://127.0.0.1/',
    'http://[::1]/',
    'file:///tmp/index.html',
    'about:blank',
    'not a url',
  ])('%s has no site', (url) => {
    expect(siteOf(url)).toBeNull()
  })
})
