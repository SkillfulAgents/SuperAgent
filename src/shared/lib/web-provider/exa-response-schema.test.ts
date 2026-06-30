import { describe, it, expect } from 'vitest'
import { ExaSearchResponseSchema } from './exa-response-schema'

const documented = {
  requestId: 'req_abc',
  results: [
    {
      id: 'https://example.com/a',
      url: 'https://example.com/a',
      title: 'Example A',
      publishedDate: '2026-06-01T00:00:00.000Z',
      author: 'Jane Doe',
      score: 0.87,
      highlights: ['First relevant excerpt.', 'Second relevant excerpt.'],
      highlightScores: [0.9, 0.8],
    },
  ],
  costDollars: { total: 0.005 },
}

describe('ExaSearchResponseSchema', () => {
  it('accepts the documented /search envelope', () => {
    const parsed = ExaSearchResponseSchema.parse(documented)
    expect(parsed.results[0].url).toBe('https://example.com/a')
    expect(parsed.results[0].title).toBe('Example A')
    expect(parsed.results[0].highlights).toEqual(['First relevant excerpt.', 'Second relevant excerpt.'])
  })

  it('accepts a result with a null title (nullable on every vendor)', () => {
    const parsed = ExaSearchResponseSchema.parse({
      results: [{ url: 'https://example.com/b', title: null }],
    })
    expect(parsed.results[0].title).toBeNull()
  })

  it('accepts a result with no highlights or publishedDate (omitted fields)', () => {
    const parsed = ExaSearchResponseSchema.parse({
      results: [{ url: 'https://example.com/c', title: 'C' }],
    })
    expect(parsed.results[0].highlights).toBeUndefined()
    expect(parsed.results[0].publishedDate).toBeUndefined()
  })

  it('rejects a result missing the url', () => {
    expect(() =>
      ExaSearchResponseSchema.parse({ results: [{ title: 'no url' }] })
    ).toThrow()
  })

  it('rejects when results is not an array', () => {
    expect(() => ExaSearchResponseSchema.parse({ results: 'nope' })).toThrow()
  })

  it('passes through unknown extra fields', () => {
    const parsed = ExaSearchResponseSchema.parse(documented)
    expect(parsed.results[0].url).toBe('https://example.com/a')
  })
})
