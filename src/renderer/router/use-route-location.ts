import { useRouterState } from '@tanstack/react-router'
import { decodeLocation, type AppLocation, type RouteSnapshot } from './route-state'

/**
 * The current navigation state (`{ selectedAgentSlug, view }`) DERIVED from the
 * router — the read-side replacement for `useSelection()` (R14). Params/search
 * are merged across every match so the leaf sees ancestor params (the agent
 * `slug`), then `decodeLocation` maps the deepest match to an `AppLocation`.
 *
 * This is the pull version of what the R3–R13 `SelectionBridge` pushed into
 * `SelectionContext`: with every view now a real route, the URL IS the source of
 * truth, so consumers read straight from it instead of a mirrored context. The
 * selector only re-runs on a router state change (i.e. navigation), which is
 * exactly when a view-derived consumer needs to re-render.
 */
export function useRouteLocation(): AppLocation {
  return useRouterState({
    select: (state): AppLocation => {
      const params: Record<string, string | undefined> = {}
      const search: Record<string, unknown> = {}
      for (const m of state.matches) {
        Object.assign(params, m.params)
        Object.assign(search, m.search)
      }
      const deepest = state.matches[state.matches.length - 1]
      const snapshot: RouteSnapshot = { to: deepest?.fullPath ?? '/', params, search }
      return decodeLocation(snapshot)
    },
  })
}
