// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useConnectionMutation } from './use-llm-connections'
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
