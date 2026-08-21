import { AsyncLocalStorage } from 'node:async_hooks'

const userContext = new AsyncLocalStorage<{ userId: string }>()

// Lazy: stores userId; memberId / token are resolved at attribution.current() time.
export function runWithRequestUser<T>(userId: string, fn: () => Promise<T> | T): Promise<T> | T {
  return userContext.run({ userId }, fn)
}

// Same as runWithRequestUser, but a null/undefined userId is a no-op scope.
export function runWithOptionalUser<T>(
  userId: string | null | undefined,
  fn: () => Promise<T> | T,
): Promise<T> | T {
  return userId ? userContext.run({ userId }, fn) : fn()
}

export function getRequestUserId(): string | undefined {
  return userContext.getStore()?.userId
}
