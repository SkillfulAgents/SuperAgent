import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { existsSync } from 'fs'
import api from '../api'
import { shutdownServices, setupServerHandlers } from '@shared/lib/startup'
import { findAvailablePort } from '../main/find-port'
const app = new Hono()

// Mount API routes
app.route('/', api)

// Only serve static files in production (when dist/renderer exists)
// In development, Vite dev server handles the frontend
if (existsSync('./dist/renderer')) {
  app.use('/*', serveStatic({ root: './dist/renderer' }))
  app.get('*', serveStatic({ path: './dist/renderer/index.html' }))
}

let server: ReturnType<typeof serve>

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

async function start() {
  const defaultPort = parseInt(process.env.PORT || '47891', 10)
  const port = await findAvailablePort(defaultPort)
  process.env.PORT = String(port)

  server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`API server running on http://localhost:${info.port}`)

    // Services are initialized by api/index.ts (which we import above).
    // No need to call initializeServices() here — it already ran at module load.
  })

  // Set up server-level handlers (WebSocket proxies, etc.)
  setupServerHandlers(server)
}

start()
