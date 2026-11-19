import Database from 'better-sqlite3'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { inactivityTimeoutMs, AgentDurableObject, bridgeWebSocket, serveWorkspaceRequest } from './cloudflare-agent'
import { SavedWorkspace, linkTarget, workspaceBlobKey } from '../lib/saved-workspace'
import { createObjectSessionIndexStorage } from '../lib/object-session-index-storage'
import type { Env } from '../index'
import { captureException } from '@shared/lib/error-reporting'
import { describeFileOpsContract } from '@shared/lib/agent-actor/testing/file-ops-contract'
import { createCloudflareFileOps } from '../cloudflare-file-ops'
import { sleepingStoreOn } from '../cloudflare-container-control'

vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))
// The app must not boot to list a sleeping agent: its session index is in the object's own SQLite.
const { boot, syncAgentStatus } = vi.hoisted(() => ({ boot: vi.fn(), syncAgentStatus: vi.fn(async () => {}) }))
vi.mock('../boot', () => ({ boot, syncAgentStatus, runAgentActorOp: async () => ({ value: 'from the actor' }), autoSleepTimeoutMs: async () => 30 * 60_000 }))

// Workers' FixedLengthStream, which Node lacks: here a pass-through.
beforeAll(() => {
  vi.stubGlobal('FixedLengthStream', class extends TransformStream {
    constructor(_length: number) {
      super()
    }
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

const OBJECT = 'a'.repeat(64)
const HASH = 'b'.repeat(64)

/** R2 in memory; a put with a sha256 that does not match is refused, as R2 does. */
function bucket(hashOf: (bytes: string) => string) {
  const objects = new Map<string, string>()
  return {
    objects,
    get: vi.fn(async (key: string) => (objects.has(key) ? { body: new Response(objects.get(key)).body } : null)),
    put: vi.fn(async (key: string, body: ReadableStream, options: { sha256: string }) => {
      const bytes = await new Response(body).text()
      if (hashOf(bytes) !== options.sha256) throw new Error('The SHA-256 checksum you specified did not match what we received.')
      objects.set(key, bytes)
    }),
  }
}

function env(r2: ReturnType<typeof bucket>) {
  const agent = { workspaceRequest: vi.fn(async () => new Response(null, { status: 202 })) }
  const value = {
    WORKSPACES: r2,
    AGENT: { idFromString: (id: string) => id, get: vi.fn(() => agent), getByName: vi.fn(() => agent) },
  } as unknown as Env
  return { value, agent }
}

const put = (bytes: string) => new Request(`http://workspace.internal/blobs/${HASH}`, {
  method: 'PUT',
  headers: { 'x-content-length': String(bytes.length) },
  body: bytes,
})

describe('serveWorkspaceRequest', () => {
  it("serves a file's bytes from R2 without the agent's object", async () => {
    const r2 = bucket(() => HASH)
    r2.objects.set(workspaceBlobKey(OBJECT, HASH), '# Lead research')
    const { value, agent } = env(r2)

    const response = await serveWorkspaceRequest(new Request(`http://workspace.internal/blobs/${HASH}`), value, OBJECT)

    expect(await response.text()).toBe('# Lead research')
    expect(agent.workspaceRequest).not.toHaveBeenCalled()
  })

  it("stores uploaded bytes in R2 without a call to the agent's object", async () => {
    const r2 = bucket(() => HASH)
    const { value, agent } = env(r2)

    const response = await serveWorkspaceRequest(put('Find the decision maker.'), value, OBJECT)

    expect(response.status).toBe(204)
    expect(r2.objects.get(workspaceBlobKey(OBJECT, HASH))).toBe('Find the decision maker.')
    expect(r2.put.mock.calls[0][2]).toEqual({ sha256: HASH })
    expect(agent.workspaceRequest).not.toHaveBeenCalled()
  })

  it('refuses bytes that no longer match their hash and keeps the stored copy', async () => {
    const r2 = bucket(() => 'c'.repeat(64))
    r2.objects.set(workspaceBlobKey(OBJECT, HASH), 'the earlier, matching bytes')
    const { value } = env(r2)

    const response = await serveWorkspaceRequest(put('changed while it was read'), value, OBJECT)

    expect(response.status).toBe(409)
    expect(r2.objects.get(workspaceBlobKey(OBJECT, HASH))).toBe('the earlier, matching bytes')
  })

  it("hands the container's changes to the agent's object", async () => {
    const r2 = bucket(() => HASH)
    const { value, agent } = env(r2)

    const response = await serveWorkspaceRequest(new Request('http://workspace.internal/changes', { method: 'POST', body: '{"entries":[],"removed":[]}' }), value, OBJECT)

    expect(response.status).toBe(202)
    expect(agent.workspaceRequest).toHaveBeenCalledTimes(1)
  })

  it("reaches the agent's object by its name when the container's route names it, so the object knows its agent", async () => {
    const { value } = env(bucket(() => HASH))
    const namespace = value.AGENT as unknown as { get: ReturnType<typeof vi.fn>; getByName: ReturnType<typeof vi.fn> }

    await serveWorkspaceRequest(new Request('http://workspace.internal/changes', { method: 'POST', body: '{"entries":[],"removed":[]}' }), value, OBJECT, 'sales')

    expect(namespace.getByName).toHaveBeenCalledWith('sales')
    expect(namespace.get).not.toHaveBeenCalled()
  })
})

/** The real stop code, on an object whose container calls are recorded instead of made. */
function agent(saved: boolean) {
  const calls: string[] = []
  const object = Object.create(AgentDurableObject.prototype) as AgentDurableObject & Record<string, unknown>
  Object.assign(object, {
    ctx: { id: { name: 'sales agent' } },
    saveWorkspace: async () => {
      calls.push('save')
      return saved
    },
    stop: async () => {
      calls.push('stop')
    },
    containerUp: async () => false,
    cancelIdleCheck: async () => {
      calls.push('cancelIdleCheck')
    },
  })
  /** The object's private members, which a test sets or replaces. */
  const internals = object as unknown as Record<string, unknown>
  return { object, calls, internals }
}

describe('AgentDurableObject stop', () => {
  it('stops the container after the workspace is saved, then drops its idle check', async () => {
    const { object, calls } = agent(true)

    await object.stopAgent()

    expect(calls).toEqual(['save', 'stop', 'cancelIdleCheck'])
  })

  it('keeps the container running when the save fails, and says so', async () => {
    const { object, calls } = agent(false)

    await expect(object.stopAgent()).rejects.toThrow('Saving the workspace of agent sales agent failed')
    expect(calls).toEqual(['save'])
  })

  it('waits for the container it watches to exit before the stop is over', async () => {
    const { object, calls, internals } = agent(true)
    let exit: () => void = () => {}
    internals.watching = new Promise<void>((resolve) => {
      exit = resolve
    })

    const stopped = object.stopAgent().then(() => calls.push('stopped'))
    await vi.waitFor(() => expect(calls).toEqual(['save', 'stop']))
    exit()
    await stopped

    expect(calls).toEqual(['save', 'stop', 'cancelIdleCheck', 'stopped'])
  })

  it('drops the container of an agent being deleted without saving its workspace', async () => {
    const { object, calls, internals } = agent(true)
    internals.containerUp = async () => true
    internals.destroy = async () => {
      calls.push('destroy')
    }

    await object.stopAgent({ discard: true })

    expect(calls).toEqual(['destroy', 'cancelIdleCheck'])
  })

  it('stops an agent whose container never started without signalling it', async () => {
    const { object } = agent(true)
    const signal = vi.fn(() => {
      throw new Error('signal() cannot be called on a container that is not running')
    })
    // The real `stop`, on a container that is not running.
    const real = object as unknown as { stop?: unknown; ctx: Record<string, unknown> }
    delete real.stop
    real.ctx.container = { running: false, signal }

    await object.stopAgent()

    expect(signal).not.toHaveBeenCalled()
  })
})

describe('AgentDurableObject while its agent starts', () => {
  /** A container whose agent process exists, so /state answers launched, as it does before the agent's API listens. */
  function launching(starting?: Promise<void>) {
    const object = Object.create(AgentDurableObject.prototype) as AgentDurableObject & Record<string, unknown>
    Object.assign(object, {
      ctx: { id: { name: 'sales agent' }, container: { running: true } },
      containerFetch: async () => Response.json({ launched: true }),
      starting,
    })
    return object
  }

  it('reads as not running until the start has finished, so reads stay on the saved workspace', async () => {
    expect(await launching(new Promise<void>(() => {})).agentRunning()).toBe(false)
  })

  it('reads as running once the start has finished', async () => {
    expect(await launching().agentRunning()).toBe(true)
  })

  it('leaves a container that gives no answer alone, and removes one that answers it has no agent', async () => {
    const destroy = vi.fn(async () => {})
    const silent = launching()
    Object.assign(silent, { destroy, containerFetch: async () => { throw new Error('Network connection lost.') } })
    expect(await silent.agentRunning()).toBe(false)
    expect(destroy).not.toHaveBeenCalled()

    const empty = launching()
    Object.assign(empty, { destroy, containerFetch: async () => Response.json({ launched: false }) })
    expect(await empty.agentRunning()).toBe(false)
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('does not start a new container over one that gives no answer', async () => {
    const destroy = vi.fn(async () => {})
    const startContainer = vi.fn(async () => {})
    const silent = launching()
    Object.assign(silent, { destroy, startContainer, containerFetch: async () => { throw new Error('Network connection lost.') } })

    await expect(silent.startAgent({})).rejects.toThrow('is up but does not answer')

    expect(destroy).not.toHaveBeenCalled()
    expect(startContainer).not.toHaveBeenCalled()
  })

  it('asks a container that failed to answer once again before its silence counts', async () => {
    const object = launching()
    let asked = 0
    Object.assign(object, { containerFetch: async () => (++asked === 1 ? Promise.reject(new Error('Network connection lost.')) : Response.json({ launched: true })) })
    expect(await object.agentRunning()).toBe(true)
  })

  it('is not proven stopped while it starts or its container is up', async () => {
    expect(await launching(new Promise<void>(() => {})).containerStopped()).toBe(false)
    expect(await launching().containerStopped()).toBe(false)
  })
})

describe('AgentDurableObject with no container', () => {
  it('is proven stopped, so a session of a stopped agent can be deleted', async () => {
    const object = Object.create(AgentDurableObject.prototype) as AgentDurableObject & Record<string, unknown>
    Object.assign(object, { ctx: { id: { name: 'sales agent' }, container: { running: false } } })
    expect(await object.containerStopped()).toBe(true)
  })
})

/** The object's SQLite in memory, with the tables its constructor makes. */
function storage() {
  const db = new Database(':memory:')
  const sql = {
    exec: (query: string, ...bindings: unknown[]) => {
      const statement = db.prepare(query)
      // The object's SQLite takes and gives bytes as an ArrayBuffer; this one as a Buffer.
      const bound = bindings.map((value) => (value instanceof ArrayBuffer ? Buffer.from(value) : value))
      let rowsWritten = 0
      const rows = (statement.reader ? statement.all(...bound) : ((rowsWritten = statement.run(...bound).changes), [])) as Array<Record<string, unknown>>
      for (const row of rows) for (const [key, value] of Object.entries(row)) if (Buffer.isBuffer(value)) row[key] = new Uint8Array(value).buffer
      return { toArray: () => rows, rowsWritten }
    },
  }
  return { sql, transactionSync: <T>(run: () => T) => db.transaction(run)() }
}

/** A running agent's object with real save code over in-memory SQLite and R2. */
function runningAgent(running = true) {
  const r2 = new Map<string, string>()
  /** R2 writes wait for this, so a test can look before they land. */
  const puts = { gate: Promise.resolve() }
  const object = Object.create(AgentDurableObject.prototype) as AgentDurableObject & Record<string, unknown>
  const ctx = { id: { name: 'sales agent', toString: () => OBJECT }, storage: storage() }
  const bucket = {
    head: async (key: string) => (r2.has(key) ? {} : null),
    delete: async (keys: string[]) => keys.forEach((key) => r2.delete(key)),
    put: async (key: string, bytes: ArrayBuffer | Uint8Array) => {
      await puts.gate
      r2.set(key, new TextDecoder().decode(bytes))
    },
    get: async (key: string) => (r2.has(key) ? { body: new Response(r2.get(key)).body } : null),
  }
  Object.assign(object, {
    ctx,
    env: { WORKSPACES: bucket },
    // The real saved workspace, which makes its own tables, over the in-memory SQLite and R2.
    workspace: new SavedWorkspace(ctx.storage as never, bucket as never, OBJECT),
    storeLock: Promise.resolve(),
    agentUp: async () => running,
  })
  const saved = () => ctx.storage.sql.exec('SELECT path, hash, kind FROM workspace_file ORDER BY path').toArray()
  const pending = () => ctx.storage.sql.exec('SELECT hash FROM workspace_pending ORDER BY hash').toArray().map((row) => (row as { hash: string }).hash)
  const send = (entries: unknown[], removed: string[] = [], uploaded: string[] = []) =>
    object.workspaceRequest(new Request('http://workspace.internal/changes', { method: 'POST', body: JSON.stringify({ entries, removed, uploaded }) }))
  /** What the container does: send, upload what the object asks for, send again naming the uploads. */
  const save = async (entries: Array<{ hash: string }>, removed: string[] = []) => {
    const first = await send(entries, removed)
    if (first.status !== 409) return first
    const { missing } = (await first.json()) as { missing: string[] }
    for (const hash of missing) r2.set(workspaceBlobKey(OBJECT, hash), `bytes of ${hash.slice(0, 4)}`)
    return send(entries, removed, missing)
  }
  return { object, ctx, r2, puts, saved, pending, send, save }
}

const file = (path: string, hash: string) => ({ path, hash, size: 4, mode: 0o644, mtimeMs: 1, kind: 'file' })
const H1 = '1'.repeat(64)
const H2 = '2'.repeat(64)

describe("AgentDurableObject saving the container's changes", () => {
  it('asks for the bytes of a new file before it saves anything, and marks them pending', async () => {
    const agent = runningAgent()

    const response = await agent.send([file('notes/leads.md', H1)])

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ missing: [H1] })
    expect(agent.saved()).toEqual([])
    expect(agent.pending()).toEqual([H1])
  })

  it('saves the file once the container names the bytes it uploaded', async () => {
    const agent = runningAgent()

    expect((await agent.save([file('notes/leads.md', H1)])).status).toBe(204)

    expect(agent.saved()).toEqual([{ path: 'notes/leads.md', hash: H1, kind: 'file' }])
  })

  it('does not take an upload it did not ask for', async () => {
    const agent = runningAgent()

    const response = await agent.send([file('notes/leads.md', H1)], [], [H1])

    expect(response.status).toBe(409)
    expect(agent.saved()).toEqual([])
  })

  it('asks again when the bytes it asked for were dropped before the container named its upload', async () => {
    const agent = runningAgent()
    await agent.send([file('notes/leads.md', H1)])
    // A full save settles pending bytes no file uses, between the ask and the upload.
    agent.ctx.storage.sql.exec('DELETE FROM workspace_pending')

    const response = await agent.send([file('notes/leads.md', H1)], [], [H1])

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ missing: [H1] })
  })

  it('saves a changed file and drops the bytes of its earlier version', async () => {
    const agent = runningAgent()
    expect((await agent.save([file('notes/leads.md', H1)])).status).toBe(204)

    expect((await agent.save([file('notes/leads.md', H2)])).status).toBe(204)

    expect(agent.saved()).toEqual([{ path: 'notes/leads.md', hash: H2, kind: 'file' }])
    expect(agent.r2.has(workspaceBlobKey(OBJECT, H1))).toBe(false)
  })

  it('removes a folder with everything under it', async () => {
    const agent = runningAgent()
    await agent.save([file('drafts/a.md', H1), file('drafts/old/b.md', H2), file('drafts-2026.md', H1)])

    expect((await agent.send([], ['drafts'])).status).toBe(204)

    expect(agent.saved()).toEqual([{ path: 'drafts-2026.md', hash: H1, kind: 'file' }])
    expect(agent.r2.has(workspaceBlobKey(OBJECT, H2))).toBe(false)
  })

  it('keeps only the folder when a file became a folder, and only the file when a folder became a file', async () => {
    const agent = runningAgent()
    await agent.save([file('notes', H1), file('drafts/a.md', H1)])

    // One batch can carry the new kind without naming the old entry as removed.
    await agent.save([file('notes/today.md', H2)])
    expect(agent.saved()).toEqual([{ path: 'drafts/a.md', hash: H1, kind: 'file' }, { path: 'notes/today.md', hash: H2, kind: 'file' }])

    await agent.save([file('drafts', H2)])
    expect(agent.saved()).toEqual([{ path: 'drafts', hash: H2, kind: 'file' }, { path: 'notes/today.md', hash: H2, kind: 'file' }])
    expect(agent.r2.has(workspaceBlobKey(OBJECT, H1))).toBe(false)
  })

  it('keeps the bytes of a renamed file, which the removed path and the new one share', async () => {
    const agent = runningAgent()
    await agent.save([file('notes/leads.md.tmp', H1)])

    expect((await agent.send([file('notes/leads.md', H1)], ['notes/leads.md.tmp'])).status).toBe(204)

    expect(agent.saved()).toEqual([{ path: 'notes/leads.md', hash: H1, kind: 'file' }])
    expect(agent.r2.has(workspaceBlobKey(OBJECT, H1))).toBe(true)
  })

  it('refuses an entry outside the workspace or with a malformed hash, and saves nothing of that request', async () => {
    const { send, saved, pending } = runningAgent()

    for (const entry of [file('../etc/passwd', H1), file('/etc/passwd', H1), file('notes/./a.md', H1), file('notes/a.md', 'not-a-hash'), { ...file('notes/a.md', H1), mode: -1 }]) {
      expect((await send([file('notes/ok.md', H2), entry])).status).toBe(400)
    }
    expect((await send([], ['../outside'])).status).toBe(400)
    expect((await send([], [], ['not-a-hash'])).status).toBe(400)

    expect(saved()).toEqual([])
    expect(pending()).toEqual([])
  })

  it('refuses changes when the agent is not running, so a stray container cannot replace the saved workspace', async () => {
    const agent = runningAgent(false)
    agent.r2.set(workspaceBlobKey(OBJECT, H1), 'a')

    expect((await agent.send([file('notes/leads.md', H1)])).status).toBe(409)
    expect(agent.saved()).toEqual([])
  })
})

describe('bridgeWebSocket', () => {
  type Listener = (event: { data?: unknown; code?: number; reason?: string }) => void
  function socket() {
    const listeners = new Map<string, Listener>()
    const sent: unknown[] = []
    return {
      sent,
      accept: () => {},
      close: () => {},
      send: (data: unknown) => sent.push(data),
      addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
      deliver: (data: unknown) => listeners.get('message')!({ data }),
    }
  }

  it('forwards a binary message that arrives as a Blob as its bytes, in the order the messages came', async () => {
    const container = socket()
    const server = socket()
    vi.stubGlobal('WebSocketPair', class {
      0 = socket()
      1 = server
    })
    // Node's Response refuses a 101 status and a webSocket: the bridge's answer is not looked at here.
    const NodeResponse = globalThis.Response
    vi.stubGlobal('Response', class {})

    bridgeWebSocket({ status: 101, headers: new Headers() } as Response, container as never)
    container.deliver(new Blob([new Uint8Array([0xff, 0xd8, 0xff])]))
    container.deliver('{"type":"frame-done"}')
    await vi.waitFor(() => expect(server.sent).toHaveLength(2))
    vi.stubGlobal('Response', NodeResponse)

    expect([...new Uint8Array(server.sent[0] as ArrayBuffer)]).toEqual([0xff, 0xd8, 0xff])
    expect(server.sent[1]).toBe('{"type":"frame-done"}')
  })
})

describe("AgentDurableObject starting its agent's container", () => {
  const SNAPSHOT = { id: 'snap-1', name: 'agent-0.6.11', size: 2254857830 }
  type Start = { image?: string; containerSnapshot?: unknown; entrypoint: string[]; env: Record<string, string> }

  /** The real start code over a container that records each start; `ports` says whether the n-th start's port opens. */
  function starting(variable: string | undefined, ports: boolean[] = [true]) {
    const starts: Start[] = []
    const calls: string[] = []
    const container = {
      running: false,
      images: { agent: 'registry.example.com/agent@sha256:abc' },
      start: (options: Start) => {
        starts.push(options)
        container.running = true
      },
      setInactivityTimeout: async () => {},
      destroy: async () => {
        calls.push('destroy')
        container.running = false
      },
      exec: async () => ({ output: async () => ({ stdout: new TextEncoder().encode('CLOUDFLARE_LOCATION=sjc04\n').buffer }) }),
    }
    const object = Object.create(AgentDurableObject.prototype) as AgentDurableObject
    Object.assign(object, {
      ctx: { id: { name: 'sales agent' }, container },
      env: { CONTAINER_SNAPSHOT: variable },
      routeContainerCalls: async () => {
        calls.push('route')
      },
      watchContainer: () => {},
      waitForPort: async () => {
        if (!ports[starts.length - 1]) throw new Error("Port 8090 of agent sales agent's container did not open")
      },
    })
    const start = () => (object as unknown as { startContainer(env: Record<string, string>): Promise<void> }).startContainer({ AGENT_ID: 'sales agent' })
    return { start, starts, calls }
  }

  beforeAll(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('starts from the container snapshot the deployment names, inside the image it holds', async () => {
    const { start, starts } = starting(JSON.stringify(SNAPSHOT))

    await start()

    expect(starts).toHaveLength(1)
    expect(starts[0].containerSnapshot).toEqual(SNAPSHOT)
    expect(starts[0].image).toBeUndefined()
    expect(starts[0].entrypoint.join(' ')).toContain('exec chroot /img')
    expect(starts[0].env).toEqual({ AGENT_ID: 'sales agent' })
  })

  it('starts from the image when the deployment names no snapshot', async () => {
    const { start, starts } = starting(undefined)

    await start()

    expect(starts.map((options) => [options.image, options.containerSnapshot])).toEqual([['registry.example.com/agent@sha256:abc', undefined]])
    expect(starts[0].entrypoint).toEqual(['gamut-start', 'node', '/opt/gamut/cloudflare/cf-workspace-server.mjs'])
  })

  it('starts from the image in the same call when the snapshot start fails, and reports where it failed', async () => {
    vi.mocked(captureException).mockClear()
    const { start, starts, calls } = starting(JSON.stringify(SNAPSHOT), [false, true])

    await start()

    expect(starts.map((options) => (options.containerSnapshot ? 'snapshot' : 'image'))).toEqual(['snapshot', 'image'])
    // The failed container is gone before the image starts, and the image's container gets its own routes.
    expect(calls).toEqual(['route', 'destroy', 'route'])
    expect(captureException).toHaveBeenCalledTimes(1)
    expect(vi.mocked(captureException).mock.calls[0][1]).toMatchObject({ extra: { agent: 'sales agent', snapshot: 'agent-0.6.11', location: 'sjc04' } })
  })

  it('starts from the image, and reports it, when the variable is not a snapshot handle', async () => {
    vi.mocked(captureException).mockClear()
    const { start, starts } = starting('{"id":"snap-1"}')

    await start()

    expect(starts.map((options) => (options.containerSnapshot ? 'snapshot' : 'image'))).toEqual(['image'])
    expect(captureException).toHaveBeenCalledTimes(1)
  })

  it('fails the start when the image does not come up either', async () => {
    const { start, starts } = starting(JSON.stringify(SNAPSHOT), [false, false])

    await expect(start()).rejects.toThrow('did not open')
    expect(starts).toHaveLength(2)
  })
})

describe('AgentDurableObject writing a file while its agent sleeps', () => {
  const text = async (read: { stream: ReadableStream<Uint8Array> } | null) => (read ? new Response(read.stream).text() : null)
  /** Past the wait after the last change, and through the store's turn that follows. */
  const settled = async (agent: ReturnType<typeof runningAgent>) => {
    await vi.advanceTimersByTimeAsync(2_000)
    await (agent.object as unknown as { storeLock: Promise<unknown> }).storeLock
  }
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  it('answers a small write before R2 has it, reads it back at once, and then moves it to R2', async () => {
    const agent = runningAgent(false)
    let open = () => {}
    agent.puts.gate = new Promise<void>((resolve) => { open = resolve })

    expect(await agent.object.storedWrite('AGENTS.md', new TextEncoder().encode('first'))).toBe(true)

    expect(agent.r2.size).toBe(0)
    expect(await text(await agent.object.storedRead('AGENTS.md'))).toBe('first')
    expect(await text(await agent.object.storedRead('AGENTS.md', { start: 1, end: 2 }))).toBe('ir')

    // Nothing goes to R2 while changes may still be coming.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(agent.r2.size).toBe(0)

    open()
    await settled(agent)
    expect([...agent.r2.values()]).toEqual(['first'])
    expect(agent.ctx.storage.sql.exec('SELECT hash FROM workspace_held').toArray()).toEqual([])
    expect(agent.pending()).toEqual([])
    expect(await text(await agent.object.storedRead('AGENTS.md'))).toBe('first')
  })

  it('leaves only the newest bytes in R2 after the file is written again', async () => {
    const agent = runningAgent(false)
    await agent.object.storedWrite('AGENTS.md', new TextEncoder().encode('first'))
    await agent.object.storedWrite('AGENTS.md', new TextEncoder().encode('second'))
    await settled(agent)
    expect([...agent.r2.values()]).toEqual(['second'])
    expect(await text(await agent.object.storedRead('AGENTS.md'))).toBe('second')
  })

  it('writes a large file to R2 before it answers', async () => {
    const agent = runningAgent(false)
    const large = new Uint8Array(300 * 1024).fill(97)
    expect(await agent.object.storedWrite('data.bin', large)).toBe(true)
    expect(agent.r2.size).toBe(1)
    expect(agent.ctx.storage.sql.exec('SELECT hash FROM workspace_held').toArray()).toEqual([])
  })

  it('does not write while the agent runs: the write belongs to its container', async () => {
    const agent = runningAgent(true)
    expect(await agent.object.storedWrite('AGENTS.md', new TextEncoder().encode('first'))).toBe(false)
    expect(agent.saved()).toEqual([])
  })

  it('keeps both of two appends made at the same time, and reads nothing past the end of a file', async () => {
    const agent = runningAgent(false)
    await agent.object.storedWrite('session.jsonl', new TextEncoder().encode('{"turn":0}\n'))

    const added = await Promise.all([
      agent.object.appendToFile('session.jsonl', new TextEncoder().encode('{"turn":1}\n')),
      agent.object.appendToFile('session.jsonl', new TextEncoder().encode('{"turn":2}\n')),
    ])

    expect(added).toEqual(['done', 'done'])
    expect(await text(await agent.object.storedRead('session.jsonl'))).toBe('{"turn":0}\n{"turn":1}\n{"turn":2}\n')
    expect(await text(await agent.object.storedRead('session.jsonl', { start: 500 }))).toBe('')
    expect(await text(await agent.object.storedRead('session.jsonl', { start: 22, end: 900 }))).toBe('{"turn":2}\n')
    expect(await agent.object.appendToFile('voice/notes.txt', new TextEncoder().encode('hello'))).toBe('done')
    expect(await text(await agent.object.storedRead('voice/notes.txt'))).toBe('hello')
    expect(await agent.object.appendToFile('voice', new TextEncoder().encode('x'))).toBe('not-a-file')
  })

  it("adds to a running agent's file through the container's cf-workspace-server, which refuses a folder", async () => {
    const agent = runningAgent()
    const sent: string[] = []
    Object.assign(agent.object, {
      containerFetch: async (request: Request, port: number) => {
        const { pathname, searchParams } = new URL(request.url)
        sent.push(`${port} ${request.method} ${pathname} ${searchParams.get('path')}: ${await request.text()}`)
        return searchParams.get('path') === 'logs' ? new Response('not a file', { status: 409 }) : new Response('appended')
      },
    })

    expect(await agent.object.appendToFile('session.jsonl', new TextEncoder().encode('{"turn":1}\n'))).toBe('done')
    expect(await agent.object.appendToFile('logs', new TextEncoder().encode('x'))).toBe('not-a-file')

    expect(sent).toEqual(['8090 POST /append session.jsonl: {"turn":1}\n', '8090 POST /append logs: x'])
    expect(agent.saved()).toEqual([])
  })

  it('keeps a folder made while the agent sleeps, and lists only what is in the folder asked for', async () => {
    const agent = runningAgent(false)
    await agent.object.storedWrite('reports/q3.md', new TextEncoder().encode('Q3'))
    await agent.object.storedWrite('reports-old/q1.md', new TextEncoder().encode('Q1'))

    expect(await agent.object.storedMkdir('drafts')).toBe(true)
    // Something is already there: no folder row is added over it.
    expect(await agent.object.storedMkdir('reports')).toBe(true)

    expect(agent.saved().map((row) => `${(row as { kind: string }).kind} ${(row as { path: string }).path}`)).toEqual(['dir drafts', 'file reports-old/q1.md', 'file reports/q3.md'])
    expect(await agent.object.storedEntry('drafts')).toEqual([])
    expect(await agent.object.storedEntry('reports')).toEqual([expect.objectContaining({ path: 'reports/q3.md', type: 'file' })])
    expect(((await agent.object.storedEntry('')) as Array<{ path: string }>).map((entry) => entry.path).sort()).toEqual(['drafts', 'reports', 'reports-old'])

    expect(await agent.object.storedRemove('reports')).toBe(true)
    expect(agent.saved().map((row) => (row as { path: string }).path)).toEqual(['drafts', 'reports-old/q1.md'])
  })

  it('refuses a write that would leave a file and a folder at one path', async () => {
    const agent = runningAgent(false)
    const bytes = new TextEncoder().encode('Q3')
    await agent.object.storedWrite('reports/q3.md', bytes)

    // As codes: an error thrown in the object reaches its caller without its class.
    expect(await agent.object.storedWrite('reports', bytes)).toBe('not-a-file')
    expect(await agent.object.storedWrite('reports/q3.md/notes.md', bytes)).toBe('not-a-directory')
    expect(await agent.object.storedMkdir('reports/q3.md/attachments')).toBe('not-a-directory')
    expect(await agent.object.appendToFile('reports/q3.md/log.txt', bytes)).toBe('not-a-directory')

    expect(agent.saved().map((row) => (row as { path: string }).path)).toEqual(['reports/q3.md'])
  })

  it("restores each file with the time it was last changed", async () => {
    const agent = runningAgent(false)
    await agent.object.storedWrite('AGENTS.md', new TextEncoder().encode('first'))
    agent.ctx.storage.sql.exec('UPDATE workspace_file SET mtime = ?', Date.UTC(2026, 9, 22, 12))
    let restored: Array<{ path: string; mtimeMs: number }> = []
    Object.assign(agent.object, {
      containerFetch: async (request: Request) => {
        restored = ((await request.json()) as { files: typeof restored }).files
        return new Response('restored')
      },
    })

    await (agent.object as unknown as { restoreWorkspace(): Promise<void> }).restoreWorkspace()

    expect(restored).toEqual([expect.objectContaining({ path: 'AGENTS.md', mtimeMs: Date.UTC(2026, 9, 22, 12) })])
  })
})

describe('AgentDurableObject listing its agent', () => {
  /** A sleeping agent with one dashboard in its saved workspace and one session in the index. */
  function sleepingAgent() {
    const agent = runningAgent(false)
    Object.assign(agent.ctx, { container: { running: false } })
    const files = {
      'artifacts/sales/package.json': JSON.stringify({ name: 'Sales', scripts: { start: 'bun run server.ts' } }),
      'artifacts/sales/screenshot.png': 'png',
    }
    for (const [path, bytes] of Object.entries(files)) {
      const hash = path.endsWith('package.json') ? H1 : H2
      agent.ctx.storage.sql.exec("INSERT INTO workspace_file (path, hash, size, mode, mtime, kind) VALUES (?, ?, ?, 420, 1, 'file')", path, hash, bytes.length)
      agent.r2.set(workspaceBlobKey(OBJECT, hash), bytes)
    }
    boot.mockReset()
    return agent
  }

  it('answers for a sleeping agent from its saved files and its session index, without booting the app', async () => {
    const { object, ctx } = sleepingAgent()
    await createObjectSessionIndexStorage(() => ctx.storage.sql as never).fill([
      { sessionId: 'weekly-report', meta: null, transcript: { mtimeMs: Date.parse('2026-11-12T09:30:00Z'), birthtimeMs: 1, size: 200 } },
    ])

    const outcome = await object.actorCall('listing', [])

    expect(boot).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({
      value: {
        live: { container: { status: 'stopped' }, activeSessionIds: [], awaitingSessionIds: [], openRequests: [], pendingReviews: [] },
        sessions: { sessionIds: ['weekly-report'], sessionCount: 1, lastActivityAt: new Date('2026-11-12T09:30:00Z') },
        artifacts: { dashboards: [{ slug: 'sales', name: 'Sales', hasScreenshot: true }] },
        refreshingWidgets: [],
      },
    })
  })

  it("asks the agent's actor once this object has run it, or while a container runs: it may hold live state", async () => {
    const booted = sleepingAgent()
    await booted.object.actorCall('live', [])
    expect(await booted.object.actorCall('listing', [])).toEqual({ value: 'from the actor' })

    const running = sleepingAgent()
    Object.assign(running.ctx, { container: { running: true } })
    expect(await running.object.actorCall('listing', [])).toEqual({ value: 'from the actor' })
    expect(boot).toHaveBeenCalled()
  })

  it("reads the container's status again when the container exits by itself, once this object has run the actor", async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const exit = (object: unknown) => (object as { onContainerExit(outcome: string): void }).onContainerExit('code 137')

    const asleep = sleepingAgent()
    syncAgentStatus.mockClear()
    exit(asleep.object)
    await vi.waitFor(() => expect(log).toHaveBeenCalled())
    expect(syncAgentStatus).not.toHaveBeenCalled()

    const booted = sleepingAgent()
    await booted.object.actorCall('live', [])
    expect(syncAgentStatus).toHaveBeenCalledTimes(1)
    exit(booted.object)
    await vi.waitFor(() => expect(syncAgentStatus).toHaveBeenCalledTimes(2))
    log.mockRestore()
  })

  it('asks the actor when the reading without it fails', async () => {
    const { object, ctx } = sleepingAgent()
    // The object's SQLite refuses the index's statements.
    const exec = ctx.storage.sql.exec
    ctx.storage.sql.exec = (query: string, ...bindings: unknown[]) => {
      if (query.includes('agent_session')) throw new Error('disk I/O error')
      return exec(query, ...bindings)
    }
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await object.actorCall('listing', [])).toEqual({ value: 'from the actor' })
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
  })
})

describe('AgentDurableObject agent name', () => {
  const kv = () => {
    const values = new Map<string, unknown>()
    return { get: (key: string) => values.get(key), put: (key: string, value: unknown) => void values.set(key, value), delete: (key: string) => values.delete(key) }
  }
  const objectWith = (id: { name?: string; toString(): string }, store: ReturnType<typeof kv>) => {
    const object = Object.create(AgentDurableObject.prototype) as Record<string, unknown>
    Object.assign(object, { ctx: { id, storage: { kv: store } } })
    return object as unknown as { agentSlug(): string; agentName(): string }
  }

  it('keeps the name it was first reached by, for a later instance reached by id', () => {
    const store = kv()
    const named = { name: 'sales', toString: () => '92fe3b64fead0000' }
    // What the constructor does for an instance reached by name.
    if (named.name) store.put('agent-name', named.name)
    expect(objectWith(named, store).agentSlug()).toBe('sales')

    const byId = { toString: () => '92fe3b64fead0000' }
    expect(objectWith(byId, store).agentSlug()).toBe('sales')
  })

  it('refuses to act for an agent when it was only ever reached by id', () => {
    const byId = { toString: () => '92fe3b64fead0000' }
    expect(() => objectWith(byId, kv()).agentSlug()).toThrow(/reached by id/)
    expect(objectWith(byId, kv()).agentName()).toBe('92fe3b64')
  })
})

describe('SavedWorkspace reading a link while its agent sleeps', () => {
  const linked = async () => {
    const store = storage()
    const bucket = { put: async () => {}, get: async () => null, head: async () => null, delete: async () => {} }
    const workspace = new SavedWorkspace(store as never, bucket as never, OBJECT)
    await workspace.write('reports/q3.csv', new TextEncoder().encode('region,revenue\nwest,120\n'))
    const link = (path: string, target: string) =>
      store.sql.exec("INSERT INTO workspace_file (path, hash, size, mode, mtime, kind, target) VALUES (?, '', 0, 511, 0, 'symlink', ?)", path, target)
    link('latest.csv', 'reports/q3.csv')
    link('reports/again.csv', '../latest.csv')
    link('outside.csv', '../../etc/passwd')
    link('loop-a', 'loop-b')
    link('loop-b', 'loop-a')
    return workspace
  }

  it('reads a relative link to a file, and a link to that link, as the file at the link path', async () => {
    const workspace = await linked()
    expect(workspace.entry('latest.csv')).toMatchObject({ name: 'latest.csv', path: 'latest.csv', type: 'file', size: 24 })
    const read = await workspace.read('reports/again.csv')
    expect(await new Response(read!.stream).text()).toBe('region,revenue\nwest,120\n')
  })

  it('finds nothing at a link out of the workspace or in a loop', async () => {
    const workspace = await linked()
    expect(workspace.entry('outside.csv')).toBeNull()
    expect(await workspace.read('loop-a')).toBeNull()
  })

  it('resolves a link target against the link folder, inside the workspace only', () => {
    expect(linkTarget('a/b/link', '../c.txt')).toBe('a/c.txt')
    expect(linkTarget('link', '/workspace/a.txt')).toBe('a.txt')
    expect(linkTarget('link', '/etc/passwd')).toBeNull()
    expect(linkTarget('a/link', '../../x')).toBeNull()
  })
})

describe('inactivityTimeoutMs', () => {
  it('runs a container past the auto-sleep timeout, and as long as the runtime allows when auto-sleep is off', () => {
    expect(inactivityTimeoutMs(30 * 60_000)).toBe(35 * 60_000)
    expect(inactivityTimeoutMs(120 * 60_000)).toBe(125 * 60_000)
    expect(inactivityTimeoutMs(24 * 60 * 60_000)).toBe(6 * 60 * 60_000)
    expect(inactivityTimeoutMs(0)).toBe(6 * 60 * 60_000)
  })
})

// The shared contract over the real file ops, object and saved workspace of a sleeping agent.
describeFileOpsContract('Cloudflare file ops while the agent sleeps', () => {
  const { object } = runningAgent(false)
  return {
    files: createCloudflareFileOps(async () => null, sleepingStoreOn(async (run) => run(object))),
    dispose: () => clearTimeout((object as unknown as { settleTimer?: ReturnType<typeof setTimeout> }).settleTimer),
  }
})

describe('SavedWorkspace writing a large file from a stream', () => {
  /** R2 in memory with multipart uploads; parts must be one size but the last, as R2 asks. */
  function multipartBucket() {
    const objects = new Map<string, Uint8Array>()
    const join = (chunks: Uint8Array[]) => {
      const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
      let at = 0
      for (const c of chunks) {
        out.set(c, at)
        at += c.byteLength
      }
      return out
    }
    const bucket = {
      objects,
      createMultipartUpload: async (key: string) => {
        const parts = new Map<number, Uint8Array>()
        return {
          uploadPart: async (n: number, bytes: Uint8Array) => {
            parts.set(n, bytes.slice())
            return { partNumber: n, etag: `etag-${n}` }
          },
          complete: async (done: Array<{ partNumber: number }>) => {
            const sizes = done.slice(0, -1).map((p) => parts.get(p.partNumber)!.byteLength)
            if (new Set(sizes).size > 1) throw new Error('parts must be one size')
            objects.set(key, join(done.map((p) => parts.get(p.partNumber)!)))
          },
          abort: async () => {},
        }
      },
      get: async (key: string) => (objects.has(key) ? { body: new Response(objects.get(key)! as Uint8Array<ArrayBuffer>).body! } : null),
      put: async (key: string, body: ReadableStream<Uint8Array> | Uint8Array) => {
        objects.set(key, body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer()))
      },
      delete: async (keys: string | string[]) => {
        for (const key of [keys].flat()) objects.delete(key)
      },
    }
    return bucket
  }

  const nodeCrypto = globalThis.crypto
  afterAll(() => void vi.stubGlobal('crypto', nodeCrypto))
  beforeAll(() => {
    // Workers' DigestStream, which Node lacks: a writable that hashes what it is given.
    vi.stubGlobal('crypto', {
      randomUUID: () => nodeCrypto.randomUUID(),
      subtle: nodeCrypto.subtle,
      getRandomValues: <T extends ArrayBufferView>(array: T) => nodeCrypto.getRandomValues(array),
      DigestStream: class extends WritableStream<Uint8Array> {
        readonly digest: Promise<ArrayBuffer>
        constructor() {
          const chunks: Uint8Array[] = []
          let done: () => void = () => {}
          const closed = new Promise<void>((resolve) => { done = resolve })
          super({ write: (chunk) => void chunks.push(chunk.slice()), close: () => done() })
          this.digest = closed.then(() => nodeCrypto.subtle.digest('SHA-256', new Uint8Array(Buffer.concat(chunks))))
        }
      },
    })
  })

  it('stores the file under its hash, in parts of one size, and leaves nothing else in R2', async () => {
    const store = storage()
    const bucket = multipartBucket()
    const workspace = new SavedWorkspace(store as never, bucket as never, OBJECT)
    const bytes = new Uint8Array(20 * 1024 * 1024 + 123)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
    let at = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= bytes.length) return controller.close()
        const size = Math.min(3 * 1024 * 1024 + 7, bytes.length - at)
        controller.enqueue(bytes.slice(at, at + size))
        at += size
      },
    })

    await workspace.writeStream('data/export.bin', body, 0o600)

    const hash = Buffer.from(await nodeCrypto.subtle.digest('SHA-256', bytes)).toString('hex')
    expect([...bucket.objects.keys()]).toEqual([workspaceBlobKey(OBJECT, hash)])
    expect(Buffer.compare(Buffer.from(bucket.objects.get(workspaceBlobKey(OBJECT, hash))!), Buffer.from(bytes))).toBe(0)
    expect(store.sql.exec('SELECT path, hash, size, mode FROM workspace_file').toArray()).toEqual([{ path: 'data/export.bin', hash, size: bytes.length, mode: 0o600 }])
  })

  it('refuses a stream over a folder before it reads it', async () => {
    const store = storage()
    const workspace = new SavedWorkspace(store as never, multipartBucket() as never, OBJECT)
    workspace.mkdir('data')
    let pulled = false
    // No buffer: the stream is pulled only when something reads it.
    const body = new ReadableStream<Uint8Array>({ pull: () => void (pulled = true) }, { highWaterMark: 0 })
    await expect(workspace.writeStream('data', body)).rejects.toMatchObject({ code: 'not-a-file' })
    expect(pulled).toBe(false)
  })
})
