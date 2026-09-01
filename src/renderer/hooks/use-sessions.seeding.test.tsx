// @vitest-environment jsdom
/**
 * The create/rename mutations get the full session back in the response, so
 * they seed/write-through the caches instead of only invalidating — the
 * sidebar row and the session view render immediately, and a rename can't
 * flash back to the old name while the list refetch is in flight. The
 * invalidation still follows for the authoritative refresh.
 */
import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCreateSession, useUpdateSessionName } from './use-sessions'
import type { ApiSession } from '@shared/lib/types/api'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  apiJson: vi.fn(),
}))

vi.mock('@renderer/context/analytics-context', () => ({
  useAnalyticsTracking: () => ({ track: vi.fn() }),
}))

vi.mock('@renderer/hooks/use-agents', () => ({
  useAgents: () => ({ data: [] }),
  resolveRouteAgentId: (slug: string) => slug,
}))

const existingSession: ApiSession = {
  id: 'sess-old',
  agentSlug: 'agent-1',
  name: 'Older session',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  lastActivityAt: new Date('2026-01-01T00:00:00.000Z'),
  messageCount: 3,
}

function respondWith(body: unknown) {
  mockApiFetch.mockResolvedValue({ ok: true, json: async () => body })
}

function renderMutation<T>(useHook: () => T) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  queryClient.setQueryData(['sessions', 'agent-1'], [existingSession])
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  const { result } = renderHook(useHook, { wrapper })
  return { result, queryClient, invalidate }
}

describe('useCreateSession cache seeding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('seeds the detail entry and prepends the new session to the cached list', async () => {
    const created = {
      ...existingSession,
      id: 'sess-new',
      name: 'Fresh session',
      isActive: true,
      initialMessageUuid: 'msg-1',
    }
    respondWith(created)
    const { result, queryClient, invalidate } = renderMutation(useCreateSession)

    result.current.mutate({ agentSlug: 'agent-1', message: 'hello' })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(queryClient.getQueryData<ApiSession>(['session', 'sess-new', 'agent-1'])).toMatchObject({
      id: 'sess-new',
      name: 'Fresh session',
    })
    const list = queryClient.getQueryData<ApiSession[]>(['sessions', 'agent-1'])
    expect(list?.map((s) => s.id)).toEqual(['sess-new', 'sess-old'])
    // The refetch still runs for the authoritative ordering/enrichment.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sessions', 'agent-1'] })
  })

  it('does not duplicate a session the list already holds', async () => {
    respondWith({ ...existingSession, initialMessageUuid: 'msg-1' })
    const { result, queryClient } = renderMutation(useCreateSession)

    result.current.mutate({ agentSlug: 'agent-1', message: 'hello' })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(queryClient.getQueryData<ApiSession[]>(['sessions', 'agent-1'])).toHaveLength(1)
  })
})

describe('useUpdateSessionName write-through', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('writes the new name into the cached list and detail entry before the refetch', async () => {
    respondWith({ ...existingSession, name: 'Renamed session' })
    const { result, queryClient, invalidate } = renderMutation(useUpdateSessionName)
    queryClient.setQueryData(['session', 'sess-old', 'agent-1'], existingSession)

    result.current.mutate({ sessionId: 'sess-old', agentSlug: 'agent-1', name: 'Renamed session' })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(queryClient.getQueryData<ApiSession[]>(['sessions', 'agent-1'])?.[0].name).toBe('Renamed session')
    expect(queryClient.getQueryData<ApiSession>(['session', 'sess-old', 'agent-1'])?.name).toBe('Renamed session')
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sessions', 'agent-1'] })
  })
})
