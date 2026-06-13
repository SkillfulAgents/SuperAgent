import type { MiddlewareHandler } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import { isAuthMode } from '@shared/lib/auth/mode'

const LOCALHOST_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * API path prefixes hit by the agent container, NOT a browser. These
 * authenticate via per-agent bearer tokens (IsAgent() / proxy token), so they
 * must bypass the localhost IP restriction below.
 *
 * Why the bypass is required (not just an optimization): the container reaches
 * the host across its runtime's network bridge, so the host server (bound to
 * 0.0.0.0) sees a NON-loopback source — e.g. WSL2's `172.x` NAT gateway or
 * Docker's bridge IP. Runtimes that SNAT host traffic to loopback (macOS Lima)
 * happen to pass the check, which is exactly why an omission here is invisible
 * on a dev's Mac yet 403s every cross-agent call on Windows/WSL2.
 *
 * Keep this in sync with the container-facing routers mounted in api/index.ts.
 */
const CONTAINER_FACING_PREFIXES = [
  '/api/proxy/',
  '/api/mcp-proxy/',
  '/api/x-agent/', // covers /api/x-agent and /api/x-agent/chat
  '/api/browser/',
]

/**
 * True when `path` is a container→host endpoint that authenticates via a
 * bearer token rather than the localhost IP restriction.
 */
export function isContainerFacingPath(path: string): boolean {
  return CONTAINER_FACING_PREFIXES.some((prefix) => path.startsWith(prefix))
}

export function LocalModeAuth(): MiddlewareHandler {
  return async (c, next) => {
    if (isAuthMode()) return next()

    // Only restrict to localhost in Electron — Docker/web deployments
    // handle network security at the infrastructure level.
    if (process.type !== 'browser') return next()

    const addr = getConnInfo(c).remote.address
    if (!addr || !LOCALHOST_ADDRS.has(addr)) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    return next()
  }
}
