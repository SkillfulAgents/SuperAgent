// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

const { mockGetApiBaseUrl, mockGetCloudApiBaseUrl, mockUseTargetSwitch } = vi.hoisted(() => ({
  mockGetApiBaseUrl: vi.fn(() => ''),
  mockGetCloudApiBaseUrl: vi.fn((): string | null => null),
  mockUseTargetSwitch: vi.fn(() => ({ available: false })),
}))

// `lib/api` is deliberately NOT mocked: the wrappers are what put the origin on
// the request, so stubbing them would leave the thing under test untested.
vi.mock('@renderer/lib/env', () => ({
  getApiBaseUrl: mockGetApiBaseUrl,
  getCloudApiBaseUrl: mockGetCloudApiBaseUrl,
}))
vi.mock('@renderer/hooks/use-target-switch', () => ({
  useTargetSwitch: mockUseTargetSwitch,
}))

import { cloudApiFetch } from '@renderer/lib/api'
import { useCloudRuntimeStatus, useRuntimeStatus } from './use-runtime-status'

const LOCAL = 'http://localhost:3000'
const DOOR = 'http://localhost:3000/cloud/KEY123'

const STATUS = {
  runtimeReadiness: { status: 'READY' },
  hasRunningAgents: false,
  apiKeyConfigured: true,
  servicesInitError: null,
  appVersion: '1.2.3',
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

beforeEach(() => {
  mockGetApiBaseUrl.mockReturnValue(LOCAL)
  mockGetCloudApiBaseUrl.mockReturnValue(null)
  mockUseTargetSwitch.mockReturnValue({ available: false })
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(STATUS), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useCloudRuntimeStatus', () => {
  it('does not fetch when the door is missing', () => {
    renderHook(() => useCloudRuntimeStatus(), { wrapper })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not fetch when a workspace is not reachable', () => {
    mockGetCloudApiBaseUrl.mockReturnValue(DOOR)
    mockUseTargetSwitch.mockReturnValue({ available: false })
    renderHook(() => useCloudRuntimeStatus(), { wrapper })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fetches the deployment through the door, not this window', async () => {
    mockGetCloudApiBaseUrl.mockReturnValue(DOOR)
    mockUseTargetSwitch.mockReturnValue({ available: true })
    const { result } = renderHook(() => useCloudRuntimeStatus(), { wrapper })
    await waitFor(() => expect(result.current.data?.appVersion).toBe('1.2.3'))
    expect(fetch).toHaveBeenCalledWith(`${DOOR}/api/runtime-status`, undefined)
  })
})

describe('cache keys', () => {
  it('keeps the two polls apart so neither serves the other its number', async () => {
    mockGetCloudApiBaseUrl.mockReturnValue(DOOR)
    mockUseTargetSwitch.mockReturnValue({ available: true })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    })
    renderHook(
      () => {
        useRuntimeStatus()
        useCloudRuntimeStatus()
      },
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    )
    await waitFor(() => {
      const urls = vi.mocked(fetch).mock.calls.map((call) => call[0])
      expect(urls).toContain(`${LOCAL}/api/runtime-status`)
      expect(urls).toContain(`${DOOR}/api/runtime-status`)
    })
    const keys = client.getQueryCache().getAll().map((query) => query.queryKey)
    expect(keys).toEqual(
      expect.arrayContaining([
        ['runtime-status', LOCAL],
        ['runtime-status', DOOR],
      ]),
    )
  })

  it('collapses onto one query when both origins are the same Superagent', async () => {
    // The cloud tab: this window already drives the deployment, so both getters
    // return the proxy door. Two entries here would poll it twice every 30s.
    mockGetApiBaseUrl.mockReturnValue(DOOR)
    mockGetCloudApiBaseUrl.mockReturnValue(DOOR)
    mockUseTargetSwitch.mockReturnValue({ available: true })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    })
    const { result } = renderHook(
      () => {
        useRuntimeStatus()
        return useCloudRuntimeStatus()
      },
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    )
    await waitFor(() => expect(result.current.data?.appVersion).toBe('1.2.3'))
    expect(client.getQueryCache().getAll()).toHaveLength(1)
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1)
  })

  it('still serves the cloud reader when only the local poll is enabled', async () => {
    // Pins the react-query semantics the collapse above rests on: a query runs
    // while ANY observer is enabled, and a disabled observer sharing the key
    // still reads the result. Not a reachable product state — the keys only
    // match on the cloud tab, where `available` is unconditionally true — but
    // the collapse is only safe *because* of this, and nothing else asserts it.
    mockGetApiBaseUrl.mockReturnValue(DOOR)
    mockGetCloudApiBaseUrl.mockReturnValue(DOOR)
    mockUseTargetSwitch.mockReturnValue({ available: false })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    })
    const { result } = renderHook(
      () => {
        useRuntimeStatus()
        return useCloudRuntimeStatus()
      },
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    )
    await waitFor(() => expect(result.current.data?.appVersion).toBe('1.2.3'))
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1)
  })
})

describe('cloudApiFetch', () => {
  it('refuses to fall back to this window when there is no door', async () => {
    // The hook gates on the door, so this throw is a backstop. It matters
    // because the silent alternative answers a question about the deployment
    // with the laptop's own number, which is indistinguishable in the UI.
    mockGetCloudApiBaseUrl.mockReturnValue(null)
    await expect(cloudApiFetch('/api/runtime-status')).rejects.toThrow(
      'Cloud proxy door is not available',
    )
    expect(fetch).not.toHaveBeenCalled()
  })
})
