// @vitest-environment jsdom
//
// Pins what a navigation costs the sidebar: the agent rows, their menus and
// their dialogs are the real components, over a real router and a real
// `['agents']` cache. Only what the rows merely decorate themselves with is
// stubbed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { forwardRef, type ReactNode } from 'react'
import { _setRenderTracker } from '@renderer/lib/perf'

// The shared setup stubs these two for tests without a router; this one has one.
vi.mock('@renderer/router/use-route-agent', async (importOriginal) => importOriginal())
vi.mock('@renderer/router/use-route-location', async (importOriginal) => importOriginal())

const { renders } = vi.hoisted(() => ({
  renders: { menu: 0, dialog: 0 },
}))

vi.mock('@renderer/lib/api', () => ({
  apiFetch: vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) })),
}))

vi.mock('@renderer/hooks/use-agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/hooks/use-agents')>()),
  useStartAgent: () => ({ mutate: vi.fn() }),
  useUpdateAgent: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteAgent: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))
vi.mock('@renderer/hooks/use-sessions', () => ({
  useSessions: () => ({ data: undefined, isLoading: false }),
  useRecentSessions: (slug: string | null) => ({
    data: slug ? [{ id: `${slug}-s1`, agentSlug: slug, name: 'Session 1' }, { id: `${slug}-s2`, agentSlug: slug, name: 'Session 2' }] : undefined,
    isLoading: false,
  }),
  useSessionTotal: (slug: string | null) => (slug ? 2 : undefined),
  recentSessionsQueryOptions: (_queryClient: unknown, slug: string) => ({
    queryKey: ['sessions', slug, 'recent', 6],
    queryFn: () => Promise.resolve([]),
  }),
}))
vi.mock('@renderer/hooks/use-artifacts', () => ({ useArtifacts: () => ({ data: [] }) }))
vi.mock('@renderer/hooks/use-message-stream', () => ({ useMessageStream: () => ({ isStreaming: false }) }))
vi.mock('@renderer/hooks/use-settings', () => ({
  useSettings: () => ({ data: undefined }),
  useModelSettings: () => ({ data: undefined }),
  useWarmStartOnTypeEnabled: () => false,
}))
vi.mock('@renderer/hooks/use-user-settings', () => ({
  useUserSettings: () => ({ data: { agentFolders: [], agentFolderAssignments: {} } }),
  useUpdateUserSettings: () => ({ mutate: vi.fn() }),
}))
vi.mock('@renderer/hooks/use-runtime-status', () => ({
  useRuntimeStatus: () => ({ data: { runtimeReadiness: { status: 'READY' } } }),
}))
vi.mock('@renderer/context/user-context', () => {
  const user = {
    isAuthMode: false,
    agentMemberCount: () => 1,
    canUseAgent: () => true,
    canAdminAgent: () => true,
  }
  return { useUser: () => user }
})
vi.mock('@renderer/context/nav-transient-context', () => {
  const value = { pendingAgentHomeAction: null, setPendingAgentHomeAction: vi.fn() }
  return { useNavTransient: () => value }
})
vi.mock('./use-sidebar-file-drop', () => ({ useSidebarFileDrop: () => ({}) }))
vi.mock('@renderer/components/sessions/session-context-menu', () => ({
  SessionContextMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('@renderer/components/agents/agent-avatar/agent-avatar', () => ({ AgentAvatar: () => null }))
vi.mock('@renderer/components/ui/sidebar', () => {
  const li = forwardRef<HTMLLIElement, { children?: ReactNode }>(function Li({ children }, ref) {
    return <li ref={ref}>{children}</li>
  })
  const slot = ({ children }: { children?: ReactNode }) => <>{children}</>
  return {
    Sidebar: slot, SidebarContent: slot, SidebarFooter: slot, SidebarGroup: slot, SidebarGroupContent: slot,
    SidebarHeader: slot, SidebarMenu: slot, SidebarMenuSkeleton: () => null, SidebarRail: () => null,
    SidebarMenuItem: li,
    SidebarMenuSubItem: li,
    SidebarMenuSub: ({ children }: { children?: ReactNode }) => <ul>{children}</ul>,
    // The row's highlight, as the real button reports it.
    SidebarMenuButton: ({ children, isActive }: { children?: ReactNode; isActive?: boolean }) => (
      <div data-testid="agent-row" data-active={isActive ? 'true' : 'false'}>{children}</div>
    ),
    SidebarMenuSubButton: ({ children, isActive }: { children?: ReactNode; isActive?: boolean }) => (
      <div data-testid="session-row" data-active={isActive ? 'true' : 'false'}>{children}</div>
    ),
    useSidebar: () => ({ setOpenMobile: vi.fn() }),
  }
})
vi.mock('@renderer/components/ui/collapsible', () => ({
  Collapsible: ({ children, open }: { children?: ReactNode; open?: boolean }) => <div data-open={open}>{children}</div>,
  CollapsibleContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))
// The menu's root renders once per render of AgentContextMenu, and a dialog's
// root once per render of a mounted dialog, open or closed.
vi.mock('@renderer/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children?: ReactNode }) => {
    renders.menu++
    return <>{children}</>
  },
  ContextMenuTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  ContextMenuContent: () => null,
  ContextMenuItem: () => null,
  ContextMenuSeparator: () => null,
  ContextMenuSub: () => null,
  ContextMenuSubContent: () => null,
  ContextMenuSubTrigger: () => null,
  ContextMenuMoreButton: () => null,
}))
vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: () => {
    renders.dialog++
    return null
  },
  DialogContent: () => null, DialogDescription: () => null, DialogFooter: () => null,
  DialogHeader: () => null, DialogTitle: () => null,
}))
vi.mock('@renderer/components/ui/alert-dialog', () => ({
  AlertDialog: () => {
    renders.dialog++
    return null
  },
  AlertDialogAction: () => null, AlertDialogCancel: () => null, AlertDialogClose: () => null,
  AlertDialogContent: () => null, AlertDialogDescription: () => null, AlertDialogFooter: () => null,
  AlertDialogHeader: () => null, AlertDialogTitle: () => null,
}))

import { AgentMenuItem } from './app-sidebar'

const ROWS = 30
// A changed row renders a few times (the highlight, then opening, then its
// sessions); what matters is that the count does not grow with ROWS.
const ONE_ROW = 3

// Ids in the host's minted shape, behind a display slug as the URL carries it.
const AGENTS = Array.from({ length: ROWS }, (_, i) => {
  const slug = `agent${String(i).padStart(5, '0')}`
  return {
    slug,
    displaySlug: `helper-${i}-${slug}`,
    name: `Helper ${i}`,
    status: 'running',
    sessionCount: 2,
    dashboards: [],
    createdAt: new Date(0),
  }
})

let rowRenders = 0

function resetCounts() {
  rowRenders = 0
  renders.menu = 0
  renders.dialog = 0
}

async function mountSidebarRows() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queryClient.setQueryData(['agents'], AGENTS)

  const rootRoute = createRootRoute({
    component: () => (
      <>
        <ul>
          {AGENTS.map((agent) => (
            <AgentMenuItem key={agent.slug} agent={agent as never} />
          ))}
        </ul>
        <Outlet />
      </>
    ),
  })
  const agentRoute = createRoute({ getParentRoute: () => rootRoute, path: '/agents/$slug' })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: '/' }),
      agentRoute.addChildren([
        createRoute({ getParentRoute: () => agentRoute, path: '/' }),
        createRoute({ getParentRoute: () => agentRoute, path: '/sessions/$sessionId' }),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })

  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  )
  await screen.findAllByTestId('agent-row')

  const go = async (to: string) => {
    resetCounts()
    act(() => {
      void router.navigate({ to } as never)
    })
    await waitFor(() => {
      expect(router.state.status).toBe('idle')
      expect(router.state.location.pathname).toBe(to)
    })
    // Let anything the navigation scheduled (effects, transitions) land.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    if (process.env.LOG_RENDERS) console.log('COUNTS', to, JSON.stringify({ rowRenders, ...renders }))
  }
  return { go }
}

function activeAgentRows() {
  return screen.getAllByTestId('agent-row').filter((row) => row.dataset.active === 'true')
}

beforeEach(() => {
  _setRenderTracker((name) => {
    if (name === 'AgentMenuItem') rowRenders++
  })
})

afterEach(() => {
  cleanup()
  _setRenderTracker(() => {})
})

describe('sidebar rows on navigation', () => {
  it('mounts no dialog for a row whose dialogs were never opened', async () => {
    resetCounts()
    await mountSidebarRows()
    expect(rowRenders).toBeGreaterThanOrEqual(ROWS)
    expect(renders.dialog).toBe(0)
  })

  it('re-renders only the rows a navigation leaves and enters, not every row', async () => {
    const { go } = await mountSidebarRows()
    const [a, b] = [AGENTS[3], AGENTS[17]]

    // Home → agent A: one row gains the highlight.
    await go(`/agents/${a.displaySlug}`)
    expect(activeAgentRows()).toHaveLength(1)
    expect(rowRenders).toBeLessThanOrEqual(ONE_ROW)
    expect(renders.menu).toBeLessThanOrEqual(ONE_ROW)

    // Agent A → agent B: two rows change.
    await go(`/agents/${b.displaySlug}`)
    expect(activeAgentRows()).toHaveLength(1)
    expect(rowRenders).toBeLessThanOrEqual(2 * ONE_ROW)
    expect(renders.menu).toBeLessThanOrEqual(2 * ONE_ROW)
    expect(renders.dialog).toBe(0)

    // Agent B home → one of its sessions: B's row opens, nothing else moves.
    await go(`/agents/${b.displaySlug}/sessions/${b.slug}-s1`)
    expect(rowRenders).toBeLessThanOrEqual(ONE_ROW)
    expect(screen.getAllByTestId('session-row').filter((row) => row.dataset.active === 'true')).toHaveLength(1)

    // Session → session inside B: no agent row changes at all.
    await go(`/agents/${b.displaySlug}/sessions/${b.slug}-s2`)
    expect(rowRenders).toBe(0)
    expect(renders.menu).toBe(0)
    expect(screen.getAllByTestId('session-row').filter((row) => row.dataset.active === 'true')).toHaveLength(1)

    // Back to Home: the one selected row lets go.
    await go('/')
    expect(activeAgentRows()).toHaveLength(0)
    expect(rowRenders).toBeLessThanOrEqual(ONE_ROW)
  })

  it('keeps a row selected through a stale display slug, as the route resolver does', async () => {
    const { go } = await mountSidebarRows()
    await go(`/agents/untitled-${AGENTS[5].slug}`)
    expect(activeAgentRows()).toHaveLength(1)
    await go(`/agents/${AGENTS[5].slug}`)
    expect(activeAgentRows()).toHaveLength(1)
  })
})
