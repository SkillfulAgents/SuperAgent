/**
 * Serves SuperAgent's cloudflare-container runner in this isolate. A Worker cannot dial a
 * container's port, so the runner calls CLOUDFLARE_CONTAINER_URL (http://agent-container.internal)
 * and these calls are answered here, by intercepting fetch: `_control/<agentId>[/start|/stop]`
 * drives the agent's AgentDurableObject, and `<agentId>/<path>` (WebSocket upgrades too) goes to
 * its container's API. The agent reaches the host at CLOUDFLARE_CONTAINER_HOST_URL
 * (http://host.internal), which AgentDurableObject routes back to the Worker.
 */
import type { DurableObjectNamespace } from 'cloudflare:workers'
import type { AgentDurableObject } from './cloudflare-agent'
import { servingAgentObject } from './agent-objects'
import { reachCurrentCode } from './object-version'

const CONTAINER_HOST = 'agent-container.internal'
const CONTAINER_PORT = 3000

type AgentObjects = DurableObjectNamespace<AgentDurableObject>

/** Marks the 503 an agent's object answers while its agent is not running: a 503 crossing the stub keeps no null body to tell by. */
export const ASLEEP_HEADER = 'X-Agent-Asleep'

/** A saved file or folder, in the shape of the container's file API. */
export type StoredEntry = { name: string; path: string; type: 'file' | 'directory'; size?: number; modifiedAt?: string }

/** Bytes `start` to `end`, both included; no `end` reads to the end of the file. */
export type ByteRange = { start: number; end?: number }

/** An agent's saved workspace, read and written while its container is not running. */
export interface SleepingStore {
  /** A file, a directory's children, or null when neither exists. */
  entry(path: string): Promise<StoredEntry | StoredEntry[] | null>
  /** A file's bytes, or the range asked for, streamed from R2; `size` is the whole file's. */
  read(path: string, range?: ByteRange): Promise<{ size: number; stream: ReadableStream<Uint8Array> } | null>
  /** False when the container started meanwhile: the write has to go to the container. */
  write(path: string, bytes: Uint8Array): Promise<boolean>
  /** Removes a file or a directory with everything under it; false as for write. */
  remove(path: string): Promise<boolean>
}

/**
 * The agent's object: itself when it serves the current request (a call through its stub would
 * come back to it), and otherwise its stub, once it runs this deploy's code or newer.
 */
export async function withAgentObject<R>(agents: AgentObjects, agentId: string, version: string | undefined, run: (agent: AgentCalls) => R | Promise<R>): Promise<R> {
  const own = servingAgentObject(agentId)
  if (own) return run(own)
  await reachCurrentCode(agents, agentId, version)
  return run(agents.getByName(agentId) as unknown as AgentCalls)
}

/** The agent object's calls the rest of the org makes, as its stub answers them. */
type AgentCalls = Pick<AgentDurableObject, 'fetch' | 'actorCall' | 'agentRunning' | 'startAgent' | 'stopAgent' | 'storedEntry' | 'storedRead' | 'storedWrite' | 'storedRemove' | 'purgeWorkspace'>

export function sleepingStore(agents: AgentObjects, agentId: string, version: string | undefined): SleepingStore {
  const call = <R>(run: (agent: AgentCalls) => R | Promise<R>) => withAgentObject(agents, agentId, version, run)
  return {
    entry: (path) => call((agent) => agent.storedEntry(path)),
    read: (path, range) => call((agent) => agent.storedRead(path, range)),
    write: (path, bytes) => call((agent) => agent.storedWrite(path, bytes)),
    remove: (path) => call((agent) => agent.storedRemove(path)),
  }
}

let installed = false

/**
 * Sets the runner's configuration and answers its calls in this isolate. Called at boot, before
 * SuperAgent first starts a container; the token only has to match within this isolate.
 */
export function routeContainerFetch(agents: AgentObjects, version: string | undefined): void {
  if (installed) return
  installed = true
  const token = crypto.randomUUID()
  process.env.CLOUDFLARE_CONTAINER_URL = `http://${CONTAINER_HOST}`
  process.env.CLOUDFLARE_CONTAINER_HOST_URL = 'http://host.internal'
  process.env.CLOUDFLARE_CONTAINER_TOKEN = token

  const call = <R>(agentId: string, run: (agent: AgentCalls) => R | Promise<R>) => withAgentObject(agents, agentId, version, run)

  const control = async (request: Request, agentId: string, action: string): Promise<Response> => {
    if (request.headers.get('authorization') !== `Bearer ${token}`) return new Response('unauthorized', { status: 401 })
    if (request.method === 'GET' && action === '') return Response.json({ running: await call(agentId, (agent) => agent.agentRunning()) })
    if (request.method === 'POST' && action === 'start') {
      const { env } = (await request.json()) as { env: Record<string, string> }
      await call(agentId, (agent) => agent.startAgent(env))
      return new Response(null, { status: 204 })
    }
    if (request.method === 'POST' && action === 'stop') {
      await call(agentId, (agent) => agent.stopAgent())
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
    return call(decodeURIComponent(first), (agent) => agent.fetch(new Request(target, new Request(input, init))))
  }
}
