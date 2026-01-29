import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { existsSync } from 'fs'
import api from '../api'
import { containerManager } from '@shared/lib/container/container-manager'
import { taskScheduler } from '@shared/lib/scheduler/task-scheduler'
import { autoSleepMonitor } from '@shared/lib/scheduler/auto-sleep-monitor'

const app = new Hono()

// Mount API routes
app.route('/', api)

// Only serve static files in production (when dist/renderer exists)
// In development, Vite dev server handles the frontend
if (existsSync('./dist/renderer')) {
  app.use('/*', serveStatic({ root: './dist/renderer' }))
  app.get('*', serveStatic({ path: './dist/renderer/index.html' }))
}

const port = parseInt(process.env.PORT || '47891', 10)

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`API server running on http://localhost:${info.port}`)

  // Start the task scheduler after server is ready
  taskScheduler.start().catch((error) => {
    console.error('Failed to start task scheduler:', error)
  })

  // Start the auto-sleep monitor
  autoSleepMonitor.start().catch((error) => {
    console.error('Failed to start auto-sleep monitor:', error)
  })
})

// Graceful shutdown handling
let isShuttingDown = false

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return
  isShuttingDown = true

  console.log(`\nReceived ${signal}, shutting down gracefully...`)

  // Stop the task scheduler and auto-sleep monitor
  taskScheduler.stop()
  autoSleepMonitor.stop()

  // Stop all containers
  try {
    await containerManager.stopAll()
    console.log('All containers stopped.')
  } catch (error) {
    console.error('Error stopping containers:', error)
  }

  // Close the server
  server.close(() => {
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
