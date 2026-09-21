// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ApiAgent } from '@shared/lib/types/api'

const mutateAsync = vi.fn()
vi.mock('./use-agents', () => ({
  useAgents: () => ({
    data: [agent('a', 'Research assistant', true), agent('b', 'Shopify ops', true, true), agent('c', 'Fresh one')],
  }),
  useStopAgent: () => ({ mutateAsync }),
}))

import { useStaleAgents } from './use-stale-agents'

function agent(slug: string, name: string, stale?: boolean, hasActiveSessions?: boolean): ApiAgent {
  return { slug, displaySlug: slug, name, createdAt: new Date(), status: 'running', containerPort: 4000, stale, hasActiveSessions }
}

describe('useStaleAgents', () => {
  it('lists only marked agents and counts only the stops that succeeded', async () => {
    mutateAsync.mockImplementation(async (slug: string) => {
      if (slug === 'b') throw new Error('Failed to stop agent')
    })
    const { result } = renderHook(() => useStaleAgents())
    expect(result.current.rows).toEqual([
      { slug: 'a', name: 'Research assistant', working: false },
      { slug: 'b', name: 'Shopify ops', working: true },
    ])

    await act(() => result.current.stopAll())
    expect(mutateAsync.mock.calls.map(([slug]) => slug)).toEqual(['a', 'b'])
    expect(result.current.isStopping).toBe(false)
    expect(result.current.stoppedCount).toBe(1)
  })
})
