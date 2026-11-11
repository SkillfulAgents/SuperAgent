/**
 * What every isolate of the org boots, whatever it serves, in src/web/server.ts's order: the
 * database, AppState, key custody, task dispatch and where each agent runs. Each role adds its own
 * part on top: boot.ts the API and the background services, boot-agent.ts an agent's actor. Kept
 * apart from both so an agent's object does not load the API.
 */
import { openDatabase } from '@shared/lib/db/open-database'
import { d1 } from '@shared/lib/db/drivers/d1'
import { initializeAppState, isAppStateInitialized } from '@shared/lib/app-state'
import { ensureKeyManager } from '@shared/lib/keys/key-manager'
import { appKeyProbes } from '@shared/lib/keys/app-key-probes'
import { registerAllAccountProviders } from '@shared/lib/account-providers/register'
import { setServerAnalyticsVersion } from '@shared/lib/analytics/server-analytics'
import { APP_VERSION } from '@shared/lib/config/version'
import { decodeOrgIdFromToken } from '@shared/lib/platform-auth/decode-org-id'
import { installPlatformFetchInterceptor } from '@shared/lib/platform-attribution/install-fetch-interceptor'
import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import { captureException } from '@shared/lib/error-reporting'
import { initializeBackgroundWork, isBackgroundWorkInitialized } from '@shared/lib/background-work'
import { containerHost } from '@shared/lib/agent-actor'
import { setActorTransport, setSessionStore } from '@shared/lib/agent-actor/registry'
import { createConfigOps } from '@shared/lib/agent-actor/config-ops'
import { CLI_TRANSCRIPTS_DIR, type SessionStore } from '@shared/lib/agent-actor/session-store'
import type { AgentSlug } from '@shared/lib/agent-actor/types'
import { SessionIndex } from '@shared/lib/agent-actor/session-index'
import { createDbSessionIndexStorage } from '@shared/lib/agent-actor/db-session-index-storage'
import { ingestSessionMetadataFile } from '@shared/lib/services/session-metadata-file'
import { CloudflareAppState } from './cloudflare-app-state'
import { CloudflareKeyManager } from './cloudflare-key-manager'
import { CloudflareTaskManager, ensureMigrated } from './cloudflare-task-manager'
import { withAgentObject, routeContainerFetch, sleepingStore, type SleepingStore } from './cloudflare-container-control'
import { createCloudflareFileOps } from './cloudflare-file-ops'
import { ownedHere, servingAgentObject } from './agent-objects'
import { cloudflareAgentActor } from './cloudflare-agent-actor'
import type { Env } from './index'

let core: Promise<void> | undefined
let prepared: Promise<void> | undefined
let tasks: CloudflareTaskManager | undefined
let fetchWrapped = false

/** Boots the shared part in this isolate once; a failed boot is tried again by the next call. */
export function bootCore(env: Env): Promise<void> {
  core ??= start(env).catch((error: unknown) => {
    core = undefined
    throw error
  })
  return core
}

/** The part of the process setup (prepareProcess in startup.ts) that lives in this isolate's memory, once. */
export function prepareIsolate(): Promise<void> {
  prepared ??= prepare()
  return prepared
}

async function prepare(): Promise<void> {
  setServerAnalyticsVersion(APP_VERSION)
  registerAllAccountProviders()
  try {
    const platformToken = await getPlatformAccessToken()
    if (platformToken && decodeOrgIdFromToken(platformToken) !== null) installPlatformFetchInterceptor()
  } catch (error) {
    captureException(error, { tags: { component: 'startup', operation: 'install-fetch-interceptor' } })
  }
}

/** This isolate's TaskManager, whose handlers the org's task manager object runs jobs through. */
export function backgroundTasks(): CloudflareTaskManager {
  if (!tasks) throw new Error('SuperAgent has not booted in this isolate')
  return tasks
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
  // Task dispatch, before anything is served: a request can schedule work. Each role registers the Tasks it schedules.
  if (!isBackgroundWorkInitialized()) {
    tasks = new CloudflareTaskManager(env.TASK_MANAGER, env.VERSION?.timestamp)
    await initializeBackgroundWork(tasks)
  }
  if (!fetchWrapped) {
    // Outermost: the wrappers inside (platform attribution) can build a Request, which refuses redirect: 'error' on Workers.
    globalThis.fetch = errorOnRedirect(globalThis.fetch)
    fetchWrapped = true
  }
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
export function wireAgents(env: Env): void {
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
