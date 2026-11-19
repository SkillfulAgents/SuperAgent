import { useRouterState } from '@tanstack/react-router'
import { useResolvedAgentId, type ApiAgent } from '@renderer/hooks/use-agents'
import { decodeLocation, routeSnapshot, type AgentView } from './route-state'

type RouteAgent = Pick<ApiAgent, 'slug' | 'displaySlug'>

/**
 * Whether a route `:slug` could name this agent: its id, its display slug, or
 * a stale display slug ending in its id. Deliberately loose, as it only decides
 * whether a subscriber hears about the route at all; `useResolvedAgentId` then
 * gives the same answer `useRouteAgentId` would.
 */
function mayNameAgent(routeSlug: string | undefined, agent: RouteAgent): routeSlug is string {
  return (
    !!routeSlug &&
    (routeSlug === agent.slug || routeSlug === agent.displaySlug || routeSlug.endsWith(`-${agent.slug}`))
  )
}

/** The views that live under an agent's sidebar row. */
const SUB_ITEM_KINDS: ReadonlySet<AgentView['kind']> = new Set([
  'session',
  'task',
  'webhook',
  'chat',
  'dashboard',
  'completedTasks',
])

const OFF_ROUTE = { routeSlug: null, onSubItem: false } as const

/**
 * What one agent's sidebar row needs from the URL: whether the route is on this
 * agent, and whether it is on one of the agent's sub-items.
 *
 * `useRouteAgentId()` answers the first by handing every caller the route's
 * agent id, which changes on each agent switch (and its unselected `useParams`
 * on each param change), so every row re-rendered on every navigation. Here
 * the selection is made inside the router subscription and comes out the same
 * for every agent the route does not name, so a navigation re-renders only the
 * row it leaves and the row it enters.
 */
export function useRouteAgentRow(agent: RouteAgent): { isSelected: boolean; isViewingSubItem: boolean } {
  const { routeSlug, onSubItem } = useRouterState({
    // The result is a small JSON value: structural sharing keeps its identity
    // while it is unchanged, which is what the subscription compares.
    structuralSharing: true,
    select: (state): { routeSlug: string | null; onSubItem: boolean } => {
      const snapshot = routeSnapshot(state.matches)
      const slug = snapshot.params.slug
      if (!mayNameAgent(slug, agent)) return OFF_ROUTE
      return { routeSlug: slug, onSubItem: SUB_ITEM_KINDS.has(decodeLocation(snapshot).view.kind) }
    },
  })
  const isSelected = useResolvedAgentId(routeSlug ?? undefined) === agent.slug
  return { isSelected, isViewingSubItem: isSelected && onSubItem }
}

/** Whether the route is on this agent. See {@link useRouteAgentRow}. */
export function useIsRouteAgent(agent: RouteAgent): boolean {
  const routeSlug = useRouterState({
    select: (state) => {
      const slug = routeSnapshot(state.matches).params.slug
      return mayNameAgent(slug, agent) ? slug : undefined
    },
  })
  return useResolvedAgentId(routeSlug) === agent.slug
}
