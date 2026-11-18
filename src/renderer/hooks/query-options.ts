import { queryOptions } from '@tanstack/react-query'
import { apiJson } from '@renderer/lib/api'
import type { ApiAgent } from '@shared/lib/types/api'

/**
 * Shared TanStack Query options consumed by route loaders and data hooks.
 *
 * The query keys MUST match the existing data hooks so the loader's prefetch and
 * the component's `useQuery` resolve to the SAME cache entry — the loader warms
 * the cache, the hook reads it, no double fetch:
 *   - agent:   `['agents', slug]`            (use-agents.ts `useAgent`)
 *   - session: `['session', id, agentSlug]`  (use-sessions.ts `useSession`)
 *
 * NOTE: `useSession` resolves `agentSlug` to the canonical agent id before keying
 * (a display slug and the bare id must share one entry). `sessionQuery` below is
 * currently unused by any loader; a future session loader must resolve the slug
 * the same way (via the cached agents list) to land on `useSession`'s entry.
 *
 * `useAgent` uses this same queryFn, so a 403/404 maps to `notFound()` even
 * when the loader joins the hook's already-running request.
 */
export const agentQuery = (slug: string) =>
  queryOptions({
    queryKey: ['agents', slug],
    queryFn: async ({ client }) => {
      const agent = await apiJson<ApiAgent>(`/api/agents/${slug}`)
      // The route loader reads the agent by its display slug and the shell by its
      // id: fill the other key when it is empty, so one read serves both.
      for (const alias of [agent.slug, agent.displaySlug]) {
        if (alias && alias !== slug && client.getQueryData(['agents', alias]) === undefined) {
          client.setQueryData(['agents', alias], agent)
        }
      }
      return agent
    },
    // Loader fetch: a 403/404 is definitive (don't retry → the route resolves to
    // notFound immediately); a transient 5xx surfaces on the errorComponent,
    // which offers a manual retry. The component's own useAgent observer keeps
    // transient retries for background refetches, but not definitive 4xx errors.
    retry: false,
  })

export const sessionQuery = (agentSlug: string, id: string) =>
  queryOptions({
    queryKey: ['session', id, agentSlug],
    queryFn: () => apiJson(`/api/agents/${agentSlug}/sessions/${id}`),
  })
