import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Hono } from 'hono'

vi.mock('@shared/lib/proxy/token-store', () => ({ validateProxyToken: vi.fn(async () => 'test-agent') }))
vi.mock('@shared/lib/services/platform-auth-service', () => ({ getPlatformAccessToken: () => null }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }))

import { loadSettings, updateSettings } from '@shared/lib/config/settings'
import { getActiveWebProvider, resolveEffectiveWebVendor } from '@shared/lib/web-provider'
import { handleWebSearch } from '../../../agent-container/src/tools/web/web-search-handler'
import webSearch from './web-search'

let scratch: string
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'parallel-native-'))
  vi.stubEnv('SUPERAGENT_DATA_DIR', scratch)
  vi.stubEnv('SUPERAGENT_HOST_API_URL', 'http://native-host.test/api/x-agent')
  vi.stubEnv('PROXY_TOKEN', 'isolated-test-token')
  for (const name of ['PARALLEL_API_KEY', 'PLATFORM_TOKEN', 'EXA_API_KEY']) vi.stubEnv(name, '')
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(scratch, { recursive: true, force: true }) })

it('loads a saved keyless choice and returns the canonical agent tool answer through the authenticated host route', async () => {
  updateSettings({ ...loadSettings(), webProvider: 'parallel', apiKeys: {}, webBlockedSites: ['blocked.test'] })
  expect(loadSettings().webProvider).toBe('parallel')
  expect(resolveEffectiveWebVendor()).toBe('parallel')
  expect(getActiveWebProvider()?.fetch).toBeUndefined()
  const app = new Hono().route('/api/x-agent/web-search', webSearch)
  const observed: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url.startsWith('http://native-host.test')) return app.request(url, init)
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
  const answer = await handleWebSearch({ query: 'native keyless search', numResults: 2, includeDomains: undefined, excludeDomains: undefined, startPublishedDate: undefined, endPublishedDate: undefined })
  expect(answer.isError).not.toBe(true)
  const text = answer.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n')
  expect(text).toContain('Links: [{"title":"Native search guide","url":"https://example.com/guide"')
  expect(text).toContain('Keyless search works through the host.')
  expect(text).not.toContain('Must not reach the agent')
  expect(text).toContain('removed by your allowed-sites policy')
  expect(observed).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call'])
  updateSettings({ ...loadSettings(), webProvider: 'native' })
  expect(resolveEffectiveWebVendor()).toBe('native')
  expect(getActiveWebProvider()).toBeNull()
})
