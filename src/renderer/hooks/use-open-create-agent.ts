import { useCallback } from 'react'
import { useRouter } from '@tanstack/react-router'
import { newAgentSearchSchema, type CreateAgentSurface } from '@renderer/router/search-schemas'

export interface OpenCreateAgentOptions {
  surface: CreateAgentSurface
  /** Where to start: the from-scratch steps (default) or the template roster. */
  start?: 'scratch' | 'templates'
  /**
   * The left-nav section to file the new agent into. Omitted (or the default
   * section) leaves it unfiled, the way the nav's own "New Agent" does.
   */
  folderId?: string
}

/**
 * Opens a create page — from scratch (`/new-agent`) or the template roster
 * (`/new-agent/templates`) — capturing where it was opened as the page's Back
 * target (`?from=`, as settings does). Nothing is created until the page
 * creates it.
 */
export function useOpenCreateAgent(): (options: OpenCreateAgentOptions) => void {
  const router = useRouter()
  return useCallback(
    ({ surface, folderId, start = 'scratch' }: OpenCreateAgentOptions) => {
      // Already on a create page (the menu command fired again): keep the
      // original Back target instead of nesting the page into its own.
      const { pathname, search, searchStr } = router.state.location
      const from = pathname.startsWith('/new-agent')
        ? newAgentSearchSchema.safeParse(search).data?.from
        : pathname + searchStr
      void router.navigate({
        to: start === 'templates' ? '/new-agent/templates' : '/new-agent',
        search: { from, section: folderId, surface },
      })
    },
    [router],
  )
}
