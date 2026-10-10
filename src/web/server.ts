import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { existsSync } from 'fs'
import api from '../api'
import { openDatabase } from '@shared/lib/db'
import { flushErrorReporting, initErrorReporting } from '@shared/lib/error-reporting'
import { afterBindInitialize, shutdownServices, setupServerHandlers } from '@shared/lib/startup'
import { markBoot } from '@shared/lib/boot-timing'
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
  // The service worker script is the update trigger for the whole precached
  // asset set — browsers revalidate it on their own schedule, but an explicit
  // no-cache removes any intermediary-cache delay on picking up a deploy.
  if (p.endsWith('/sw.js')) return 'no-cache'
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
  // close() waits for keep-alive / streaming sockets; drop them so it can call back.
  ;(server as { closeAllConnections?: () => void } | undefined)?.closeAllConnections?.()

  // Force exit after timeout
  setTimeout(() => {
    console.error('Forced shutdown after timeout')
    process.exit(1)
  }, 10000)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

async function start() {
  markBoot('modulesLoaded')

  // Error reporting before the database: a failed open or migration is the
  // first thing that can end this process, and its fatal report needs a
  // provider to reach. Same rule as afterBindInitialize (production only,
  // where a second init is a no-op).
  if (process.env.NODE_ENV === 'production') {
    initErrorReporting({ environment: 'web' })
  }

  // Then the database: nothing below runs without the schema being current,
  // and a migration failure must fail the boot rather than the first request.
  await openDatabase()

  const defaultPort = parseInt(process.env.PORT || '47891', 10)

  // Bind atomically, retrying on a port race (no probe-then-bind TOCTOU gap; an
  // EADDRINUSE retries the next port instead of crashing the process via an
  // unhandled 'error' event).
  const bound = await bindServerWithRetry(app.fetch, { startPort: defaultPort })
  server = bound.server
  process.env.PORT = String(bound.port)
  console.log(`API server running on http://localhost:${bound.port}`)

  setupServerHandlers(server)
  // Degraded on failure: health already passed; don't flap healthy → crash.
  await afterBindInitialize({ degradedOnFailure: true })
}

start().catch(async (error) => {
  console.error('Failed to start server:', error)
  // The fatal report was captured where the failure happened; give the
  // transport a moment to send it before the process goes.
  await flushErrorReporting(2_000)
  process.exit(1)
})
