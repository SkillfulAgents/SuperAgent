import { describe, it, expect } from 'vitest'
import { YouSearchResponseSchema } from './youcom-response-schema'

// Shape verified against the live OpenAPI (documentation.you.com/api-reference/search/v1-search.md,
// 2026-06-30): results.web[] with every field schema-optional; news[] is asymmetric and we ignore it.
const documented = {
  results: {
    web: [
      {
        url: 'https://example.com/a',
        title: 'Example A',
        description: 'A brief description.',
        snippets: ['First excerpt.', 'Second excerpt.'],
        thumbnail_url: 'https://example.com/t.jpg',
        page_age: '2025-11-30T04:39:48',
        favicon_url: 'https://you.com/favicon',
        authors: ['Jane Doe'],
      },
    ],
    news: [{ url: 'https://example.com/n', title: 'N', description: 'news', page_age: '2025-11-25T12:31:29' }],
  },
  metadata: { search_uuid: 'f4593192-3fbe', query: 'q', latency: 0.7 },
}

describe('YouSearchResponseSchema', () => {
  it('accepts the documented results.web envelope', () => {
    const parsed = YouSearchResponseSchema.parse(documented)
    expect(parsed.results.web?.[0].url).toBe('https://example.com/a')
    expect(parsed.results.web?.[0].snippets).toEqual(['First excerpt.', 'Second excerpt.'])
  })

  it('accepts a web result with absent snippets / page_age (every field optional)', () => {
    const parsed = YouSearchResponseSchema.parse({
      results: { web: [{ url: 'https://example.com/b', title: 'B', description: 'd' }] },
    })
    expect(parsed.results.web?.[0].snippets).toBeUndefined()
    expect(parsed.results.web?.[0].page_age).toBeUndefined()
  })

  it('accepts a response with no web array', () => {
    const parsed = YouSearchResponseSchema.parse({ results: {} })
    expect(parsed.results.web).toBeUndefined()
  })

  it('rejects when results.web is not an array', () => {
    expect(() => YouSearchResponseSchema.parse({ results: { web: 'nope' } })).toThrow()
  })
})
