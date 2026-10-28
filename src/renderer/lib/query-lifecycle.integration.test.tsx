// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { focusManager, onlineManager, QueryClientProvider, useIsMutating, type QueryClient } from '@tanstack/react-query'

const state = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  createSession: vi.fn(),
  authSignOut: vi.fn(),
  session: { data: null, isPending: false } as { data: { user: { id: string; name: string; email: string } } | null; isPending: boolean },
  switchTarget: vi.fn(),
  capture: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('./api', () => ({
  apiFetch: state.apiFetch,
  clearRedirectStash: vi.fn(),
  markDeliberateSignOut: vi.fn(),
  clearDeliberateSignOut: vi.fn(),
}))
vi.mock('./auth-client', () => ({ useSession: () => state.session, signOut: state.authSignOut }))
vi.mock('./error-reporting', () => ({ captureRendererException: state.capture }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: state.toastError }) }))
vi.mock('./env', () => ({ isElectron: () => true }))
vi.mock('./api-target', async (original) => ({
  ...await original<typeof import('./api-target')>(),
  switchTarget: state.switchTarget,
}))
vi.mock('@renderer/hooks/use-platform-auth', () => ({
  usePlatformAuthStatus: () => ({ data: { connected: true } }),
}))
vi.mock('@renderer/hooks/use-cloud-workspace', () => ({
  useCloudWorkspace: () => ({ refetch: async () => ({ data: { found: true, hasValidToken: true } }) }),
}))
vi.mock('@renderer/context/connectivity-context', () => ({ useIsOnline: () => true }))
// Keep the board query disabled: the pending indicator must update from the
// actual start mutation, rather than a coincidental board-query notification.
vi.mock('@renderer/hooks/use-experiment', () => ({ useExperiment: () => false }))
vi.mock('@renderer/hooks/use-sessions', () => ({ useCreateSession: () => ({ mutateAsync: state.createSession }) }))
vi.mock('@renderer/hooks/use-create-agent-for-prompt', () => ({ useCreateAgentForPrompt: () => vi.fn() }))

import { createAppQueryClient } from './query-client'
import { _resetApiTargetForTest } from './api-target'
import { useTargetSwitch } from '@renderer/hooks/use-target-switch'
import { useAgent, useAgents } from '@renderer/hooks/use-agents'
import { TODOS_QUERY_KEY, useStartTodo, useStartingTodoIds, type StartableTodo } from '@renderer/hooks/use-todos'
import { UserProvider, useUser } from '@renderer/context/user-context'
import { useUpdateUserSettings } from '@renderer/hooks/use-user-settings'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
}

const draft: StartableTodo = {
  id: 'draft-old', title: 'Old workspace task', description: '', agentSlug: 'old-agent',
  newAgent: false, model: null, llmProviderId: null, effort: null, speed: null,
}
const user = { id: 'user-one', name: 'One', email: 'one@example.test' }
let client: QueryClient

function Wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

function AuthWrapper({ children }: { children: ReactNode }) {
  return <Wrapper><UserProvider>{children}</UserProvider></Wrapper>
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('__AUTH_MODE__', false)
  onlineManager.setOnline(true)
  focusManager.setFocused(true)
  state.session = { data: null, isPending: false }
  state.switchTarget.mockResolvedValue(undefined)
  state.authSignOut.mockResolvedValue(undefined)
  state.apiFetch.mockImplementation(async (path: string) => {
    if (path === '/api/agents') return json([])
    if (path === '/api/agents/my-roles') return json({ roles: {} })
    if (path === '/api/todos/draft-old/claim') return json({ claim: 'claim-old', todo: draft })
    if (path === '/api/todos/draft-old/start') return json({ ...draft, column: 'working', sessionId: 'session-old' })
    throw new Error(`Unexpected request: ${path}`)
  })
  client = createAppQueryClient()
})

afterEach(() => {
  cleanup()
  client.clear()
  onlineManager.setOnline(true)
  focusManager.setFocused(undefined)
  vi.useRealTimers()
  vi.unstubAllGlobals()
  _resetApiTargetForTest()
})

describe('pending work at app identity boundaries', () => {
  it('finishes queued settings edits while unfocused, merging each against the preceding result', async () => {
    const firstResponse = deferred<Response>()
    const saved = { theme: 'dark', agentFolderAssignments: { support: 'folder-one' } }
    client.setQueryData(['user-settings'], saved)
    state.apiFetch.mockImplementationOnce(() => firstResponse.promise).mockImplementationOnce(async () =>
      json({ ...saved, agentFolderAssignments: { support: 'folder-one', sales: 'folder-two', legal: 'folder-three' } }),
    )
    const { result } = renderHook(() => ({ first: useUpdateUserSettings(), second: useUpdateUserSettings() }), { wrapper: Wrapper })
    let first!: ReturnType<typeof result.current.first.mutateAsync>
    let second!: ReturnType<typeof result.current.second.mutateAsync>
    act(() => {
      first = result.current.first.mutateAsync((current) => ({ agentFolderAssignments: { ...current.agentFolderAssignments, sales: 'folder-two' } }))
      second = result.current.second.mutateAsync((current) => ({ agentFolderAssignments: { ...current.agentFolderAssignments, legal: 'folder-three' } }))
    })
    await waitFor(() => expect(state.apiFetch).toHaveBeenCalledTimes(1))
    act(() => { focusManager.setFocused(false) })
    await act(async () => {
      firstResponse.resolve(json({ ...saved, agentFolderAssignments: { support: 'folder-one', sales: 'folder-two' } }))
      await first
    })
    try {
      await waitFor(() => expect(state.apiFetch).toHaveBeenCalledTimes(2))
      expect(JSON.parse(state.apiFetch.mock.calls[1][1].body)).toEqual({
        agentFolderAssignments: { support: 'folder-one', sales: 'folder-two', legal: 'folder-three' },
      })
      await act(async () => { await second })
      expect(client.getQueryData(['user-settings'])).toMatchObject({
        agentFolderAssignments: { support: 'folder-one', sales: 'folder-two', legal: 'folder-three' },
      })
    } finally {
      // Also release the old-version baseline's paused mutation on failure.
      act(() => { focusManager.setFocused(true) })
      await act(async () => { await second })
    }
  })

  it('clears the Todo starting indicator immediately after a successful workspace switch', async () => {
    const session = deferred<{ id: string }>()
    state.createSession.mockReturnValue(session.promise)
    const { result } = renderHook(() => ({
      start: useStartTodo(), starting: useStartingTodoIds(), pending: useIsMutating(), target: useTargetSwitch(),
    }), { wrapper: Wrapper })

    let work!: ReturnType<typeof result.current.start.mutateAsync>
    act(() => { work = result.current.start.mutateAsync(draft) })
    await waitFor(() => expect(result.current.starting.has(draft.id)).toBe(true))
    expect(result.current.pending).toBe(1)

    await act(async () => { expect(await result.current.target.switchTo('cloud')).toBe(true) })
    await waitFor(() => expect([...result.current.starting]).toEqual([]))
    expect(result.current.pending).toBe(0)
    expect(state.switchTarget).toHaveBeenCalledWith('cloud')
    expect(client.getMutationCache().getAll()).toEqual([])

    // clear() does not cancel the server-side operation. Its eventual response
    // must not restore the dropped board or its pending indicator before reload.
    await act(async () => { session.resolve({ id: 'session-old' }); await work })
    expect(client.getQueryData(TODOS_QUERY_KEY)).toBeUndefined()
    expect([...result.current.starting]).toEqual([])
  })

  it('retains pending work and cached data when the workspace preference write fails', async () => {
    const session = deferred<{ id: string }>()
    state.createSession.mockReturnValue(session.promise)
    state.switchTarget.mockRejectedValue(new Error('Settings are read-only'))
    client.setQueryData(['agents', 'old-agent'], { slug: 'old-agent' })
    const { result } = renderHook(() => ({
      start: useStartTodo(), starting: useStartingTodoIds(), target: useTargetSwitch(),
    }), { wrapper: Wrapper })
    let work!: ReturnType<typeof result.current.start.mutateAsync>
    act(() => { work = result.current.start.mutateAsync(draft) })
    await waitFor(() => expect(result.current.starting.has(draft.id)).toBe(true))
    await act(async () => { expect(await result.current.target.switchTo('cloud')).toBe(false) })
    expect(result.current.starting.has(draft.id)).toBe(true)
    expect(client.getQueryData(['agents', 'old-agent'])).toEqual({ slug: 'old-agent' })
    expect(result.current.target.switching).toBe(false)
    await act(async () => { session.resolve({ id: 'session-old' }); await work })
  })

  it.each(['manual logout', 'session loss'] as const)('clears pending indicators on %s and ignores a late query response', async (boundary) => {
    vi.stubGlobal('__AUTH_MODE__', true)
    state.session = { data: { user }, isPending: false }
    const session = deferred<{ id: string }>()
    const agentResponse = deferred<Response>()
    state.createSession.mockReturnValue(session.promise)
    const normalFetch = state.apiFetch.getMockImplementation()!
    state.apiFetch.mockImplementation((path: string) => path === '/api/agents/old-agent' ? agentResponse.promise : normalFetch(path))
    const { result, rerender } = renderHook(() => ({
      user: useUser(), agent: useAgent('old-agent'),
      start: useStartTodo(), starting: useStartingTodoIds(), pending: useIsMutating(),
    }), { wrapper: AuthWrapper })
    let work!: ReturnType<typeof result.current.start.mutateAsync>
    act(() => { work = result.current.start.mutateAsync(draft) })
    await waitFor(() => expect(result.current.starting.has(draft.id)).toBe(true))
    await waitFor(() => expect(state.apiFetch).toHaveBeenCalledWith('/api/agents/old-agent'))

    if (boundary === 'manual logout') {
      await act(async () => { await result.current.user.signOut() })
      expect(state.authSignOut).toHaveBeenCalledOnce()
    } else {
      state.session = { data: null, isPending: false }
      rerender()
    }
    await waitFor(() => expect([...result.current.starting]).toEqual([]))
    expect(result.current.pending).toBe(0)
    expect(client.getQueryData(['agents', 'old-agent'])).toBeUndefined()

    // A later login/load may create the same key. A previous request completing
    // afterwards must never overwrite the new entry, even without AbortSignal.
    client.setQueryData(['agents', 'old-agent'], { slug: 'new-user-agent' })
    await act(async () => {
      agentResponse.resolve(json({ slug: 'old-private-agent' }))
      session.resolve({ id: 'session-old' })
      await work
    })
    expect(client.getQueryData(['agents', 'old-agent'])).toEqual({ slug: 'new-user-agent' })
    expect(client.getQueryData(TODOS_QUERY_KEY)).toBeUndefined()
    expect(state.capture).not.toHaveBeenCalled()
  })
})

describe('agent query lifecycle with the production client', () => {
  async function tick(ms = 0) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
  }

  beforeEach(() => { vi.useFakeTimers() })

  it('retries transient failures and reports only a terminal failure, without query toasts', async () => {
    const failure = new Error('Temporary network error')
    state.apiFetch.mockRejectedValueOnce(failure).mockResolvedValueOnce(json([{ slug: 'recovered' }]))
    const { result, unmount } = renderHook(() => useAgents({ poll: false }), { wrapper: Wrapper })
    await tick(1_010)
    expect(result.current.data).toEqual([{ slug: 'recovered' }])
    expect(state.apiFetch).toHaveBeenCalledTimes(2)
    expect(state.capture).not.toHaveBeenCalled()
    unmount()
    client.clear()
    state.apiFetch.mockReset().mockRejectedValue(failure)
    const failed = renderHook(() => useAgents({ poll: false }), { wrapper: Wrapper })
    await tick(7_100)
    expect(failed.result.current.isError).toBe(true)
    expect(state.apiFetch).toHaveBeenCalledTimes(4)
    expect(state.capture).toHaveBeenCalledExactlyOnceWith(failure, { tags: { source: 'query' } })
    expect(state.toastError).not.toHaveBeenCalled()
  })

  it('holds an offline fetch, resumes on reconnect, and keeps the app focus-refetch policy', async () => {
    state.apiFetch.mockResolvedValue(json([{ slug: 'online' }]))
    onlineManager.setOnline(false)
    const { result } = renderHook(() => useAgents({ poll: false }), { wrapper: Wrapper })
    await tick()
    expect(result.current.fetchStatus).toBe('paused')
    expect(state.apiFetch).not.toHaveBeenCalled()
    act(() => { onlineManager.setOnline(true) })
    await tick(10)
    expect(result.current.data).toEqual([{ slug: 'online' }])
    await tick(6_000)
    act(() => { focusManager.setFocused(false); focusManager.setFocused(true) })
    await tick(10)
    expect(state.apiFetch).toHaveBeenCalledTimes(1)
    act(() => { onlineManager.setOnline(false); onlineManager.setOnline(true) })
    await tick(10)
    expect(state.apiFetch).toHaveBeenCalledTimes(2)
  })

  it('shares polling across consumers, preserves narrow selections, and stops after unmount', async () => {
    let version = 0
    state.apiFetch.mockImplementation(async () => json([{ slug: 'same-agent', status: `status-${++version}` }]))
    const select = (agents: { slug: string }[]) => agents.map(({ slug }) => slug)
    const { result, unmount } = renderHook(() => ({
      list: useAgents(), index: useAgents({ poll: false, select }),
    }), { wrapper: Wrapper })
    await tick(10)
    const index = result.current.index.data
    expect(index).toEqual(['same-agent'])
    expect(state.apiFetch).toHaveBeenCalledTimes(1)
    await tick(60_010)
    expect(state.apiFetch).toHaveBeenCalledTimes(2)
    expect(result.current.index.data).toBe(index)
    expect(result.current.list.data?.[0]).toMatchObject({ status: 'status-2' })
    unmount()
    await tick(120_000)
    expect(state.apiFetch).toHaveBeenCalledTimes(2)
  })
})
