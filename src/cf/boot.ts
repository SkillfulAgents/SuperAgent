/**
 * SuperAgent in this isolate, booted once, in src/web/server.ts's order: the database, AppState,
 * key custody, then the setup from main's afterBindInitialize that requests read from memory.
 * index.ts loads this module on the first API request. The Worker and CloudflareTaskManager boot
 * the same way; only the task manager starts the background services.
 */
import api from '../api'
import { openDatabase } from '@shared/lib/db/open-database'
import { d1, migrateD1 } from '@shared/lib/db/drivers/d1'
import { initializeAppState, isAppStateInitialized } from '@shared/lib/app-state'
import { ensureKeyManager } from '@shared/lib/keys/key-manager'
import { appKeyProbes } from '@shared/lib/keys/app-key-probes'
import { runWithBackground } from '@shared/lib/background'
import { mutateSettings } from '@shared/lib/config/settings'
import { isAuthMode } from '@shared/lib/auth/mode'
import { validateAuthModeStartup } from '@shared/lib/auth/startup-validation'
import { registerAllAccountProviders } from '@shared/lib/account-providers/register'
import { setServerAnalyticsVersion } from '@shared/lib/analytics/server-analytics'
import { APP_VERSION } from '@shared/lib/config/version'
import { decodeOrgIdFromToken, installPlatformFetchInterceptor } from '@shared/lib/platform-attribution'
import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import { ensureManagedPlatformConnection } from '@shared/lib/llm-provider/connection-settings'
import { initializeServices, shutdownServices } from '@shared/lib/startup'
import type { ExecutionContext } from 'cloudflare:workers'
import { CloudflareAppState } from './cloudflare-app-state'
import { CloudflareKeyManager } from './cloudflare-key-manager'
import { errorOnRedirect } from './workers-shims/fetch-redirect'
import type { Env } from './index'

let booted: Promise<void> | undefined
let fetchWrapped = false

/** Boots SuperAgent in this isolate once; a failed boot is tried again by the next call. */
export function boot(env: Env): Promise<void> {
  booted ??= start(env).catch((error: unknown) => {
    booted = undefined
    throw error
  })
  return booted
}

/** One API request; the work it leaves running keeps the invocation alive until it settles. */
export function serve(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return runWithBackground(ctx, async () => api.fetch(request, env, ctx))
}

/** The background services, minus the ones that watch local containers: each agent's object watches its own. */
export function startBackgroundServices(): Promise<void> {
  return initializeServices({ localContainers: false })
}

export function stopBackgroundServices(): Promise<void> {
  return shutdownServices()
}

async function start(env: Env): Promise<void> {
  // D1 refuses main's migrator, which runs every pending migration in one transaction: migrateD1 runs them as one batch.
  await openDatabase({ driver: d1(env.DB), migrate: false })
  await migrateD1(env.DB)
  // A boot retried after a later step failed finds AppState installed.
  if (!isAppStateInitialized()) await initializeAppState(new CloudflareAppState(env.APP_STATE))
  await ensureKeyManager(() => new CloudflareKeyManager({ env, probes: appKeyProbes }))
  await seedSettings(env.APP_ORIGIN)

  // The setup from main's afterBindInitialize (startup.ts) that requests read from this isolate's memory.
  setServerAnalyticsVersion(APP_VERSION)
  registerAllAccountProviders()
  if (isAuthMode()) await validateAuthModeStartup()
  // Platform calls carry the acting member, as startup.ts arranges for an org's token.
  const platformToken = await getPlatformAccessToken()
  if (platformToken && decodeOrgIdFromToken(platformToken) !== null) installPlatformFetchInterceptor()
  if (!fetchWrapped) {
    // Outermost: the wrappers inside can build a Request, which refuses redirect: 'error' on Workers.
    globalThis.fetch = errorOnRedirect(globalThis.fetch)
    fetchWrapped = true
  }
  await ensureManagedPlatformConnection()
}

/**
 * What gamut-controller-ecs seeds on an org's first boot (seedSettingsJson): platform providers,
 * setup done, sign-in through the platform only. An org that finished setup keeps its settings.
 */
async function seedSettings(origin: string): Promise<void> {
  await mutateSettings((settings) => {
    if (settings.app?.setupCompleted) return false
    settings.llmProvider = 'platform'
    settings.voice = { ...settings.voice, sttProvider: 'platform' }
    settings.app = { ...settings.app, hostBrowserProvider: 'platform', setupCompleted: true }
    settings.shareAnalytics = true
    settings.shareErrorReports = true
    settings.auth = {
      ...settings.auth,
      requireAdminApproval: false,
      allowLocalAuth: false,
      allowSocialAuth: true,
      trustedOrigins: [origin],
      sessionMaxLifetimeHrs: 168,
      sessionIdleTimeoutMin: 1440,
    }
  })
}
