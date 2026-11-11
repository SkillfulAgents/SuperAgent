/**
 * SuperAgent in this isolate, booted once, in src/web/server.ts's order: the database, AppState,
 * key custody, task dispatch, then the process setup (prepareProcess).
 * index.ts loads this module on the first API request. The Worker and the Durable Objects boot
 * the same way; only TaskManagerDurableObject starts the background services, and only an agent's
 * own AgentDurableObject runs its actor.
 */
import { mkdirSync } from 'node:fs'
import api from '../api'
import { openDatabase } from '@shared/lib/db/open-database'
import { d1, migrateD1 } from '@shared/lib/db/drivers/d1'
import { migrationBundle } from '@shared/lib/db/migrations/bundle'
import { runDataMigrations } from '@shared/lib/db/data-migrations'
import { initializeAppState, isAppStateInitialized } from '@shared/lib/app-state'
import { ensureKeyManager } from '@shared/lib/keys/key-manager'
import { appKeyProbes } from '@shared/lib/keys/app-key-probes'
import { runWithBackground } from '@shared/lib/background'
import { getSettings, mutateSettings } from '@shared/lib/config/settings'
import { initializeServices, prepareProcess, registerBackgroundWork, shutdownServices } from '@shared/lib/startup'
import { initializeBackgroundWork, isBackgroundWorkInitialized } from '@shared/lib/background-work'
import { agentCatalog, agentRegistry, containerHost } from '@shared/lib/agent-actor'
import { setActorTransport, setSessionStore } from '@shared/lib/agent-actor/registry'
import { createConfigOps } from '@shared/lib/agent-actor/config-ops'
import { CLI_TRANSCRIPTS_DIR, type SessionStore } from '@shared/lib/agent-actor/session-store'
import type { AgentSlug } from '@shared/lib/agent-actor/types'
import { SessionIndex } from '@shared/lib/agent-actor/session-index'
import { createDbSessionIndexStorage } from '@shared/lib/agent-actor/db-session-index-storage'
import { ingestSessionMetadataFile } from '@shared/lib/services/session-metadata-file'
// eslint-disable-next-line local-rules/no-agent-internals-outside-actor -- the agent's object schedules its idle check from the same timeout the alarm reads
import { autoSleepTimeoutMsFrom } from '@shared/lib/container/container-runtime'
import { IDLE_ALARM_RETRY_MS } from '@shared/lib/container/idle-alarm'
// eslint-disable-next-line local-rules/no-agent-internals-outside-actor -- the delete route's folder must exist on Workers (see serve)
import { getAgentDir } from '@shared/lib/utils/file-storage'
import type { ExecutionContext } from 'cloudflare:workers'
import { CloudflareAppState } from './cloudflare-app-state'
import { CloudflareKeyManager } from './cloudflare-key-manager'
import { CloudflareTaskManager, ensureMigrated } from './cloudflare-task-manager'
import { withAgentObject, routeContainerFetch, sleepingStore, type SleepingStore } from './cloudflare-container-control'
import { createCloudflareFileOps } from './cloudflare-file-ops'
import { ownedHere, servingAgentObject } from './agent-objects'
import { cloudflareAgentActor, runActorOp, type ActorOutcome } from './cloudflare-agent-actor'
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

/** An op on the agent's actor, in the agent's own object (cloudflare-agent.ts). */
export function runAgentActorOp(slug: AgentSlug, path: string, args: unknown[]): Promise<ActorOutcome> {
  return runActorOp(agentRegistry.get(slug), path, args)
}

/** Sets the agent's cached container status from its container, which outlives the object's memory. */
export async function syncAgentStatus(slug: AgentSlug): Promise<void> {
  await containerHost.runtime(slug).syncAgentStatus()
}

/**
 * The agent's idle check, in its own object: SuperAgent's idle decision puts the agent to sleep
 * if it has been idle past the auto-sleep timeout. Returns when to check again, or null when
 * auto-sleep is off. The object's alarm outlives this isolate, whose process timer does not.
 */
export async function checkIdle(slug: AgentSlug): Promise<number | null> {
  const runtime = containerHost.runtime(slug)
  await runtime.idleAlarm.fire()
  const timeoutMs = autoSleepTimeoutMsFrom(await getSettings())
  if (timeoutMs <= 0) return null
  const now = Date.now()
  const idleSince = runtime.idleSince()
  // Busy: a full window from now. Quiet: the rest of the window, or a retry if a sleep did not complete.
  if (idleSince === null) return now + timeoutMs
  return Math.max(idleSince + timeoutMs, now + IDLE_ALARM_RETRY_MS)
}

/** This isolate's TaskManager, whose handlers the org's task manager object runs jobs through. */
export function backgroundTasks(): CloudflareTaskManager {
  if (!tasks) throw new Error('SuperAgent has not booted in this isolate')
  return tasks
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
  await runDataMigrations(d1(env.DB).open().db)
}

async function start(env: Env): Promise<void> {
  // Before anything can start a container: SuperAgent's cloudflare-container runner calls this isolate.
  routeContainerFetch(env.AGENT, env.VERSION?.timestamp)
  wireAgents(env)
  // The org's task manager object migrates the database once per deploy; no other isolate does.
  await ensureMigrated(env)
  await openDatabase({ driver: d1(env.DB), migrate: false })
  // A boot retried after a later step failed finds AppState installed.
  if (!isAppStateInitialized()) await initializeAppState(new CloudflareAppState(env.APP_STATE, { version: env.VERSION?.timestamp }))
  await ensureKeyManager(() => new CloudflareKeyManager({ env, probes: appKeyProbes }))
  // Then task dispatch, before anything is served: a request can schedule work. Every isolate registers
  // the services' Tasks; only TaskManagerDurableObject starts the services and runs the jobs.
  if (!isBackgroundWorkInitialized()) {
    tasks = new CloudflareTaskManager(env.TASK_MANAGER, env.VERSION?.timestamp)
    await initializeBackgroundWork(tasks)
  }
  registerBackgroundWork({ localContainers: false })
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

/** Where each agent runs: its actor in its own object, its files in its container or, asleep, in R2. */
function wireAgents(env: Env): void {
  // A new stub for each call: a Worker request may not use a stub another request made, and the registry keeps the handle.
  setActorTransport((slug, local) => ownedHere(slug, local, cloudflareAgentActor(slug, (run) => withAgentObject(env.AGENT, slug, env.VERSION?.timestamp, run))))
  setSessionStore((slug, hooks) => cloudflareSessionStore(env, slug, hooks))
}

function cloudflareSessionStore(env: Env, slug: AgentSlug, hooks: Pick<SessionStore, 'onActivity'>): SessionStore {
  // Through the agent's object, which knows whether its container runs and answers asleep when it does not:
  // the container status this isolate caches is only ever set in that object.
  const files = createCloudflareFileOps(async (path, init) => {
    // Asleep in its own object: the saved workspace answers, and no container request is built (its client reads the settings).
    const own = servingAgentObject(slug)
    if (own && !(await own.agentRunning())) return null
    // The container's API takes the agent's host token, as the container client sends it.
    const auth = await (await containerHost.runtime(slug).getClient()).getHostAuthHeaders()
    const headers = new Headers(init?.headers)
    for (const [name, value] of Object.entries(auth)) headers.set(name, value)
    const streamed = init?.body instanceof ReadableStream
    return withAgentObject(env.AGENT, slug, env.VERSION?.timestamp, (agent) => agent.fetch(new Request(`http://container${path}`, { ...init, headers, ...(streamed ? { duplex: 'half' } : {}) } as RequestInit)))
  }, agentSleepingStore(env, slug))
  const key = `cloudflare:${slug}`
  const store: SessionStore = {
    slug,
    files,
    config: createConfigOps(files),
    transcriptsDir: CLI_TRANSCRIPTS_DIR,
    key,
    // As local-session-store.ts: a workspace's `session-metadata.json` is taken in before the index is first used.
    index: new SessionIndex({
      files,
      transcriptsDir: CLI_TRANSCRIPTS_DIR,
      key: () => key,
      storage: createDbSessionIndexStorage(slug),
      beforeFirstUse: () => ingestSessionMetadataFile(store).catch((error: unknown) => {
        console.warn(`Could not take in the session metadata file of agent ${slug}:`, error)
      }),
    }),
    onActivity: hooks.onActivity,
  }
  return store
}

/** The saved workspace: from the agent's own object directly, from anywhere else through its stub. */
function agentSleepingStore(env: Env, slug: AgentSlug): SleepingStore {
  const viaStub = sleepingStore(env.AGENT, slug, env.VERSION?.timestamp)
  const side = (): SleepingStore => {
    const own = servingAgentObject(slug)
    if (!own) return viaStub
    return {
      entry: (path) => own.storedEntry(path),
      read: (path, range) => own.storedRead(path, range),
      write: (path, bytes) => own.storedWrite(path, bytes),
      remove: (path) => own.storedRemove(path),
    }
  }
  return {
    entry: (path) => side().entry(path),
    read: (path, range) => side().read(path, range),
    write: (path, bytes) => side().write(path, bytes),
    remove: (path) => side().remove(path),
  }
}

async function agentBeingDeleted(request: Request): Promise<AgentSlug | null> {
  if (request.method !== 'DELETE') return null
  const id = /^\/api\/agents\/([^/]+)$/.exec(new URL(request.url).pathname)?.[1]
  return id ? agentCatalog.resolve(decodeURIComponent(id)) : null
}
