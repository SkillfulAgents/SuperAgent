import { useCallback } from 'react'
import { useRouter } from '@tanstack/react-router'
import { newAgentSearchSchema, type CreateAgentSurface } from '@renderer/router/search-schemas'

export interface OpenCreateAgentOptions {
  surface: CreateAgentSurface
  /**
   * The left-nav section to file the new agent into. Omitted (or the default
   * section) leaves it unfiled, the way the nav's own "New Agent" does.
   */
  folderId?: string
}

/** All New Agent entry points preserve their opening location for Back and Close. */
export function useOpenCreateAgent(): (options: OpenCreateAgentOptions) => void {
  const router = useRouter()
  return useCallback(
    ({ surface, folderId }: OpenCreateAgentOptions) => {
      // Already on a create page (the menu command fired again): keep the
      // original Back target instead of nesting the page into its own.
      const { pathname, search, searchStr } = router.state.location
      const from = pathname.startsWith('/new-agent')
        ? newAgentSearchSchema.safeParse(search).data?.from
        : pathname + searchStr
      void router.navigate({
        to: '/new-agent',
        search: { from, section: folderId, surface },
      })
    },
    [router],
  )
}
