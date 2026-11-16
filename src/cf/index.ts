/**
 * The Cloudflare entry point, next to src/main (Electron) and src/web (server). One Worker serves
 * one org: the UI from static assets, and the API from SuperAgent in this isolate. SuperAgent
 * loads on the first API request (boot.ts): evaluating it while the Worker starts goes over the
 * startup CPU limit.
 */
import type { D1Database, DurableObjectNamespace, ExecutionContext, ExportedHandler, Fetcher, R2Bucket } from 'cloudflare:workers'
import { captureException, flushErrorReporting } from '@shared/lib/error-reporting'
import { getServerFacts, withServerFacts, withServerFactsRevision } from '@shared/lib/facts/server-facts'
import type { AppStateDurableObject } from './cloudflare-app-state'
import { prepareDeploy, startTaskManager, type TaskManagerDurableObject } from './cloudflare-task-manager'
import { logErrorsAsText } from './error-logs'
import type { VersionMetadata } from './object-version'

export { AppStateDurableObject } from './cloudflare-app-state'
export { TaskManagerDurableObject } from './cloudflare-task-manager'

export interface Env {
  /** The org's database: SuperAgent's tables. */
  DB: D1Database
  /** The org's AppState: shared state and live events (cloudflare-app-state.ts). */
  APP_STATE: DurableObjectNamespace<AppStateDurableObject>
  /** The org's scheduled work, and where its background services run (cloudflare-task-manager.ts). */
  TASK_MANAGER: DurableObjectNamespace<TaskManagerDurableObject>
  /** The org's host files: blobs (profile photos, model icons, skillset caches) and the bytes of uploads in progress. */
  HOST_FILES: R2Bucket
  /** The built UI. */
  ASSETS: Fetcher
  /** The Browser Vault key, 32 bytes in base64: a Worker secret (cloudflare-key-manager.ts). */
  SUPERAGENT_VAULT_KEY?: string
  /** The origin browsers reach this Worker at. */
  APP_ORIGIN: string
  /** The settings a new org starts from, as JSON: its deployment's choice (seed-settings.ts). */
  SEED_SETTINGS?: string
  /** The secret the deploy step sends: a Worker secret. Without it the deploy step is refused. */
  DEPLOY_TOKEN?: string
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
      if (!(await deployAuthorized(request, env.DEPLOY_TOKEN))) return new Response('unauthorized', { status: 401 })
      await prepareDeploy(env)
      return Response.json({ version: env.VERSION?.id ?? null })
    }
    if (!pathname.startsWith('/api/')) return serveAppShell(request, env.ASSETS)
    try {
      const app = await import('./boot')
      const booting = app.boot(env)
      // A client that leaves mid-boot must not cancel the boot that later requests wait on.
      ctx.waitUntil(booting.catch(() => {}))
      await booting
      wakeTaskManager(env, ctx)
      return await app.serve(withClientAddress(request), env, ctx)
    } catch (error) {
      // A failed boot, or an error the API did not answer itself: reported before the request ends.
      captureException(error, { tags: { component: 'cloudflare', operation: 'serve' } })
      ctx.waitUntil(flushErrorReporting())
      throw error
    }
  },
} satisfies ExportedHandler<Env>

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

/** Each isolate makes sure, once, that the org's background services run. */
function wakeTaskManager(env: Env, ctx: ExecutionContext): void {
  if (taskManagerWoken) return
  taskManagerWoken = true
  ctx.waitUntil(startTaskManager(env).catch((error: unknown) => {
    taskManagerWoken = false
    console.error('[cloudflare] waking the task manager failed:', error)
    captureException(error, { tags: { component: 'cloudflare', operation: 'wake-task-manager' } })
    return flushErrorReporting()
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
