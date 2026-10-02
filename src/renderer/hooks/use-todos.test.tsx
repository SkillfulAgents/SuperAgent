// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const state = vi.hoisted(() => ({
  experimentOn: true,
  calls: [] as { path: string; method: string; body: unknown }[],
  createSession: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('sonner', () => ({ toast: { error: state.toastError } }))
vi.mock('./use-experiment', () => ({ useExperiment: () => state.experimentOn }))
vi.mock('./use-sessions', () => ({ useCreateSession: () => ({ mutateAsync: state.createSession }) }))
vi.mock('@renderer/lib/api', () => ({
  apiFetch: async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    state.calls.push({ path, method, body })
    if (path === '/api/todos' && method === 'GET') {
      return new Response(JSON.stringify({ todos: [{ id: 't1', column: 'drafts' }] }))
    }
    if (path === '/api/todos/t1/start') {
      return new Response(JSON.stringify({ id: 't1', column: 'working', sessionId: body.sessionId }))
    }
    return new Response(JSON.stringify({ error: 'nope' }), { status: 409 })
  },
}))

import { useStartTodo, useStartingTodoIds, useTodos } from './use-todos'

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

beforeEach(() => {
  state.experimentOn = true
  state.calls = []
  state.createSession.mockReset()
  state.toastError.mockReset()
})

describe('useTodos', () => {
  it('loads the board', async () => {
    const { result } = renderHook(() => useTodos(), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.data).toEqual([{ id: 't1', column: 'drafts' }]))
  })

  it('asks nothing of the server while the experiment is off', async () => {
    state.experimentOn = false
    const { result } = renderHook(() => useTodos(), { wrapper: wrapper() })
    expect(result.current.fetchStatus).toBe('idle')
    expect(state.calls).toEqual([])
  })
})

describe('useStartTodo', () => {
  it('starts a session with the brief, then links it', async () => {
    state.createSession.mockResolvedValue({ id: 'session-9' })
    const { result } = renderHook(() => useStartTodo(), { wrapper: wrapper() })
    const started = await result.current.mutateAsync({ id: 't1', title: 'Churn', description: 'Why did it spike?', agentSlug: 'analyst' })

    expect(state.createSession).toHaveBeenCalledWith({ agentSlug: 'analyst', message: 'Churn\n\nWhy did it spike?' })
    expect(state.calls).toContainEqual({ path: '/api/todos/t1/start', method: 'POST', body: { sessionId: 'session-9' } })
    expect(started).toMatchObject({ column: 'working', sessionId: 'session-9' })
  })

  it('needs an agent', async () => {
    const { result } = renderHook(() => useStartTodo(), { wrapper: wrapper() })
    await expect(result.current.mutateAsync({ id: 't1', title: 'x', description: '', agentSlug: null }))
      .rejects.toThrow('Pick an agent to start this')
    expect(state.createSession).not.toHaveBeenCalled()
  })

  it('reports the draft as starting until the session exists', async () => {
    let resolveSession: (value: { id: string }) => void = () => {}
    state.createSession.mockReturnValue(new Promise((resolve) => { resolveSession = resolve }))
    const { result } = renderHook(() => ({ start: useStartTodo(), starting: useStartingTodoIds() }), { wrapper: wrapper() })

    void result.current.start.mutateAsync({ id: 't1', title: 'x', description: '', agentSlug: 'analyst' })
    await waitFor(() => expect(result.current.starting.has('t1')).toBe(true))
    resolveSession({ id: 'session-1' })
    await waitFor(() => expect(result.current.starting.has('t1')).toBe(false))
  })

  it('starts a draft only once while its first start is in flight', async () => {
    let resolveSession: (value: { id: string }) => void = () => {}
    state.createSession.mockReturnValue(new Promise((resolve) => { resolveSession = resolve }))
    const { result } = renderHook(() => useStartTodo(), { wrapper: wrapper() })
    const brief = { id: 't1', title: 'x', description: '', agentSlug: 'analyst' }

    const first = result.current.mutateAsync(brief)
    await expect(result.current.mutateAsync(brief)).rejects.toThrow('This is already starting')
    resolveSession({ id: 'session-1' })
    await first
    expect(state.createSession).toHaveBeenCalledTimes(1)
  })

  it('still reports a failure after the component that started it is gone', async () => {
    let rejectSession: (error: Error) => void = () => {}
    state.createSession.mockReturnValue(new Promise((_, reject) => { rejectSession = reject }))
    const { result, unmount } = renderHook(() => useStartTodo(), { wrapper: wrapper() })

    result.current.mutate({ id: 't1', title: 'x', description: '', agentSlug: 'analyst' })
    unmount()
    rejectSession(new Error('The agent could not start'))
    await waitFor(() => expect(state.toastError).toHaveBeenCalledWith('The agent could not start'))
  })
})
