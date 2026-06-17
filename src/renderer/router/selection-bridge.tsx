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
 * R12: now runs on the INITIAL mount too (the R3–R11 skip is removed), so a
 * cold reload / deep link rehydrates the agent + sub-view FROM the URL — which
 * keeps the still-Selection-driven chrome (e.g. the agent-header sub-crumbs,
 * which read `view`) correct on a hard refresh instead of snapping to the
 * SelectionContext default (home).
 */
export function SelectionBridge() {
  const { setAgent, setView, clearSelection, selectedAgentSlug } = useSelection()

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
  const currentSlugRef = useRef(selectedAgentSlug)
  currentSlugRef.current = selectedAgentSlug
  // `null` on the very first run so the initial mount applies (R12); the dedup
  // guard below still collapses no-op re-renders (useRouterState emits a fresh
  // object each time).
  const lastKey = useRef<string | null>(null)

  useEffect(() => {
    if (key === lastKey.current) return
    lastKey.current = key

    const loc = decodeLocation(snapshotRef.current)
    if (loc.selectedAgentSlug === null) {
      // Global routes: '/' clears the agent; '/notifications' shows notifications.
      if (loc.view.kind === 'notifications') setView({ kind: 'notifications' })
      else clearSelection()
    } else if (loc.view.kind === 'home') {
      // Agent index (/agents/$slug). Sub-views are Selection-driven until they
      // become routes (R5+), so set the agent but PRESERVE the current sub-view
      // for the same agent — only reset to home when the URL switches agents.
      if (currentSlugRef.current !== loc.selectedAgentSlug) setAgent(loc.selectedAgentSlug)
    } else {
      // A real sub-view route (R5+): the URL fully specifies the view.
      setAgent(loc.selectedAgentSlug, loc.view)
    }
  }, [key, setAgent, setView, clearSelection])

  return null
}
