import Database from 'better-sqlite3'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { AgentDurableObject, serveWorkspaceRequest, workspaceBlobKey } from './cloudflare-agent'
import { createObjectSessionIndexStorage } from './object-session-index-storage'
import type { Env } from './index'

// The listing of a sleeping agent must not boot SuperAgent.
const { boot } = vi.hoisted(() => ({ boot: vi.fn(async () => { throw new Error('SuperAgent booted') }) }))
vi.mock('./boot', () => ({ boot }))

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
  return { object, calls }
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

/** The object's SQLite in memory, with the tables its constructor makes. */
function storage() {
  const db = new Database(':memory:')
  db.exec("CREATE TABLE workspace_file (path TEXT PRIMARY KEY, hash TEXT NOT NULL, size INTEGER NOT NULL, mode INTEGER NOT NULL, mtime INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'file', target TEXT)")
  db.exec('CREATE TABLE workspace_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)')
  db.exec('CREATE TABLE workspace_pending (hash TEXT PRIMARY KEY)')
  const sql = {
    exec: (query: string, ...bindings: unknown[]) => {
      const statement = db.prepare(query)
      if (statement.reader) {
        const rows = statement.all(...bindings)
        return { toArray: () => rows, rowsWritten: 0 }
      }
      return { toArray: () => [], rowsWritten: statement.run(...bindings).changes }
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
  return { object, ctx, r2, saved, pending, send, save }
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

  it('keeps the bytes of a renamed file, which the removed path and the new one share', async () => {
    const agent = runningAgent()
    await agent.save([file('notes/leads.md.tmp', H1)])

    expect((await agent.send([file('notes/leads.md', H1)], ['notes/leads.md.tmp'])).status).toBe(204)

    expect(agent.saved()).toEqual([{ path: 'notes/leads.md', hash: H1, kind: 'file' }])
    expect(agent.r2.has(workspaceBlobKey(OBJECT, H1))).toBe(true)
  })

  it('refuses changes when the agent is not running, so a stray container cannot replace the saved workspace', async () => {
    const agent = runningAgent(false)
    agent.r2.set(workspaceBlobKey(OBJECT, H1), 'a')

    expect((await agent.send([file('notes/leads.md', H1)])).status).toBe(409)
    expect(agent.saved()).toEqual([])
  })
})

describe('AgentDurableObject listing a sleeping agent', () => {
  it('answers from its saved files and session index without booting SuperAgent', async () => {
    const { object, ctx, r2 } = runningAgent(false)
    Object.assign(ctx, { container: { running: false } })
    const files = {
      'artifacts/sales/package.json': JSON.stringify({ name: 'Sales', scripts: { start: 'bun run server.ts' } }),
      'artifacts/sales/screenshot.png': 'png',
    }
    for (const [path, bytes] of Object.entries(files)) {
      const hash = path === 'artifacts/sales/package.json' ? H1 : H2
      ctx.storage.sql.exec("INSERT INTO workspace_file (path, hash, size, mode, mtime, kind) VALUES (?, ?, ?, 420, 1, 'file')", path, hash, bytes.length)
      r2.set(workspaceBlobKey(OBJECT, hash), bytes)
    }
    Object.assign(object.env as object, { WORKSPACES: { get: async (key: string) => (r2.has(key) ? { body: new Response(r2.get(key)).body } : null) } })
    await createObjectSessionIndexStorage(() => ctx.storage.sql as never).fill([
      { sessionId: 'weekly-report', meta: null, transcript: { mtimeMs: Date.parse('2026-11-12T09:30:00Z'), birthtimeMs: 1, size: 200 } },
    ])

    const outcome = await object.actorCall('listing', [])

    expect(boot).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({
      value: {
        live: { container: { status: 'stopped' }, activeSessionIds: [], awaitingSessionIds: [] },
        sessions: { sessionIds: ['weekly-report'], sessionCount: 1, lastActivityAt: new Date('2026-11-12T09:30:00Z') },
        artifacts: { dashboards: [{ slug: 'sales', name: 'Sales', hasScreenshot: true, firstRun: true }], widgets: [] },
        refreshingWidgets: [],
      },
    })
  })
})
