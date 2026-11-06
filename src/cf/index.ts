/**
 * The Cloudflare entry point, next to src/main (Electron) and src/web (server). One Worker serves
 * one org: the UI from static assets, and the API from SuperAgent in this isolate. SuperAgent
 * loads on the first API request (boot.ts): evaluating it while the Worker starts goes over the
 * startup CPU limit.
 */
import type { D1Database, DurableObjectNamespace, ExecutionContext, ExportedHandler, Fetcher } from 'cloudflare:workers'
import { getServerFacts, withServerFacts, withServerFactsRevision } from '@shared/lib/facts/server-facts'
import type { AppStateDurableObject } from './app-state-durable-object'
import { taskManagerOf, type TaskManagerDurableObject } from './task-manager-durable-object'

export { AppStateDurableObject } from './app-state-durable-object'
export { TaskManagerDurableObject } from './task-manager-durable-object'

export interface Env {
  /** The org's database: SuperAgent's tables. */
  DB: D1Database
  /** The org's AppState: shared state and live events (app-state-durable-object.ts). */
  APP_STATE: DurableObjectNamespace<AppStateDurableObject>
  /** The org's scheduled work, and where its background services run (task-manager-durable-object.ts). */
  TASK_MANAGER: DurableObjectNamespace<TaskManagerDurableObject>
  /** The built UI. */
  ASSETS: Fetcher
  /** The Browser Vault key, 32 bytes in base64: a Worker secret (cloudflare-key-manager.ts). */
  SUPERAGENT_VAULT_KEY?: string
  /** The origin browsers reach this Worker at. */
  APP_ORIGIN: string
}

const SERVICE_WORKER = '/sw.js'
let taskManagerWoken = false

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!new URL(request.url).pathname.startsWith('/api/')) return serveAppShell(request, env.ASSETS)
    const app = await import('./boot')
    const booting = app.boot(env)
    // A client that leaves mid-boot must not cancel the boot that later requests wait on.
    ctx.waitUntil(booting.catch(() => {}))
    await booting
    wakeTaskManager(env, ctx)
    return app.serve(request, env, ctx)
  },
} satisfies ExportedHandler<Env>

/** Each isolate makes sure, once, that the org's background services run. */
function wakeTaskManager(env: Env, ctx: ExecutionContext): void {
  if (taskManagerWoken) return
  taskManagerWoken = true
  ctx.waitUntil(taskManagerOf(env.TASK_MANAGER).wake().catch((error: unknown) => {
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
