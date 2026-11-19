// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

const { mockApiFetch } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ id: 'v1', name: 'code', type: 'local' }), { status: 201 })),
}))
vi.mock('@renderer/lib/api', () => ({ apiFetch: mockApiFetch }))
let mockAgent = { slug: 'a1', status: 'running', stale: false }
vi.mock('./use-agents', () => ({ useAgent: () => ({ data: mockAgent }) }))
const registry = { data: [] as { id: string }[] | undefined, isLoading: false, error: null as Error | null, refetch: vi.fn() }
vi.mock('./use-volume-definitions', () => ({ useVolumeDefinitions: () => registry }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ canUseAgent: () => true, canAdminAgent: () => false }) }))

import { useAddMount, useAgentMounts, useVolumesManager } from './use-mounts'

function Wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
}

beforeEach(() => {
  vi.clearAllMocks()
  mockApiFetch.mockReset()
  Object.assign(registry, { data: [], isLoading: false, error: null })
})

describe('useAddMount', () => {
  it('adds a picked folder as a local volume', async () => {
    const { result } = renderHook(() => useAddMount(), { wrapper: Wrapper })

    await act(() => result.current.mutateAsync({ agentSlug: 'a1', hostPath: '/Users/joe/code', restart: true }))

    expect(mockApiFetch).toHaveBeenCalledWith('/api/agents/a1/mounts', expect.objectContaining({ method: 'POST' }))
    expect(JSON.parse(String(mockApiFetch.mock.calls[0][1]?.body))).toEqual({ type: 'local', config: { path: '/Users/joe/code' }, restart: true })
  })
  it('attaches a saved definition by reference without resending source configuration', async () => {
    const { result } = renderHook(() => useAddMount(), { wrapper: Wrapper })
    await act(() => result.current.mutateAsync({ agentSlug: 'a1', volumeId: 'saved', restart: true }))
    expect(JSON.parse(String(mockApiFetch.mock.calls[0][1]?.body))).toEqual({ volumeId: 'saved', restart: true })
  })

  it('creates and attaches a named volume with the selected visibility in one request', async () => {
    const { result } = renderHook(() => useAddMount(), { wrapper: Wrapper })
    await act(() => result.current.mutateAsync({ agentSlug: 'a1', hostPath: '/srv/reports', name: 'Reports', visibility: 'private' }))
    expect(mockApiFetch).toHaveBeenCalledOnce()
    expect(JSON.parse(String(mockApiFetch.mock.calls[0][1]?.body))).toEqual({ type: 'local', config: { path: '/srv/reports' }, name: 'Reports', visibility: 'private' })
  })

})

describe('useAgentMounts', () => {
  it('checks again while a drive is preparing, and stops once it is ready', async () => {
    const mount = (health: string) => new Response(JSON.stringify([{ id: 'm1', name: 'repo', health }]))
    mockApiFetch.mockResolvedValueOnce(mount('preparing')).mockResolvedValueOnce(mount('ok')).mockResolvedValueOnce(mount('missing'))
    const { result } = renderHook(() => useAgentMounts('a1'), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.data?.[0].health).toBe('ok'), { timeout: 4000 })
    await new Promise(resolve => setTimeout(resolve, 2500))
    expect(result.current.data?.[0].health).toBe('ok')
    expect(mockApiFetch).toHaveBeenCalledTimes(2)
  }, 10_000)
})

describe('useVolumesManager', () => {
  it('hides paths and actions if the drive is missing from the current registry', async () => {
    mockApiFetch.mockResolvedValueOnce(Response.json([{ id: 'm', volumeId: 'v', volumeName: 'Forecasts', hostPath: '/private', readOnly: true }]))
    const { result } = renderHook(() => useVolumesManager('a1'), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.mounts).toEqual([{ id: 'm', volumeName: 'Forecasts', restricted: true }]))
  })

  it('waits for the registry and supports retry before deciding whether a mount is restricted', async () => {
    registry.data = undefined
    registry.isLoading = true
    const mount = { id: 'm', volumeId: 'v', volumeName: 'Forecasts', hostPath: '/private' }
    mockApiFetch.mockImplementation(async () => Response.json([mount]))
    const { result, rerender } = renderHook(() => useVolumesManager('a1'), { wrapper: Wrapper })
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled())
    expect(result.current.isLoading).toBe(true)
    expect(result.current.mounts).toEqual([])
    Object.assign(registry, { isLoading: false, error: new Error('offline') })
    rerender()
    expect(result.current.loadError).toBe(true)
    expect(result.current.mounts).toEqual([])
    await act(() => result.current.retryLoad())
    expect(registry.refetch).toHaveBeenCalled()
    Object.assign(registry, { data: [{ id: 'v' }], error: null })
    rerender()
    await waitFor(() => expect(result.current.mounts).toEqual([mount]))
  })

  it('asks for a restart while the agent is marked stale', () => {
    mockAgent = { slug: 'a1', status: 'running', stale: true }
    expect(renderHook(() => useVolumesManager('a1'), { wrapper: Wrapper }).result.current.pendingRestart).toBe(true)

    mockAgent = { slug: 'a1', status: 'running', stale: false }
    expect(renderHook(() => useVolumesManager('a1'), { wrapper: Wrapper }).result.current.pendingRestart).toBe(false)
    mockAgent = { slug: 'a1', status: 'stopped', stale: true }
    expect(renderHook(() => useVolumesManager('a1'), { wrapper: Wrapper }).result.current.pendingRestart).toBe(false)
  })

  it('reports a failed restart as an operation error', async () => {
    const original = mockApiFetch.getMockImplementation()!
    mockApiFetch.mockImplementation(async (url: string) => url.endsWith('/start')
      ? new Response(JSON.stringify({ error: 'No room for the agent' }), { status: 500 })
      : new Response('[]', { status: 200 }))
    const { result } = renderHook(() => useVolumesManager('a1'), { wrapper: Wrapper })
    await act(() => result.current.handleRestart())
    expect(result.current.operationError).toBe('No room for the agent')
    mockApiFetch.mockImplementation(original)
  })
})
