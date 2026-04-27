import { AsyncLocalStorage } from 'node:async_hooks'

interface RequestContext {
  userId: string
}

const requestContext = new AsyncLocalStorage<RequestContext>()

export function runWithRequestUser<T>(
  userId: string,
  fn: () => Promise<T> | T,
): Promise<T> | T {
  return requestContext.run({ userId }, fn)
}

export function getCurrentRequestUserId(): string | null {
  return requestContext.getStore()?.userId ?? null
}
