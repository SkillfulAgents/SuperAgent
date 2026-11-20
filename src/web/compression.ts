import type { Hono } from 'hono'
import { compress } from 'hono/compress'
import { isContainerFacingPath } from '../api/middleware/local-mode-auth'

/**
 * A dashboard's own server, relayed from its container
 * (`/api/agents/:id/artifacts/:slug/*`, `proxyArtifactRequest`). What it sends
 * is the dashboard's business and can be a live stream of any type.
 */
const DASHBOARD_PROXY_PATH = /^\/api\/agents\/[^/]+\/artifacts\/[^/]+(?:\/|$)/

/**
 * Paths whose bodies are relayed from somewhere else as they arrive: the
 * endpoints an agent container calls (the LLM, API and MCP proxies, the
 * volumes it mounts) and a dashboard's own server. Hono's `compress` pipes a
 * body through a `CompressionStream`, which holds what it is given until it has
 * a block's worth, so a live body sent through it reaches the client late.
 * These routes run outside it. SSE needs no entry here: `compress` leaves
 * `text/event-stream` alone by its type.
 */
export function isRelayedPath(path: string): boolean {
  return isContainerFacingPath(path) || DASHBOARD_PROXY_PATH.test(path)
}

/**
 * gzip for the Node web server (`src/web/server.ts`), the one entry point whose
 * responses cross a real network with nothing in front of them that
 * compresses. Not the API app itself: the desktop app serves that over
 * loopback, where the CPU buys nothing, and Cloudflare compresses at its edge.
 * Call it before mounting the API and the web build.
 */
export function mountCompression(app: Hono): void {
  const compressed = compress()
  app.use('*', (c, next) => (isRelayedPath(c.req.path) ? next() : compressed(c, next)))
}
