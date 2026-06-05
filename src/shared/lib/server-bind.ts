import { serve } from '@hono/node-server'

export interface BoundServer {
  /** The bound HTTP server instance (as returned by `serve`). */
  server: ReturnType<typeof serve>
  /** The port the server actually bound to. */
  port: number
}

export interface BindServerOptions {
  /** First port to try. */
  startPort: number
  /** Interface to bind. Defaults to '0.0.0.0' (IPv4, matching the renderer). */
  hostname?: string
  /** How many sequential ports to try before giving up. Defaults to 10. */
  maxAttempts?: number
}

/**
 * Bind an HTTP server for a Hono `fetch` handler, advancing to the next port on
 * a port-in-use race and retrying atomically.
 *
 * Unlike a "probe for a free port, then bind" approach there is NO TOCTOU gap:
 * the real server claims the port, so nothing can steal it between the check and
 * the bind. An EADDRINUSE surfaces on the server's 'error' event (and triggers a
 * retry) rather than being re-thrown as an unhandled 'error' — which would
 * otherwise crash the process / escape to a global uncaughtException handler.
 * A non-EADDRINUSE error (e.g. EACCES) is surfaced as-is instead of being masked
 * as "port unavailable".
 *
 * Resolves with the surviving server and the port it actually bound to. The
 * caller is responsible for wiring `setupServerHandlers` on the returned server
 * and recording the port wherever it's consumed.
 */
export function bindServerWithRetry(
  fetch: Parameters<typeof serve>[0]['fetch'],
  { startPort, hostname = '0.0.0.0', maxAttempts = 10 }: BindServerOptions,
): Promise<BoundServer> {
  return new Promise<BoundServer>((resolve, reject) => {
    const attempt = (port: number, attemptsLeft: number) => {
      let settled = false

      // serve() creates the server and calls listen() synchronously, returning
      // the underlying http.Server. The EADDRINUSE 'error' fires asynchronously,
      // so attaching the listener right after serve() returns is in time.
      const server = serve({ fetch, port, hostname }, (info) => {
        if (settled) return
        settled = true
        server.off('error', onError)
        resolve({ server, port: info.port })
      })

      const onError = (error: NodeJS.ErrnoException) => {
        if (settled) return
        settled = true

        // Discard the failed instance before retrying so we never leak a
        // half-bound server.
        server.close()

        if (error.code === 'EADDRINUSE' && attemptsLeft > 1) {
          console.warn(`Port ${port} in use, trying ${port + 1}`)
          attempt(port + 1, attemptsLeft - 1)
          return
        }

        reject(error)
      }

      server.once('error', onError)
    }

    attempt(startPort, maxAttempts)
  })
}
