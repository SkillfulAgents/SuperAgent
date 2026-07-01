import { describe, it, expect } from 'vitest'
import { formatWebSearchResults } from './format-results'

describe('formatWebSearchResults', () => {
  it('emits a Links: JSON line (renderer contract) with title + url', () => {
    const out = formatWebSearchResults({ hits: [{ url: 'https://a.com', title: 'A', snippet: 's' }] })
    const m = out.match(/Links:\s*(\[[\s\S]*?\])\s*\n/)
    expect(m).not.toBeNull()
    expect(JSON.parse(m![1])[0]).toEqual({ title: 'A', url: 'https://a.com' })
  })

  it('includes each hit url, snippet and published date', () => {
    const out = formatWebSearchResults({
      hits: [{ url: 'https://a.com', title: 'A', snippet: 'snip', publishedDate: '2026-06-01' }],
    })
    expect(out).toContain('https://a.com')
    expect(out).toContain('snip')
    expect(out).toContain('2026-06-01')
  })

  it('falls back to the url for the link title when title is null', () => {
    const out = formatWebSearchResults({ hits: [{ url: 'https://a.com', title: null, snippet: '' }] })
    const links = JSON.parse(out.match(/Links:\s*(\[[\s\S]*?\])\s*\n/)![1])
    expect(links[0].title).toBe('https://a.com')
  })

  it('says no results when the hit list is empty', () => {
    expect(formatWebSearchResults({ hits: [] })).toContain('No results')
  })

  it('appends warnings', () => {
    const out = formatWebSearchResults({
      hits: [{ url: 'https://a.com', title: 'A', snippet: '' }],
      warnings: ['2 results removed by your allowed-sites policy'],
    })
    expect(out).toContain('removed by your allowed-sites policy')
  })
})
