import type { ServerType } from '@hono/node-server'
import { containerManager } from './container/container-manager'
import { shutdownActiveRunner } from './container/client-factory'
import { taskScheduler } from './scheduler/task-scheduler'
import { autoSleepMonitor } from './scheduler/auto-sleep-monitor'
import { stopAllProviders } from '../../main/host-browser'
import { listAgents } from './services/agent-service'
import { isAuthMode } from './auth/mode'
import { validateAuthModeStartup } from './auth/startup-validation'
import { setupBrowserStreamProxy } from '../../main/browser-stream-proxy'
import { setServerAnalyticsVersion } from './analytics/server-analytics'
import { APP_VERSION } from './config/version'

/**
 * Initialize all background services.
 *
 * Called from two places:
 * - api/index.ts: for non-Electron environments (Vite dev server, standalone web server)
 * - main/index.ts: for Electron, after SUPERAGENT_DATA_DIR is set
 */
export async function initializeServices() {
  // Initialize server-side analytics version
  setServerAnalyticsVersion(APP_VERSION)

  // Validate auth mode startup requirements before anything else
  if (isAuthMode()) {
    await validateAuthModeStartup()
  }
  // Initialize container manager with all agents
  const agents = await listAgents()
  const slugs = agents.map((a) => a.slug)
  await containerManager.initializeAgents(slugs)

  // Check/pull container image (non-blocking)
  containerManager.ensureImageReady().catch((error) => {
    console.error('Failed to ensure image ready:', error)
  })

  // Start container status sync and health monitor
  containerManager.startStatusSync()
  containerManager.startHealthMonitor()

  // Start task scheduler
  taskScheduler.start().catch((error) => {
    console.error('Failed to start task scheduler:', error)
  })

  // Start auto-sleep monitor
  autoSleepMonitor.start().catch((error) => {
    console.error('Failed to start auto-sleep monitor:', error)
  })
}

/**
 * Set up server-level handlers that require the HTTP server instance.
 *
 * Called from all entry points after creating the HTTP server:
 * - main/index.ts: Electron
 * - web/server.ts: standalone web server (Docker)
 * - vite.config.ts: Vite dev server
 */
export function setupServerHandlers(server: ServerType): void {
  setupBrowserStreamProxy(server)
}

/**
 * Shut down all background services started by initializeServices().
 *
 * Called from three places:
 * - main/index.ts: Electron graceful shutdown
 * - web/server.ts: standalone web server shutdown
 * - vite.config.ts: Vite dev server close
 */
export async function shutdownServices() {
  await stopAllProviders()
  taskScheduler.stop()
  autoSleepMonitor.stop()
  containerManager.stopStatusSync()
  containerManager.stopHealthMonitor()
  await containerManager.stopAll()
  await shutdownActiveRunner()
}
