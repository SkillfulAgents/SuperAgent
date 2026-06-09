/**
 * The app's TanStack Query client + global error handling.
 *
 * Two cross-cutting concerns are handled once here instead of at every call site:
 *
 *  1. Reporting — EVERY mutation and (post-retry) query failure is reported to
 *     Sentry via the cache-level `onError`. This is the safety net that makes
 *     silent failures observable, regardless of whether the call site handles
 *     the error.
 *
 *  2. A default error toast for MUTATIONS — discrete, user-initiated actions
 *     (delete / save / create) should never fail silently. The global handler
 *     shows `toast.error` by default. Mutations that surface errors themselves
 *     (inline form errors, a custom toast) or are background/optimistic opt out
 *     with `meta: { skipGlobalErrorToast: true }` — they are still reported to
 *     Sentry. A mutation may override the toast text with `meta.errorMessage`.
 *
 * Queries are SILENT by default (they retry and usually render inline/empty
 * states); a query opts INTO a toast with `meta: { showErrorToast: true }`.
 */
import { QueryClient, QueryCache, MutationCache, CancelledError } from '@tanstack/react-query'
import type { MutationMeta, QueryMeta } from '@tanstack/react-query'
import { toast } from 'sonner'
import { captureRendererException } from './error-reporting'

// Type the meta fields the global handlers read. Augmenting `Register` makes
// `mutation.options.meta` / `query.meta` strongly typed everywhere.
declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: {
      /**
       * Skip the global default error toast. Use when the mutation surfaces the
       * error itself (inline form error / its own toast) or is background /
       * passive / fire-and-forget / optimistic. The error is still reported to
       * Sentry.
       */
      skipGlobalErrorToast?: boolean
      /** Override the global error toast text for this mutation. */
      errorMessage?: string
    }
    queryMeta: {
      /** Opt a query INTO a global error toast (queries are silent by default). */
      showErrorToast?: boolean
      /** Override the global error toast text for this query. */
      errorMessage?: string
    }
  }
}

const GENERIC_MESSAGE = 'Something went wrong. Please try again.'

/** Prefer a meaningful Error message (incl. server messages thrown by hooks); fall back to generic. */
function messageFromError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return GENERIC_MESSAGE
}

/** Exported for unit tests. Report to Sentry, then toast unless opted out. */
export function handleMutationError(error: unknown, meta?: MutationMeta): void {
  captureRendererException(error, { tags: { source: 'mutation' } })
  if (meta?.skipGlobalErrorToast) return
  toast.error(meta?.errorMessage ?? messageFromError(error))
}

/** Exported for unit tests. Report to Sentry; toast only if the query opted in. */
export function handleQueryError(error: unknown, meta?: QueryMeta): void {
  // A cancelled fetch (navigation / unmount / refetch supersede) is not a failure.
  if (error instanceof CancelledError) return
  captureRendererException(error, { tags: { source: 'query' } })
  if (meta?.showErrorToast) toast.error(meta.errorMessage ?? messageFromError(error))
}

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5 * 1000,
        refetchOnWindowFocus: false,
      },
    },
    mutationCache: new MutationCache({
      // v5 signature: (error, variables, onMutateResult, mutation, context)
      onError: (error, _variables, _onMutateResult, mutation) =>
        handleMutationError(error, mutation.options.meta),
    }),
    queryCache: new QueryCache({
      onError: (error, query) => handleQueryError(error, query.meta),
    }),
  })
}
