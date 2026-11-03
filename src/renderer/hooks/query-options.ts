import { queryOptions } from '@tanstack/react-query'
import { apiJson } from '@renderer/lib/api'
import type { ApiAgent } from '@shared/lib/types/api'

/**
 * Shared TanStack Query options consumed by route LOADERS.
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
 * Both the loader's `apiJson` and useAgent's queryFn throw `HttpError`, so a
 * 403/404 maps to `notFound()` even when the loader joins an observer's fetch.
 * Both queryFns hit the same endpoint and shape, so they coexist on one key.
 */
export const agentQuery = (slug: string) =>
  queryOptions({
    queryKey: ['agents', slug],
    queryFn: () => apiJson<ApiAgent>(`/api/agents/${slug}`),
    // Loader fetch: a 403/404 is definitive (don't retry → the route resolves to
    // notFound immediately); a transient 5xx surfaces on the errorComponent,
    // which offers a manual retry. The component's own useAgent observer keeps
    // transient retries for background refetches, but never retries 403/404.
    retry: false,
  })

export const sessionQuery = (agentSlug: string, id: string) =>
  queryOptions({
    queryKey: ['session', id, agentSlug],
    queryFn: () => apiJson(`/api/agents/${agentSlug}/sessions/${id}`),
  })
