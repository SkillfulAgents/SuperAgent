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

vi.mock('@renderer/lib/env', () => ({
  getApiBaseUrl: mockGetApiBaseUrl,
  getCloudApiBaseUrl: mockGetCloudApiBaseUrl,
}))
vi.mock('@renderer/hooks/use-target-switch', () => ({
  useTargetSwitch: mockUseTargetSwitch,
}))
vi.mock('@renderer/lib/api', () => ({
  handleUnauthorizedResponse: vi.fn(async () => {}),
}))

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

  it('fetches the deployment through the door', async () => {
    mockGetCloudApiBaseUrl.mockReturnValue(DOOR)
    mockUseTargetSwitch.mockReturnValue({ available: true })
    const { result } = renderHook(() => useCloudRuntimeStatus(), { wrapper })
    await waitFor(() => expect(result.current.data?.appVersion).toBe('1.2.3'))
    expect(fetch).toHaveBeenCalledWith(`${DOOR}/api/runtime-status`)
  })
})

describe('URL-keyed cache', () => {
  it('keeps the two polls on different keys when the URLs differ', async () => {
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
})
