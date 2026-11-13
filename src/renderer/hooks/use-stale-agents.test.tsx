// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ApiAgent } from '@shared/lib/types/api'

const mutateAsync = vi.fn()
vi.mock('./use-agents', () => ({
  useAgents: () => ({
    data: [agent('a', 'Research assistant', true), agent('b', 'Shopify ops', true, true), agent('c', 'Fresh one'), agent('v', 'Viewer only', true)],
  }),
  useStopAgent: () => ({ mutateAsync }),
}))

const user = vi.hoisted(() => ({ isAdmin: false }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ isAdmin: user.isAdmin, canUseAgent: (slug: string) => slug !== 'v' }) }))
afterEach(() => { user.isAdmin = false })

import { useStaleAgents } from './use-stale-agents'

function agent(slug: string, name: string, stale?: boolean, hasActiveSessions?: boolean): ApiAgent {
  return { avatar: { color: 'tonal-blue', shape: 'circle' } as const, slug, displaySlug: slug, name, createdAt: new Date(), status: 'running', containerPort: 4000, stale, hasActiveSessions }
}

describe('useStaleAgents', () => {
  it('lists only marked agents this viewer can stop, and counts only the stops that succeeded', async () => {
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
  it('lists every marked agent for an admin, who can stop any of them', () => {
    user.isAdmin = true
    const { result } = renderHook(() => useStaleAgents())
    expect(result.current.rows.map((r) => r.slug)).toEqual(['a', 'b', 'v'])
  })
})
