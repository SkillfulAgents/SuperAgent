// Upper bound for a single management call to the proxy (trigger/endpoint CRUD).
export const PLATFORM_FETCH_TIMEOUT_MS = 15_000

/** Caller-supplied signal wins; otherwise bound the request so a hung proxy can't stall the caller. */
export function platformFetchSignal(options: Pick<RequestInit, 'signal'>): AbortSignal {
  return options.signal ?? AbortSignal.timeout(PLATFORM_FETCH_TIMEOUT_MS)
}
