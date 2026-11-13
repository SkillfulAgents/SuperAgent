/**
 * The Cloudflare entry point, next to src/main (Electron) and src/web (server). One Worker serves
 * one org: the UI from static assets, and the API from SuperAgent in this isolate. SuperAgent
 * loads on the first API request (boot.ts): evaluating it while the Worker starts goes over the
 * startup CPU limit.
 */
import { WorkerEntrypoint, type D1Database, type DurableObjectNamespace, type ExecutionContext, type ExportedHandler, type Fetcher, type R2Bucket } from 'cloudflare:workers'
import { getServerFacts, withServerFacts, withServerFactsRevision } from '@shared/lib/facts/server-facts'
import { runWithBackground } from '@shared/lib/background'
import type { AppStateDurableObject } from './cloudflare-app-state'
import { serveContainerCall, type AgentDurableObject } from './cloudflare-agent'
import { prepareDeploy, startTaskManager, type TaskManagerDurableObject } from './cloudflare-task-manager'
import { logErrorsAsText } from './error-logs'
import type { VersionMetadata } from './object-version'

export { AppStateDurableObject } from './cloudflare-app-state'
export { TaskManagerDurableObject } from './cloudflare-task-manager'
export { AgentDurableObject } from './cloudflare-agent'

/**
 * A container's calls to http://host.internal and http://workspace.internal, which its
 * AgentDurableObject routes here (ctx.exports, by this name). The work they leave running keeps
 * the invocation alive.
 */
export class AgentContainerOutbound extends WorkerEntrypoint<Env, { containerId: string }> {
  fetch(request: Request): Promise<Response> {
    return runWithBackground(this.ctx, () => serveContainerCall(request, this.env, this.ctx.props.containerId))
  }
}

export interface Env {
  /** The org's database: SuperAgent's tables. */
  DB: D1Database
  /** The org's AppState: shared state and live events (cloudflare-app-state.ts). */
  APP_STATE: DurableObjectNamespace<AppStateDurableObject>
  /** The org's scheduled work, and where its background services run (cloudflare-task-manager.ts). */
  TASK_MANAGER: DurableObjectNamespace<TaskManagerDurableObject>
  /** One per agent: its container and, while it sleeps, its saved workspace (cloudflare-agent.ts). */
  AGENT: DurableObjectNamespace<AgentDurableObject>
  /** Agent workspace files, one object per content hash. */
  WORKSPACES: R2Bucket
  /** The built UI. */
  ASSETS: Fetcher
  /** The Browser Vault key, 32 bytes in base64: a Worker secret (cloudflare-key-manager.ts). */
  SUPERAGENT_VAULT_KEY?: string
  /** The origin browsers reach this Worker at. */
  APP_ORIGIN: string
  /** This deploy: an object on older code restarts when a caller on this one reaches it (object-version.ts). */
  VERSION?: VersionMetadata
}

logErrorsAsText()

const SERVICE_WORKER = '/sw.js'
/** What the deploy step calls right after an upload (wrangler.jsonc). */
const DEPLOY_PATH = '/_deploy/prepare'
let taskManagerWoken = false

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname === DEPLOY_PATH && request.method === 'POST') {
      await prepareDeploy(env)
      return Response.json({ version: env.VERSION?.id ?? null })
    }
    if (!pathname.startsWith('/api/')) return serveAppShell(request, env.ASSETS)
    const app = await import('./boot')
    const booting = app.boot(env)
    // A client that leaves mid-boot must not cancel the boot that later requests wait on.
    ctx.waitUntil(booting.catch(() => {}))
    await booting
    wakeTaskManager(env, ctx)
    return app.serve(withClientAddress(request), env, ctx)
  },
} satisfies ExportedHandler<Env>

/**
 * The client's address where SuperAgent reads it (x-forwarded-for, as the cloud load balancer sets
 * it): Cloudflare's cf-connecting-ip, which a client cannot set. Without it every client shares one
 * address, so one client's sign-in attempts use up everyone's limit.
 */
export function withClientAddress(request: Request): Request {
  const address = request.headers.get('cf-connecting-ip')
  if (!address) return request
  const headers = new Headers(request.headers)
  headers.set('x-forwarded-for', address)
  headers.delete('x-real-ip')
  return new Request(request, { headers })
}

/** Each isolate makes sure, once, that the org's background services run. */
function wakeTaskManager(env: Env, ctx: ExecutionContext): void {
  if (taskManagerWoken) return
  taskManagerWoken = true
  ctx.waitUntil(startTaskManager(env).catch((error: unknown) => {
    taskManagerWoken = false
    console.error('[cloudflare] waking the task manager failed:', error)
  }))
}

/** The UI's HTML entry and service worker with this server's facts filled in, as src/web/web-build.ts does. */
async function serveAppShell(request: Request, assets: Fetcher): Promise<Response> {
  const response = await assets.fetch(request)
  const isServiceWorker = new URL(request.url).pathname === SERVICE_WORKER
  const isHtml = response.headers.get('content-type')?.startsWith('text/html') ?? false
  if (!response.ok || (!isServiceWorker && !isHtml)) return response

  const facts = getServerFacts()
  const body = isServiceWorker ? withServerFactsRevision(await response.text(), facts) : withServerFacts(await response.text(), facts)
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.delete('etag')
  // A reload always finds the latest bundles, and a deploy's service worker is picked up at once.
  headers.set('cache-control', 'no-cache')
  return new Response(body, { status: response.status, headers })
}
