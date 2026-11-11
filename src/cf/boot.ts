/**
 * SuperAgent in the Worker and in the org's task manager object: the shared boot (boot-core.ts),
 * then the background services' Tasks and the process setup (prepareProcess). index.ts loads this
 * module on the first API request. Only TaskManagerDurableObject starts the background services;
 * an agent's own object boots through boot-agent.ts, without the API.
 */
import { mkdirSync } from 'node:fs'
import api from '../api'
import { d1, migrateD1 } from '@shared/lib/db/drivers/d1'
import { migrationBundle } from '@shared/lib/db/migrations/bundle'
import { runDataMigrations } from '@shared/lib/db/data-migrations'
import { runWithBackground } from '@shared/lib/background'
import { mutateSettings } from '@shared/lib/config/settings'
import { initializeServices, registerBackgroundWork, shutdownServices } from '@shared/lib/startup'
import { isAuthMode } from '@shared/lib/auth/mode'
import { validateAuthModeStartup } from '@shared/lib/auth/startup-validation'
import { ensureManagedPlatformConnection } from '@shared/lib/llm-provider/connection-settings'
import { agentCatalog } from '@shared/lib/agent-actor'
import type { AgentSlug } from '@shared/lib/agent-actor/types'
// eslint-disable-next-line local-rules/no-agent-internals-outside-actor -- the delete route's folder must exist on Workers (see serve)
import { getAgentDir } from '@shared/lib/utils/file-storage'
import type { ExecutionContext } from 'cloudflare:workers'
import { bootCore, prepareIsolate, wireAgents } from './boot-core'
import { ensureOrgPrepared } from './cloudflare-task-manager'
import { withAgentObject } from './cloudflare-container-control'
import type { Env } from './index'

export { backgroundTasks } from './boot-core'

let booted: Promise<void> | undefined
/** Boots SuperAgent in this isolate once; a failed boot is tried again by the next call. */
export function boot(env: Env): Promise<void> {
  booted ??= bootIsolate(env).then(() => ensureOrgPrepared(env)).then(prepareIsolate).catch((error: unknown) => {
    booted = undefined
    throw error
  })
  return booted
}

let isolateBooted: Promise<void> | undefined
/**
 * A boot without the org's once-per-deploy setup and what follows it: the task manager object
 * runs that setup on top of this (TaskManagerDurableObject.prepareOrg), so it must not wait for it.
 */
export function bootIsolate(env: Env): Promise<void> {
  // Every isolate that serves the API registers the services' Tasks, as a request can schedule
  // work; only TaskManagerDurableObject starts the services and runs the jobs.
  isolateBooted ??= bootCore(env).then(() => registerBackgroundWork({ localContainers: false })).catch((error: unknown) => {
    isolateBooted = undefined
    throw error
  })
  return isolateBooted
}

/**
 * The part of the process setup (prepareProcess in startup.ts) that writes or checks the org's
 * data, plus the first-boot settings: once per deploy, in the task manager object.
 */
export async function prepareOrg(env: Env): Promise<void> {
  await seedSettings(env.APP_ORIGIN)
  if (isAuthMode()) await validateAuthModeStartup()
  await ensureManagedPlatformConnection()
}

/** One API request; the work it leaves running keeps the invocation alive until it settles. */
export function serve(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return runWithBackground(ctx, async () => {
    const deleted = await agentBeingDeleted(request)
    // The delete removes the agent's folder with rm's force option, which the Workers runtime does not
    // honour for a missing path; here the folder never exists (the workspace is in the container and R2).
    if (deleted) mkdirSync(getAgentDir(deleted), { recursive: true })
    const response = await api.fetch(request, env, ctx)
    if (deleted && response.ok) {
      await withAgentObject(env.AGENT, deleted, env.VERSION?.timestamp, (agent) => agent.purgeWorkspace()).catch((error: unknown) => {
        console.error(`[cloudflare] purging the saved workspace of ${deleted} failed:`, error)
      })
    }
    return response
  })
}

/** A container's call to the host, from the library's outbound proxy, which holds the request lifetime. */
export function serveContainerRequest(request: Request, env: Env): Promise<Response> {
  return Promise.resolve(api.fetch(request, env))
}

/** The background services, minus the ones that watch local containers: each agent's object watches its own. */
export function startBackgroundServices(): Promise<void> {
  return initializeServices()
}

export function stopBackgroundServices(): Promise<void> {
  return shutdownServices()
}

/** The schema and data migrations, for the one object that runs them (TaskManagerDurableObject.migrate). */
export async function migrateDatabase(env: Env): Promise<void> {
  // As a boot does before it opens the database: the data migrations reach agents through this wiring.
  wireAgents(env)
  await migrateD1(env.DB, migrationBundle)
  await runDataMigrations((await d1(env.DB).open()).db)
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
    settings.container = { ...settings.container, containerRunner: 'cloudflare-container' }
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

async function agentBeingDeleted(request: Request): Promise<AgentSlug | null> {
  if (request.method !== 'DELETE') return null
  const id = /^\/api\/agents\/([^/]+)$/.exec(new URL(request.url).pathname)?.[1]
  return id ? agentCatalog.resolve(decodeURIComponent(id)) : null
}
