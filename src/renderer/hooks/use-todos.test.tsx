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
  moveOk: true,
  claimHeld: false,
  createAgentForPrompt: vi.fn(),
  track: vi.fn(),
  claimedTodo: {} as Record<string, unknown>,
}))

vi.mock('sonner', () => ({ toast: { error: state.toastError } }))
vi.mock('./use-experiment', () => ({ useExperiment: () => state.experimentOn }))
vi.mock('./use-sessions', () => ({ useCreateSession: () => ({ mutateAsync: state.createSession }) }))
vi.mock('./use-create-agent-for-prompt', () => ({ useCreateAgentForPrompt: () => state.createAgentForPrompt }))
vi.mock('@renderer/context/analytics-context', () => ({ useAnalyticsTracking: () => ({ track: state.track }) }))
vi.mock('@renderer/lib/api', () => ({
  apiFetch: async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    state.calls.push({ path, method, body })
    if (path === '/api/todos' && method === 'GET') {
      return new Response(JSON.stringify({ todos: [{ id: 't1', column: 'drafts' }] }))
    }
    if (path === '/api/todos/t1/position' && state.moveOk) {
      return new Response(JSON.stringify({ id: 't1', column: 'drafts', position: body.position }))
    }
    // One claim at a time, as the server keeps it.
    if (path === '/api/todos/t1/claim') {
      if (state.claimHeld) return new Response(JSON.stringify({ error: 'This is already starting' }), { status: 409 })
      state.claimHeld = true
      return new Response(JSON.stringify({ claim: 'c1', todo: { id: 't1', title: 'Churn', description: 'Why did it spike?', agentSlug: 'analyst', ...state.claimedTodo } }))
    }
    if (path === '/api/todos/t1' && method === 'PATCH') {
      return new Response(JSON.stringify({ id: 't1', column: 'drafts', agentSlug: body.agentSlug, newAgent: false }))
    }
    if (path === '/api/todos/t1/release') {
      state.claimHeld = false
      return new Response(null, { status: 204 })
    }
    if (path === '/api/todos/t1/start') {
      state.claimHeld = false
      return new Response(JSON.stringify({ id: 't1', column: 'working', sessionId: body.sessionId }))
    }
    return new Response(JSON.stringify({ error: 'nope' }), { status: 409 })
  },
}))

import { TODOS_QUERY_KEY, useMoveTodo, useSetTodoStatus, useStartTodo, useStartingTodoIds, useTodos, type StartableTodo, type TodoView } from './use-todos'

function draft(partial: Partial<StartableTodo> = {}): StartableTodo {
  return { id: 't1', title: 'Churn', description: 'Why did it spike?', agentSlug: 'analyst', newAgent: false, model: null, llmProviderId: null, effort: null, speed: null, ...partial }
}

function wrapper(client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

beforeEach(() => {
  state.experimentOn = true
  state.calls = []
  state.createSession.mockReset()
  state.toastError.mockReset()
  state.moveOk = true
  state.claimHeld = false
  state.createAgentForPrompt.mockReset()
  state.track.mockReset()
  state.claimedTodo = {}
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
  it('claims the draft, starts a session with the stored brief, then links it', async () => {
    state.createSession.mockResolvedValue({ id: 'session-9' })
    const { result } = renderHook(() => useStartTodo(), { wrapper: wrapper() })
    const started = await result.current.mutateAsync(draft())

    expect(state.calls[0]).toMatchObject({ path: '/api/todos/t1/claim', method: 'POST' })
    expect(state.createSession).toHaveBeenCalledWith({ agentSlug: 'analyst', message: 'Churn\n\nWhy did it spike?' })
    expect(state.calls).toContainEqual({ path: '/api/todos/t1/start', method: 'POST', body: { sessionId: 'session-9', claim: 'c1' } })
    expect(started).toMatchObject({ column: 'working', sessionId: 'session-9' })
  })

  it('starts the session on the model, effort and speed picked for the draft', async () => {
    state.createSession.mockResolvedValue({ id: 'session-9' })
    state.claimedTodo = { model: 'claude-opus-5-5', llmProviderId: 'anthropic-main', effort: 'high', speed: 'fast' }
    const { result } = renderHook(() => useStartTodo(), { wrapper: wrapper() })
    await result.current.mutateAsync(draft({ model: 'claude-opus-5-5', llmProviderId: 'anthropic-main' }))

    expect(state.createSession).toHaveBeenCalledWith({
      agentSlug: 'analyst',
      message: 'Churn\n\nWhy did it spike?',
      model: 'claude-opus-5-5',
      llmProviderId: 'anthropic-main',
      effort: 'high',
      speed: 'fast',
    })
  })

  it('makes a new agent named from the brief, gives the draft to it, then starts it there', async () => {
    state.createSession.mockResolvedValue({ id: 'session-9' })
    state.createAgentForPrompt.mockResolvedValue({ slug: 'churn-analyst' })
    state.claimedTodo = { agentSlug: 'churn-analyst' }
    const { result } = renderHook(() => useStartTodo(), { wrapper: wrapper() })
    await result.current.mutateAsync(draft({ agentSlug: null, newAgent: true }))

    expect(state.createAgentForPrompt).toHaveBeenCalledWith('Churn\n\nWhy did it spike?')
    expect(state.calls[0]).toEqual({ path: '/api/todos/t1', method: 'PATCH', body: { agentSlug: 'churn-analyst' } })
    expect(state.calls[1]).toMatchObject({ path: '/api/todos/t1/claim', method: 'POST' })
    expect(state.createSession).toHaveBeenCalledWith({ agentSlug: 'churn-analyst', message: 'Churn\n\nWhy did it spike?' })
    expect(state.track).toHaveBeenCalledWith('agent_created', expect.objectContaining({ source: 'todo' }))
  })

  it('creates nothing when the new agent could not be made', async () => {
    state.createAgentForPrompt.mockRejectedValue(new Error('Failed to create agent'))
    const { result } = renderHook(() => useStartTodo(), { wrapper: wrapper() })
    await expect(result.current.mutateAsync(draft({ agentSlug: null, newAgent: true }))).rejects.toThrow('Failed to create agent')
    expect(state.calls.filter((c) => c.method !== 'GET')).toEqual([])
    expect(state.createSession).not.toHaveBeenCalled()
    await waitFor(() => expect(state.toastError).toHaveBeenCalledWith('Failed to create agent'))
  })

  it('needs an agent', async () => {
    const { result } = renderHook(() => useStartTodo(), { wrapper: wrapper() })
    await expect(result.current.mutateAsync(draft({ agentSlug: null })))
      .rejects.toThrow('Pick an agent to start this')
    expect(state.createSession).not.toHaveBeenCalled()
  })

  it('reports the draft as starting until the session exists', async () => {
    let resolveSession: (value: { id: string }) => void = () => {}
    state.createSession.mockReturnValue(new Promise((resolve) => { resolveSession = resolve }))
    const { result } = renderHook(() => ({ start: useStartTodo(), starting: useStartingTodoIds() }), { wrapper: wrapper() })

    void result.current.start.mutateAsync(draft())
    await waitFor(() => expect(result.current.starting.has('t1')).toBe(true))
    resolveSession({ id: 'session-1' })
    await waitFor(() => expect(result.current.starting.has('t1')).toBe(false))
  })

  it('starts a draft only once while its first start is in flight', async () => {
    let resolveSession: (value: { id: string }) => void = () => {}
    state.createSession.mockReturnValue(new Promise((resolve) => { resolveSession = resolve }))
    const { result } = renderHook(() => useStartTodo(), { wrapper: wrapper() })
    const brief = draft()

    const first = result.current.mutateAsync(brief)
    await expect(result.current.mutateAsync(brief)).rejects.toThrow('This is already starting')
    resolveSession({ id: 'session-1' })
    await first
    expect(state.createSession).toHaveBeenCalledTimes(1)
  })

  it('says when another start already holds the draft, even after its component is gone', async () => {
    state.claimHeld = true
    const { result, unmount } = renderHook(() => useStartTodo(), { wrapper: wrapper() })
    result.current.mutate(draft())
    unmount()
    await waitFor(() => expect(state.toastError).toHaveBeenCalledWith('This is already starting'))
    expect(state.createSession).not.toHaveBeenCalled()
  })

  it('leaves a failed session creation to report itself, so it is said once', async () => {
    state.createSession.mockRejectedValue(new Error('The agent could not start'))
    const { result } = renderHook(() => useStartTodo(), { wrapper: wrapper() })
    await expect(result.current.mutateAsync(draft())).rejects.toThrow()
    expect(state.toastError).not.toHaveBeenCalled()
  })

  it('gives the claim back when the session could not be created', async () => {
    state.createSession.mockRejectedValue(new Error('The agent could not start'))
    const { result } = renderHook(() => useStartTodo(), { wrapper: wrapper() })
    await expect(result.current.mutateAsync(draft())).rejects.toThrow('The agent could not start')
    await waitFor(() => expect(state.calls).toContainEqual({ path: '/api/todos/t1/release', method: 'POST', body: { claim: 'c1' } }))
    expect(state.claimHeld).toBe(false)
  })
})

describe('useSetTodoStatus', () => {
  it('reloads the board when a change fails: it may be out of date', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })
    qc.setQueryData(TODOS_QUERY_KEY, [{ id: 't1', column: 'has_updates' }])
    const { result } = renderHook(() => useSetTodoStatus(), { wrapper: wrapper(qc) })
    result.current.mutate({ id: 't1', status: 'done' })
    await waitFor(() => expect(qc.getQueryState(TODOS_QUERY_KEY)?.isInvalidated).toBe(true))
  })
})

describe('useMoveTodo', () => {
  const board = () => [{ id: 't1', column: 'drafts', position: 1 }, { id: 't2', column: 'drafts', position: 2 }] as TodoView[]
  const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })

  it('moves the card at once and keeps it there', async () => {
    const qc = client()
    qc.setQueryData(TODOS_QUERY_KEY, board())
    const { result } = renderHook(() => useMoveTodo(), { wrapper: wrapper(qc) })
    result.current.mutate({ id: 't1', position: 3 })
    await waitFor(() => expect(qc.getQueryData<TodoView[]>(TODOS_QUERY_KEY)?.[0].position).toBe(3))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(state.calls).toContainEqual({ path: '/api/todos/t1/position', method: 'POST', body: { position: 3 } })
  })

  it('reloads the board when the move fails', async () => {
    state.moveOk = false
    const qc = client()
    qc.setQueryData(TODOS_QUERY_KEY, board())
    const { result } = renderHook(() => useMoveTodo(), { wrapper: wrapper(qc) })
    result.current.mutate({ id: 't1', position: 3 })
    await waitFor(() => expect(qc.getQueryState(TODOS_QUERY_KEY)?.isInvalidated).toBe(true))
  })
})
