import Database from 'better-sqlite3'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { AgentDurableObject, serveWorkspaceRequest, workspaceBlobKey } from './cloudflare-agent'
import type { Env } from './index'

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
  const agent = { markBlobPending: vi.fn(async () => {}), workspaceRequest: vi.fn(async () => new Response(null, { status: 202 })) }
  const value = {
    WORKSPACES: r2,
    AGENT: { idFromString: (id: string) => id, get: () => agent },
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
    expect(agent.markBlobPending).not.toHaveBeenCalled()
  })

  it('stores uploaded bytes in R2 after the object has recorded them as pending', async () => {
    const r2 = bucket(() => HASH)
    const { value, agent } = env(r2)

    const response = await serveWorkspaceRequest(put('Find the decision maker.'), value, OBJECT)

    expect(response.status).toBe(204)
    expect(r2.objects.get(workspaceBlobKey(OBJECT, HASH))).toBe('Find the decision maker.')
    expect(agent.markBlobPending).toHaveBeenCalledWith(HASH)
    expect(agent.markBlobPending.mock.invocationCallOrder[0]).toBeLessThan(r2.put.mock.invocationCallOrder[0])
    expect(r2.put.mock.calls[0][2]).toEqual({ sha256: HASH })
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
  })
  return { object, calls }
}

describe('AgentDurableObject stop', () => {
  it('stops the container after the workspace is saved', async () => {
    const { object, calls } = agent(true)

    await object.stopAgent()

    expect(calls).toEqual(['save', 'stop'])
  })

  it('keeps the container running when the save fails, and says so', async () => {
    const { object, calls } = agent(false)

    await expect(object.stopAgent()).rejects.toThrow('Saving the workspace of agent sales agent failed')
    expect(calls).toEqual(['save'])
  })

  it('logs a failed idle stop, so the library renews the timeout and tries again', async () => {
    const { object, calls } = agent(false)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await object.onActivityExpired()

    expect(calls).toEqual(['save'])
    expect(error).toHaveBeenCalledWith('[AgentDurableObject sales agent] idle stop failed:', expect.any(Error))
    error.mockRestore()
  })
})

/** The object's SQLite in memory, with the tables its constructor makes. */
function storage() {
  const db = new Database(':memory:')
  db.exec("CREATE TABLE workspace_file (path TEXT PRIMARY KEY, hash TEXT NOT NULL, size INTEGER NOT NULL, mode INTEGER NOT NULL, mtime INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'file', target TEXT)")
  db.exec('CREATE TABLE workspace_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)')
  db.exec('CREATE TABLE workspace_pending (hash TEXT PRIMARY KEY)')
  const sql = {
    exec: (query: string, ...bindings: unknown[]) => {
      const statement = db.prepare(query)
      const rows = statement.reader ? statement.all(...bindings) : (statement.run(...bindings), [])
      return { toArray: () => rows }
    },
  }
  return { sql, transactionSync: <T>(run: () => T) => db.transaction(run)() }
}

/** A running agent's object with real save code over in-memory SQLite and R2. */
function runningAgent(running = true) {
  const r2 = new Map<string, string>()
  const object = Object.create(AgentDurableObject.prototype) as AgentDurableObject & Record<string, unknown>
  const ctx = { id: { name: 'sales agent', toString: () => OBJECT }, storage: storage() }
  Object.assign(object, {
    ctx,
    env: {
      WORKSPACES: {
        head: async (key: string) => (r2.has(key) ? {} : null),
        delete: async (keys: string[]) => keys.forEach((key) => r2.delete(key)),
      },
    },
    storeLock: Promise.resolve(),
    agentUp: async () => running,
  })
  const saved = () => ctx.storage.sql.exec('SELECT path, hash, kind FROM workspace_file ORDER BY path').toArray()
  const send = (entries: unknown[], removed: string[] = []) =>
    object.workspaceRequest(new Request('http://workspace.internal/changes', { method: 'POST', body: JSON.stringify({ entries, removed }) }))
  return { object, r2, saved, send }
}

const file = (path: string, hash: string) => ({ path, hash, size: 4, mode: 0o644, mtimeMs: 1, kind: 'file' })
const H1 = '1'.repeat(64)
const H2 = '2'.repeat(64)

describe("AgentDurableObject saving the container's changes", () => {
  it('asks for the bytes R2 lacks before it saves anything', async () => {
    const agent = runningAgent()

    const response = await agent.send([file('notes/leads.md', H1)])

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ missing: [H1] })
    expect(agent.saved()).toEqual([])
  })

  it('saves a changed file and drops the bytes of its earlier version', async () => {
    const agent = runningAgent()
    agent.r2.set(workspaceBlobKey(OBJECT, H1), 'v1')
    expect((await agent.send([file('notes/leads.md', H1)])).status).toBe(204)

    agent.r2.set(workspaceBlobKey(OBJECT, H2), 'v2')
    expect((await agent.send([file('notes/leads.md', H2)])).status).toBe(204)

    expect(agent.saved()).toEqual([{ path: 'notes/leads.md', hash: H2, kind: 'file' }])
    expect(agent.r2.has(workspaceBlobKey(OBJECT, H1))).toBe(false)
  })

  it('removes a folder with everything under it', async () => {
    const agent = runningAgent()
    agent.r2.set(workspaceBlobKey(OBJECT, H1), 'a')
    agent.r2.set(workspaceBlobKey(OBJECT, H2), 'b')
    await agent.send([file('drafts/a.md', H1), file('drafts/old/b.md', H2), file('drafts-2026.md', H1)])

    expect((await agent.send([], ['drafts'])).status).toBe(204)

    expect(agent.saved()).toEqual([{ path: 'drafts-2026.md', hash: H1, kind: 'file' }])
    expect(agent.r2.has(workspaceBlobKey(OBJECT, H2))).toBe(false)
  })

  it('refuses changes when the agent is not running, so a stray container cannot replace the saved workspace', async () => {
    const agent = runningAgent(false)
    agent.r2.set(workspaceBlobKey(OBJECT, H1), 'a')

    expect((await agent.send([file('notes/leads.md', H1)])).status).toBe(409)
    expect(agent.saved()).toEqual([])
  })
})
