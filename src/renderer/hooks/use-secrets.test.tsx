// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import { apiFetch } from '@renderer/lib/api'
import { useAgentSecrets, useCreateSecret, type ApiSecretDisplay } from './use-secrets'

vi.mock('@renderer/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@renderer/context/analytics-context', () => ({
  useAnalyticsTracking: () => ({ track: vi.fn() }),
}))

it('publishes a saved key before refetch finishes, then adopts the refreshed list', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const saved: ApiSecretDisplay = { id: 'API_KEY', envVar: 'API_KEY', key: 'My Key', hasValue: true }
  client.setQueryData(['agent-secrets', 'agent'], [{ ...saved, key: 'Old name' }])
  let finishRefetch!: (response: Response) => void
  const refetch = new Promise<Response>((resolve) => { finishRefetch = resolve })
  vi.mocked(apiFetch).mockImplementation(async (_url, options) => (
    options?.method === 'POST' ? Response.json(saved) : refetch
  ))
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
  const { result, unmount } = renderHook(() => ({
    create: useCreateSecret(),
    secrets: useAgentSecrets('agent'),
  }), { wrapper: Wrapper })

  await act(async () => {
    await result.current.create.mutateAsync({ agentSlug: 'agent', key: saved.key, value: 'test-value' })
  })
  expect(client.getQueryData(['agent-secrets', 'agent'])).toEqual([saved])
  await waitFor(() => expect(result.current.secrets.data).toEqual([saved]))
  expect(result.current.secrets.isFetching).toBe(true)

  await act(async () => { finishRefetch(Response.json([])) })
  await waitFor(() => expect(result.current.secrets.data).toEqual([]))
  unmount()
  client.clear()
})
