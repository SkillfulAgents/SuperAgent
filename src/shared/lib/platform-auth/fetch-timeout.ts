// Upper bound for an upstream teardown call. Mints stay unbounded: a client-side
// abort after the proxy has committed the subscription would create an orphan.
export const UPSTREAM_DELETE_TIMEOUT_MS = 15_000

export function upstreamDeleteSignal(): AbortSignal {
  return AbortSignal.timeout(UPSTREAM_DELETE_TIMEOUT_MS)
}
