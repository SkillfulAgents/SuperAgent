// @vitest-environment jsdom
import { Component, StrictMode, createContext, useContext, useEffect, type ReactNode } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRouteWithContext, createRoute, createRouter, notFound, Outlet } from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserContextValue } from '@renderer/context/user-context'

const state = vi.hoisted(() => ({ user: null as unknown as UserContextValue }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => useContext(TestUserContext) }))
const TestUserContext = createContext<UserContextValue>(state.user)
import { AuthRouteBoundary, RouterMount } from './auth-boundary'

function identity(id: string): UserContextValue {
  return {
    authGeneration: {}, user: { id, name: id, email: `${id}@example.test` },
    isAuthenticated: true, isAdmin: false, isAuthMode: true, isPending: false,
    mustChangePassword: false, cloudWait: null, rolesReady: true,
    agentRole: () => null, agentMemberCount: () => 0, canAccessAgent: () => false,
    canUseAgent: () => false, canAdminAgent: () => false, signOut: async () => {},
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
let client: QueryClient
beforeEach(() => { client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); state.user = identity('alice') })
afterEach(() => { cleanup(); client.clear(); vi.restoreAllMocks() })

function harness() {
  const effects: Array<{ identity: string | undefined; documentOwner: string }> = []
  const loadPrivate = vi.fn(async () => 'alice')
  const loadPublic = vi.fn(async () => undefined)
  const root = createRootRouteWithContext<{ queryClient: QueryClient; user: UserContextValue }>()({
    component: () => <AuthRouteBoundary><Outlet /></AuthRouteBoundary>,
  })
  const privateRoute = createRoute({
    getParentRoute: () => root, path: '/private',
    loader: () => loadPrivate(),
    component: function PrivateScreen() {
      const owner = privateRoute.useLoaderData()
      const user = useContext(TestUserContext)
      useEffect(() => { effects.push({ identity: user.user?.id, documentOwner: owner }) }, [user, owner])
      return <div data-testid="private-document">{owner}</div>
    },
    notFoundComponent: () => <div data-testid="denied" />,
  })
  const publicRoute = createRoute({ getParentRoute: () => root, path: '/public', loader: loadPublic, component: () => <div data-testid="public" /> })
  const router = createRouter({
    routeTree: root.addChildren([privateRoute, publicRoute]),
    history: createMemoryHistory({ initialEntries: ['/private'] }),
    context: { queryClient: client, user: state.user },
    defaultPendingMinMs: 0,
  })
  const tree = (visible = true) => <StrictMode><QueryClientProvider client={client}><TestUserContext.Provider value={state.user}>{visible && <RouterMount router={router} />}</TestUserContext.Provider></QueryClientProvider></StrictMode>
  return { router, tree, effects, loadPrivate, loadPublic }
}

describe('retained Router matches at an auth boundary', () => {
  it('loads once on a cold StrictMode mount', async () => {
    const h = harness()
    render(h.tree())
    await screen.findByText('alice')
    expect(h.loadPrivate).toHaveBeenCalledTimes(1)
  })

  it.each([true, false])('never mounts the retained private screen for a new identity (AuthGate remount: %s)', async (remount) => {
    const h = harness()
    const view = render(h.tree())
    await screen.findByText('alice')
    if (remount) view.rerender(h.tree(false))
    h.effects.length = 0
    const access = deferred<string>()
    h.loadPrivate.mockImplementationOnce(() => access.promise)
    const invalidate = vi.spyOn(h.router, 'invalidate')
    state.user = identity('bob')
    view.rerender(h.tree())
    await waitFor(() => expect(h.loadPrivate).toHaveBeenCalledTimes(2))
    expect(screen.queryByTestId('private-document')).toBeNull()
    expect(h.effects).toEqual([])
    await act(async () => { access.reject(notFound()) })
    await screen.findByTestId('denied')
    expect(h.effects).toEqual([])
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it.each([true, false])('loads a changed URL exactly once (new identity: %s)', async (newIdentity) => {
    const h = harness()
    const view = render(h.tree())
    await screen.findByText('alice')
    view.rerender(h.tree(false))
    state.user = identity('bob')
    if (!newIdentity) state.user = h.router.options.context.user
    h.router.history.push('/public')
    const invalidate = vi.spyOn(h.router, 'invalidate')
    view.rerender(h.tree())
    await screen.findByTestId('public')
    expect(h.loadPublic).toHaveBeenCalledTimes(1)
    expect(h.loadPrivate).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledTimes(newIdentity ? 1 : 0)
  })

  it('loads a missed new history entry even when its URL is unchanged', async () => {
    const h = harness()
    const view = render(h.tree())
    await screen.findByText('alice')
    const key = h.router.state.location.state.__TSR_key
    view.rerender(h.tree(false))
    h.router.history.push('/private')
    view.rerender(h.tree())
    await waitFor(() => expect(h.loadPrivate).toHaveBeenCalledTimes(2))
    await screen.findByText('alice')
    expect(h.router.state.location.state.__TSR_key).not.toBe(key)
  })

  it('lets an already initiated current-identity navigation finish without loading it twice', async () => {
    const h = harness()
    const view = render(h.tree())
    await screen.findByText('alice')
    const access = deferred<undefined>()
    h.loadPublic.mockImplementationOnce(() => access.promise)
    let navigation!: Promise<void>
    act(() => { navigation = h.router.navigate({ href: '/public' }) })
    await waitFor(() => expect(h.loadPublic).toHaveBeenCalledTimes(1))
    view.rerender(h.tree(false))
    const invalidate = vi.spyOn(h.router, 'invalidate')
    view.rerender(h.tree())
    expect(h.loadPublic).toHaveBeenCalledTimes(1)
    expect(invalidate).not.toHaveBeenCalled()
    await act(async () => { access.resolve(undefined) })
    await screen.findByTestId('public')
    await navigation
    expect(h.loadPublic).toHaveBeenCalledTimes(1)
  })

  it('replaces an in-flight navigation from the old identity before revealing its matches', async () => {
    const h = harness()
    const view = render(h.tree())
    await screen.findByText('alice')
    const oldAccess = deferred<undefined>()
    const newAccess = deferred<undefined>()
    h.loadPublic.mockImplementationOnce(() => oldAccess.promise).mockImplementationOnce(() => newAccess.promise)
    let navigation!: Promise<void>
    act(() => { navigation = h.router.navigate({ href: '/public' }) })
    await waitFor(() => expect(h.loadPublic).toHaveBeenCalledTimes(1))
    h.effects.length = 0
    state.user = identity('bob')
    view.rerender(h.tree())
    await waitFor(() => expect(h.loadPublic).toHaveBeenCalledTimes(2))
    expect(screen.queryByTestId('private-document')).toBeNull()
    expect(screen.queryByTestId('public')).toBeNull()
    expect(h.effects).toEqual([])
    await act(async () => { oldAccess.resolve(undefined) })
    expect(screen.queryByTestId('public')).toBeNull()
    await act(async () => { newAccess.resolve(undefined) })
    await screen.findByTestId('public')
    await navigation
    expect(h.router.state.matches[0].context.user.authGeneration).toBe(state.user.authGeneration)
    expect(h.effects).toEqual([])
  })

  it('reloads a retained same-user match after logout but skips a same-generation remount', async () => {
    const h = harness()
    const view = render(h.tree())
    await screen.findByText('alice')
    view.rerender(h.tree(false))
    view.rerender(h.tree())
    expect(h.loadPrivate).toHaveBeenCalledTimes(1)
    view.rerender(h.tree(false))
    state.user = identity('alice')
    view.rerender(h.tree())
    await waitFor(() => expect(h.loadPrivate).toHaveBeenCalledTimes(2))
    await screen.findByText('alice')
  })

  it('surfaces an unexpected invalidation rejection through an error boundary', async () => {
    const h = harness()
    class Boundary extends Component<{ children: ReactNode }, { error?: Error }> {
      state: { error?: Error } = {}
      static getDerivedStateFromError(error: Error) { return { error } }
      render() { return this.state.error ? <div data-testid="boundary-error">{this.state.error.message}</div> : this.props.children }
    }
    const view = render(<Boundary>{h.tree()}</Boundary>)
    await screen.findByText('alice')
    view.rerender(<Boundary>{h.tree(false)}</Boundary>)
    state.user = identity('bob')
    vi.spyOn(h.router, 'invalidate').mockRejectedValueOnce(new Error('Route validation failed'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    view.rerender(<Boundary>{h.tree()}</Boundary>)
    await screen.findByText('Route validation failed')
    expect(screen.queryByTestId('private-document')).toBeNull()
  })
})
