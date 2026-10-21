// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

const { mockApiFetch } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ id: 'v1', name: 'code', type: 'local' }), { status: 201 })),
}))
vi.mock('@renderer/lib/api', () => ({ apiFetch: mockApiFetch }))
let mockAgent: { slug: string; status: string; stale: boolean; hasActiveSessions?: boolean } = { slug: 'a1', status: 'running', stale: false }
vi.mock('./use-agents', () => ({ useAgent: () => ({ data: mockAgent }) }))
vi.mock('./use-volume-definitions', () => ({ useVolumeDefinitions: () => ({ data: [], isLoading: false, error: null }) }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ canUseAgent: () => true }) }))

import { useAddMount, useVolumesManager } from './use-mounts'

function Wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
}

beforeEach(() => vi.clearAllMocks())

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

describe('useVolumesManager', () => {
  it('asks for a restart while the agent is marked stale', () => {
    mockAgent = { slug: 'a1', status: 'running', stale: true }
    expect(renderHook(() => useVolumesManager('a1'), { wrapper: Wrapper }).result.current.pendingRestart).toBe(true)

    mockAgent = { slug: 'a1', status: 'running', stale: false }
    expect(renderHook(() => useVolumesManager('a1'), { wrapper: Wrapper }).result.current.pendingRestart).toBe(false)
    mockAgent = { slug: 'a1', status: 'stopped', stale: true }
    expect(renderHook(() => useVolumesManager('a1'), { wrapper: Wrapper }).result.current.pendingRestart).toBe(false)
  })

  it('offers to continue running sessions only when a session is working', () => {
    mockAgent = { slug: 'a1', status: 'running', stale: true, hasActiveSessions: true }
    expect(renderHook(() => useVolumesManager('a1'), { wrapper: Wrapper }).result.current.continuesSessions).toBe(true)
    mockAgent = { slug: 'a1', status: 'running', stale: true, hasActiveSessions: false }
    expect(renderHook(() => useVolumesManager('a1'), { wrapper: Wrapper }).result.current.continuesSessions).toBe(false)
  })

  it('reports a failed restart as an operation error', async () => {
    const original = mockApiFetch.getMockImplementation()!
    mockApiFetch.mockImplementation(async (url: string) => url.endsWith('/restart')
      ? new Response(JSON.stringify({ error: 'No room for the agent' }), { status: 500 })
      : new Response('[]', { status: 200 }))
    const { result } = renderHook(() => useVolumesManager('a1'), { wrapper: Wrapper })
    await act(() => result.current.handleRestart())
    expect(result.current.operationError).toBe('No room for the agent')
    mockApiFetch.mockImplementation(original)
  })
})
