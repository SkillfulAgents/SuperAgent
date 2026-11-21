/**
 * Serves SuperAgent's cloudflare-container runner in this isolate. A Worker cannot dial a
 * container's port, so the boot installs agentContainers as how the runner reaches its agents
 * (installCloudflareContainers): `_control/<agentId>[/start|/stop|/stopped]` drives the agent's
 * AgentDurableObject, and `<agentId>/<path>` (WebSocket upgrades too) goes to its container's API.
 * The agent reaches the host at http://host.internal, which AgentDurableObject routes back to the Worker.
 */
import type { DurableObjectNamespace } from 'cloudflare:workers'
import { CLOUDFLARE_CONTAINER_ORIGIN, type CloudflareContainers } from '@shared/lib/container/cloudflare-container-runtime'
import type { AgentDurableObject } from './objects/cloudflare-agent'
import { servingAgentObject } from './objects/cloudflare-agent-actor'
import { reachCurrentCode } from './lib/object-version'

const CONTAINER_HOST = new URL(CLOUDFLARE_CONTAINER_ORIGIN).hostname
const CONTAINER_PORT = 3000

type AgentObjects = DurableObjectNamespace<AgentDurableObject>

/** Marks the 503 an agent's object answers while its agent is not running: a 503 crossing the stub keeps no null body to tell by. */
export const ASLEEP_HEADER = 'X-Agent-Asleep'

/** A saved file or folder, in the shape of the container's file API. */
export type StoredEntry = { name: string; path: string; type: 'file' | 'directory'; size?: number; modifiedAt?: string; mode?: number }

/**
 * A change the saved workspace refuses as the agent's disk would, by its WorkspaceFileError code:
 * an error thrown in the agent's object reaches the caller without its class.
 */
export type StoredRefusal = 'not-a-file' | 'not-a-directory'

/** Bytes `start` to `end`, both included; no `end` reads to the end of the file. */
export type ByteRange = { start: number; end?: number }

/** What the file ops ask of an agent's object: its saved workspace, read and written while its container is not running, and an append in either state. */
export interface SleepingStore {
  /** A file, a directory's children, or null when neither exists. */
  entry(path: string): Promise<StoredEntry | StoredEntry[] | null>
  /** A file's bytes, or the range asked for, streamed from R2; `size` is the whole file's. */
  read(path: string, range?: ByteRange): Promise<{ size: number; stream: ReadableStream<Uint8Array> } | null>
  /** False when the container started meanwhile: the write has to go to the container. A refusal when a folder is in the way. */
  write(path: string, bytes: Uint8Array, mode?: number): Promise<boolean | StoredRefusal>
  /** As write, for a file too large to hold whole; false leaves the stream unread. */
  writeStream(path: string, body: ReadableStream<Uint8Array>, mode?: number): Promise<boolean | StoredRefusal>
  /** Removes a file or a directory with everything under it; false as for write. */
  remove(path: string): Promise<boolean>
  /** Keeps an empty directory, unless something is already there; false and a refusal as for write. */
  mkdir(path: string): Promise<boolean | StoredRefusal>
  /**
   * Adds bytes to the end of a file, or makes it, wherever the agent's files are now: in its container
   * while the agent runs, in the saved workspace while it sleeps. Appends take turns, so none is lost.
   */
  appendToFile(path: string, bytes: Uint8Array): Promise<'done' | StoredRefusal>
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
export type AgentCalls = Pick<AgentDurableObject, 'fetch' | 'actorCall' | 'agentRunning' | 'containerStopped' | 'startAgent' | 'stopAgent' | 'storedEntry' | 'storedRead' | 'storedWrite' | 'storedWriteStream' | 'storedRemove' | 'storedMkdir' | 'appendToFile' | 'purgeWorkspace'>

/** An agent's saved workspace, each call made on the agent's object through `call`. */
export function sleepingStoreOn(call: <R>(run: (agent: AgentCalls) => R | Promise<R>) => Promise<R>): SleepingStore {
  return {
    entry: (path) => call((agent) => agent.storedEntry(path)),
    read: (path, range) => call((agent) => agent.storedRead(path, range)),
    write: (path, bytes, mode) => call((agent) => agent.storedWrite(path, bytes, mode)),
    writeStream: (path, body, mode) => call((agent) => agent.storedWriteStream(path, body, mode)),
    remove: (path) => call((agent) => agent.storedRemove(path)),
    mkdir: (path) => call((agent) => agent.storedMkdir(path)),
    appendToFile: (path, bytes) => call((agent) => agent.appendToFile(path, bytes)),
  }
}

/** The saved workspace of the agent `agentId`: on its own object inside that object's request, through its stub anywhere else. */
export function sleepingStore(agents: AgentObjects, agentId: string, version: string | undefined): SleepingStore {
  return sleepingStoreOn((run) => withAgentObject(agents, agentId, version, run))
}

/**
 * How the runner reaches the agents' containers in this isolate. Only the runner's own calls come
 * here, never the global fetch, so a control call needs no token.
 */
export function agentContainers(agents: AgentObjects, version: string | undefined): CloudflareContainers {
  const call = <R>(agentId: string, run: (agent: AgentCalls) => R | Promise<R>) => withAgentObject(agents, agentId, version, run)

  const control = async (request: Request, agentId: string, action: string): Promise<Response> => {
    if (request.method === 'GET' && action === '') return Response.json({ running: await call(agentId, (agent) => agent.agentRunning()) })
    if (request.method === 'GET' && action === 'stopped') return Response.json({ stopped: await call(agentId, (agent) => agent.containerStopped()) })
    if (request.method === 'POST' && action === 'start') {
      const { env } = (await request.json()) as { env: Record<string, string> }
      await call(agentId, (agent) => agent.startAgent(env))
      return new Response(null, { status: 204 })
    }
    if (request.method === 'POST' && action === 'stop') {
      const discard = request.headers.has('content-type') && ((await request.json()) as { discard?: boolean }).discard === true
      await call(agentId, (agent) => agent.stopAgent({ discard }))
      return new Response(null, { status: 204 })
    }
    return new Response('not found', { status: 404 })
  }

  return {
    hostUrl: 'http://host.internal',
    fetch: async (input, init) => {
      const url = new URL(input)
      if (url.hostname !== CONTAINER_HOST) throw new Error(`Not a call to an agent's container: ${url.origin}`)
      const [, first, ...rest] = url.pathname.split('/')
      if (first === '_control') return control(new Request(input, init), decodeURIComponent(rest[0] ?? ''), rest[1] ?? '')
      const target = `http://127.0.0.1:${CONTAINER_PORT}/${rest.join('/')}${url.search}`
      return call(decodeURIComponent(first), (agent) => agent.fetch(new Request(target, new Request(input, init))))
    },
  }
}
