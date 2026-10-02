import { afterEach, describe, expect, it, vi } from 'vitest'
import { ParallelWebProvider } from './parallel-web-provider'

const provider = new ParallelWebProvider()
const result = { results: [
  { url: 'https://example.com/a', title: 'A', excerpts: ['Useful excerpt'], publish_date: '2026-09-01' },
  { url: 'https://blocked.com/b', title: null, excerpts: ['Excluded'] },
] }

function mockMcp(options?: { sse?: boolean; error?: boolean; missingTool?: boolean; mismatchedId?: boolean }) {
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'DELETE') return new Response(null, { status: 204 })
    const request = JSON.parse(String(init?.body))
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 })
    let rpcResult: unknown
    if (request.method === 'initialize') rpcResult = { protocolVersion: '2025-03-26' }
    if (request.method === 'tools/list') rpcResult = { tools: options?.missingTool ? [] : [{ name: 'web_search' }] }
    if (request.method === 'tools/call') rpcResult = { content: [{ type: 'text', text: JSON.stringify(result) }], isError: options?.error }
    const body = JSON.stringify({ jsonrpc: '2.0', id: options?.mismatchedId ? 999 : request.id, result: rpcResult })
    return new Response(options?.sse ? `event: message\ndata: ${body}\n\n` : body, {
      headers: { 'Content-Type': options?.sse ? 'text/event-stream' : 'application/json', 'Mcp-Session-Id': 'test-session' },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

it.each([false, true])('maps useful normalized hits over JSON/SSE (SSE=%s) without credentials', async (sse) => {
  vi.stubEnv('PARALLEL_API_KEY', 'inherited-test-key')
  const fetchMock = mockMcp({ sse })
  expect(await provider.search('current news', { numResults: 1 })).toEqual({ hits: [
    { url: 'https://example.com/a', title: 'A', snippet: 'Useful excerpt', publishedDate: '2026-09-01' },
  ] })
  expect(provider.getEffectiveApiKey()).toBeUndefined()
  for (const [url, init] of fetchMock.mock.calls) {
    expect(url).toBe('https://search.parallel.ai/mcp')
    expect(new Headers(init?.headers).has('Authorization')).toBe(false)
    expect(new Headers(init?.headers).get('User-Agent')).toMatch(/^Gamut\//)
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  }
  const requests = fetchMock.mock.calls.map(([, init]) => init)
  expect(requests[1]?.headers).toMatchObject({ 'Mcp-Session-Id': 'test-session', 'MCP-Protocol-Version': '2025-03-26' })
  expect(JSON.parse(String(requests[3]?.body)).params.arguments).toEqual({ objective: 'current news', search_queries: ['current news'] })
  expect(requests.at(-1)?.method).toBe('DELETE')
})

describe('filter contracts', () => {
  it('enforces domain and date constraints locally, excluding undated results', async () => {
    mockMcp()
    const output = await provider.search('news', { includeDomains: ['example.com'], startPublishedDate: '2026-08-01' })
    expect(output.hits).toHaveLength(1)
    expect(output.warnings?.[0]).toMatch(/removed/)
  })
  it('honors exclusions even when the server returns an excluded URL', async () => {
    mockMcp()
    expect((await provider.search('news', { excludeDomains: ['example.com'] })).hits[0].url).toBe('https://blocked.com/b')
  })
})

it.each([{ error: true }, { missingTool: true }, { mismatchedId: true }])('fails loudly on MCP errors: %j', async (options) => {
  mockMcp(options)
  await expect(provider.search('news', {})).rejects.toThrow(/Parallel/)
})

it('does not retry an authentication error or use an inherited key', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }))
  vi.stubGlobal('fetch', fetchMock)
  await expect(provider.search('news', {})).rejects.toThrow('Parallel request failed: 401')
  expect(fetchMock).toHaveBeenCalledTimes(1)
})
