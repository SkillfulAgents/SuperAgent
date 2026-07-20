import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { existsSync } from 'fs'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import api from '../api'
import { shutdownServices, setupServerHandlers } from '@shared/lib/startup'
import { bindServerWithRetry, type BoundServer } from '@shared/lib/server-bind'
const app = new Hono()

// Mount API routes
app.route('/', api)

// Cache policy for the static web build. Vite emits content-hashed JS/CSS into
// `/assets/*`, so the filename itself changes whenever the bytes change — those
// can be cached permanently and a new deploy is picked up automatically (new
// URLs, nothing to invalidate). `index.html` is the un-hashed entry that points
// at the hashed bundles, so it must always be revalidated or clients pin to a
// stale build. Stable-named `public/` assets (icons, manifest) have no hash to
// bust them, so they revalidate too rather than caching forever.
function staticCacheControl(filePath: string): string {
  const p = filePath.replace(/\\/g, '/')
  if (p.includes('/assets/')) return 'public, max-age=31536000, immutable'
  if (p.endsWith('index.html')) return 'no-cache'
  return 'public, max-age=3600, must-revalidate'
}

// Only serve static files in production (when dist/renderer exists)
// In development, Vite dev server handles the frontend
if (existsSync('./dist/renderer')) {
  app.use(
    '/*',
    serveStatic({
      root: './dist/renderer',
      onFound: (filePath, c) => c.header('Cache-Control', staticCacheControl(filePath)),
    }),
  )
  // SPA fallback: any unmatched route serves the HTML entry, which must never be
  // cached so a reload always discovers the latest hashed bundles.
  app.get(
    '*',
    serveStatic({
      path: './dist/renderer/index.html',
      onFound: (_filePath, c) => c.header('Cache-Control', 'no-cache'),
    }),
  )
}

let server: BoundServer['server']

// Graceful shutdown handling
let isShuttingDown = false

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return
  isShuttingDown = true

  console.log(`\nReceived ${signal}, shutting down gracefully...`)

  // Stop all background services and containers
  try {
    await shutdownServices()
    console.log('All services stopped.')
  } catch (error) {
    console.error('Error stopping services:', error)
  }

  // Close the server
  server?.close(() => {
    console.log('Server closed.')
    process.exit(0)
  })

  // Force exit after timeout
  setTimeout(() => {
    console.error('Forced shutdown after timeout')
    process.exit(1)
  }, 10000)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

// Log when the event loop stalls past 500ms (helps diagnose health-check hangs). Silent when healthy.
function startEventLoopStallLog(): void {
  const h = monitorEventLoopDelay({ resolution: 20 })
  h.enable()
  setInterval(() => {
    const delay_ms = Math.round(h.max / 1e6)
    h.reset()
    if (delay_ms < 500) return
    console.error(
      JSON.stringify({
        event: 'event_loop_stall',
        ts: new Date().toISOString(),
        org_id: process.env.SUPERAGENT_ORG_ID ?? null,
        delay_ms,
      })
    )
  }, 1000).unref()
}

async function start() {
  const defaultPort = parseInt(process.env.PORT || '47891', 10)

  // Bind atomically, retrying on a port race (no probe-then-bind TOCTOU gap; an
  // EADDRINUSE retries the next port instead of crashing the process via an
  // unhandled 'error' event).
  const bound = await bindServerWithRetry(app.fetch, { startPort: defaultPort })
  server = bound.server
  process.env.PORT = String(bound.port)
  console.log(`API server running on http://localhost:${bound.port}`)

  // Services are initialized by api/index.ts (which we import above).
  // No need to call initializeServices() here — it already ran at module load.

  // Set up server-level handlers (WebSocket proxies, etc.)
  setupServerHandlers(server)
  startEventLoopStallLog()
}

start().catch((error) => {
  console.error('Failed to start server:', error)
  process.exit(1)
})
