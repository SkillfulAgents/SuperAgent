import type { APIResponse, Route } from '@playwright/test'

/** Surface intercepted API failures to both Playwright and standalone harnesses. */
export function createResponseGuard(options: { allowedStatuses?: readonly number[] } = {}) {
  let reportFailure!: (error: Error) => void
  // Resolve with the error: a route may fail before run() attaches its race.
  const failure = new Promise<Error>(resolve => { reportFailure = resolve })
  const pending = new Set<Promise<void>>()
  const track = (task: Promise<void>) => {
    pending.add(task)
    void task.then(() => pending.delete(task), cause => {
      pending.delete(task)
      reportFailure(cause instanceof Error ? cause : new Error(String(cause)))
    })
    return task
  }
  return {
    intercept: (inspect: (route: Route, response: APIResponse) => Promise<void>) => (route: Route) => track((async () => {
      let response: APIResponse | undefined
      try {
        response = await route.fetch()
        if (!response.ok() && !options.allowedStatuses?.includes(response.status())) throw new Error('Expected a successful API response')
        await inspect(route, response)
      } catch (cause) {
        const request = route.request()
        const detail = cause instanceof Error ? cause.message : String(cause)
        const status = response ? `HTTP ${response.status()}, ${response.headers()['content-type'] ?? 'no content-type'}` : 'fetch failed'
        const error = new Error(`Intercepted ${request.method()} ${request.url()} (${status}): ${detail}`, { cause })
        reportFailure(error)
        try {
          // Preserve an upstream error body for the app; a failed fetch has no
          // response to forward. Neither path leaves the intercepted request open.
          if (response) await route.fulfill({ response })
          else await route.abort('failed')
        } catch (settlementError) {
          // Closing the page after the reported failure may win this race. Keep
          // that detail on the original failure, without an unhandled rejection.
          error.message += `; request settlement failed: ${String(settlementError)}`
        }
      }
    })()),
    run: <T>(operation: () => Promise<T>): Promise<T> => Promise.race([
      failure.then(error => { throw error }),
      Promise.resolve().then(async () => {
        const result = await operation()
        // An operation can finish its UI assertions before an intercepted fetch
        // responds. Drain every started handler before accepting that success.
        while (pending.size) await Promise.all([...pending])
        return result
      }),
    ]),
  }
}
