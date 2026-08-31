import type { ServerType } from '@hono/node-server'
import pLimit from 'p-limit'
import { containerManager } from './container/container-manager'
import { shutdownActiveRunner } from './container/client-factory'
import { reviewManager } from './proxy/review-manager'
import { accountReauthManager } from './proxy/account-reauth-manager'
import { mcpReauthManager } from './proxy/mcp-reauth-manager'
import { taskScheduler } from './scheduler/task-scheduler'
import { triggerManager } from './scheduler/trigger-manager'
import { platformNotificationsManager } from './scheduler/platform-notifications-manager'
import { chatIntegrationManager } from './chat-integrations/chat-integration-manager'
import { captureException } from './error-reporting'
import { registerAllAccountProviders } from './account-providers/register'
import { autoSleepMonitor } from './scheduler/auto-sleep-monitor'
import { sessionAutoDeleteMonitor } from './scheduler/session-auto-delete-monitor'
import { apiLogAutoDeleteMonitor } from './scheduler/api-log-auto-delete-monitor'
import { accountSyncService } from './scheduler/account-sync-service'
import { platformService } from './services/platform-service'
import { getActiveProvider, stopAllProviders } from '../../main/host-browser'
import { startBrowserProfileCleanup, stopBrowserProfileCleanup } from '../../main/host-browser/profile-maintenance'
import { listAgents } from './services/agent-service'
import { isAuthMode } from './auth/mode'
import { clearPendingApprovalBans } from './auth/clear-pending-approval-bans'
import { validateAuthModeStartup } from './auth/startup-validation'
import {
  decodeOrgIdFromToken,
  installPlatformFetchInterceptor,
} from './platform-attribution'
import { getPlatformAccessToken } from './services/platform-auth-service'
import { setupBrowserStreamProxy } from '../../main/browser-stream-proxy'
import { setupCloudStreamProxy } from '../../main/cloud-stream-proxy'
import { setupArtifactStreamProxy } from '../../main/artifact-stream-proxy'
import { setServerAnalyticsVersion } from './analytics/server-analytics'
import { APP_VERSION } from './config/version'
import { shutdownAC } from './computer-use/executor'
import { reconcileSkillsetConfigsForCurrentAuth } from './services/skillset-reconcile'
import { initErrorReporting, setErrorReportingUser } from './error-reporting'
import { getSettings } from './config/settings'
import { logBootTiming, markBoot } from './boot-timing'
import { credentialBroker } from '../../api/credentials/credential-broker'

const STARTUP_IO_CONCURRENCY = 3
const startupIoLimit = pLimit(STARTUP_IO_CONCURRENCY)
let servicesShuttingDown = false
let servicesInitPromise: Promise<void> | null = null
let servicesInitError: string | null = null

/**
 * Start post-bind I/O through one shared lane so image inspection, overdue
 * tasks, realtime handshakes, and chat connections do not all hit the host at
 * once. Callers remain non-blocking, matching the previous startup contract.
 */
function scheduleStartupIo(
  start: () => Promise<unknown>,
  stop?: () => void,
): Promise<unknown> {
  return startupIoLimit(async () => {
    if (servicesShuttingDown) return
    try {
      return await start()
    } finally {
      // A start already in flight can outlive shutdown. Give it a second stop
      // after settling so it cannot resurrect intervals or sockets.
      if (servicesShuttingDown) stop?.()
    }
  })
}

/** Non-null when background-service init failed and the server runs degraded. */
export function getServicesInitError(): string | null {
  return servicesInitError
}

/** Idempotent; call only via afterBindInitialize (or tests). */
export function initializeServices(): Promise<void> {
  servicesInitPromise ??= initializeServicesInner()
  return servicesInitPromise
}

export type AfterBindInitOptions = {
  /** Keep serving on failure (Docker/web). Default: log and continue without Sentry. */
  degradedOnFailure?: boolean
}

/** Mark bound → init services → emit boot_timing. Shared by web / Electron / Vite. */
export async function afterBindInitialize(options: AfterBindInitOptions = {}): Promise<void> {
  markBoot('bound')
  try {
    await initializeServices()
  } catch (error) {
    console.error('Failed to initialize services:', error)
    servicesInitError = error instanceof Error ? error.message : String(error)
    if (options.degradedOnFailure) {
      captureException(error, { tags: { component: 'startup', operation: 'initialize-services' } })
    }
  } finally {
    logBootTiming()
  }
}

async function initializeServicesInner() {
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
  } finally {
    markBoot('settingsRead')
  }

  // Initialize server-side analytics version
  setServerAnalyticsVersion(APP_VERSION)

  // Register account providers (Composio, Nango if configured)
  registerAllAccountProviders()

  try {
    reconcileSkillsetConfigsForCurrentAuth()
  } catch (error) {
    captureException(error, { tags: { component: 'startup', operation: 'skillset-reconcile' } })
  }

  // Auth validation and agent discovery are independent reads. Run them
  // together, then join before container initialization so a failed auth gate
  // still prevents any runtime side effects.
  const [, agents] = await Promise.all([
    (async () => {
      if (isAuthMode()) {
        await validateAuthModeStartup()
        try {
          clearPendingApprovalBans()
        } catch (error) {
          captureException(error, {
            tags: { component: 'startup', operation: 'clear-pending-approval-bans' },
          })
        }
      }

      // Install fetch interceptor for org JWTs (opaque keys don't need attribution).
      try {
        const platformToken = getPlatformAccessToken()
        if (platformToken && decodeOrgIdFromToken(platformToken) !== null) {
          installPlatformFetchInterceptor()
        }
      } catch (error) {
        captureException(error, { tags: { component: 'startup', operation: 'install-fetch-interceptor' } })
      }
    })(),
    listAgents(),
  ])
  markBoot('dbReady')
  const slugs = agents.map((a) => a.slug)
  await containerManager.initializeAgents(slugs)

  // Reclaim host-browser profile storage (orphaned/legacy dirs, regenerable
  // Chrome caches). Scheduled a few minutes out so it doesn't pile onto the
  // startup burst. The agent list is a supplier resolved when the sweep fires,
  // not a snapshot — an agent created during the delay must not be treated as
  // an orphan. Profiles claimed by a browser launch are skipped internally.
  startBrowserProfileCleanup(async () => (await listAgents()).map((a) => a.slug))

  // Stop the host browser for an agent before its container is torn down,
  // so the browser closes gracefully instead of getting a "socket hang up".
  containerManager.onBeforeContainerStop = async (agentId) => {
    const provider = getActiveProvider()
    if (provider?.isRunning(agentId)) {
      await provider.stop(agentId)
    }
  }

  // Lane order is priority: the limiter grants slots FIFO, and the last three
  // starts below are open-ended (image pull on fresh installs; the task
  // scheduler's catch-up scan boots a container per overdue task; the trigger
  // manager's initial poll processes claimed webhook events). The two
  // user-facing connects are cheap handshakes — schedule them first so chat
  // messages and notifications cannot go dark behind minutes of catch-up work.

  // Desktop-only platform-notifications subscription (OS notifications from
  // Supabase Realtime INSERTs). The manager self-gates on auth mode and
  // platform connectivity; connect/disconnect after launch is handled by the
  // platform auth-changed notifier.
  scheduleStartupIo(
    () => platformNotificationsManager.start(),
    () => platformNotificationsManager.stop(),
  ).catch((error) => {
    console.error('Failed to start platform notifications manager:', error)
  })

  // Start chat integration manager
  scheduleStartupIo(
    () => chatIntegrationManager.start(),
    () => chatIntegrationManager.stop(),
  ).catch((error) => {
    console.error('Failed to start chat integration manager:', error)
    // TODO add exception capturing for all other services that start in this file
    captureException(error, { tags: { component: 'chat-integration', operation: 'startup' } })
  })

  // Check/pull container image (non-blocking, bounded with other startup I/O)
  scheduleStartupIo(() => containerManager.ensureImageReady()).catch((error) => {
    console.error('Failed to ensure image ready:', error)
  })

  // Start container status sync and health monitor
  containerManager.startStatusSync()
  containerManager.startHealthMonitor()

  // Start task scheduler
  scheduleStartupIo(
    () => taskScheduler.start(),
    () => taskScheduler.stop(),
  ).catch((error) => {
    console.error('Failed to start task scheduler:', error)
  })

  // Start trigger manager whenever platform auth exists: webhook events
  // (Composio-brokered AND custom endpoints) are claimed from the platform
  // with the platform token, so a personal Composio key must not disable
  // delivery — same trap as the endpoint tool/teardown gating. The manager
  // itself no-ops per-poll when the token is missing.
  if (getPlatformAccessToken()) {
    scheduleStartupIo(
      () => triggerManager.start(),
      () => triggerManager.stop(),
    ).catch((error) => {
      console.error('Failed to start trigger manager:', error)
    })
  }

  // Start auto-sleep monitor
  autoSleepMonitor.start().catch((error) => {
    console.error('Failed to start auto-sleep monitor:', error)
  })

  // Start session auto-delete monitor (deferred — waits before first check)
  sessionAutoDeleteMonitor.start().catch((error) => {
    console.error('Failed to start session auto-delete monitor:', error)
  })

  apiLogAutoDeleteMonitor.start().catch((error) => {
    console.error('Failed to start API log auto-delete monitor:', error)
  })

  // Start account sync service (deferred — syncs OAuth account status with remote providers)
  accountSyncService.start().catch((error) => {
    console.error('Failed to start account sync service:', error)
  })

  // Refreshes platform account + billing info when connected (no-op otherwise).
  platformService.start()
}

/** WebSocket proxies etc. Call after HTTP bind, before or with afterBindInitialize. */
export function setupServerHandlers(server: ServerType): void {
  setupBrowserStreamProxy(server)
  setupArtifactStreamProxy(server)
  // Self-gated to Electron main outside auth mode; a no-op everywhere else.
  setupCloudStreamProxy(server)
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
  servicesShuttingDown = true
  reviewManager.rejectAll()
  accountReauthManager.rejectAll()
  mcpReauthManager.rejectAll()
  stopBrowserProfileCleanup()
  chatIntegrationManager.stop()
  await credentialBroker.shutdown()
  await stopAllProviders()
  taskScheduler.stop()
  triggerManager.stop()
  platformNotificationsManager.stop()
  autoSleepMonitor.stop()
  sessionAutoDeleteMonitor.stop()
  apiLogAutoDeleteMonitor.stop()
  accountSyncService.stop()
  platformService.stop()
  containerManager.stopStatusSync()
  containerManager.stopHealthMonitor()
  await containerManager.stopAll()
  await shutdownActiveRunner()
  await shutdownAC()
}
