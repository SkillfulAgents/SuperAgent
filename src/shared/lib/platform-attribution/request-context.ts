import { AsyncLocalStorage } from 'node:async_hooks'

import type { Attribution } from './index'

interface RequestScope {
  userId: string
  /**
   * The platform attribution resolved for this scope, shared by every
   * platform call made in it (see `attribution.current`) while the request or
   * run that opened the scope is in progress; a platform-auth write in the
   * scope drops it.
   */
  attribution?: Promise<Attribution | null>
  /**
   * Set when the function that opened the scope has settled. Work it started
   * that is still running (fire-and-forget, a stream listener registered in
   * the request) keeps the request user but no longer shares the memo: it
   * resolves its attribution afresh, as it did before the memo existed.
   */
  ended?: boolean
}

const userContext = new AsyncLocalStorage<RequestScope>()

function runInScope<T>(userId: string, fn: () => Promise<T> | T): Promise<T> | T {
  const scope: RequestScope = { userId }
  const end = () => {
    scope.ended = true
    scope.attribution = undefined
  }
  return userContext.run(scope, () => {
    let result: Promise<T> | T
    try {
      result = fn()
    } catch (error) {
      end()
      throw error
    }
    if (result instanceof Promise) return result.finally(end)
    end()
    return result
  })
}

// Lazy: stores userId; memberId / token are resolved at attribution.current() time.
export function runWithRequestUser<T>(userId: string, fn: () => Promise<T> | T): Promise<T> | T {
  return runInScope(userId, fn)
}

// Same as runWithRequestUser, but a null/undefined userId is a no-op scope.
export function runWithOptionalUser<T>(
  userId: string | null | undefined,
  fn: () => Promise<T> | T,
): Promise<T> | T {
  return userId ? runInScope(userId, fn) : fn()
}

export function getRequestUserId(): string | undefined {
  return userContext.getStore()?.userId
}

// fn, and everything it schedules, runs with no request user.
export function runOutsideRequestUser<T>(fn: () => T): T {
  return userContext.exit(fn)
}

/**
 * The attribution of the current request scope, resolved by `resolve` the
 * first time it is asked for and shared by every later (or concurrent) call in
 * the same scope; null outside a request scope. A resolution that fails is not
 * kept, so the next call in the scope tries again. Never shared across scopes:
 * the next request, task run or sync resolves again.
 */
export function requestScopedAttribution(
  resolve: (userId: string) => Promise<Attribution | null>,
): Promise<Attribution | null> {
  const scope = userContext.getStore()
  if (!scope) return Promise.resolve(null)
  // The request or run is over: whatever it left running resolves afresh.
  if (scope.ended) return resolve(scope.userId)
  if (!scope.attribution) {
    const resolving: Promise<Attribution | null> = resolve(scope.userId).catch((error: unknown) => {
      if (scope.attribution === resolving) scope.attribution = undefined
      throw error
    })
    scope.attribution = resolving
  }
  return scope.attribution
}

/**
 * Drop the current scope's resolved attribution: the platform connection was
 * saved, changed or removed in this request, so the next platform call in it
 * resolves against the new one.
 */
export function forgetRequestScopedAttribution(): void {
  const scope = userContext.getStore()
  if (scope) scope.attribution = undefined
}
