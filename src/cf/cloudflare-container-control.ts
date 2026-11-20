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

export function sleepingStore(agents: AgentObjects, agentId: string): SleepingStore {
  const agent = () => agents.getByName(agentId)
  return {
    entry: (path) => agent().storedEntry(path),
    read: (path, range) => agent().storedRead(path, range),
    write: (path, bytes, mode) => agent().storedWrite(path, bytes, mode),
    remove: (path) => agent().storedRemove(path),
    mkdir: (path) => agent().storedMkdir(path),
    appendToFile: (path, bytes) => agent().appendToFile(path, bytes),
  }
}

/**
 * How the runner reaches the agents' containers in this isolate. Only the runner's own calls come
 * here, never the global fetch, so a control call needs no token.
 */
export function agentContainers(agents: AgentObjects): CloudflareContainers {
  const control = async (request: Request, agentId: string, action: string): Promise<Response> => {
    const agent = agents.getByName(agentId)
    if (request.method === 'GET' && action === '') return Response.json({ running: await agent.agentRunning() })
    if (request.method === 'GET' && action === 'stopped') return Response.json({ stopped: await agent.containerStopped() })
    if (request.method === 'POST' && action === 'start') {
      const { env } = (await request.json()) as { env: Record<string, string> }
      await agent.startAgent(env)
      return new Response(null, { status: 204 })
    }
    if (request.method === 'POST' && action === 'stop') {
      const discard = request.headers.has('content-type') && ((await request.json()) as { discard?: boolean }).discard === true
      await agent.stopAgent({ discard })
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
      return agents.getByName(decodeURIComponent(first)).fetch(new Request(target, new Request(input, init)))
    },
  }
}
