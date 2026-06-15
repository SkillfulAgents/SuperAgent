import { useEffect, useRef } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { useSelection } from '@renderer/context/selection-context'
import { decodeLocation, type RouteSnapshot } from './route-state'

/**
 * UNIDIRECTIONAL bridge: URL → SelectionContext, NEVER the reverse (a
 * bidirectional shim would fight a migrated route — migration plan §12.1).
 *
 * Mirrors the matched route into the existing SelectionContext so the legacy
 * MainContent/SelectionContext switch keeps rendering while the router owns the
 * URL. During R3 it is effectively dormant (no `<AppLink>`/`navigate` yet
 * changes the URL); it goes live as views convert in R5+. Deleted wholesale at
 * R14 once the router is the sole source of truth.
 *
 * Skips the initial mount so a fresh load / reload does NOT override the
 * SelectionContext default (home) — keeping R3 behavior-neutral on the reload
 * contract. Deep-link restore is deferred to R12.
 */
export function SelectionBridge() {
  const { setAgent, setView } = useSelection()

  // Deepest matched route → snapshot for decodeLocation. Params/search are
  // merged across all matches so the leaf sees ancestor params (slug) too,
  // regardless of whether a match's `params` is cumulative or own-only.
  const snapshot = useRouterState({
    select: (state): RouteSnapshot => {
      const matches = state.matches
      const params: Record<string, string | undefined> = {}
      const search: Record<string, unknown> = {}
      for (const m of matches) {
        Object.assign(params, m.params)
        Object.assign(search, m.search)
      }
      const deepest = matches[matches.length - 1]
      return { to: deepest?.fullPath ?? '/', params, search }
    },
  })

  // Stable string key gates the effect (useRouterState returns a fresh object
  // each change); the ref carries the live snapshot into the effect closure.
  const key = `${snapshot.to}|${JSON.stringify(snapshot.params)}|${JSON.stringify(snapshot.search)}`
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const lastKey = useRef<string | null>(null)

  useEffect(() => {
    if (lastKey.current === null) {
      lastKey.current = key // skip the initial mount (behavior-neutral reload)
      return
    }
    if (key === lastKey.current) return
    lastKey.current = key

    const loc = decodeLocation(snapshotRef.current)
    if (loc.selectedAgentSlug === null) {
      setView(loc.view) // global views (home / notifications)
    } else {
      setAgent(loc.selectedAgentSlug, loc.view)
    }
  }, [key, setAgent, setView])

  return null
}
