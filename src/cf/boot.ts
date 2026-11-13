/**
 * SuperAgent in this isolate, booted once, in src/web/server.ts's order: the database, AppState,
 * key custody, task dispatch, then the process setup (prepareProcess).
 * index.ts loads this module on the first API request. The Worker and the Durable Objects boot
 * the same way; only TaskManagerDurableObject starts the background services.
 */
import api from '../api'
import { openDatabase } from '@shared/lib/db/open-database'
import { d1, migrateD1 } from '@shared/lib/db/drivers/d1'
import { migrationBundle } from '@shared/lib/db/migrations/bundle'
import { runDataMigrations } from '@shared/lib/db/data-migrations'
import { initializeAppState, isAppStateInitialized } from '@shared/lib/app-state'
import { ensureKeyManager } from '@shared/lib/keys/key-manager'
import { appKeyProbes } from '@shared/lib/keys/app-key-probes'
import { runWithBackground } from '@shared/lib/background'
import { mutateSettings } from '@shared/lib/config/settings'
import { initializeServices, prepareProcess, registerBackgroundWork, shutdownServices } from '@shared/lib/startup'
import { initializeBackgroundWork, isBackgroundWorkInitialized } from '@shared/lib/background-work'
import type { ExecutionContext } from 'cloudflare:workers'
import { CloudflareAppState } from './cloudflare-app-state'
import { CloudflareKeyManager } from './cloudflare-key-manager'
import { CloudflareTaskManager } from './cloudflare-task-manager'
import type { Env } from './index'

let booted: Promise<void> | undefined
let tasks: CloudflareTaskManager | undefined
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

/** This isolate's TaskManager, whose handlers the org's task manager object runs jobs through. */
export function backgroundTasks(): CloudflareTaskManager {
  if (!tasks) throw new Error('SuperAgent has not booted in this isolate')
  return tasks
}

export function startBackgroundServices(): Promise<void> {
  return initializeServices()
}

export function stopBackgroundServices(): Promise<void> {
  return shutdownServices()
}

async function start(env: Env): Promise<void> {
  // Its own step, not part of opening the database: D1 takes the schema migrations as one batch.
  await migrateD1(env.DB, migrationBundle)
  await runDataMigrations(await openDatabase({ driver: d1(env.DB), migrate: false }))
  // A boot retried after a later step failed finds AppState installed.
  if (!isAppStateInitialized()) await initializeAppState(new CloudflareAppState(env.APP_STATE))
  await ensureKeyManager(() => new CloudflareKeyManager({ env, probes: appKeyProbes }))
  // Then task dispatch, before anything is served: a request can schedule work. Every isolate registers
  // the services' Tasks; only TaskManagerDurableObject starts the services and runs the jobs.
  if (!isBackgroundWorkInitialized()) {
    tasks = new CloudflareTaskManager(env.TASK_MANAGER)
    await initializeBackgroundWork(tasks)
  }
  registerBackgroundWork()
  await seedSettings(env.APP_ORIGIN)

  await prepareProcess()
  if (!fetchWrapped) {
    // Outermost: the wrappers inside (platform attribution) can build a Request, which refuses redirect: 'error' on Workers.
    globalThis.fetch = errorOnRedirect(globalThis.fetch)
    fetchWrapped = true
  }
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

/**
 * Workers' fetch refuses `redirect: 'error'` ("use 'manual' and check the response status code"),
 * which SuperAgent's calls to fixed hosts use. The same request goes out with 'manual' here, and a
 * redirect fails it with the TypeError Node's fetch throws.
 */
function errorOnRedirect(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    if (init?.redirect !== 'error') return fetch(input, init)
    const response = await fetch(input, { ...init, redirect: 'manual' })
    if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
      await response.body?.cancel()
      throw new TypeError('fetch failed: the response redirected, and the request asked for redirect: "error"')
    }
    return response
  }
}
