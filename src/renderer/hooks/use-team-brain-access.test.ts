// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// Writer has the drive; taking it off takes as long as the agent's container needs.
const { removing, adding } = vi.hoisted(() => ({ removing: { done: () => {}, calls: 0 }, adding: vi.fn() }))
vi.mock('@renderer/hooks/use-mounts', () => ({
  useAddMount: () => ({ mutateAsync: adding }),
  useRemoveMount: () => ({
    mutateAsync: () => {
      removing.calls++
      return new Promise<void>((resolve) => { removing.done = resolve })
    },
  }),
}))
vi.mock('@renderer/hooks/use-volume-definitions', () => ({
  useVolumeAgents: () => ({ data: { attachments: [{ agentSlug: 'writer', mountId: 'm1' }] } }),
  useVolumeDefinitions: () => ({ data: [{ id: 'vol', userId: null, canManage: true, globalAccess: null }] }),
  useSaveVolumeDefinition: () => ({ mutateAsync: vi.fn() }),
}))
vi.mock('@renderer/lib/api', () => ({ apiFetch: vi.fn(async () => new Response(null, { status: 204 })) }))

import { useTeamBrainAccess } from './use-team-brain-access'

describe('useTeamBrainAccess', () => {
  it('shows a switch where it is going at once, and holds it until the change lands', async () => {
    const client = new QueryClient()
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
    const { result } = renderHook(() => useTeamBrainAccess('brain', 'vol'), { wrapper })
    act(() => result.current.toggle('writer', false))
    expect(result.current.isOn('writer')).toBe(false)
    expect(result.current.isChanging('writer')).toBe(true)
    // A second press while it is under way does nothing.
    act(() => result.current.toggle('writer', true))
    expect(adding).not.toHaveBeenCalled()
    expect(removing.calls).toBe(1)
    await act(async () => removing.done())
    await waitFor(() => expect(result.current.isChanging('writer')).toBe(false))
  })
})
