// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import type { ReactNode } from 'react'

// Mock apiFetch
const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

import {
  useAutomationList,
  useAutomationDetail,
  useCancelAutomation,
  useAutomationSessions,
} from './use-agent-automations'

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
  return Wrapper
}

describe('useAutomationList', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('fetches list for agent', async () => {
    const items = [{ id: '1' }, { id: '2' }]
    mockApiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(items) })

    const { result } = renderHook(
      () => useAutomationList('scheduled-tasks', 'my-agent'),
      { wrapper: createWrapper() },
    )

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual(items)
    expect(mockApiFetch).toHaveBeenCalledWith('/api/agents/my-agent/scheduled-tasks')
  })

  it('appends status filter', async () => {
    mockApiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve([]) })

    const { result } = renderHook(
      () => useAutomationList('webhook-triggers', 'my-agent', 'active'),
      { wrapper: createWrapper() },
    )

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(mockApiFetch).toHaveBeenCalledWith('/api/agents/my-agent/webhook-triggers?status=active')
  })

  it('does not fetch when agentSlug is null', () => {
    const { result } = renderHook(
      () => useAutomationList('scheduled-tasks', null),
      { wrapper: createWrapper() },
    )

    expect(result.current.fetchStatus).toBe('idle')
    expect(mockApiFetch).not.toHaveBeenCalled()
  })
})

describe('useAutomationDetail', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('fetches single entity by ID', async () => {
    const entity = { id: 't1', agentSlug: 'agent-1' }
    mockApiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(entity) })

    const { result } = renderHook(
      () => useAutomationDetail('webhook-triggers', 't1'),
      { wrapper: createWrapper() },
    )

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual(entity)
    expect(mockApiFetch).toHaveBeenCalledWith('/api/webhook-triggers/t1')
  })

  it('does not fetch when id is null', () => {
    const { result } = renderHook(
      () => useAutomationDetail('scheduled-tasks', null),
      { wrapper: createWrapper() },
    )

    expect(result.current.fetchStatus).toBe('idle')
  })
})

describe('useCancelAutomation', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('sends DELETE and invalidates queries', async () => {
    mockApiFetch.mockResolvedValue({ ok: true })

    const { result } = renderHook(
      () => useCancelAutomation('webhook-triggers'),
      { wrapper: createWrapper() },
    )

    await result.current.mutateAsync({ id: 't1', agentSlug: 'agent-1' })
    expect(mockApiFetch).toHaveBeenCalledWith('/api/webhook-triggers/t1', { method: 'DELETE' })
  })

  it('throws on non-ok response', async () => {
    mockApiFetch.mockResolvedValue({ ok: false })

    const { result } = renderHook(
      () => useCancelAutomation('scheduled-tasks'),
      { wrapper: createWrapper() },
    )

    await expect(
      result.current.mutateAsync({ id: 't1', agentSlug: 'agent-1' }),
    ).rejects.toThrow('Failed to cancel scheduled task')
  })
})

describe('useAutomationSessions', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('fetches sessions for entity', async () => {
    const sessions = [{ id: 's1', name: 'Session 1', createdAt: '2025-01-01' }]
    mockApiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(sessions) })

    const { result } = renderHook(
      () => useAutomationSessions('scheduled-tasks', 'task-1'),
      { wrapper: createWrapper() },
    )

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual(sessions)
    expect(mockApiFetch).toHaveBeenCalledWith('/api/scheduled-tasks/task-1/sessions')
  })
})
