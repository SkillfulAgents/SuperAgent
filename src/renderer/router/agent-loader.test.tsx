// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  createMemoryHistory,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { QueryClient } from '@tanstack/react-query'
import { z } from 'zod'

// api.ts imports getApiBaseUrl at module load; stub it so the import is inert
// (the loader never actually fetches — agentQuery's queryFn is replaced below).
// Same pattern as api.test.ts.
vi.mock('@renderer/lib/env', () => ({ getApiBaseUrl: () => '' }))

// Replace agentQuery so its queryFn is the per-test stub, but KEEP the real
// query key shape (['agents', slug]) so the success case can assert the loader
// warmed THE cache entry the component would read.
const agentQueryFn = vi.fn<() => Promise<unknown>>()
vi.mock('@renderer/hooks/query-options', () => ({
  agentQuery: (slug: string) => ({
    queryKey: ['agents', slug],
    queryFn: agentQueryFn,
    retry: false,
  }),
}))

// The REAL HttpError so the loader's `err instanceof HttpError` branch matches.
import { HttpError } from '@renderer/lib/api'
import { agentLayoutRoute, type RouterContext } from './routes'
import { lenient } from './zod-search'
import { rootSearchSchema } from './search-schemas'
import type { UserContextValue } from '@renderer/context/user-context'

/**
 * Pins the access-control core of the agent loader (routes.ts) at a deterministic
 * integration layer: a real RouterProvider over memory history, rendering the
 * REAL AgentNotFound / AgentLoadError fallbacks.
 *
 *   - 403 AND 404 collapse to ONE ambiguous notFound (anti-enumeration).
 *   - 5xx and non-HttpError (network) rethrow to the errorComponent — NOT
 *     notFound — so only 403/404 are treated as "not available".
 *   - success warms ['agents', slug] into the shared cache (loader prefetch).
 *
 * Mock e2e always 404s an unknown slug and never returns a 403 or 5xx, so this
 * is the only place the collapse/rethrow invariants are pinned.
 *
 * `@tanstack/react-router` is globally stubbed in test/setup.ts (spreads the real
 * module, only swapping `useNavigate`), so createRouter/RouterProvider/etc. here
 * are the REAL implementations. `AppLink` (used by AgentNotFound) is globally
 * stubbed to a plain anchor there, so the fallback doesn't pull the singleton.
 */

const userStub = {
  user: null,
  isAuthenticated: false,
  isAdmin: false,
  isAuthMode: false,
  isPending: false,
  mustChangePassword: false,
  agentRole: () => null,
  agentMemberCount: () => 0,
  canAccessAgent: () => true,
  canUseAgent: () => true,
  canAdminAgent: () => true,
  rolesReady: true,
  signOut: async () => {},
} satisfies UserContextValue

// A fresh, NON-singleton tree (do NOT import index.tsx): root → app-shell layout
// (bare Outlet) → the REAL agentLayoutRoute + agentHomeRoute leaf. We reuse the
// real loader + notFoundComponent/errorComponent and only swap the heavy
// AgentShell COMPONENT for a stub so the test is a pure loader pin.
function buildRouter(initialPath: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  // Mirror the PRODUCTION root exactly (same RouterContext + lenient root search)
  // so the grafted real agentLayoutRoute.options.{loader,*Component} type-align —
  // the loader's generics are bound to a root with this context + search shape.
  const rootRoute = createRootRouteWithContext<RouterContext>()({
    validateSearch: lenient(rootSearchSchema),
    component: () => <Outlet />,
  })

  const appShellRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: 'app-shell',
    component: () => <Outlet />,
  })

  // Clone the real agent layout route so we keep its loader + fallbacks but render
  // a cheap stub agent component (the real AgentShell is irrelevant to this pin).
  const layout = createRoute({
    getParentRoute: () => appShellRoute,
    path: 'agents/$slug',
    params: { parse: (raw) => ({ slug: z.string().min(1).parse(raw.slug) }) },
    loader: agentLayoutRoute.options.loader,
    component: () => <div data-testid="agent-shell-stub">agent</div>,
    notFoundComponent: agentLayoutRoute.options.notFoundComponent,
    errorComponent: agentLayoutRoute.options.errorComponent,
  })

  // The layout stub renders no <Outlet/>, so this index leaf never actually
  // renders — it only needs to exist so '/agents/$slug' matches. A trivial stub
  // avoids grafting the real agent-home component across a different route tree
  // (its type is bound to the production root's context/search).
  const home = createRoute({
    getParentRoute: () => layout,
    path: '/',
    component: () => <div data-testid="agent-home-stub" />,
  })

  const routeTree = rootRoute.addChildren([appShellRoute.addChildren([layout.addChildren([home])])])

  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
    context: { queryClient, user: userStub },
    // Keep the pending component from flashing while the loader resolves so the
    // assertions race only the loader's terminal state.
    defaultPendingMs: 10_000,
  })
}

describe('agentLayoutRoute loader (access-control collapse + rethrow + cache warm)', () => {
  it('403 → ambiguous AgentNotFound (never AgentLoadError)', async () => {
    agentQueryFn.mockRejectedValueOnce(new HttpError(403))
    render(<RouterProvider router={buildRouter('/agents/forbidden')} />)

    expect(await screen.findByTestId('agent-not-found')).toBeInTheDocument()
    expect(screen.queryByTestId('agent-load-error')).toBeNull()
    expect(screen.queryByTestId('agent-shell-stub')).toBeNull()
  })

  it('404 → the SAME ambiguous AgentNotFound (collapse with 403)', async () => {
    agentQueryFn.mockRejectedValueOnce(new HttpError(404))
    render(<RouterProvider router={buildRouter('/agents/missing')} />)

    expect(await screen.findByTestId('agent-not-found')).toBeInTheDocument()
    expect(screen.queryByTestId('agent-load-error')).toBeNull()
  })

  it('500 → AgentLoadError (5xx rethrows, does NOT collapse to notFound)', async () => {
    agentQueryFn.mockRejectedValueOnce(new HttpError(500))
    render(<RouterProvider router={buildRouter('/agents/boom')} />)

    expect(await screen.findByTestId('agent-load-error')).toBeInTheDocument()
    expect(screen.queryByTestId('agent-not-found')).toBeNull()
  })

  it('plain Error (network) → STILL AgentLoadError (only 403/404 collapse)', async () => {
    agentQueryFn.mockRejectedValueOnce(new Error('network down'))
    render(<RouterProvider router={buildRouter('/agents/offline')} />)

    expect(await screen.findByTestId('agent-load-error')).toBeInTheDocument()
    expect(screen.queryByTestId('agent-not-found')).toBeNull()
  })

  it('success → agent renders (neither fallback) AND the loader warms the cache', async () => {
    agentQueryFn.mockResolvedValueOnce({ slug: 'ok', name: 'OK Agent' })
    const router = buildRouter('/agents/ok')
    render(<RouterProvider router={router} />)

    expect(await screen.findByTestId('agent-shell-stub')).toBeInTheDocument()
    expect(screen.queryByTestId('agent-not-found')).toBeNull()
    expect(screen.queryByTestId('agent-load-error')).toBeNull()
    // The loader's ensureQueryData populated the shared cache entry the component
    // would read (same key the real agentQuery uses).
    expect(router.options.context.queryClient.getQueryData(['agents', 'ok'])).toEqual({
      slug: 'ok',
      name: 'OK Agent',
    })
  })
})
