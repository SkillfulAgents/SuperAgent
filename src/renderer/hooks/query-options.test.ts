import { describe, it, expect, vi, beforeEach } from 'vitest'

// Keep the queryFns inert: query-options.ts imports `apiJson` from
// '@renderer/lib/api' at module load, so mock it before importing the SUT (same
// '@renderer/lib/*' factory-mock style as tool-policy-editor.test.ts). The mock
// factory is hoisted above the import.
vi.mock('@renderer/lib/api', () => ({ apiJson: vi.fn() }))

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

  it('agentQuery.queryFn hits /api/agents/:slug via apiJson', () => {
    agentQuery('a').queryFn?.(undefined as never)
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
