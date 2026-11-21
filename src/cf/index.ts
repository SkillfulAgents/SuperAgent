/**
 * The Cloudflare entry point, next to src/main (Electron) and src/web (server). One Worker serves
 * one org: the UI from static assets, and the API from SuperAgent in this isolate. SuperAgent
 * loads on the first API request (boot.ts): evaluating it while the Worker starts goes over the
 * startup CPU limit.
 */
import { WorkerEntrypoint, type D1Database, type DurableObjectNamespace, type ExecutionContext, type ExportedHandler, type Fetcher, type ImagesBinding, type R2Bucket } from 'cloudflare:workers'
import { captureException, flushErrorReporting } from '@shared/lib/error-reporting'
import { declareServerCapabilities, getServerFacts, withServerFacts, withServerFactsRevision } from '@shared/lib/facts/server-facts'
import { runWithBackground } from '@shared/lib/background'
import type { AppStateDurableObject } from './objects/cloudflare-app-state'
import { serveContainerCall, type AgentDurableObject } from './objects/cloudflare-agent'
import { DeployStepNotReady, needsLiveConnections, prepareDeploy, serveInTaskManager, type TaskManagerDurableObject } from './objects/cloudflare-task-manager'
import { logErrorsAsText } from './lib/cloudflare-error-reporting'
import { nearStorage } from './lib/object-location'
import type { VersionMetadata } from './lib/object-version'

export { AppStateDurableObject } from './objects/cloudflare-app-state'
export { TaskManagerDurableObject } from './objects/cloudflare-task-manager'
export { AgentDurableObject } from './objects/cloudflare-agent'

/**
 * A container's calls to http://host.internal and http://workspace.internal, which its
 * AgentDurableObject routes here (ctx.exports, by this name). The work they leave running keeps
 * the invocation alive.
 */
export class AgentContainerOutbound extends WorkerEntrypoint<Env, { containerId: string; agentName?: string }> {
  fetch(request: Request): Promise<Response> {
    return runWithBackground(this.ctx, () => serveContainerCall(withoutClientAddress(request), nearStorage(this.env), this.ctx.props.containerId, this.ctx.props.agentName))
  }
}

export interface Env {
  /** The org's database: SuperAgent's tables. */
  DB: D1Database
  /** The org's AppState: shared state and live events (cloudflare-app-state.ts). */
  APP_STATE: DurableObjectNamespace<AppStateDurableObject>
  /** The org's scheduled work, and where its background services run (cloudflare-task-manager.ts). */
  TASK_MANAGER: DurableObjectNamespace<TaskManagerDurableObject>
  /** The org's host files: blobs (profile photos, model icons, skillset caches) and the bytes of uploads in progress. */
  HOST_FILES: R2Bucket
  /** Cloudflare Images: HEIC photos to JPEG and profile photos (cloudflare-image-service.ts). */
  IMAGES: ImagesBinding
  /** One per agent: its container and, while it sleeps, its saved workspace (cloudflare-agent.ts). */
  AGENT: DurableObjectNamespace<AgentDurableObject>
  /** Agent workspace files, one object per content hash. */
  WORKSPACES: R2Bucket
  /** The built UI. */
  ASSETS: Fetcher
  /** The Browser Vault key, 32 bytes in base64: a Worker secret (cloudflare-key-manager.ts). */
  SUPERAGENT_VAULT_KEY?: string
  /** The origin browsers reach this Worker at. Unset: the origin of the request that first reaches a deploy. */
  APP_ORIGIN?: string
  /** Where the org's database is, as Cloudflare's location hint (such as "wnam"): new Durable Objects are made near it (object-location.ts). Unset: near their first caller. */
  STORAGE_LOCATION?: string
  /** The container snapshot agents start from, as JSON (id, name, size): its deployment keeps it warm. Unset: the image (container-snapshot.ts). */
  CONTAINER_SNAPSHOT?: string
  /** The instance type of each agent's container; unset: the one cloudflare-agent.ts names. */
  AGENT_INSTANCE_TYPE?: string
  /** The settings a new org starts from, as JSON: its deployment's choice (seed-settings.ts). */
  SEED_SETTINGS?: string
  /** The secret the deploy step sends: a Worker secret. Without it the deploy step is refused, and the first API request of each isolate runs the step. */
  DEPLOY_TOKEN?: string
  /** This deploy: an object on older code restarts when a caller on this one reaches it (object-version.ts). */
  VERSION?: VersionMetadata
}

logErrorsAsText()
// No file or process here outlives a request, and it is not the person's computer: nothing runs on the host.
declareServerCapabilities({
  canUseComputer: false,
  canRunHostScripts: false,
  canDriveUserChrome: false,
  canReadHostFoldersByPath: false,
  canFindHostApps: false,
  canRunHostGit: false,
})

const SERVICE_WORKER = '/sw.js'
/** The live browser view's WebSocket (browser-stream.ts). */
const BROWSER_STREAM_PATH = /^\/api\/agents\/([^/]+)\/browser\/stream$/
/** A dashboard's WebSockets (artifact-stream.ts). */
const ARTIFACT_STREAM_PATH = /^\/api\/agents\/[^/]+\/artifacts\/[^/]+(\/|$)/
/** The meeting bot host's frames of shared screens (meeting-frames.ts). */
const MEETING_FRAMES_PATH = /^\/api\/meeting-participant\/([^/]+)\/frames\/?$/
/** What the deploy step calls right after an upload (wrangler.jsonc). */
const DEPLOY_PATH = '/_deploy/prepare'
let deployPrepared = false

export default {
  async fetch(request: Request, bindings: Env, ctx: ExecutionContext): Promise<Response> {
    const env = nearStorage(bindings)
    const { pathname, origin } = new URL(request.url)
    if (pathname === DEPLOY_PATH && request.method === 'POST') {
      if (!(await deployAuthorized(request, env.DEPLOY_TOKEN))) return new Response('unauthorized', { status: 401 })
      try {
        await prepareDeploy(env, origin)
      } catch (error) {
        // Not an error of this deploy: the step's caller tries again until the object runs this code.
        if (error instanceof DeployStepNotReady) return new Response(error.message, { status: 503, headers: { 'retry-after': '1' } })
        throw error
      }
      return Response.json({ version: env.VERSION?.id ?? null })
    }
    if (!servedByApi(pathname)) return serveAppShell(request, env.ASSETS)
    try {
      // Before this isolate boots: the task manager object serves the request whole.
      if (needsLiveConnections(pathname)) {
        // The deploy's steps first, with this origin: they trust it for sign-in, and the object knows no origin.
        await prepareDeployOnce(env, ctx, origin)
        return await serveInTaskManager(withClientAddress(request), env)
      }
      const app = await import('./boot')
      const booting = app.boot(env)
      // A client that leaves mid-boot must not cancel the boot that later requests wait on.
      ctx.waitUntil(booting.catch(() => {}))
      await booting
      void prepareDeployOnce(env, ctx, origin)
      // A WebSocket upgrade does not go through the API's routes, as on the Node server (browser-stream-proxy.ts).
      if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        const browserStream = BROWSER_STREAM_PATH.exec(pathname)
        if (browserStream) return await (await import('./lib/browser-stream')).serveBrowserStream(request, decodeURIComponent(browserStream[1]), ctx)
        if (ARTIFACT_STREAM_PATH.test(pathname)) return await (await import('./lib/artifact-stream')).serveArtifactStream(withClientAddress(request))
        const meetingFrames = MEETING_FRAMES_PATH.exec(pathname)
        if (meetingFrames) return await (await import('./lib/meeting-frames')).serveMeetingFrames(request, meetingFrames[1])
      }
      return await app.serve(withClientAddress(request), env, ctx)
    } catch (error) {
      // A failed boot, or an error the API did not answer itself: reported before the request ends,
      // and answered as the API answers an error, not with the runtime's error page.
      console.error('[cloudflare] serving the request failed:', error)
      captureException(error, { tags: { component: 'cloudflare', operation: 'serve' } })
      ctx.waitUntil(flushErrorReporting())
      return Response.json({ error: 'Internal server error' }, { status: 500 })
    }
  },
} satisfies ExportedHandler<Env>

/**
 * True for a path the API answers rather than the UI: everything under /api/, and the Platform
 * sign-in launcher the API mounts at /auth in auth mode (src/api/index.ts), which Platform's
 * "Open Cloud Agents" link targets.
 */
export function servedByApi(pathname: string): boolean {
  return pathname.startsWith('/api/') || pathname.startsWith('/auth/')
}

/**
 * True when the request carries the deploy secret as a bearer token; with no secret set, nobody is
 * let in. The digests are compared in full, so the answer takes the same time whatever was sent.
 */
export async function deployAuthorized(request: Request, token: string | undefined): Promise<boolean> {
  if (!token) return false
  const digest = async (text: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  const [sent, expected] = await Promise.all([digest(request.headers.get('authorization') ?? ''), digest(`Bearer ${token}`)])
  let difference = 0
  for (let i = 0; i < expected.length; i++) difference |= sent[i] ^ expected[i]
  return difference === 0
}

/**
 * The client's address where SuperAgent reads it (x-forwarded-for, as the cloud load balancer sets
 * it): Cloudflare's cf-connecting-ip, which a client cannot set. Without it every client shares one
 * address, so one client's sign-in attempts use up everyone's limit. An address the client sent
 * itself never counts, with or without Cloudflare's.
 */
export function withClientAddress(request: Request): Request {
  const headers = new Headers(request.headers)
  headers.delete('x-forwarded-for')
  headers.delete('x-real-ip')
  const address = request.headers.get('cf-connecting-ip')
  if (address) headers.set('x-forwarded-for', address)
  return new Request(request, { headers })
}

/**
 * A container's call with no client address on it. It does not come through Cloudflare's edge, so
 * every address header on it, cf-connecting-ip too, is what the agent's own code sent.
 */
export function withoutClientAddress(request: Request): Request {
  const headers = new Headers(request.headers)
  for (const name of ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip']) headers.delete(name)
  return new Request(request, { headers })
}

/**
 * Each isolate makes sure, once, that this deploy's steps ran, for a deployment that does not call
 * the deploy step. Resolves once they ran, or failed; a failed one is tried again by the next request.
 */
function prepareDeployOnce(env: Env, ctx: ExecutionContext, origin: string): Promise<void> {
  if (deployPrepared) return Promise.resolve()
  deployPrepared = true
  const prepared = prepareDeploy(env, origin).catch(async (error: unknown) => {
    deployPrepared = false
    // The object still runs the previous code and restarts on this one: not an error.
    if (error instanceof DeployStepNotReady) return
    console.error('[cloudflare] preparing the deploy failed:', error)
    captureException(error, { tags: { component: 'cloudflare', operation: 'prepare-deploy' } })
    await flushErrorReporting()
  })
  ctx.waitUntil(prepared)
  return prepared
}

/**
 * How long a browser keeps a static file, by the rule of src/web/web-build.ts: a bundle under
 * /assets/ has its content's hash in its name, so it never changes; a file with a fixed name
 * (an icon, the manifest) is asked for again after an hour.
 */
const staticCacheControl = (pathname: string) => (pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600, must-revalidate')

/**
 * The UI's files. Its HTML entry and service worker get this server's facts filled in, as
 * src/web/web-build.ts does; every other file is passed on with the time a browser may keep it.
 */
export async function serveAppShell(request: Request, assets: Fetcher): Promise<Response> {
  const response = await assets.fetch(request)
  const { pathname } = new URL(request.url)
  const isServiceWorker = pathname === SERVICE_WORKER
  const isHtml = response.headers.get('content-type')?.startsWith('text/html') ?? false
  if (!isServiceWorker && !isHtml) {
    // Not on an error: a missing file must not be remembered as missing.
    if (!response.ok && response.status !== 304) return response
    const kept = new Response(response.body, response)
    kept.headers.set('cache-control', staticCacheControl(pathname))
    return kept
  }
  if (!response.ok) return response

  const facts = getServerFacts()
  const body = isServiceWorker ? withServerFactsRevision(await response.text(), facts) : withServerFacts(await response.text(), facts)
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.delete('etag')
  // A reload always finds the latest bundles, and a deploy's service worker is picked up at once.
  headers.set('cache-control', 'no-cache')
  return new Response(body, { status: response.status, headers })
}
