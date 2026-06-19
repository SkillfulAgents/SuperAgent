// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

import { useSummarizeSession, useCreateSession } from './use-sessions'

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
  return Wrapper
}

describe('useSummarizeSession', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('calls apiFetch with the correct URL and body, returns the summary', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ summary: 'This is the summary.' }),
    })

    const { result } = renderHook(() => useSummarizeSession(), {
      wrapper: createWrapper(),
    })

    let data: { summary: string } | undefined
    await act(async () => {
      data = await result.current.mutateAsync({ agentSlug: 'my-agent', fromSessionId: 'sess-123' })
    })

    expect(mockApiFetch).toHaveBeenCalledOnce()
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/agents/my-agent/sessions/summarize',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromSessionId: 'sess-123' }),
      },
    )
    expect(data).toEqual({ summary: 'This is the summary.' })
  })

  it('throws when res.ok is false', async () => {
    mockApiFetch.mockResolvedValue({ ok: false })

    const { result } = renderHook(() => useSummarizeSession(), {
      wrapper: createWrapper(),
    })

    await expect(
      act(async () => {
        await result.current.mutateAsync({ agentSlug: 'my-agent', fromSessionId: 'sess-123' })
      }),
    ).rejects.toThrow('Failed to summarize session')
  })
})

describe('useCreateSession', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('includes seedSummary and fromSessionId in the request body when provided', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'new-sess', initialMessageUuid: 'msg-1' }),
    })

    const { result } = renderHook(() => useCreateSession(), {
      wrapper: createWrapper(),
    })

    await act(async () => {
      await result.current.mutateAsync({
        agentSlug: 'my-agent',
        message: 'Hello',
        seedSummary: 'Prior context summary',
        fromSessionId: 'old-sess-456',
      })
    })

    expect(mockApiFetch).toHaveBeenCalledOnce()
    const [, options] = mockApiFetch.mock.calls[0] as [string, { body: string }]
    const body = JSON.parse(options.body)
    expect(body.seedSummary).toBe('Prior context summary')
    expect(body.fromSessionId).toBe('old-sess-456')
  })

  it('omits seedSummary and fromSessionId from the body when not provided', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'new-sess', initialMessageUuid: 'msg-2' }),
    })

    const { result } = renderHook(() => useCreateSession(), {
      wrapper: createWrapper(),
    })

    await act(async () => {
      await result.current.mutateAsync({ agentSlug: 'my-agent', message: 'Hello without seed' })
    })

    const [, options] = mockApiFetch.mock.calls[0] as [string, { body: string }]
    const body = JSON.parse(options.body)
    expect(Object.keys(body)).not.toContain('seedSummary')
    expect(Object.keys(body)).not.toContain('fromSessionId')
  })

  it('throws when res.ok is false', async () => {
    mockApiFetch.mockResolvedValue({ ok: false })

    const { result } = renderHook(() => useCreateSession(), {
      wrapper: createWrapper(),
    })

    await expect(
      act(async () => {
        await result.current.mutateAsync({ agentSlug: 'my-agent', message: 'Hello' })
      }),
    ).rejects.toThrow('Failed to create session')
  })
})
