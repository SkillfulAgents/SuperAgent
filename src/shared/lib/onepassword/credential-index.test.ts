import { describe, it, expect } from 'vitest'
import { normalizeHost, buildCredentialIndex, matchCandidates, siteNameQuery } from './credential-index'
import type { OpLoginItem } from './op-schema'

const item = (id: string, title: string, hrefs: string[] = [], username?: string): OpLoginItem => ({
  id,
  title,
  category: 'LOGIN',
  urls: hrefs.map((href) => ({ href })),
  fields: username ? [{ id: 'username', value: username }] : [],
})

describe('normalizeHost', () => {
  it('lowercases and drops a www prefix', () => {
    expect(normalizeHost('https://WWW.Notion.so/login')).toBe('notion.so')
  })

  it('keeps a non-www subdomain', () => {
    expect(normalizeHost('https://sso.corp.com/login')).toBe('sso.corp.com')
  })

  it('accepts a bare host with no scheme, which 1Password stores', () => {
    expect(normalizeHost('github.com')).toBe('github.com')
    expect(normalizeHost('www.github.com/login')).toBe('github.com')
  })

  it('returns null for a non-url', () => {
    expect(normalizeHost('not a url')).toBeNull()
  })

  it('does not treat about:blank as a host', () => {
    expect(normalizeHost('about:blank')).toBeNull()
  })
})

describe('siteNameQuery', () => {
  it('uses the registrable site name', () => {
    expect(siteNameQuery('https://github.com/login')).toBe('github')
    expect(siteNameQuery('https://www.github.com')).toBe('github')
    expect(siteNameQuery('https://sso.corp.com/login')).toBe('corp')
  })

  it('skips short labels', () => {
    expect(siteNameQuery('https://x.com')).toBeNull()
    expect(siteNameQuery('https://me.com')).toBeNull()
  })

  it('keeps a private-suffix host as its own name', () => {
    expect(siteNameQuery('https://alice.github.io/app')).toBe('alice')
  })

  it('returns null for a non-page', () => {
    expect(siteNameQuery('about:blank')).toBeNull()
  })
})

describe('matchCandidates', () => {
  it('prefers an exact host match over a parent-domain match', () => {
    const index = buildCredentialIndex([
      item('a', 'Corp SSO', ['https://sso.corp.com'], 'a@corp.com'),
      item('b', 'Corp Root', ['https://corp.com'], 'b@corp.com'),
    ])
    const hits = matchCandidates(index, 'https://sso.corp.com/login')
    expect(hits.map((h) => h.itemId)).toEqual(['a', 'b'])
    expect(hits[0].confidence).toBe('exact')
    expect(hits[1].confidence).toBe('domain')
  })

  it('does not match a child domain from a parent page', () => {
    // An item for sso.corp.com is NOT a credential for corp.com.
    const index = buildCredentialIndex([item('a', 'Corp SSO', ['https://sso.corp.com'])])
    expect(matchCandidates(index, 'https://corp.com/login')).toEqual([])
  })

  it('returns every item on an ambiguous host so the user can choose', () => {
    const index = buildCredentialIndex([
      item('a', 'GitHub personal', ['https://github.com'], 'me@x.com'),
      item('b', 'GitHub work', ['https://github.com'], 'me@work.com'),
    ])
    expect(matchCandidates(index, 'https://github.com/login')).toHaveLength(2)
  })

  it('lists an item once even when it records the same host twice', () => {
    const index = buildCredentialIndex([
      item('a', 'Notion', ['https://notion.so/login', 'https://www.notion.so/signin']),
    ])
    expect(matchCandidates(index, 'https://notion.so/login')).toHaveLength(1)
  })

  it('returns nothing when no item records the address', () => {
    const index = buildCredentialIndex([item('a', 'No URL item')])
    expect(matchCandidates(index, 'https://example.com')).toEqual([])
  })

  it('carries the username through to the candidate', () => {
    const index = buildCredentialIndex([
      item('a', 'Bank', ['https://bank.com'], 'me@x.com'),
    ])
    const [hit] = matchCandidates(index, 'https://bank.com/login')
    expect(hit.username).toBe('me@x.com')
  })

  it('ignores an unparseable page address', () => {
    const index = buildCredentialIndex([item('a', 'Notion', ['https://notion.so'])])
    expect(matchCandidates(index, 'about:blank')).toEqual([])
  })

  it('stops the parent-domain walk at the public suffix', () => {
    const index = buildCredentialIndex([item('co.uk-item', 'Suffix', ['https://co.uk'])])
    expect(matchCandidates(index, 'https://example.co.uk/login')).toHaveLength(0)
  })

  it('offers sibling-subdomain items last, labeled site, keeping the recorded host', () => {
    const index = buildCredentialIndex([
      item('exact', 'Mail', ['https://mail.corp.com']),
      item('sibling', 'SSO', ['https://sso.corp.com']),
    ])
    const matches = matchCandidates(index, 'https://mail.corp.com/login')
    expect(matches.map((m) => m.confidence)).toEqual(['exact', 'site'])
    expect(matches[1].host).toBe('sso.corp.com')
  })

  it('never crosses registrable sites for the sibling tier', () => {
    const index = buildCredentialIndex([item('other', 'Other', ['https://sso.other.com'])])
    expect(matchCandidates(index, 'https://mail.corp.com/login')).toHaveLength(0)
  })

  it('treats private-suffix hosts as separate sites', () => {
    const index = buildCredentialIndex([
      item('alice', 'Alice', ['https://alice.github.io']),
      item('bob', 'Bob', ['https://bob.github.io']),
    ])
    expect(matchCandidates(index, 'https://alice.github.io/app').map((m) => m.itemId)).toEqual(['alice'])
    expect(matchCandidates(index, 'https://bob.github.io/app').map((m) => m.itemId)).toEqual(['bob'])
  })
})
