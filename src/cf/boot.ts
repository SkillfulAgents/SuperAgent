/**
 * SuperAgent in this isolate, booted once, in src/web/server.ts's order: the database, AppState,
 * key custody, then the setup from main's afterBindInitialize that requests read from memory.
 * index.ts loads this module on the first API request. The Worker and the Durable Objects boot
 * the same way; only TaskManagerDurableObject starts the background services, and only an agent's
 * own CloudflareAgentActor runs its actor.
 */
import { mkdirSync } from 'node:fs'
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
import { initializeServices, prepareBackgroundWork, shutdownServices } from '@shared/lib/startup'
import { initializeBackgroundWork, isBackgroundWorkInitialized } from '@shared/lib/background-work'
import { agentCatalog, agentRegistry, containerHost } from '@shared/lib/agent-actor'
import { useActorTransport, useSessionStore } from '@shared/lib/agent-actor/registry'
import { remoteActor, serveActor } from '@shared/lib/agent-actor/network-actor'
import { createConfigOps } from '@shared/lib/agent-actor/config-ops'
import { CLI_TRANSCRIPTS_DIR, type SessionStore } from '@shared/lib/agent-actor/session-store'
import type { AgentSlug } from '@shared/lib/agent-actor/types'
// eslint-disable-next-line local-rules/no-agent-internals-outside-actor -- a deployment's session store needs its own summary cache, as local-session-store.ts makes
import { SessionSummaryCache } from '@shared/lib/services/session-summary-slot'
import { setIdleAlarmTimers } from '@shared/lib/container/idle-alarm'
// eslint-disable-next-line local-rules/no-agent-internals-outside-actor -- the delete route's folder must exist on Workers (see serve)
import { getAgentDir } from '@shared/lib/utils/file-storage'
import type { ExecutionContext } from 'cloudflare:workers'
import { CloudflareAppState } from './cloudflare-app-state'
import { CloudflareKeyManager } from './cloudflare-key-manager'
import { CloudflareTaskManager } from './cloudflare-task-manager'
import { withAgentObject, routeContainerFetch, sleepingStore, type SleepingStore } from './cloudflare-container-control'
import { createCloudflareFileOps } from './cloudflare-file-ops'
import { ownedHere, servingAgentObject } from './agent-objects'
import { errorOnRedirect } from './workers-shims/fetch-redirect'
import type { Env } from './index'

let booted: Promise<void> | undefined
let tasks: CloudflareTaskManager | undefined
let fetchWrapped = false
// The decision of each agent's idle alarm armed in this isolate, by agent.
const idleRings = new Map<AgentSlug, () => Promise<void>>()
// The agent's actor, as its own object serves it.
const actorOps = serveActor((slug) => agentRegistry.get(slug))

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
  return runWithBackground(ctx, async () => {
    const deleted = await agentBeingDeleted(request)
    // The delete removes the agent's folder with rm's force option, which the Workers runtime does not
    // honour for a missing path; here the folder never exists (the workspace is in the container and R2).
    if (deleted) mkdirSync(getAgentDir(deleted), { recursive: true })
    const response = await api.fetch(request, env, ctx)
    if (deleted && response.ok) {
      await withAgentObject(env.AGENT_ACTOR, deleted, env.VERSION?.timestamp, (agent) => agent.purgeWorkspace()).catch((error: unknown) => {
        console.error(`[cloudflare] purging the saved workspace of ${deleted} failed:`, error)
      })
    }
    return response
  })
}

/** An op on the agent's actor, in the agent's own object (cloudflare-agent-actor.ts). */
export function serveActorRequest(request: Request): Promise<Response> {
  return actorOps(request)
}

/** Sets the agent's cached container status from its container, which outlives the object's memory. */
export async function syncAgentStatus(slug: AgentSlug): Promise<void> {
  await containerHost.runtime(slug).syncAgentStatus()
}

/** The agent's idle alarm went off in its object. Armed by an isolate that is gone, the status sync arms it again. */
export async function ringIdleAlarm(slug: AgentSlug): Promise<void> {
  const ring = idleRings.get(slug)
  if (ring) return ring()
  await syncAgentStatus(slug)
}

/** A container's call to the host, from the library's outbound proxy, which holds the request lifetime. */
export function serveContainerRequest(request: Request, env: Env): Promise<Response> {
  return Promise.resolve(api.fetch(request, env))
}

/** This isolate's TaskManager, whose handlers the org's task manager object runs jobs through. */
export function backgroundTasks(): CloudflareTaskManager {
  if (!tasks) throw new Error('SuperAgent has not booted in this isolate')
  return tasks
}

/** The background services, minus the ones that watch local containers: each agent's object watches its own. */
export function startBackgroundServices(): Promise<void> {
  return initializeServices({ localContainers: false })
}

export function stopBackgroundServices(): Promise<void> {
  return shutdownServices()
}

async function start(env: Env): Promise<void> {
  // Before anything can start a container: SuperAgent's cloudflare-container runner calls this isolate.
  routeContainerFetch(env.AGENT_ACTOR, env.VERSION?.timestamp)
  wireAgents(env)
  // D1 refuses main's migrator, which runs every pending migration in one transaction: migrateD1 runs them as one batch.
  await openDatabase({ driver: d1(env.DB), migrate: false })
  await migrateD1(env.DB)
  // A boot retried after a later step failed finds AppState installed.
  if (!isAppStateInitialized()) await initializeAppState(new CloudflareAppState(env.APP_STATE, { version: env.VERSION?.timestamp }))
  await ensureKeyManager(() => new CloudflareKeyManager({ env, probes: appKeyProbes }))
  // Then task dispatch, before anything is served: a request can schedule work. Every isolate registers
  // the services' Tasks; only TaskManagerDurableObject starts the services and runs the jobs.
  if (!isBackgroundWorkInitialized()) {
    tasks = new CloudflareTaskManager(env.TASK_MANAGER, env.VERSION?.timestamp)
    await initializeBackgroundWork(tasks)
  }
  await prepareBackgroundWork({ localContainers: false })
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

/** Where each agent runs: its actor in its own object, its files in its container or, asleep, in R2. */
function wireAgents(env: Env): void {
  // A new stub for each call: a Worker request may not use a stub another request made, and the registry keeps the handle.
  useActorTransport((slug, local) => ownedHere(slug, local, remoteActor({ name: slug, fetch: (request) => withAgentObject(env.AGENT_ACTOR, slug, env.VERSION?.timestamp, (agent) => agent.fetch(request)) })))
  useSessionStore((slug, hooks) => cloudflareSessionStore(env, slug, hooks))
  setIdleAlarmTimers((slug, ring) => {
    idleRings.set(slug, ring)
    // Armed from the actor, which runs only in the agent's own object.
    return {
      set: (at) => servingAgentObject(slug)?.setIdleAlarm(at),
      clear: () => servingAgentObject(slug)?.clearIdleAlarm(),
    }
  })
}

function cloudflareSessionStore(env: Env, slug: AgentSlug, hooks: Pick<SessionStore, 'onActivity'>): SessionStore {
  // Through the agent's object, which knows whether its container runs and answers asleep when it does not:
  // the container status this isolate caches is only ever set in that object.
  const files = createCloudflareFileOps(async (path, init) => {
    // The container's API takes the agent's host token, as the container client sends it.
    const auth = await (await containerHost.runtime(slug).getClient()).getHostAuthHeaders()
    const headers = new Headers(init?.headers)
    for (const [name, value] of Object.entries(auth)) headers.set(name, value)
    const streamed = init?.body instanceof ReadableStream
    return withAgentObject(env.AGENT_ACTOR, slug, env.VERSION?.timestamp, (agent) => agent.fetch(new Request(`http://container${path}`, { ...init, headers, ...(streamed ? { duplex: 'half' } : {}) } as RequestInit)))
  }, agentSleepingStore(env, slug))
  return {
    slug,
    files,
    config: createConfigOps(files),
    transcriptsDir: CLI_TRANSCRIPTS_DIR,
    key: `cloudflare:${slug}`,
    summaryCache: new SessionSummaryCache(),
    onActivity: hooks.onActivity,
  }
}

/** The saved workspace: from the agent's own object directly, from anywhere else through its stub. */
function agentSleepingStore(env: Env, slug: AgentSlug): SleepingStore {
  const viaStub = sleepingStore(env.AGENT_ACTOR, slug, env.VERSION?.timestamp)
  const side = (): SleepingStore => {
    const own = servingAgentObject(slug)
    if (!own) return viaStub
    return {
      entry: (path) => own.storedEntry(path),
      read: (path) => own.storedRead(path),
      write: (path, bytes) => own.storedWrite(path, bytes),
      remove: (path) => own.storedRemove(path),
    }
  }
  return {
    entry: (path) => side().entry(path),
    read: (path) => side().read(path),
    write: (path, bytes) => side().write(path, bytes),
    remove: (path) => side().remove(path),
  }
}

async function agentBeingDeleted(request: Request): Promise<AgentSlug | null> {
  if (request.method !== 'DELETE') return null
  const id = /^\/api\/agents\/([^/]+)$/.exec(new URL(request.url).pathname)?.[1]
  return id ? agentCatalog.resolve(decodeURIComponent(id)) : null
}
