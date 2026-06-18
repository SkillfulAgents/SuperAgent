import { queryOptions } from '@tanstack/react-query'
import { apiJson } from '@renderer/lib/api'

/**
 * Shared TanStack Query options consumed by route LOADERS (migration plan §9.2).
 *
 * The query keys MUST match the existing data hooks so the loader's prefetch and
 * the component's `useQuery` resolve to the SAME cache entry — the loader warms
 * the cache, the hook reads it, no double fetch:
 *   - agent:   `['agents', slug]`            (use-agents.ts `useAgent`)
 *   - session: `['session', id, agentSlug]`  (use-sessions.ts `useSession`)
 *
 * The loader uses `apiJson` (throws `HttpError`) rather than the hooks' own
 * `apiFetch` queryFn so a 403/404 surfaces as a throw the loader can map to
 * `notFound()`. Both queryFns hit the same endpoint and shape, so they coexist
 * on one key.
 */
export const agentQuery = (slug: string) =>
  queryOptions({
    queryKey: ['agents', slug],
    queryFn: () => apiJson(`/api/agents/${slug}`),
    // Loader fetch: a 403/404 is definitive (don't retry → the route resolves to
    // notFound immediately); a transient 5xx surfaces on the errorComponent,
    // which offers a manual retry. The component's own useAgent observer keeps
    // the default retry for background refetches.
    retry: false,
  })

export const sessionQuery = (agentSlug: string, id: string) =>
  queryOptions({
    queryKey: ['session', id, agentSlug],
    queryFn: () => apiJson(`/api/agents/${agentSlug}/sessions/${id}`),
  })
