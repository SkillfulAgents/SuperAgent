// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

vi.mock('@renderer/lib/env', () => ({ getApiBaseUrl: () => '' }))
vi.mock('@renderer/context/analytics-context', () => ({ useAnalyticsTracking: () => ({ track: vi.fn() }) }))

import { HttpError } from '@renderer/lib/api'
import { useAgent } from './use-agents'
import { agentQuery } from './query-options'

afterEach(() => { vi.unstubAllGlobals() })

describe('an agent loader joining its mounted component query', () => {
  it.each([403, 404, 503])('retains HTTP %s when the component starts the shared request first', async (status) => {
    let respond!: (response: Response) => void
    const pending = new Promise<Response>(resolve => { respond = resolve })
    const fetch = vi.fn(() => pending)
    vi.stubGlobal('fetch', fetch)
    const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const { result, unmount } = renderHook(() => useAgent('shared-agent'), { wrapper })
    try {
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
      // AuthGate can remount the component before Router revalidates its
      // retained match. Query deduplicates the loader onto this first fetch.
      const loader = client.ensureQueryData(agentQuery('shared-agent'))
      const rejected = expect(loader).rejects.toMatchObject({ status })
      await act(async () => {
        respond(new Response('Access check failed', { status }))
        await rejected
      })
      await waitFor(() => expect(result.current.error).toBeInstanceOf(HttpError))
      expect((result.current.error as HttpError).status).toBe(status)
      // Access decisions finish immediately; transient failures retain the
      // component's three retries even when a loader joins the same request.
      expect(fetch).toHaveBeenCalledTimes(status === 503 ? 4 : 1)
    } finally {
      unmount()
      client.clear()
    }
  })
})
