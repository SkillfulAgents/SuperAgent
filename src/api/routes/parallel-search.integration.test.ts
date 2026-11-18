import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Hono } from 'hono'

vi.mock('@shared/lib/proxy/token-store', () => ({ validateProxyToken: vi.fn(async () => 'test-agent') }))
vi.mock('@shared/lib/services/platform-auth-service', () => ({ getPlatformAccessToken: async () => null }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }))

import { getSettings, mutateSettings } from '@shared/lib/config/settings'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { getActiveWebProvider, resolveEffectiveWebVendor } from '@shared/lib/web-provider'
import webSearch from './web-search'

let handle: TestDatabase
let testDb: TestDatabase['db']
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

beforeEach(async () => {
  for (const name of ['PARALLEL_API_KEY', 'PLATFORM_TOKEN', 'EXA_API_KEY']) vi.stubEnv(name, '')
  handle = await createTestDatabase()
  testDb = handle.db
})
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await handle.close()
})

it('serves a saved keyless choice through the authenticated host route with the operator policy applied', async () => {
  await mutateSettings((s) => {
    s.webProvider = 'parallel'
    s.apiKeys = {}
    s.webBlockedSites = ['blocked.test']
  })
  expect((await getSettings()).webProvider).toBe('parallel')
  expect(await resolveEffectiveWebVendor()).toBe('parallel')
  expect((await getActiveWebProvider())?.fetch).toBeUndefined()
  const app = new Hono().route('/api/x-agent/web-search', webSearch)
  const observed: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe('https://search.parallel.ai/mcp')
    expect(new Headers(init.headers).has('Authorization')).toBe(false)
    expect(new Headers(init.headers).get('User-Agent')).toMatch(/^Gamut\//)
    const rpc = JSON.parse(String(init.body))
    observed.push(rpc.method)
    if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 })
    const result = rpc.method === 'initialize' ? { protocolVersion: '2025-03-26' }
      : rpc.method === 'tools/list' ? { tools: [{ name: 'web_search' }] }
        : { content: [{ type: 'text', text: JSON.stringify({ results: [
          { url: 'https://example.com/guide', title: 'Native search guide', excerpts: ['Keyless search works through the host.'] },
          { url: 'https://blocked.test/page', title: 'Blocked', excerpts: ['Must not reach the agent'] },
        ] }) }] }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }), { headers: { 'Content-Type': 'application/json' } })
  }))
  const res = await app.request('http://localhost/api/x-agent/web-search/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer isolated-test-token' },
    body: JSON.stringify({ query: 'native keyless search', numResults: 2 }),
  })
  expect(res.status).toBe(200)
  const body = await res.json() as { hits: Array<{ url: string, title: string | null, snippet: string }>, warnings?: string[] }
  expect(body.hits).toHaveLength(1)
  expect(body.hits[0]).toMatchObject({ url: 'https://example.com/guide', title: 'Native search guide' })
  expect(body.hits[0].snippet).toContain('Keyless search works through the host.')
  expect(body.warnings).toEqual(['1 result removed by your allowed-sites policy'])
  expect(observed).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call'])
  await mutateSettings((s) => {
    s.webProvider = 'native'
  })
  expect(await resolveEffectiveWebVendor()).toBe('native')
  expect(await getActiveWebProvider()).toBeNull()
})
