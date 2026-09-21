// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { makeChatIntegration } from '@renderer/components/agent-integrations/test-factories'
import {
  agentIntegrationKeys,
  useAgentIntegration,
  useCreateAgentIntegration,
  useUpdateAgentIntegration,
  useDeleteAgentIntegration,
  useSetRequireApproval,
} from './use-agent-integrations'

vi.mock('@renderer/lib/api', () => ({ apiFetch: vi.fn() }))

// Each write must invalidate every status-filtered list for the affected agent,
// without invalidating another agent's list. Use the real query-cache matching.
describe('integration list invalidation', () => {
  const integration = makeChatIntegration()
  const mutations = [
    ['create', () => {
      const mutation = useCreateAgentIntegration()
      return () => mutation.mutateAsync({ agentSlug: integration.agentSlug, provider: 'telegram', config: {} })
    }],
    ['update', () => {
      const mutation = useUpdateAgentIntegration()
      return () => mutation.mutateAsync({ id: integration.id, name: 'Renamed' })
    }],
    ['delete', () => {
      const mutation = useDeleteAgentIntegration()
      return () => mutation.mutateAsync({ id: integration.id, agentSlug: integration.agentSlug })
    }],
    ['require approval', () => {
      const mutation = useSetRequireApproval()
      return () => mutation.mutateAsync({ id: integration.id, requireApproval: true })
    }],
  ] as const

  it.each(mutations)('%s refreshes unfiltered and filtered lists', async (_name, useMutation) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify(integration), { status: 200 }))
    const keys = [undefined, 'active', 'paused'].map(status => agentIntegrationKeys.list(integration.agentSlug, status))
    const other = agentIntegrationKeys.list('other-agent', 'active')
    for (const key of [...keys, other]) client.setQueryData(key, [])
    const { result, unmount } = renderHook(useMutation, {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    })
    await act(async () => { await result.current() })
    for (const key of keys) expect(client.getQueryState(key)?.isInvalidated).toBe(true)
    expect(client.getQueryState(other)?.isInvalidated).toBe(false)
    unmount()
    client.clear()
  })
})

describe('integration authorization polling', () => {
  it.each(['telegram', 'slack', 'imessage'])('does not poll settled %s details', async provider => {
    vi.useFakeTimers()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const data = { ...makeChatIntegration(), provider }
    vi.mocked(apiFetch).mockClear().mockImplementation(async () => new Response(JSON.stringify(data)))
    const { unmount } = renderHook(() => useAgentIntegration(data.id), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    })
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(90000) })
      expect(apiFetch).toHaveBeenCalledOnce()
    } finally { unmount(); client.clear(); vi.useRealTimers() }
  })
  it.each(['setup', 'reconnect', 'expired'])('does not poll every 2.5 seconds for %s', async state => {
    vi.useFakeTimers()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const data = { ...makeChatIntegration(), provider: 'test-oauth', refreshIntervalMs: 30000, hasCredentials: false,
      ...(state === 'expired' ? { authorizationPendingUntil: Date.now() - 1 } : {}) }
    vi.mocked(apiFetch).mockClear().mockImplementation(async () => new Response(JSON.stringify(data)))
    const { unmount } = renderHook(() => useAgentIntegration(data.id), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    })
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
      expect(apiFetch).toHaveBeenCalledOnce()
      await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
      expect(apiFetch).toHaveBeenCalledTimes(2)
    } finally { unmount(); client.clear(); vi.useRealTimers() }
  })
  it('polls quickly only until the pending authorization expires', async () => {
    vi.useFakeTimers()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const data = { ...makeChatIntegration(), provider: 'test-oauth', refreshIntervalMs: 30000, hasCredentials: false, authorizationPendingUntil: Date.now() + 5000 }
    vi.mocked(apiFetch).mockClear().mockImplementation(async () => new Response(JSON.stringify(data)))
    const { unmount } = renderHook(() => useAgentIntegration(data.id), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    })
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(apiFetch).toHaveBeenCalledTimes(3)
      await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
      expect(apiFetch).toHaveBeenCalledTimes(3)
    } finally { unmount(); client.clear(); vi.useRealTimers() }
  })
})
