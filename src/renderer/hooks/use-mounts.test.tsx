// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

const { mockApiFetch } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ id: 'v1', name: 'code', type: 'local' }), { status: 201 })),
}))
vi.mock('@renderer/lib/api', () => ({ apiFetch: mockApiFetch }))

import { volumeStopConfirmation } from '@renderer/lib/volume-stop'
import { useAddMount } from './use-mounts'

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

  it('asks before retrying a declined restart with force and preserves the creation request', async () => {
    const unsubscribe = volumeStopConfirmation.subscribe(() => {})
    const { result } = renderHook(() => useAddMount(), { wrapper: Wrapper })
    mockApiFetch.mockResolvedValueOnce(Response.json({ code: 'volume_stop_deferred', error: 'Uploads pending', workStopped: false }, { status: 409 }))
    try {
      await act(async () => {
        const pending = result.current.mutateAsync({ agentSlug: 'a1', hostPath: '/Users/joe/code', restart: true })
        await waitFor(() => expect(volumeStopConfirmation.getSnapshot()?.action).toBe('Restart'))
        expect(mockApiFetch).toHaveBeenCalledOnce()
        volumeStopConfirmation.answer(true)
        await pending
      })
      expect(mockApiFetch.mock.calls[1][0]).toBe('/api/agents/a1/mounts?force=true')
      expect(mockApiFetch.mock.calls[1][1]).toEqual(mockApiFetch.mock.calls[0][1])
    } finally { unsubscribe() }
  })

  it('creates and attaches a named volume with the selected visibility in one request', async () => {
    const { result } = renderHook(() => useAddMount(), { wrapper: Wrapper })
    await act(() => result.current.mutateAsync({ agentSlug: 'a1', hostPath: '/srv/reports', name: 'Reports', visibility: 'private' }))
    expect(mockApiFetch).toHaveBeenCalledOnce()
    expect(JSON.parse(String(mockApiFetch.mock.calls[0][1]?.body))).toEqual({ type: 'local', config: { path: '/srv/reports' }, name: 'Reports', visibility: 'private' })
  })

})
