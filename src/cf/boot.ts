/**
 * SuperAgent in this isolate, booted once, in src/web/server.ts's order: the database, AppState,
 * key custody, task dispatch, then the process setup. The setup runs as its two halves
 * (startup.ts): prepareDeployment once per deploy, in the task manager object (prepareOrg), and
 * prepareProcess in every isolate.
 * index.ts loads this module on the first API request. The Worker and the Durable Objects boot
 * the same way; only TaskManagerDurableObject starts the background services, and only an agent's
 * own AgentDurableObject runs its actor.
 */
import api from '../api'
import { openDatabase } from '@shared/lib/db/open-database'
import { d1, migrateD1 } from '@shared/lib/db/drivers/d1'
import { migrationBundle } from '@shared/lib/db/migrations/bundle'
import { runDataMigrations } from '@shared/lib/db/data-migrations'
import { initializeAppState, isAppStateInitialized } from '@shared/lib/app-state'
import { setBlobStore } from '@shared/lib/blob-store/blob-store'
import { setImageService } from '@shared/lib/images/image-service'
import { setUploadByteStore } from '@shared/lib/utils/chunked-upload-bytes'
import { ensureKeyManager } from '@shared/lib/keys/key-manager'
import { appKeyProbes } from '@shared/lib/keys/app-key-probes'
import { background, runWithBackground } from '@shared/lib/background'
import { getSettings, mutateSettings } from '@shared/lib/config/settings'
import { initializeServices, prepareDeployment, prepareProcess, registerBackgroundWork, shutdownServices } from '@shared/lib/startup'
import { captureException } from '@shared/lib/error-reporting'
import { initializeBackgroundWork, isBackgroundWorkInitialized, taskManager } from '@shared/lib/background-work'
import { getErrorReporter, initErrorReporting } from '@shared/lib/error-reporting'
import { agentRegistry, containerHost } from '@shared/lib/agent-actor'
import { setActorTransport, setSessionStore } from '@shared/lib/agent-actor/registry'
import { setWorkspaceRemoval } from '@shared/lib/agent-actor/workspace-removal'
import { setSessionStartAnnouncer } from '@shared/lib/host/local-host-port'
import { createConfigOps } from '@shared/lib/agent-actor/config-ops'
import { CLI_TRANSCRIPTS_DIR, type SessionStore } from '@shared/lib/agent-actor/session-store'
import type { AgentSlug } from '@shared/lib/agent-actor/types'
import { SessionIndex } from '@shared/lib/agent-actor/session-index'
import { ingestSessionMetadataFile } from '@shared/lib/services/session-metadata-file'
// eslint-disable-next-line local-rules/no-agent-internals-outside-actor -- the agent's object schedules its idle check from the same timeout the alarm reads
import { autoSleepTimeoutMsFrom } from '@shared/lib/container/container-runtime'
import { IDLE_ALARM_RETRY_MS } from '@shared/lib/container/idle-alarm'
import type { ExecutionContext, SqlStorage } from 'cloudflare:workers'
import { CloudflareAppState } from './objects/cloudflare-app-state'
import { CloudflareBlobStore, CloudflareUploadByteStore } from './cloudflare-host-files'
import { CloudflareImageService } from './cloudflare-image-service'
import { createCloudflareErrorReporter } from './lib/cloudflare-error-reporting'
import { CloudflareKeyManager } from './cloudflare-key-manager'
import { CloudflareTaskManager, announceSessionStart } from './objects/cloudflare-task-manager'
import { agentContainers, withAgentObject, sleepingStore } from './cloudflare-container-control'
import { installCloudflareContainers } from '@shared/lib/container/cloudflare-container-runtime'
import { createCloudflareFileOps } from './cloudflare-file-ops'
import { cloudflareAgentActor, ownedHere, runActorOp, servingAgentObject, type ActorOutcome, type ReachActorObject } from './objects/cloudflare-agent-actor'
import { createObjectSessionIndexStorage } from './lib/object-session-index-storage'
import { callOnCurrentCode } from './lib/object-version'
import { seedSettings } from './lib/seed-settings'
import { PURGE_WORKSPACE_TASK, PurgeWorkspaceTask } from './lib/purge-workspace-task'
import type { Env } from './index'

let booted: Promise<void> | undefined
let tasks: CloudflareTaskManager | undefined
let fetchInstalled = false
/** Boots SuperAgent in this isolate once; a failed boot is tried again by the next call. */
export function boot(env: Env): Promise<void> {
  booted ??= bootIsolate(env).then(prepareProcess).catch((error: unknown) => {
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
  isolateBooted ??= start(env).catch((error: unknown) => {
    isolateBooted = undefined
    throw error
  })
  return isolateBooted
}

/**
 * What a deploy does once for the org, in the task manager object: the settings a new org starts
 * from (`seed`: false once a deploy applied them), its origin as trusted for sign-in, then
 * prepareDeployment (the auth gate and the managed platform connection).
 */
export async function prepareOrg(env: Env, options: { seed: boolean; origin: string | undefined }): Promise<void> {
  // An isolate does not check the vault key when it boots (cloudflare-key-manager.ts): a deploy does, once.
  await new CloudflareKeyManager({ env, probes: appKeyProbes }).check()
  await mutateSettings((settings) => (seedSettings(settings, options.seed ? env.SEED_SETTINGS : undefined, options.origin) ? undefined : false))
  await prepareDeployment()
}

/**
 * One API request; the work it leaves running keeps the invocation alive until it settles. So does
 * the request itself: a client that leaves must not cancel a lookup that later requests wait on.
 */
export function serve(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const response = runWithBackground(ctx, async () => api.fetch(request, env, ctx))
  ctx.waitUntil(response.catch(() => {}))
  return response
}

/** An op on the agent's actor, in the agent's own object (cloudflare-agent.ts). */
export function runAgentActorOp(slug: AgentSlug, path: string, args: unknown[], actingUserId?: string): Promise<ActorOutcome> {
  return runActorOp(agentRegistry.get(slug), path, args, actingUserId)
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

/** One API request in an object that outlives it: the work the request leaves running needs no lifetime. */
export function serveInObject(request: Request, env: Env): Promise<Response> {
  return Promise.resolve(api.fetch(request, env))
}

/** A container's call to the host, from AgentContainerOutbound (index.ts), which holds the request lifetime. */
export function serveContainerRequest(request: Request, env: Env): Promise<Response> {
  return Promise.resolve(api.fetch(request, env))
}

/** The background services, minus the ones that watch local containers: each agent's object watches its own. */
export function startBackgroundServices(): Promise<void> {
  return initializeServices()
}

let servicesShutDown = false

export function stopBackgroundServices(): Promise<void> {
  servicesShutDown = true
  return shutdownServices()
}

/** True once this isolate's services were shut down: they never start again in it (startup.ts). */
export function backgroundServicesShutDown(): boolean {
  return servicesShutDown
}

/** Error reporting, before the database: a failed migration or open is the first thing a boot can fail on. */
export function startErrorReporting(): void {
  if (!getErrorReporter()) initErrorReporting(createCloudflareErrorReporter({ environment: 'cloudflare' }))
}

/** The schema and data migrations, for the one object that runs them (TaskManagerDurableObject.migrate). */
export async function migrateDatabase(env: Env): Promise<void> {
  // This can be the first thing the isolate does: a failed migration must reach error reporting.
  startErrorReporting()
  // As a boot does before it opens the database: the data migrations reach agents through this wiring.
  wireAgents(env)
  await migrateD1(env.DB, migrationBundle)
  await runDataMigrations((await d1(env.DB).open()).db)
}

async function start(env: Env): Promise<void> {
  startErrorReporting()
  // Before anything can start a container: how SuperAgent's cloudflare-container runner reaches agents here.
  installCloudflareContainers(agentContainers(env.AGENT, env.VERSION?.timestamp))
  installFetch()
  wireAgents(env)
  // A Worker's disk does not outlive a request: blobs and the bytes of uploads in progress live in R2.
  setBlobStore(new CloudflareBlobStore(env.HOST_FILES))
  setUploadByteStore(new CloudflareUploadByteStore(env.HOST_FILES))
  setImageService(new CloudflareImageService(env.IMAGES))
  // The deploy step migrated the database (prepareDeploy); a boot neither migrates nor checks it.
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
  taskManager().register(new PurgeWorkspaceTask((slug) => withAgentObject(env.AGENT, slug, env.VERSION?.timestamp, (agent) => agent.purgeWorkspace())))
}

/**
 * The one place this isolate's fetch is replaced, so every call goes through errorOnRedirect.
 * The platform attribution that the process setup installs later wraps this fetch.
 */
function installFetch(): void {
  if (fetchInstalled) return
  fetchInstalled = true
  globalThis.fetch = errorOnRedirect(globalThis.fetch)
}

/**
 * Workers' fetch refuses `redirect: 'error'` ("use 'manual' and check the response status code"),
 * which SuperAgent's calls to fixed hosts use. The same request goes out with 'manual' here, and a
 * redirect fails it with the TypeError Node's fetch throws.
 */
function errorOnRedirect(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    // The request's own setting counts when the call names none.
    const redirect = init?.redirect ?? (input instanceof Request ? input.redirect : undefined)
    if (redirect !== 'error') return fetch(input, init)
    const response = await fetch(input, { ...init, redirect: 'manual' })
    if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
      await response.body?.cancel()
      throw new TypeError('fetch failed: the response redirected, and the request asked for redirect: "error"')
    }
    return response
  }
}

/** One call on the agent's actor: in this object when it is the agent's own, else through its stub, which checks its code on the first call. */
const reachAgentActor: (env: Env, slug: AgentSlug, run: Parameters<ReachActorObject>[0]) => Promise<ActorOutcome> = async (env, slug, run) => {
  const own = servingAgentObject(slug)
  if (own) return (await run(own)) as ActorOutcome
  return callOnCurrentCode(env.AGENT, slug, env.VERSION?.timestamp, (agent, callerVersion) => run(agent, callerVersion))
}

/** Where each agent runs: its actor in its own object, its files in its container or, asleep, in R2. */
function wireAgents(env: Env): void {
  // A new stub for each call: a Worker request may not use a stub another request made, and the registry keeps the handle.
  setActorTransport((slug, local) => ownedHere(slug, local, cloudflareAgentActor(slug, (run) => reachAgentActor(env, slug, run))))
  setSessionStore((slug, hooks) => cloudflareSessionStore(env, slug, hooks))
  // A session runs in its agent's object, and the chat connections are in the task manager object.
  setSessionStartAnnouncer((slug, sessionId) => announceSessionStart(env, slug, sessionId))
  // A deleted agent's saved files are in its object and R2, not in a directory here. They are removed
  // after the answer, by a task that is tried again if it fails: the purge lists and deletes every
  // object the agent saved. A removal that cannot be scheduled fails, and the agent is kept.
  setWorkspaceRemoval(async (slug) => {
    await taskManager().at(Date.now(), `${PURGE_WORKSPACE_TASK}:${slug}`, { taskType: PURGE_WORKSPACE_TASK, payload: { slug } })
  })
}

/** The SQLite of the agent's object, where its session index is kept. The actor that uses the index runs only in that object. */
function agentObjectSql(slug: AgentSlug): SqlStorage {
  const own = servingAgentObject(slug)
  if (!own) throw new Error(`The session index of agent ${slug} is read only in the agent's own object`)
  return own.sessionIndexSql()
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
  }, sleepingStore(env.AGENT, slug, env.VERSION?.timestamp))
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
      // In the agent's own object, not the org's database: the actor runs only there, and a read costs no round trip.
      storage: createObjectSessionIndexStorage(() => agentObjectSql(slug)),
      beforeFirstUse: () => ingestSessionMetadataFile(store).catch((error: unknown) => {
        console.warn(`Could not take in the session metadata file of agent ${slug}:`, error)
        captureException(error, { tags: { component: 'session-store', operation: 'ingest-session-metadata' }, extra: { agent: slug }, level: 'warning' })
      }),
    }),
    onActivity: hooks.onActivity,
  }
  return store
}
