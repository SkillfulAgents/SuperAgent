import { useRouterState } from '@tanstack/react-router'
import { decodeLocation, routeSnapshot, type AppLocation } from './route-state'

/**
 * The current navigation state (`{ selectedAgentSlug, view }`) DERIVED from the
 * router. Params/search are merged across every match so the leaf sees ancestor
 * params (the agent `slug`), then `decodeLocation` maps the deepest match to an
 * `AppLocation`.
 *
 * The URL is the source of truth for navigation, so consumers read straight from
 * it rather than from a mirrored context. The selector only re-runs on a router
 * state change (i.e. navigation), which is exactly when a view-derived consumer
 * needs to re-render.
 */
export function useRouteLocation(): AppLocation {
  return useRouterState({
    // Dedupe the selector output by structure so consumers only re-render on a
    // real view change, not on every router-store tick during a loader's
    // pending/loading transitions. AppLocation is JSON-compatible, satisfying
    // the structural-sharing constraint.
    structuralSharing: true,
    select: (state): AppLocation => decodeLocation(routeSnapshot(state.matches)),
  })
}
