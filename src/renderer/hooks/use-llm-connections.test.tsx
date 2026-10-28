// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useConnectionMutation, useLlmConnections } from './use-llm-connections'
import { useRuntimeStatus } from './use-runtime-status'
import { useUpdateSettings } from './use-settings'

const apiFetchMock = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

describe('provider credential status refresh', () => {
  it.each(['connection', 'legacy settings'] as const)(
    'refreshes an already-mounted runtime status after a %s save, without waiting for polling',
    async (kind) => {
      let configured = false
      apiFetchMock.mockImplementation(async (url: string) => {
        if (url === '/api/runtime-status') {
          return { ok: true, json: async () => ({ apiKeyConfigured: configured }) }
        }
        configured = true
        return { ok: true, json: async () => ({}) }
      })
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
      })
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      )
      const { result, unmount } = renderHook(() => ({
        status: useRuntimeStatus(),
        connection: useConnectionMutation(),
        settings: useUpdateSettings(),
      }), { wrapper })
      try {
        await waitFor(() => expect(result.current.status.data?.apiKeyConfigured).toBe(false))
        await act(async () => {
          if (kind === 'connection') {
            await result.current.connection.mutateAsync({
              method: 'PUT', path: '/defaults/default',
              body: { llmProviderId: 'configured-account', model: 'sonnet' },
            })
          } else {
            await result.current.settings.mutateAsync({ apiKeys: { anthropicApiKey: 'test-key' } })
          }
        })
        await waitFor(() => expect(result.current.status.data?.apiKeyConfigured).toBe(true))
      } finally {
        unmount()
        client.clear()
      }
    },
  )
})


it('only invalidates usage for the connection being edited', async () => {
  apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'edited' }) })
  const client = new QueryClient()
  client.setQueryData(['llm-provider-usage', 'edited', 'alice'], {})
  client.setQueryData(['llm-provider-usage', 'other', 'alice'], {})
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const { result } = renderHook(() => useConnectionMutation(), { wrapper })
  await act(async () => { await result.current.mutateAsync({ path: '/edited', method: 'PUT', body: {} }) })
  expect(client.getQueryState(['llm-provider-usage', 'edited', 'alice'])?.isInvalidated).toBe(true)
  expect(client.getQueryState(['llm-provider-usage', 'other', 'alice'])?.isInvalidated).toBe(false)
})

describe('useLlmConnections', () => {
  type Pending = { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  // A fresh object per read, like a real body: the hook writes into it.
  const respond = (body: unknown, ok = true) => ({ ok, json: async () => JSON.parse(JSON.stringify(body)) })
  const catalog = { connections: [{ id: 'catalog' }], defaultSelection: null, summarizerSelection: null }

  function renderConnections(...args: Parameters<typeof useLlmConnections>) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    return renderHook(() => useLlmConnections(...args), { wrapper })
  }

  // Every request stays in flight until the test answers it. The hook gets a
  // plain thenable because vi.fn() handles any Promise it returns, which
  // would hide a rejection the hook leaves unhandled.
  function holdRequests() {
    const pending = new Map<string, Pending>()
    apiFetchMock.mockImplementation((url: string) => {
      const request = new Promise((resolve, reject) => { pending.set(url, { resolve, reject }) })
      return { then: request.then.bind(request), catch: request.catch.bind(request) }
    })
    return pending
  }

  beforeEach(() => {
    apiFetchMock.mockReset()
  })

  it('starts the agent read before the catalog read answers', async () => {
    const pending = holdRequests()
    const { result } = renderConnections('my agent')

    await waitFor(() => expect([...pending.keys()]).toEqual([
      '/api/llm-connections',
      '/api/agents/my%20agent/llm-connections',
    ]))
    pending.get('/api/agents/my%20agent/llm-connections')?.resolve(respond({ connections: [{ id: 'scoped' }] }))
    pending.get('/api/llm-connections')?.resolve(respond(catalog))

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.connections).toEqual([{ id: 'scoped' }])
    expect(result.current.data?.defaultSelection).toBeNull()
  })

  it('starts the session read before the catalog read answers', async () => {
    const pending = holdRequests()
    renderConnections('agent', 'session 1', 'connection')

    await waitFor(() => expect([...pending.keys()]).toEqual([
      '/api/llm-connections',
      '/api/agents/agent/sessions/session%201/llm-connections',
    ]))
  })

  it('reads only the catalog without an agent', async () => {
    apiFetchMock.mockResolvedValue(respond(catalog))
    const { result } = renderConnections()

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(apiFetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/llm-connections'])
    expect(result.current.data?.connections).toEqual([{ id: 'catalog' }])
  })

  it('reports a failed catalog read even when the agent read failed first', async () => {
    const pending = holdRequests()
    const { result } = renderConnections('agent')

    await waitFor(() => expect(pending.size).toBe(2))
    pending.get('/api/agents/agent/llm-connections')?.reject(new TypeError('Failed to fetch'))
    pending.get('/api/llm-connections')?.resolve(respond({}, false))

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe('Could not load model connections')
  })

  it('does not leave the abandoned agent read unhandled when the catalog read fails', async () => {
    const pending = holdRequests()
    const { result } = renderConnections('agent')

    await waitFor(() => expect(pending.size).toBe(2))
    pending.get('/api/llm-connections')?.resolve(respond({}, false))
    await waitFor(() => expect(result.current.isError).toBe(true))
    pending.get('/api/agents/agent/llm-connections')?.reject(new TypeError('Failed to fetch'))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(result.current.error?.message).toBe('Could not load model connections')
  })

  it('fails without partial data when only the agent read fails', async () => {
    apiFetchMock.mockImplementation(async (url: string) => (
      url === '/api/llm-connections' ? respond(catalog) : respond({}, false)
    ))
    const { result } = renderConnections('agent')

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe('Could not load session connection')
    expect(result.current.data).toBeUndefined()
  })
})
