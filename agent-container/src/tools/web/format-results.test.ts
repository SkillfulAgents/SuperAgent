import { describe, it, expect } from 'vitest'
import { formatWebFetchResult, formatWebSearchResults } from './format-results'

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

describe('formatWebFetchResult', () => {
  it('renders the title/url header, published date and content body', () => {
    const out = formatWebFetchResult({
      result: { url: 'https://a.com', title: 'A Title', content: 'the body', publishedDate: '2026-06-01', fetchedAt: '2026-07-01T00:00:00.000Z' },
    })
    expect(out).toContain('A Title')
    expect(out).toContain('https://a.com')
    expect(out).toContain('Published: 2026-06-01')
    expect(out).toContain('the body')
  })

  it('falls back to the url as the header when title is null', () => {
    const out = formatWebFetchResult({
      result: { url: 'https://a.com', title: null, content: 'x', fetchedAt: '2026-07-01T00:00:00.000Z' },
    })
    expect(out.split('\n')[0]).toBe('https://a.com')
  })

  it('shows a placeholder when the content is empty', () => {
    const out = formatWebFetchResult({
      result: { url: 'https://a.com', title: 'A', content: '', fetchedAt: '2026-07-01T00:00:00.000Z' },
    })
    expect(out).toContain('(no content returned)')
  })

  it('appends warnings', () => {
    const out = formatWebFetchResult({
      result: { url: 'https://a.com', title: 'A', content: 'x', fetchedAt: '2026-07-01T00:00:00.000Z' },
      warnings: ['Content truncated to 100000 characters.'],
    })
    expect(out).toContain('truncated')
  })
})
