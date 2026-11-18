import type { InvalidateQueryFilters, QueryClient, QueryKey } from '@tanstack/react-query'

export interface InvalidationCoalescer {
  /** Queue an invalidation; it runs with the rest of the batch. `exact` leaves out the keys this one prefixes. */
  invalidate(queryKey: QueryKey, options?: { exact?: boolean }): void
  /** Run whatever is queued now and stop the timer. */
  flush(): void
}

/**
 * Collects query invalidations and runs them together once `delayMs` after the
 * first one is queued, each key once however often it was asked for. Bursty
 * event streams use it for refetches that only confirm an already-applied
 * local update: one refetch per burst instead of one per event.
 */
export function createInvalidationCoalescer(queryClient: QueryClient, delayMs: number): InvalidationCoalescer {
  const pending = new Map<string, InvalidateQueryFilters>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = null
    const batch = [...pending.values()]
    pending.clear()
    for (const filters of batch) void queryClient.invalidateQueries(filters)
  }

  return {
    invalidate(queryKey, options) {
      const exact = options?.exact === true
      pending.set(JSON.stringify([queryKey, exact]), exact ? { queryKey, exact } : { queryKey })
      if (!timer) timer = setTimeout(flush, delayMs)
    },
    flush,
  }
}
