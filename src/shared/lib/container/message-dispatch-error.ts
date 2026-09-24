/** Raised only where the host knows no runtime input was accepted. Do not infer
 * this from arbitrary HTTP 5xx bodies or a lost/timeout response. */
export class MessageNotAcceptedError extends Error {
  constructor(readonly reason: 'session-gone' | 'unavailable' | 'rejected', message: string, options?: ErrorOptions) { super(message, options) }
}

/** A refused connection/DNS failure cannot have delivered the HTTP request.
 * A reset, read timeout, or arbitrary error message supplies no such evidence. */
export function requestWasNotDispatched(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || typeof error !== 'object' || seen.has(error)) return false
  seen.add(error)
  const code = Reflect.get(error, 'code')
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) return true
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every(item => requestWasNotDispatched(item, seen))
  return requestWasNotDispatched(Reflect.get(error, 'cause'), seen)
}
