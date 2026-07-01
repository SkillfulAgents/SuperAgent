import { describe, it, expect } from 'vitest'
import { applyAllowedSites } from './allowed-sites'
import type { WebSearchHit } from './types'

function hit(url: string): WebSearchHit {
  return { url, title: null, snippet: '' }
}

describe('applyAllowedSites', () => {
  const hits = [hit('https://nytimes.com/a'), hit('https://evil.com/b'), hit('https://blog.nytimes.com/c')]

  it('returns hits unchanged when no policy is set', () => {
    const out = applyAllowedSites(hits, {})
    expect(out.hits).toBe(hits)
    expect(out.removed).toBe(0)
  })

  it('drops hits whose host matches a blocked pattern', () => {
    const out = applyAllowedSites(hits, { blockedSites: ['evil.com'] })
    expect(out.hits.map((h) => h.url)).toEqual(['https://nytimes.com/a', 'https://blog.nytimes.com/c'])
    expect(out.removed).toBe(1)
  })

  it('keeps only hits whose host matches an allowed pattern', () => {
    const out = applyAllowedSites(hits, { allowedSites: ['nytimes.com'] })
    expect(out.hits.map((h) => h.url)).toEqual(['https://nytimes.com/a'])
    expect(out.removed).toBe(2)
  })

  it('honors *. wildcard subdomains in the allow list', () => {
    const out = applyAllowedSites(hits, { allowedSites: ['*.nytimes.com'] })
    expect(out.hits.map((h) => h.url)).toEqual(['https://blog.nytimes.com/c'])
  })

  it('lets a block override an allow for the same host', () => {
    const out = applyAllowedSites(hits, { allowedSites: ['nytimes.com'], blockedSites: ['nytimes.com'] })
    expect(out.hits).toEqual([])
    expect(out.removed).toBe(3)
  })

  it('drops a hit with an unparseable url when a policy is active', () => {
    const out = applyAllowedSites([hit('not a url')], { allowedSites: ['nytimes.com'] })
    expect(out.hits).toEqual([])
    expect(out.removed).toBe(1)
  })
})
