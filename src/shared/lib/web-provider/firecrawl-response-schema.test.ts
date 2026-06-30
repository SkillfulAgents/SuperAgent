import { describe, it, expect } from 'vitest'
import { FirecrawlSearchResponseSchema } from './firecrawl-response-schema'

// Shape verified against the live OpenAPI (docs.firecrawl.dev/api-reference/endpoint/search.md,
// 2026-06-30): envelope { success, data:{ web[] }, id, creditsUsed }; web item { url, title, description }.
const documented = {
  success: true,
  data: {
    web: [
      {
        title: 'Firecrawl - The Ultimate Web Scraping API',
        description: 'Firecrawl turns any website into clean, structured data.',
        url: 'https://firecrawl.dev/',
        metadata: { sourceURL: 'https://firecrawl.dev/', statusCode: 200 },
      },
    ],
  },
  id: 'f1e2',
  creditsUsed: 1,
}

describe('FirecrawlSearchResponseSchema', () => {
  it('accepts the documented data.web envelope', () => {
    const parsed = FirecrawlSearchResponseSchema.parse(documented)
    expect(parsed.data.web?.[0].url).toBe('https://firecrawl.dev/')
    expect(parsed.data.web?.[0].description).toContain('Firecrawl')
  })

  it('accepts a web result with a null title (defensive)', () => {
    const parsed = FirecrawlSearchResponseSchema.parse({
      data: { web: [{ url: 'https://x.com', title: null, description: 'd' }] },
    })
    expect(parsed.data.web?.[0].title).toBeNull()
  })

  it('accepts a response with no web array', () => {
    const parsed = FirecrawlSearchResponseSchema.parse({ success: true, data: {} })
    expect(parsed.data.web).toBeUndefined()
  })

  it('rejects a web result missing the url', () => {
    expect(() => FirecrawlSearchResponseSchema.parse({ data: { web: [{ title: 'no url', description: 'd' }] } })).toThrow()
  })

  it('passes through unknown extra fields', () => {
    const parsed = FirecrawlSearchResponseSchema.parse(documented)
    expect(parsed.data.web?.[0].url).toBe('https://firecrawl.dev/')
  })
})
