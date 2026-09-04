// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PropsWithChildren } from 'react'

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), agentStatus: 'stopped' as 'running' | 'stopped' }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: mocks.apiFetch }))
vi.mock('@renderer/hooks/use-agents', () => ({ useAgent: () => ({ data: { slug: 'a1', status: mocks.agentStatus } }) }))
vi.mock('@renderer/lib/host-features', () => ({ canUseHostFeatures: () => true }))

import { useVolumesManager, useAddMount } from './use-mounts'
import { agentMountsResponseSchema, sharedVolumeListItemSchema } from '@shared/lib/services/mount-schema'

const FOLDER = { id: 'm1', hostPath: '/Users/joe/code', containerPath: '/mounts/code', folderName: 'code', addedAt: '2026-01-01', source: 'folder' as const, health: 'ok' as const }
const SHARED = { id: 'vol-1', hostPath: '/data/volumes/vol-1', containerPath: '/volumes/research', folderName: 'Research', addedAt: '2026-01-01', source: 'shared' as const, health: 'ok' as const }
const RESEARCH = sharedVolumeListItemSchema.parse({ id: 'vol-1', name: 'Research', mountName: 'research', attachedAgents: [{ slug: 'a1', name: 'Agent One' }] })
const LIST = agentMountsResponseSchema.parse({ hostFolders: false, sharedVolumes: true, mounts: [SHARED] })

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('useVolumesManager', () => {
  let queryClient: QueryClient
  let list: { hostFolders: boolean; sharedVolumes: boolean; mounts: unknown[] }
  let listReads: number
  let registryReads: number

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.agentStatus = 'stopped'
    listReads = 0
    registryReads = 0
    list = LIST
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (url === '/api/agents/a1/mounts' && method === 'GET') { listReads++; return jsonResponse(list) }
      if (url === '/api/volumes' && method === 'GET') { registryReads++; return jsonResponse({ volumes: [RESEARCH] }) }
      if (url === '/api/agents/a1/volumes' && method === 'POST') return jsonResponse({ id: 'vol-new' }, 201)
      if (url === '/api/agents/a1/volumes/vol-1' && method === 'DELETE') return jsonResponse({ success: true })
      if (url === '/api/volumes/vol-1' && method === 'DELETE') return jsonResponse({ success: true })
      if (url === '/api/agents/a1/mounts' && method === 'POST') return jsonResponse(FOLDER, 201)
      if (url === '/api/agents/a1/stop' && method === 'POST') return jsonResponse({ ok: true })
      if (url === '/api/agents/a1/start' && method === 'POST') return jsonResponse({ ok: true })
      throw new Error(`Unexpected request: ${method} ${url}`)
    })
  })

  function wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }

  it('reads flags, records, and the registry', async () => {
    const { result } = renderHook(() => useVolumesManager('a1'), { wrapper })
    await waitFor(() => expect(result.current.mounts).toEqual([SHARED]))
    expect(result.current.hostFolders).toBe(false)
    expect(result.current.sharedVolumes).toBe(true)
    await waitFor(() => expect(result.current.registry).toEqual([RESEARCH]))
  })

  it('a shared write refetches the mount list and the registry', async () => {
    const { result } = renderHook(() => useVolumesManager('a1'), { wrapper })
    await waitFor(() => expect(result.current.mounts).toHaveLength(1))
    await waitFor(() => expect(result.current.registry).toEqual([RESEARCH]))
    const listBefore = listReads
    const registryBefore = registryReads
    await act(async () => { await result.current.attachShared('vol-1') })
    await waitFor(() => expect(listReads).toBeGreaterThan(listBefore))
    await waitFor(() => expect(registryReads).toBeGreaterThan(registryBefore))
  })

  it('a composer add refetches the card list through the bare mounts prefix', async () => {
    const manager = renderHook(() => useVolumesManager('a1'), { wrapper })
    await waitFor(() => expect(manager.result.current.mounts).toHaveLength(1))
    const readsBefore = listReads
    const add = renderHook(() => useAddMount(), { wrapper })
    await act(async () => { await add.result.current.mutateAsync({ agentSlug: 'a1', hostPath: '/Users/joe/code' }) })
    await waitFor(() => expect(listReads).toBeGreaterThan(readsBefore))
  })

  it('marks pendingRestart after a shared write only when the agent runs, and restart clears it and refetches', async () => {
    mocks.agentStatus = 'running'
    const { result } = renderHook(() => useVolumesManager('a1'), { wrapper })
    await waitFor(() => expect(result.current.mounts).toHaveLength(1))
    await act(async () => { await result.current.detachShared('vol-1') })
    expect(result.current.pendingRestart).toBe(true)
    const readsBefore = listReads
    await act(async () => { await result.current.handleRestart() })
    expect(result.current.pendingRestart).toBe(false)
    await waitFor(() => expect(listReads).toBeGreaterThan(readsBefore))
  })

  it('records an attach refusal on the manager', async () => {
    mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (url === '/api/agents/a1/mounts' && method === 'GET') { listReads++; return jsonResponse(list) }
      if (url === '/api/volumes' && method === 'GET') { registryReads++; return jsonResponse({ volumes: [RESEARCH] }) }
      if (url === '/api/agents/a1/volumes' && method === 'POST') return jsonResponse({ error: 'This agent already has the maximum of 19 shared volumes' }, 409)
      throw new Error(`Unexpected request: ${method} ${url}`)
    })
    const { result } = renderHook(() => useVolumesManager('a1'), { wrapper })
    await waitFor(() => expect(result.current.mounts).toHaveLength(1))
    await act(async () => {
      await result.current.attachShared('vol-1').catch(() => {})
    })
    expect(result.current.actionError).toBe('This agent already has the maximum of 19 shared volumes')
  })

  it('keeps pendingRestart and records the error when stop fails', async () => {
    mocks.agentStatus = 'running'
    const { result } = renderHook(() => useVolumesManager('a1'), { wrapper })
    await waitFor(() => expect(result.current.mounts).toHaveLength(1))
    await act(async () => { await result.current.detachShared('vol-1') })
    mocks.apiFetch.mockImplementationOnce(async () => jsonResponse({ error: 'stop failed' }, 500))
    await act(async () => { await result.current.handleRestart() })
    expect(result.current.pendingRestart).toBe(true)
    expect(result.current.restartError).toBe('stop failed')
  })
})
