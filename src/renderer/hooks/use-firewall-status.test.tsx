// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

const { mockApiFetch } = vi.hoisted(() => ({ mockApiFetch: vi.fn() }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: mockApiFetch }))

const { mockCanUseHostFeatures } = vi.hoisted(() => ({
  mockCanUseHostFeatures: vi.fn(() => true),
}))
vi.mock('@renderer/lib/host-features', () => ({ canUseHostFeatures: mockCanUseHostFeatures }))

import { useFirewallStatus } from './use-firewall-status'

/**
 * The condition this detects is Windows Firewall rules on the machine running
 * the app, blocking its own containers from reaching it.
 */

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCanUseHostFeatures.mockReturnValue(true)
  mockApiFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ supported: true, blocked: false, blockRuleNames: [], hyperVInboundBlock: false }),
  })
})

afterEach(() => vi.clearAllMocks())

describe('useFirewallStatus', () => {
  it('asks when this computer is the one being driven', async () => {
    renderHook(() => useFirewallStatus(), { wrapper })
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith('/api/firewall/status'))
  })

  it('does not ask a cloud workspace about a firewall nobody here can fix', async () => {
    mockCanUseHostFeatures.mockReturnValue(false)

    const { result } = renderHook(() => useFirewallStatus(), { wrapper })

    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'))
    expect(mockApiFetch).not.toHaveBeenCalled()
  })
})
