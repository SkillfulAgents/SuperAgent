// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  resetBillingRecoveryForTests,
  setBillingRecoveryDelaysForTests,
} from '@renderer/lib/billing-recovery'
import { useBillingUpdatedListener } from './use-billing-updated'

const target = {
  agentSlug: 'agent-1',
  sessionId: 'session-1',
  attemptId: '550e8400-e29b-41d4-a716-446655440000',
  initialAllowed: false,
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
}
const mockApiFetch = vi.fn()
const mockGetTarget = vi.fn()
const mockClearTarget = vi.fn()
const mockClearPaywallError = vi.fn()

vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))
vi.mock('@renderer/lib/billing-resume-target', () => ({
  getBillingResumeTarget: () => mockGetTarget(),
  clearBillingResumeTarget: (...args: unknown[]) => mockClearTarget(...args),
}))
vi.mock('@renderer/hooks/use-message-stream', () => ({
  clearPaywallError: (...args: unknown[]) => mockClearPaywallError(...args),
  clearPaywallErrors: vi.fn(),
}))
vi.mock('@renderer/lib/error-reporting', () => ({
  captureRendererException: vi.fn(),
}))

function wrapper(
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return React.createElement(QueryClientProvider, { client }, children)
  }
}

function billingResponse(access: { allowed: boolean; reason: 'current_pool' | 'insufficient_balance' }) {
  return {
    connected: true,
    billing: {
      configured: true,
      subscription: { status: 'active', paymentStatus: 'current', currentPeriodEnd: null },
      seat: { balanceCents: 100, startingBalanceCents: 100 },
      orgPool: { poolBalanceCents: 0 },
      access,
    },
  }
}

describe('useBillingUpdatedListener', () => {
  let billingUpdated: (() => void) | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    resetBillingRecoveryForTests()
    setBillingRecoveryDelaysForTests([0])
    billingUpdated = undefined
    mockGetTarget.mockReturnValue(target)
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/platform-auth/billing') {
        return {
          ok: true,
          status: 200,
          json: async () => billingResponse({ allowed: true, reason: 'current_pool' }),
        }
      }
      return { ok: true, status: 202, json: async () => ({ resumed: true }) }
    })
    window.electronAPI = {
      onBillingUpdated: (callback) => {
        billingUpdated = callback
        return () => {}
      },
      flushPendingBillingUpdated: async () => false,
    } as typeof window.electronAPI
  })

  it('continues the armed session after the KV gate allows', async () => {
    renderHook(() => useBillingUpdatedListener(), { wrapper: wrapper() })
    act(() => billingUpdated?.())

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/agents/agent-1/sessions/session-1/resume-after-billing',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ attemptId: target.attemptId }),
        }),
      )
    })
    expect(mockClearTarget).toHaveBeenCalledWith(target)
    expect(mockClearPaywallError).toHaveBeenCalledWith('session-1')
  })

  it('does not resume from a positive balance while the gate stays denied', async () => {
    mockApiFetch.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => url === '/api/platform-auth/billing'
        ? billingResponse({ allowed: false, reason: 'insufficient_balance' })
        : { resumed: true },
    }))
    renderHook(() => useBillingUpdatedListener(), { wrapper: wrapper() })
    act(() => billingUpdated?.())

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith('/api/platform-auth/billing'))
    expect(mockApiFetch).not.toHaveBeenCalledWith(
      '/api/agents/agent-1/sessions/session-1/resume-after-billing',
      expect.anything(),
    )
    expect(mockClearPaywallError).not.toHaveBeenCalled()
  })

  it('coalesces billing lifecycle signals without a resume target', async () => {
    mockGetTarget.mockReturnValue(null)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue()
    renderHook(() => useBillingUpdatedListener(), { wrapper: wrapper(client) })

    act(() => {
      billingUpdated?.()
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })

    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ['platform-billing'],
        refetchType: 'active',
      })
    })
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(mockApiFetch).not.toHaveBeenCalled()
  })
})
