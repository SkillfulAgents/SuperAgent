// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

const { mockApiFetch } = vi.hoisted(() => ({ mockApiFetch: vi.fn() }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: mockApiFetch }))

import { _resetApiTargetForTest, setActiveTarget } from '@renderer/lib/api-target'
import { useFirewallStatus } from './use-firewall-status'

/**
 * The condition this detects is Windows Firewall rules on the machine running
 * the API, blocking its own containers from reaching it — and the fix runs
 * there, behind a UAC prompt.
 */

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

function drive(target: 'local' | 'cloud') {
  _resetApiTargetForTest() // the global setup already settled it to 'local'
  setActiveTarget(target, null)
}

beforeEach(() => {
  vi.clearAllMocks()
  drive('local')
  mockApiFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ supported: true, blocked: false, blockRuleNames: [], hyperVInboundBlock: false }),
  })
})

afterEach(() => {
  vi.clearAllMocks()
  _resetApiTargetForTest()
})

describe('useFirewallStatus', () => {
  it('asks about the machine running the Superagent being driven', async () => {
    renderHook(() => useFirewallStatus(), { wrapper })
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith('/api/firewall/status'))
  })

  it('does not ask a cloud workspace about a firewall nobody here can fix', async () => {
    drive('cloud')

    const { result } = renderHook(() => useFirewallStatus(), { wrapper })

    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'))
    expect(mockApiFetch).not.toHaveBeenCalled()
  })
})
