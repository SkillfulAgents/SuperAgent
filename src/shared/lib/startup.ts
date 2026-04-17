import type { ServerType } from '@hono/node-server'
import { containerManager } from './container/container-manager'
import { shutdownActiveRunner } from './container/client-factory'
import { reviewManager } from './proxy/review-manager'
import { taskScheduler } from './scheduler/task-scheduler'
import { triggerManager } from './scheduler/trigger-manager'
import { chatIntegrationManager } from './chat-integrations/chat-integration-manager'
import { captureException } from './error-reporting'
import { isPlatformComposioActive } from './composio/client'
import { autoSleepMonitor } from './scheduler/auto-sleep-monitor'
import { getActiveProvider, stopAllProviders } from '../../main/host-browser'
import { listAgents } from './services/agent-service'
import { isAuthMode } from './auth/mode'
import { validateAuthModeStartup } from './auth/startup-validation'
import { setupBrowserStreamProxy } from '../../main/browser-stream-proxy'
import { setServerAnalyticsVersion } from './analytics/server-analytics'
import { APP_VERSION } from './config/version'
import { shutdownAC } from './computer-use/executor'
import { reconcileSkillsetConfigsForCurrentAuth } from './services/skillset-reconcile'
import { initErrorReporting, setErrorReportingUser } from './error-reporting'
import { getSettings } from './config/settings'

/**
 * Initialize all background services.
 *
 * Called from two places:
 * - api/index.ts: for non-Electron environments (Vite dev server, standalone web server)
 * - main/index.ts: for Electron, after SUPERAGENT_DATA_DIR is set
 */
export async function initializeServices() {
  // Initialize error reporting for non-Electron environments (Electron inits in main/index.ts).
  // initErrorReporting is a no-op if already initialized, so this is safe.
  // Skip in dev mode — dev errors are too noisy and pollute Sentry.
  if (process.env.NODE_ENV === 'production') {
    initErrorReporting({ environment: 'web' })
  }

  // Set platform auth user identity on error reports (if logged in)
  try {
    const settings = getSettings()
    if (settings.platformAuth?.token) {
      setErrorReportingUser({
        id: settings.platformAuth.tokenPreview,
        email: settings.platformAuth.email ?? undefined,
      })
    }
  } catch {
    // Non-critical
  }

  // Initialize server-side analytics version
  setServerAnalyticsVersion(APP_VERSION)

  // Drop any skillset configs invalid for the current auth state (e.g. a
  // platform skillset left over from a previous org). Filesystem cleanup of
  // installed skills happens lazily in the metadata readers, so we don't
  // walk every agent workspace on startup.
  try {
    reconcileSkillsetConfigsForCurrentAuth()
  } catch (error) {
    captureException(error, { tags: { component: 'startup', operation: 'skillset-reconcile' } })
  }

  // Validate auth mode startup requirements before anything else
  if (isAuthMode()) {
    await validateAuthModeStartup()
  }
  // Initialize container manager with all agents
  const agents = await listAgents()
  const slugs = agents.map((a) => a.slug)
  await containerManager.initializeAgents(slugs)

  // Stop the host browser for an agent before its container is torn down,
  // so the browser closes gracefully instead of getting a "socket hang up".
  containerManager.onBeforeContainerStop = async (agentId) => {
    const provider = getActiveProvider()
    if (provider?.isRunning(agentId)) {
      await provider.stop(agentId)
    }
  }

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

  // Start trigger manager (only when platform Composio is connected)
  if (isPlatformComposioActive()) {
    triggerManager.start().catch((error) => {
      console.error('Failed to start trigger manager:', error)
    })
  }

  // Start chat integration manager
  chatIntegrationManager.start().catch((error) => {
    console.error('Failed to start chat integration manager:', error)
    // TODO add exception capturing for all other services that start in this file
    captureException(error, { tags: { component: 'chat-integration', operation: 'startup' } })
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
  reviewManager.rejectAll()
  chatIntegrationManager.stop()
  await stopAllProviders()
  taskScheduler.stop()
  triggerManager.stop()
  autoSleepMonitor.stop()
  containerManager.stopStatusSync()
  containerManager.stopHealthMonitor()
  await containerManager.stopAll()
  await shutdownActiveRunner()
  await shutdownAC()
}
