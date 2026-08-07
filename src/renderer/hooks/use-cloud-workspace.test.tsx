// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import React from 'react'

import { useCloudWorkspace } from './use-cloud-workspace'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }))

function jsonOk(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response
}

const WORKSPACE_A = {
  available: true,
  found: true,
  deploymentUrl: 'https://org-a.example.com',
  orgId: 'org_a',
  hasValidToken: true,
  discoveryFailed: false,
  superagentVersion: 'v0.5.0',
}

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
}

function wrapper(client: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return React.createElement(QueryClientProvider, { client }, children)
  }
  return Wrapper
}

describe('useCloudWorkspace cache isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('never serves one org’s workspace under another org', async () => {
    // The response carries a deployment URL behind a live "Open" button. A
    // single global key would hand account A's URL to account B for as long as
    // B's refetch is in flight.
    mockApiFetch.mockResolvedValue(jsonOk(WORKSPACE_A))
    const client = makeClient()

    const a = renderHook(() => useCloudWorkspace(true, 'org_a'), { wrapper: wrapper(client) })
    await waitFor(() => expect(a.result.current.data).toEqual(WORKSPACE_A))

    // Account B mounts before its own fetch resolves.
    let resolveB: ((res: Response) => void) | undefined
    mockApiFetch.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveB = resolve
      }),
    )
    const b = renderHook(() => useCloudWorkspace(true, 'org_b'), { wrapper: wrapper(client) })

    expect(b.result.current.data).toBeUndefined()
    expect(b.result.current.isLoading).toBe(true)

    resolveB?.(jsonOk({ ...WORKSPACE_A, deploymentUrl: 'https://org-b.example.com', orgId: 'org_b' }))
    await waitFor(() => expect(b.result.current.data?.orgId).toBe('org_b'))
  })

  it('serves nothing after a reset, even for the same org', async () => {
    // Reconnecting as a different account under the same (not-yet-refetched)
    // org id must not leave the previous workspace on screen.
    mockApiFetch.mockResolvedValue(jsonOk(WORKSPACE_A))
    const client = makeClient()

    const view = renderHook(() => useCloudWorkspace(true, 'org_a'), { wrapper: wrapper(client) })
    await waitFor(() => expect(view.result.current.data).toEqual(WORKSPACE_A))

    // What `use-platform-auth` does on connect/reconnect.
    client.resetQueries({ queryKey: ['cloud-workspace'] })

    expect(client.getQueryData(['cloud-workspace', 'org_a'])).toBeUndefined()
  })
})
