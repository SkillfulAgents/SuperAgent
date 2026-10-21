import { describe, it, expect } from 'vitest'
import {
  BODY_TEXT_CAP,
  REDACTED,
  captureFileName,
  formatCaptureSummary,
  harSchema,
  isApiLike,
  isSensitiveName,
  redactBody,
  redactEntry,
  redactHar,
  redactUrl,
  summarizeEndpoints,
  type HarEntry,
} from './traffic-capture'

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'

function entry(over: { url?: string; method?: string; mime?: string; text?: string; status?: number; resourceType?: string } = {}): HarEntry {
  return harSchema.parse({
    log: {
      entries: [{
        request: { method: over.method ?? 'GET', url: over.url ?? 'https://www.shop.com/api/search?q=shoes', headers: [], cookies: [], queryString: [] },
        response: { status: over.status ?? 200, headers: [], cookies: [], content: { mimeType: over.mime ?? 'application/json', text: over.text ?? '{}' } },
        ...(over.resourceType && { _resourceType: over.resourceType }),
      }],
    },
  }).log.entries[0]
}

describe('isSensitiveName', () => {
  it('matches secret-bearing names and leaves ordinary ones', () => {
    for (const n of ['Cookie', 'set-cookie', 'Authorization', 'x-csrf-token', 'X-API-Key', 'access_token', 'sessionid', 'client_secret', 'password', 'otp', 'x-auth', 'code', 'sig'])
      expect(isSensitiveName(n), n).toBe(true)
    for (const n of ['author', 'authority', ':authority', 'footprint', 'q', 'page', 'content-type', 'user-agent', 'keyword', 'zipcode'])
      expect(isSensitiveName(n), n).toBe(false)
  })
})

describe('redactUrl', () => {
  it('replaces sensitive query values and userinfo, keeps the rest as written', () => {
    expect(redactUrl('https://a.com/s?q=shoes&token=abc&page=2')).toBe('https://a.com/s?q=shoes&token=REDACTED&page=2')
    expect(redactUrl('https://user:pw@a.com/x')).toBe('https://a.com/x')
    expect(redactUrl('https://a.com/s?q=shoes%20red')).toBe('https://a.com/s?q=shoes%20red')
    expect(redactUrl(`https://a.com/cb/${JWT}`)).toBe('https://a.com/cb/REDACTED')
  })
})

describe('redactBody', () => {
  it('redacts JSON fields by key, recursively, and JWTs in any string', () => {
    const body = JSON.stringify({ items: [{ id: 1 }], session: { token: 't', user: 'ada@example.com' }, author: 'Tolkien', note: `bearer ${JWT}` })
    expect(JSON.parse(redactBody(body, 'application/json'))).toEqual({
      items: [{ id: 1 }], session: { token: REDACTED, user: 'ada@example.com' }, author: 'Tolkien', note: `bearer ${REDACTED}`,
    })
  })

  it('redacts form fields by name and leaves other text but its JWTs', () => {
    expect(redactBody('user=ada&password=hunter2&remember=1', 'application/x-www-form-urlencoded')).toBe('user=ada&password=%5BREDACTED%5D&remember=1')
    expect(redactBody(`<p>${JWT}</p>`, 'text/html')).toBe(`<p>${REDACTED}</p>`)
  })
})

describe('redactEntry', () => {
  it('drops secret values from headers, every cookie value, and binary bodies; caps text bodies', () => {
    const e = harSchema.parse({
      log: {
        entries: [{
          request: {
            method: 'POST', url: 'https://a.com/api?api_key=k',
            headers: [{ name: 'Cookie', value: 'sid=1' }, { name: 'Authorization', value: 'Bearer x' }, { name: 'Accept', value: 'application/json' }],
            cookies: [{ name: 'prefs', value: 'dark' }],
            queryString: [{ name: 'api_key', value: 'k' }],
            postData: { mimeType: 'application/json', text: '{"password":"p","q":"x"}' },
          },
          response: {
            status: 200,
            headers: [{ name: 'Set-Cookie', value: 'sid=2' }, { name: 'Content-Type', value: 'application/json' }],
            cookies: [{ name: 'sid', value: '2' }],
            content: { mimeType: 'image/png', text: 'AAAA', encoding: 'base64' },
          },
        }],
      },
    }).log.entries[0]
    const r = redactEntry(e)
    expect(r.request.url).toBe('https://a.com/api?api_key=REDACTED')
    expect(r.request.headers.map(h => h.value)).toEqual([REDACTED, REDACTED, 'application/json'])
    expect(r.request.cookies[0].value).toBe(REDACTED)
    expect(r.request.queryString[0].value).toBe(REDACTED)
    expect(JSON.parse(r.request.postData!.text!)).toEqual({ password: REDACTED, q: 'x' })
    expect(r.response.headers.map(h => h.value)).toEqual([REDACTED, 'application/json'])
    expect(r.response.cookies[0].value).toBe(REDACTED)
    expect(r.response.content.text).toBeUndefined()
    expect(r.response.content.encoding).toBeUndefined()

    const big = redactEntry(entry({ mime: 'text/plain', text: 'x'.repeat(BODY_TEXT_CAP + 10) }))
    expect(big.response.content.text!.length).toBeLessThan(BODY_TEXT_CAP + 100)
    expect(big.response.content.text).toContain(`[truncated at ${BODY_TEXT_CAP} of ${BODY_TEXT_CAP + 10} chars]`)
  })

  it('keeps fields it does not know about', () => {
    const r = redactHar(harSchema.parse({ log: { version: '1.2', creator: { name: 'agent-browser' }, entries: [{ ...entry(), _resourceType: 'Fetch', timings: { wait: 1 } }] } }))
    expect(r.log).toMatchObject({ version: '1.2', creator: { name: 'agent-browser' } })
    expect(r.log.entries[0]).toMatchObject({ _resourceType: 'Fetch', timings: { wait: 1 } })
  })
})

describe('isApiLike / summarizeEndpoints', () => {
  it('counts data responses and script-fetched non-page types; leaves pages, assets and telemetry out', () => {
    expect(isApiLike(entry())).toBe(true)
    expect(isApiLike(entry({ mime: 'text/plain', resourceType: 'Fetch' }))).toBe(true)
    expect(isApiLike(entry({ mime: 'text/plain', resourceType: 'Document' }))).toBe(false)
    expect(isApiLike(entry({ mime: 'text/html', resourceType: 'XHR' }))).toBe(false)
    expect(isApiLike(entry({ url: 'https://a.com/app.js', mime: 'application/json' }))).toBe(false)
    expect(isApiLike(entry({ url: 'https://www.google-analytics.com/g/collect?v=2' }))).toBe(false)
    expect(isApiLike(entry({ url: 'https://a.com/api/track' }))).toBe(false)
  })

  it('groups by method and path, first-party first, then by count', () => {
    const har = harSchema.parse({
      log: {
        entries: [
          { ...entry({ url: 'https://cdn.other.com/data.json' }) },
          { ...entry({ url: 'https://www.shop.com/api/search?q=a' }) },
          { ...entry({ url: 'https://api.shop.com/v1/item/9', text: '{"id":9}' }) },
          { ...entry({ url: 'https://www.shop.com/api/search?q=b' }) },
          { ...entry({ url: 'https://www.shop.com/api/search?q=b', method: 'POST' }) },
        ],
      },
    })
    const { endpoints, more } = summarizeEndpoints(har, 'https://www.shop.com/s?q=a')
    expect(endpoints.map(e => [e.method, e.url, e.count, e.firstParty])).toEqual([
      ['GET', 'https://www.shop.com/api/search?q=a', 2, true],
      ['GET', 'https://api.shop.com/v1/item/9', 1, true],
      ['POST', 'https://www.shop.com/api/search?q=b', 1, true],
      ['GET', 'https://cdn.other.com/data.json', 1, false],
    ])
    expect(more).toBe(0)
    expect(summarizeEndpoints(har, 'https://www.shop.com/', 2).more).toBe(2)
  })

  it('formats the summary with sizes and counts, and says what is left out', () => {
    const text = formatCaptureSummary({
      path: '/workspace/captures/x.har', requestCount: 12, durationMs: 4200, more: 0,
      endpoints: [{ method: 'GET', url: 'https://a.com/api', status: 200, mimeType: 'application/json', bytes: 2048, count: 3, firstParty: true }],
    })
    expect(text).toContain('Saved 12 requests recorded over 4s to /workspace/captures/x.har.')
    expect(text).toContain('- GET 200 https://a.com/api · application/json · 2.0 KB · ×3')
    expect(formatCaptureSummary({ path: '/p', requestCount: 1, durationMs: 0, more: 0, endpoints: [] })).toContain('No JSON/XML/CSV responses')
  })
})

describe('captureFileName', () => {
  it('uses a sanitised label, or "traffic", plus a timestamp', () => {
    const at = new Date('2026-10-21T12:34:56.789Z')
    expect(captureFileName('Zillow Search!', at)).toBe('zillow-search-2026-10-21T12-34-56-789.har')
    expect(captureFileName(undefined, at)).toBe('traffic-2026-10-21T12-34-56-789.har')
    expect(captureFileName('../../etc', at)).toBe('etc-2026-10-21T12-34-56-789.har')
  })
})
