/**
 * Serves SuperAgent's cloudflare-container runner in this isolate. A Worker cannot dial a
 * container's port, so the runner calls CLOUDFLARE_CONTAINER_URL (http://agent-container.internal)
 * and these calls are answered here, by intercepting fetch: `_control/<agentId>[/start|/stop]`
 * drives the agent's CloudflareAgentActor, and `<agentId>/<path>` (WebSocket upgrades too) goes to
 * its container's API. The agent reaches the host at CLOUDFLARE_CONTAINER_HOST_URL
 * (http://host.internal), which CloudflareAgentActor routes back to the Worker.
 */
import type { DurableObjectNamespace } from 'cloudflare:workers'
import type { CloudflareAgentActor } from './cloudflare-agent-actor'

const CONTAINER_HOST = 'agent-container.internal'
const CONTAINER_PORT = 3000

type AgentActors = DurableObjectNamespace<CloudflareAgentActor>

/** Marks the 503 an agent's object answers while its agent is not running: a 503 crossing the stub keeps no null body to tell by. */
export const ASLEEP_HEADER = 'X-Agent-Asleep'

/** A saved file or folder, in the shape of the container's file API. */
export type StoredEntry = { name: string; path: string; type: 'file' | 'directory'; size?: number; modifiedAt?: string }

/** An agent's saved workspace, read and written while its container is not running. */
export interface SleepingStore {
  /** A file, a directory's children, or null when neither exists. */
  entry(path: string): Promise<StoredEntry | StoredEntry[] | null>
  read(path: string): Promise<Uint8Array | null>
  /** False when the container started meanwhile: the write has to go to the container. */
  write(path: string, bytes: Uint8Array): Promise<boolean>
  /** Removes a file or a directory with everything under it; false as for write. */
  remove(path: string): Promise<boolean>
}

export function sleepingStore(actors: AgentActors, agentId: string): SleepingStore {
  const actor = () => actors.getByName(agentId)
  return {
    entry: (path) => actor().storedEntry(path),
    read: (path) => actor().storedRead(path),
    write: (path, bytes) => actor().storedWrite(path, bytes),
    remove: (path) => actor().storedRemove(path),
  }
}

let installed = false

/**
 * Sets the runner's configuration and answers its calls in this isolate. Called at boot, before
 * SuperAgent first starts a container; the token only has to match within this isolate.
 */
export function routeContainerFetch(actors: AgentActors): void {
  if (installed) return
  installed = true
  const token = crypto.randomUUID()
  process.env.CLOUDFLARE_CONTAINER_URL = `http://${CONTAINER_HOST}`
  process.env.CLOUDFLARE_CONTAINER_HOST_URL = 'http://host.internal'
  process.env.CLOUDFLARE_CONTAINER_TOKEN = token

  const control = async (request: Request, agentId: string, action: string): Promise<Response> => {
    if (request.headers.get('authorization') !== `Bearer ${token}`) return new Response('unauthorized', { status: 401 })
    const actor = actors.getByName(agentId)
    if (request.method === 'GET' && action === '') return Response.json({ running: await actor.agentRunning() })
    if (request.method === 'POST' && action === 'start') {
      const { env } = (await request.json()) as { env: Record<string, string> }
      await actor.startAgent(env)
      return new Response(null, { status: 204 })
    }
    if (request.method === 'POST' && action === 'stop') {
      await actor.stopAgent()
      return new Response(null, { status: 204 })
    }
    return new Response('not found', { status: 404 })
  }

  const fetchOutside = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname !== CONTAINER_HOST) return fetchOutside(input, init)
    const [, first, ...rest] = url.pathname.split('/')
    if (first === '_control') return control(new Request(input, init), decodeURIComponent(rest[0] ?? ''), rest[1] ?? '')
    const target = `http://127.0.0.1:${CONTAINER_PORT}/${rest.join('/')}${url.search}`
    return actors.getByName(decodeURIComponent(first)).fetch(new Request(target, new Request(input, init)))
  }
}
