import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { YouComWebProvider } from './youcom-web-provider'

let handle: TestDatabase
let testDb: TestDatabase['db']
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

const provider = new YouComWebProvider()
const defaultResults = {
  results: {
    web: [
      { url: 'https://example.com/a', title: 'A', snippets: ['Useful excerpt'], published_date: '2026-09-01' },
      { url: 'https://blocked.com/b', title: null, description: 'Excluded' },
    ],
  },
}
let result: unknown = defaultResults

function mockMcp(options?: { sse?: boolean; error?: boolean; missingTool?: boolean; mismatchedId?: boolean }) {
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'DELETE') return new Response(null, { status: 204 })
    const request = JSON.parse(String(init?.body))
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 })
    let rpcResult: unknown
    if (request.method === 'initialize') rpcResult = { protocolVersion: '2025-03-26' }
    if (request.method === 'tools/list') rpcResult = { tools: options?.missingTool ? [] : [{ name: 'you-search' }] }
    if (request.method === 'tools/call') {
      rpcResult = { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: options?.error }
    }
    const body = JSON.stringify({ jsonrpc: '2.0', id: options?.mismatchedId ? 999 : request.id, result: rpcResult })
    return new Response(options?.sse ? `event: message\ndata: ${body}\n\n` : body, {
      headers: { 'Content-Type': options?.sse ? 'text/event-stream' : 'application/json', 'Mcp-Session-Id': 'test-session' },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(async () => {
  delete process.env.YDC_API_KEY
  handle = await createTestDatabase()
  testDb = handle.db
})
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); result = defaultResults
  delete process.env.YDC_API_KEY
  await handle.close()
})

it.each([false, true])('maps useful normalized hits over JSON/SSE (SSE=%s) without credentials', async (sse) => {
  const fetchMock = mockMcp({ sse })
  expect(await provider.search('current news', { numResults: 1 })).toEqual({ hits: [
    { url: 'https://example.com/a', title: 'A', snippet: 'Useful excerpt', publishedDate: '2026-09-01' },
  ] })
  expect(await provider.getEffectiveApiKey()).toBeUndefined()
  for (const [url, init] of fetchMock.mock.calls) {
    expect(url).toBe('https://api.you.com/mcp?profile=free')
    expect(new Headers(init?.headers).has('Authorization')).toBe(false)
    expect(new Headers(init?.headers).get('User-Agent')).toBe('youdotcom-integration/SkillfulAgents-Gamut')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  }
  const requests = fetchMock.mock.calls.map(([, init]) => init)
  expect(requests[1]?.headers).toMatchObject({ 'Mcp-Session-Id': 'test-session', 'MCP-Protocol-Version': '2025-03-26' })
  expect(JSON.parse(String(requests[3]?.body)).params).toEqual({
    name: 'you-search',
    arguments: { query: 'current news', count: 1, extraction: 'highlights' },
  })
  expect(requests.at(-1)?.method).toBe('DELETE')
})

it('uses the authenticated MCP endpoint when YDC_API_KEY is set', async () => {
  process.env.YDC_API_KEY = 'test-ydc-key'
  const fetchMock = mockMcp()
  await provider.search('current news', { numResults: 1 })
  expect(await provider.getEffectiveApiKey()).toBe('test-ydc-key')
  for (const [url, init] of fetchMock.mock.calls) {
    expect(url).toBe('https://api.you.com/mcp')
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-ydc-key')
    expect(new Headers(init?.headers).get('User-Agent')).toBe('youdotcom-integration/SkillfulAgents-Gamut')
  }
})

describe('filter contracts', () => {
  it('enforces domain and date constraints locally', async () => {
    mockMcp()
    const output = await provider.search('news', { includeDomains: ['example.com'], startPublishedDate: '2026-08-01' })
    expect(output.hits.map((hit) => hit.url)).toEqual(['https://example.com/a'])
    expect(output.warnings?.[0]).toMatch(/removed/)
  })
  it('treats a requested domain as that host or any subdomain', async () => {
    result = { results: { web: [
      { url: 'https://docs.python.org/3/library/venv.html', snippets: ['venv'] },
      { url: 'https://python.org/about', snippets: ['about'] },
      { url: 'https://notpython.org/x', snippets: ['lookalike'] },
      { url: 'https://en.wikipedia.org/wiki/Python', snippets: ['wiki'] },
    ] } }
    mockMcp()
    expect((await provider.search('python', { includeDomains: ['python.org'] })).hits.map((hit) => hit.url))
      .toEqual(['https://docs.python.org/3/library/venv.html', 'https://python.org/about'])
    mockMcp()
    expect((await provider.search('python', { excludeDomains: ['wikipedia.org', 'python.org'] })).hits.map((hit) => hit.url))
      .toEqual(['https://notpython.org/x'])
  })
  it('keeps undated results and treats a date-only end date as the whole day', async () => {
    result = { results: { web: [
      { url: 'https://example.com/same-day', snippets: ['a'], published_date: '2026-09-01T18:30:00Z' },
      { url: 'https://example.com/undated', snippets: ['b'] },
      { url: 'https://example.com/late', snippets: ['c'], published_date: '2026-09-02T00:00:01Z' },
    ] } }
    mockMcp()
    const output = await provider.search('news', { endPublishedDate: '2026-09-01' })
    expect(output.hits.map((hit) => hit.url)).toEqual(['https://example.com/same-day', 'https://example.com/undated'])
  })
  it('does not fail the whole search on one non-http result URL', async () => {
    result = { results: { web: [{ url: 'ftp://example.com/file', snippets: ['x'] }, ...defaultResults.results.web] } }
    mockMcp()
    expect((await provider.search('news', {})).hits.length).toBeGreaterThan(0)
  })
  it('honors exclusions even when the server returns an excluded URL', async () => {
    mockMcp()
    expect((await provider.search('news', { excludeDomains: ['example.com'] })).hits[0].url).toBe('https://blocked.com/b')
  })
})

it.each([{ error: true }, { missingTool: true }, { mismatchedId: true }])('fails loudly on MCP errors: %j', async (options) => {
  mockMcp(options)
  await expect(provider.search('news', {})).rejects.toThrow(/You\.com/)
})

it('does not retry an authentication error', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }))
  vi.stubGlobal('fetch', fetchMock)
  await expect(provider.search('news', {})).rejects.toThrow('You.com request failed: 401')
  expect(fetchMock).toHaveBeenCalledTimes(1)
})
