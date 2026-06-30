import { describe, it, expect } from 'vitest'
import { ParallelSearchResponseSchema } from './parallel-response-schema'

// Shape verified against the live OpenAPI (docs.parallel.ai/api-reference/search/search.md, 2026-06-30):
// envelope { search_id, session_id, results[] }; result { url, title|null, publish_date|null, excerpts[] }.
const documented = {
  search_id: 'search_fcb2b4f3c75e418687bccaa1a8381331',
  session_id: 'session_fcb2b4f3c75e418687bccaa1a8381331',
  results: [
    {
      url: 'https://www.example.com',
      title: 'Sample webpage title',
      publish_date: '2024-01-15',
      excerpts: ['Sample excerpt 1', 'Sample excerpt 2'],
    },
  ],
}

describe('ParallelSearchResponseSchema', () => {
  it('accepts the documented /v1/search envelope', () => {
    const parsed = ParallelSearchResponseSchema.parse(documented)
    expect(parsed.results[0].url).toBe('https://www.example.com')
    expect(parsed.results[0].excerpts).toEqual(['Sample excerpt 1', 'Sample excerpt 2'])
  })

  it('accepts a result with a null title (nullable on every vendor)', () => {
    const parsed = ParallelSearchResponseSchema.parse({
      results: [{ url: 'https://example.com/b', title: null, excerpts: [] }],
    })
    expect(parsed.results[0].title).toBeNull()
  })

  it('accepts a result with a null/absent publish_date and no excerpts', () => {
    const parsed = ParallelSearchResponseSchema.parse({
      results: [{ url: 'https://example.com/c', title: 'C', publish_date: null }],
    })
    expect(parsed.results[0].publish_date).toBeNull()
    expect(parsed.results[0].excerpts).toBeUndefined()
  })

  it('rejects a result missing the url', () => {
    expect(() => ParallelSearchResponseSchema.parse({ results: [{ title: 'no url', excerpts: [] }] })).toThrow()
  })

  it('rejects when results is not an array', () => {
    expect(() => ParallelSearchResponseSchema.parse({ results: 'nope' })).toThrow()
  })
})
