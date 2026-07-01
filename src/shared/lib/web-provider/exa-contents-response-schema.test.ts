import { describe, it, expect } from 'vitest'
import { ExaContentsResponseSchema } from './exa-contents-response-schema'

// Exa returns the same result shape from /contents as /search, plus the `text` body when requested.
const documented = {
  requestId: 'req_xyz',
  results: [
    {
      id: 'https://example.com/a',
      url: 'https://example.com/a',
      title: 'Example A',
      publishedDate: '2026-06-01T00:00:00.000Z',
      author: 'Jane Doe',
      text: 'The full extracted page text.',
    },
  ],
  costDollars: { total: 0.01 },
}

describe('ExaContentsResponseSchema', () => {
  it('accepts the documented /contents envelope with body text', () => {
    const parsed = ExaContentsResponseSchema.parse(documented)
    expect(parsed.results[0].url).toBe('https://example.com/a')
    expect(parsed.results[0].title).toBe('Example A')
    expect(parsed.results[0].text).toBe('The full extracted page text.')
  })

  it('accepts a result with a null title (nullable on every vendor)', () => {
    const parsed = ExaContentsResponseSchema.parse({
      results: [{ url: 'https://example.com/b', title: null, text: 'body' }],
    })
    expect(parsed.results[0].title).toBeNull()
  })

  it('accepts a result with no text or publishedDate (filterEmptyResults:false keeps empties)', () => {
    const parsed = ExaContentsResponseSchema.parse({
      results: [{ url: 'https://example.com/c', title: 'C' }],
    })
    expect(parsed.results[0].text).toBeUndefined()
    expect(parsed.results[0].publishedDate).toBeUndefined()
  })

  it('rejects a result missing the url', () => {
    expect(() =>
      ExaContentsResponseSchema.parse({ results: [{ title: 'no url', text: 'x' }] })
    ).toThrow()
  })

  it('rejects when results is not an array', () => {
    expect(() => ExaContentsResponseSchema.parse({ results: 'nope' })).toThrow()
  })
})
