// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PropsWithChildren } from 'react'

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  agentStatus: 'stopped' as 'running' | 'stopped',
}))

vi.mock('@renderer/lib/api', () => ({ apiFetch: mocks.apiFetch }))
vi.mock('@renderer/hooks/use-agents', () => ({
  useAgent: () => ({ data: { slug: 'a1', status: mocks.agentStatus } }),
}))

import { useSharedVolumes } from './use-shared-volumes'

const RESEARCH = {
  id: 'vol-1',
  name: 'Research',
  mountName: 'research',
  attachedAgents: [{ slug: 'a1', name: 'Agent One' }],
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('useSharedVolumes', () => {
  let queryClient: QueryClient
  let registry: { supported: boolean; volumes: typeof RESEARCH[] }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.agentStatus = 'stopped'
    registry = { supported: true, volumes: [RESEARCH] }
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/volumes' && !init?.method) return jsonResponse(registry)
      if (url === '/api/volumes' && init?.method === 'GET') return jsonResponse(registry)
      if (url === '/api/agents/a1/volumes' && init?.method === 'POST') {
        return jsonResponse({ id: 'vol-new' }, 201)
      }
      if (url === '/api/agents/a1/volumes/vol-1' && init?.method === 'DELETE') {
        return jsonResponse({ success: true })
      }
      if (url === '/api/volumes/vol-1' && init?.method === 'DELETE') {
        return jsonResponse({ success: true })
      }
      if (url === '/api/agents/a1/stop' && init?.method === 'POST') return jsonResponse({ ok: true })
      if (url === '/api/agents/a1/start' && init?.method === 'POST') return jsonResponse({ ok: true })
      throw new Error(`Unexpected request: ${url} ${init?.method ?? 'GET'}`)
    })
  })

  function wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }

  it('reports supported and splits attached vs all from the registry', async () => {
    const { result } = renderHook(() => useSharedVolumes('a1'), { wrapper })
    await waitFor(() => expect(result.current.supported).toBe(true))
    expect(result.current.attached).toEqual([RESEARCH])
    expect(result.current.all).toEqual([RESEARCH])
  })

  it('reports unsupported when the server says so', async () => {
    registry = { supported: false, volumes: [] }
    const { result } = renderHook(() => useSharedVolumes('a1'), { wrapper })
    await waitFor(() => expect(result.current.supported).toBe(false))
    expect(result.current.attached).toEqual([])
  })

  it('creates via the agent route and does not set pendingRestart when stopped', async () => {
    const { result } = renderHook(() => useSharedVolumes('a1'), { wrapper })
    await waitFor(() => expect(result.current.supported).toBe(true))
    await act(async () => {
      await result.current.create('Notes')
    })
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/agents/a1/volumes', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ name: 'Notes' }),
    }))
    expect(result.current.pendingRestart).toBe(false)
  })

  it('sets pendingRestart after attach when the agent is running', async () => {
    mocks.agentStatus = 'running'
    const { result } = renderHook(() => useSharedVolumes('a1'), { wrapper })
    await waitFor(() => expect(result.current.supported).toBe(true))
    await act(async () => {
      await result.current.attach('vol-1')
    })
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/agents/a1/volumes', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ volumeId: 'vol-1' }),
    }))
    expect(result.current.pendingRestart).toBe(true)
  })

  it('handleRestart stops then starts and clears pendingRestart', async () => {
    mocks.agentStatus = 'running'
    const { result } = renderHook(() => useSharedVolumes('a1'), { wrapper })
    await waitFor(() => expect(result.current.supported).toBe(true))
    await act(async () => {
      await result.current.attach('vol-1')
    })
    expect(result.current.pendingRestart).toBe(true)
    await act(async () => {
      await result.current.handleRestart()
    })
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/agents/a1/stop', { method: 'POST' })
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/agents/a1/start', { method: 'POST' })
    expect(result.current.pendingRestart).toBe(false)
    expect(result.current.restartError).toBeNull()
  })

  it('handleRestart records an error and keeps pendingRestart when stop fails', async () => {
    mocks.agentStatus = 'running'
    mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/volumes' && !init?.method) return jsonResponse(registry)
      if (url === '/api/volumes' && init?.method === 'GET') return jsonResponse(registry)
      if (url === '/api/agents/a1/volumes' && init?.method === 'POST') {
        return jsonResponse({ id: 'vol-new' }, 201)
      }
      if (url === '/api/agents/a1/stop' && init?.method === 'POST') {
        return jsonResponse({ error: 'agent busy' }, 500)
      }
      throw new Error(`Unexpected request: ${url} ${init?.method ?? 'GET'}`)
    })
    const { result } = renderHook(() => useSharedVolumes('a1'), { wrapper })
    await waitFor(() => expect(result.current.supported).toBe(true))
    await act(async () => {
      await result.current.attach('vol-1')
    })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => {
      await result.current.handleRestart()
    })
    expect(result.current.restartError).toBe('agent busy')
    expect(result.current.pendingRestart).toBe(true)
    expect(mocks.apiFetch).not.toHaveBeenCalledWith('/api/agents/a1/start', { method: 'POST' })
    log.mockRestore()
  })

  it('detaches and deletes through the matching routes', async () => {
    const { result } = renderHook(() => useSharedVolumes('a1'), { wrapper })
    await waitFor(() => expect(result.current.supported).toBe(true))
    await act(async () => {
      await result.current.detach('vol-1')
      await result.current.remove('vol-1')
    })
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/agents/a1/volumes/vol-1', { method: 'DELETE' })
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/volumes/vol-1', { method: 'DELETE' })
  })
})
