// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectionInfoSchema } from '@shared/lib/llm-provider/connection-schema'
import { providerUsageSchema } from '@shared/lib/llm-provider/usage-schema'
import { MOCK_PROVIDER_SCENARIOS, mockProviderFetch, setMockScenario, type MockProviderScenario } from './mock-providers'

const realList = () => Promise.resolve(new Response(JSON.stringify({ connections: [], defaultSelection: null }), { status: 200 }))

describe('mockProviderFetch', () => {
  afterEach(() => setMockScenario(null))

  it('is inert until a scenario is set', async () => {
    const realFetch = vi.fn(realList)
    expect(await mockProviderFetch('/api/llm-connections', undefined, realFetch)).toBeNull()
    expect(realFetch).not.toHaveBeenCalled()
  })

  it('appends schema-valid mock connections to every picker connection list', async () => {
    setMockScenario('healthy')
    for (const path of ['/api/llm-connections', '/api/settings/models', '/api/agents/a/llm-connections?llmProviderId=x', '/api/agents/a/sessions/s/llm-connections']) {
      const response = await mockProviderFetch(path, undefined, realList)
      const { connections } = await response!.json()
      expect(connections.map((c: { id: string }) => c.id)).toEqual(['dev-mock-claude', 'dev-mock-codex', 'dev-mock-grok', 'dev-mock-platform'])
      for (const connection of connections) expect(() => connectionInfoSchema.parse(connection)).not.toThrow()
    }
  })

  it.each(['healthy', 'warning', 'exhausted', 'mixed'] as MockProviderScenario[])('serves parseable %s usage', async scenario => {
    setMockScenario(scenario)
    for (const key of ['codex', 'grok', 'platform']) {
      const response = await mockProviderFetch(`/api/llm-connections/dev-mock-${key}/usage`, undefined, realList)
      const usage = providerUsageSchema.parse(await response!.json())
      expect(usage.status).toBe('available')
      expect(usage.limits.length).toBeGreaterThan(0)
    }
  })

  it('fails usage reads in the unavailable scenario', async () => {
    setMockScenario('unavailable')
    expect((await mockProviderFetch('/api/llm-connections/dev-mock-codex/usage', undefined, realList))!.status).toBe(500)
  })

  it('refuses writes that name a mock connection and passes other writes through', async () => {
    setMockScenario('healthy')
    const body = JSON.stringify({ llmProviderId: 'dev-mock-codex', model: 'gpt-5.5' })
    expect((await mockProviderFetch('/api/agents/a/settings', { method: 'PUT', body }, realList))!.status).toBe(409)
    expect((await mockProviderFetch('/api/llm-connections/dev-mock-codex', { method: 'DELETE' }, realList))!.status).toBe(409)
    expect(await mockProviderFetch('/api/agents/a/settings', { method: 'PUT', body: '{"model":"opus"}' }, realList)).toBeNull()
  })

  it('leaves unrelated reads alone', async () => {
    setMockScenario('healthy')
    expect(await mockProviderFetch('/api/agents', undefined, realList)).toBeNull()
    expect(Object.keys(MOCK_PROVIDER_SCENARIOS)).toContain('slow')
  })
})
