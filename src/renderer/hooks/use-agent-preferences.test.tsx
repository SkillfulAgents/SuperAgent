// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { apiFetch } from '@renderer/lib/api'
import type { AgentPreferences } from '@shared/lib/types/agent-preferences'
import { useAgentPreferences, useUpdateAgentPreferences } from './use-agent-preferences'

vi.mock('@renderer/lib/api', () => ({ apiFetch: vi.fn() }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const PREFERENCES_URL = '/api/agents/agent/preferences'
const before: AgentPreferences = { defaultModel: 'opus', defaultLlmProviderId: 'first' }
const saved: AgentPreferences = { defaultModel: 'haiku', defaultLlmProviderId: 'next', defaultEffort: 'high' }

function newClient() {
  return new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
}

it('keeps the response of a saved change as the preferences, with no request after the PUT', async () => {
  const client = newClient()
  // The agent list and one agent's detail under both of its keys, as mounted screens hold them.
  const agentKeys = [['agents'], ['agents', 'agent'], ['agents', 'my-agent-agent']]
  client.setQueryData(agentKeys[0], [{ slug: 'agent' }])
  client.setQueryData(agentKeys[1], { slug: 'agent' })
  client.setQueryData(agentKeys[2], { slug: 'agent' })
  const requests: string[] = []
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const method = init?.method ?? 'GET'
    requests.push(`${method} ${String(url)}`)
    // A read after the save would never answer: the save must not wait for one.
    if (method === 'GET' && requests.includes(`PUT ${PREFERENCES_URL}`)) return new Promise<Response>(() => {})
    return new Response(JSON.stringify(method === 'PUT' ? saved : before))
  })
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const { result } = renderHook(() => ({
    // Observed, as the controls do: an invalidation would refetch it.
    preferences: useAgentPreferences('agent'),
    update: useUpdateAgentPreferences('agent'),
  }), { wrapper })
  try {
    await waitFor(() => expect(result.current.preferences.data).toEqual(before))

    act(() => result.current.update.mutate({ defaultLlmProviderId: 'next', defaultModel: 'haiku', defaultEffort: 'high' }))
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true))

    // The control leaves its pending state with the saved value already on screen.
    expect(result.current.update.isPending).toBe(false)
    expect(result.current.preferences.data).toEqual(saved)
    expect(client.getQueryData(['agent-preferences', 'agent'])).toEqual(saved)
    expect(requests).toEqual([`GET ${PREFERENCES_URL}`, `PUT ${PREFERENCES_URL}`])
    expect(invalidate).not.toHaveBeenCalled()
    for (const key of agentKeys) expect(client.getQueryState(key)?.isInvalidated).toBe(false)
  } finally {
    client.clear()
  }
})

it('leaves the cached preferences alone when the save fails', async () => {
  const client = newClient()
  client.setQueryData(['agent-preferences', 'agent'], before)
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ error: 'No access' }), { status: 403 }))
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const { result } = renderHook(() => useUpdateAgentPreferences('agent'), { wrapper })
  try {
    act(() => result.current.mutate({ defaultModel: 'haiku' }))
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe('No access')
    expect(client.getQueryData(['agent-preferences', 'agent'])).toEqual(before)
  } finally {
    client.clear()
  }
})
