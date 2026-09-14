// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useBillingInfo } from './use-billing-info'
import { DeploymentUnavailableError } from '@renderer/lib/deployment-unavailable'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })}>{children}</QueryClientProvider>
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

describe('useBillingInfo', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the billing payload on success', async () => {
    const payload = { connected: true, billing: { plan: 'pro' } }
    mockApiFetch.mockResolvedValue(jsonResponse(payload))

    const { result } = renderHook(() => useBillingInfo(true), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(mockApiFetch).toHaveBeenCalledWith('/api/platform-auth/billing')
    expect(result.current.data).toEqual(payload)
  })

  it('throws DeploymentUnavailableError with the route state on a router 503', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ error: 'deployment_unavailable', state: 'waking' }, 503))

    const { result } = renderHook(() => useBillingInfo(true), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(result.current.error).toBeInstanceOf(DeploymentUnavailableError)
    expect((result.current.error as DeploymentUnavailableError).state).toBe('waking')
    expect(result.current.error?.message).toBe('Workspace is waking up. Try again in a moment.')
  })

  it('throws the server error string for other failures', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ error: 'not_connected' }, 400))

    const { result } = renderHook(() => useBillingInfo(true), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(result.current.error).not.toBeInstanceOf(DeploymentUnavailableError)
    expect(result.current.error?.message).toBe('not_connected')
  })

  it('falls back to a generic message when the error body is not JSON', async () => {
    mockApiFetch.mockResolvedValue({ ok: false, status: 502, json: async () => { throw new Error('bad json') } } as unknown as Response)

    const { result } = renderHook(() => useBillingInfo(true), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(result.current.error?.message).toBe('Failed to load billing')
  })

  it('does not fetch when disabled', () => {
    const { result } = renderHook(() => useBillingInfo(false), { wrapper })
    expect(result.current.fetchStatus).toBe('idle')
    expect(mockApiFetch).not.toHaveBeenCalled()
  })
})
