import { describe, it, expect, vi, beforeEach } from 'vitest'

// Keep the queryFns inert: query-options.ts imports `apiJson` from
// '@renderer/lib/api' at module load, so mock it before importing the SUT (same
// '@renderer/lib/*' factory-mock style as tool-policy-editor.test.ts). The mock
// factory is hoisted above the import.
vi.mock('@renderer/lib/api', () => ({ apiJson: vi.fn() }))

import { QueryClient } from '@tanstack/react-query'
import { agentQuery, sessionQuery } from './query-options'
import { apiJson } from '@renderer/lib/api'

/**
 * Pins the cache-key shape and `retry: false` that query-options.ts's own header
 * comment calls load-bearing: the loader prefetch and the component hooks MUST
 * resolve to ONE cache entry per resource, and the agent loader fetch must NOT
 * retry so a 403/404 maps to notFound() immediately.
 */
describe('query-options cache keys + retry', () => {
  beforeEach(() => {
    vi.mocked(apiJson).mockClear()
  })

  it('agentQuery exposes the canonical ["agents", slug] cache key', () => {
    expect(agentQuery('a').queryKey).toEqual(['agents', 'a'])
  })

  it('agentQuery disables retry so a 403/404 resolves to notFound immediately', () => {
    expect(agentQuery('a').retry).toBe(false)
  })

  it('agentQuery.queryFn hits /api/agents/:slug via apiJson', async () => {
    vi.mocked(apiJson).mockResolvedValue({ slug: 'a', displaySlug: 'a' })
    await agentQuery('a').queryFn?.({ client: new QueryClient() } as never)
    expect(apiJson).toHaveBeenCalledWith('/api/agents/a')
  })

  it('sessionQuery exposes the canonical ["session", id, agentSlug] cache key', () => {
    expect(sessionQuery('a', 's').queryKey).toEqual(['session', 's', 'a'])
  })

  it('sessionQuery.queryFn hits /api/agents/:slug/sessions/:id via apiJson', () => {
    sessionQuery('a', 's').queryFn?.(undefined as never)
    expect(apiJson).toHaveBeenCalledWith('/api/agents/a/sessions/s')
  })
})

// The route loader reads an agent by its display slug; the shell reads it by its id.
describe('agentQuery route keys', () => {
  const agent = { slug: 'k3x9w2', displaySlug: 'release-notes-k3x9w2', name: 'Release Notes' }

  beforeEach(() => {
    vi.mocked(apiJson).mockReset()
  })

  it('one read by display slug also fills the id key, so the shell does not read again', async () => {
    vi.mocked(apiJson).mockResolvedValue(agent)
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000 } } })

    await client.ensureQueryData(agentQuery('release-notes-k3x9w2'))
    await client.fetchQuery(agentQuery('k3x9w2'))

    expect(apiJson).toHaveBeenCalledTimes(1)
    expect(client.getQueryData(['agents', 'k3x9w2'])).toEqual(agent)
  })

  it('does not overwrite an id entry that is already cached', async () => {
    const cached = { ...agent, name: 'Release Notes (renamed)' }
    vi.mocked(apiJson).mockResolvedValue(agent)
    const client = new QueryClient()
    client.setQueryData(['agents', 'k3x9w2'], cached)

    await client.fetchQuery(agentQuery('release-notes-k3x9w2'))

    expect(client.getQueryData(['agents', 'k3x9w2'])).toEqual(cached)
  })
})
