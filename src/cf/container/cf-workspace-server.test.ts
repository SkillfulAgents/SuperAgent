import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceService } from './cf-workspace-service.mjs'

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

type Saved = { path: string; hash: string; kind: string }

/** The store as the agent's object and R2 answer it: bytes by hash, and a file list that asks for the bytes it lacks. */
function fakeStore() {
  const blobs = new Map<string, string>()
  const files = new Map<string, Saved>()
  const state = { failChanges: 0 }
  const fetch = async (input: string, init: { method?: string; body?: unknown } = {}): Promise<Response> => {
    const { pathname } = new URL(input)
    const hash = /^\/blobs\/([0-9a-f]{64})$/.exec(pathname)?.[1]
    if (hash && init.method === 'PUT') {
      const text = await new Response(init.body as ReadableStream).text()
      if (sha256(text) !== hash) return new Response('the file changed since it was scanned', { status: 409 })
      blobs.set(hash, text)
      return new Response(null, { status: 204 })
    }
    if (hash) return blobs.has(hash) ? new Response(blobs.get(hash)) : new Response(null, { status: 404 })
    if (pathname === '/changes') {
      if (state.failChanges > 0) {
        state.failChanges--
        return new Response('the store is away', { status: 503 })
      }
      const { entries, removed, uploaded } = JSON.parse(String(init.body)) as { entries: Saved[]; removed: string[]; uploaded: string[] }
      const missing = [...new Set(entries.filter((entry) => entry.kind === 'file' && !blobs.has(entry.hash) && !uploaded.includes(entry.hash)).map((entry) => entry.hash))]
      if (missing.length > 0) return Response.json({ missing }, { status: 409 })
      for (const path of removed) for (const saved of [...files.keys()]) if (saved === path || saved.startsWith(`${path}/`)) files.delete(saved)
      for (const entry of entries) files.set(entry.path, entry)
      return new Response(null, { status: 204 })
    }
    return new Response(null, { status: 404 })
  }
  return { fetch, blobs, files, state }
}

/** The agent's process, as far as the cf-workspace-server uses it. */
class FakeAgent extends EventEmitter {
  exitCode: number | null = null
  signalCode: string | null = null
  signals: string[] = []
  kill(signal: string): void {
    this.signals.push(signal)
    this.signalCode = signal
    queueMicrotask(() => this.emit('exit', null))
  }
}

let root = ''
let server: http.Server | undefined
let service: ReturnType<typeof createWorkspaceService> | undefined

afterEach(async () => {
  service?.close()
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)))
  server = undefined
  await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function running(store = fakeStore()) {
  root = await mkdtemp(join(tmpdir(), 'cf-workspace-'))
  const agent = new FakeAgent()
  const exits: number[] = []
  service = createWorkspaceService({ workspace: root, store: 'http://workspace.internal', launch: () => agent, exit: (code: number) => void exits.push(code), fetch: store.fetch as unknown as typeof fetch, batchMs: 20 })
  server = http.createServer(service.handle)
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = (path: string, body?: unknown) => fetch(`${origin}${path}`, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
  return { store, agent, exits, origin, post }
}

describe('the cf-workspace-server', () => {
  it('restores files, folders and links with their modes and times, and again after a restore that failed halfway', async () => {
    const store = fakeStore()
    store.blobs.set(sha256('# Q3 report'), '# Q3 report')
    const { post } = await running(store)
    const changedAt = Date.UTC(2026, 9, 22, 12)
    const files = [
      { path: 'reports/q3.md', hash: sha256('# Q3 report'), size: 11, mode: 0o600, mtimeMs: changedAt, kind: 'file' },
      { path: 'latest.md', hash: '', size: 0, mode: 0o777, kind: 'symlink', target: 'reports/q3.md' },
      { path: 'drafts', hash: '', size: 0, mode: 0o755, kind: 'dir' },
    ]

    expect((await post('/restore', { files })).status).toBe(200)
    // The link is there already: the second restore replaces it.
    expect((await post('/restore', { files })).status).toBe(200)

    expect(await readFile(join(root, 'reports/q3.md'), 'utf8')).toBe('# Q3 report')
    const restored = await stat(join(root, 'reports/q3.md'))
    expect(restored.mode & 0o777).toBe(0o600)
    expect(restored.mtimeMs).toBe(changedAt)
    expect(await readlink(join(root, 'latest.md'))).toBe('reports/q3.md')
    expect((await lstat(join(root, 'drafts'))).isDirectory()).toBe(true)
  })

  it('fails a restore whose bytes the store does not have', async () => {
    const { post } = await running()
    const response = await post('/restore', { files: [{ path: 'notes.md', hash: 'a'.repeat(64), size: 1, mode: 0o644, kind: 'file' }] })
    expect(response.status).toBe(500)
  })

  it('scans and saves only once the agent is launched, and launches it once', async () => {
    const { post, origin } = await running()
    expect((await post('/scan')).status).toBe(409)
    expect(await (await fetch(`${origin}/state`)).json()).toEqual({ launched: false })

    await post('/launch')
    await post('/launch')
    expect(await (await fetch(`${origin}/state`)).json()).toEqual({ launched: true })

    await writeFile(join(root, 'notes.md'), 'call Dana')
    const { files } = (await (await post('/scan')).json()) as { files: Saved[] }
    expect(files).toEqual([expect.objectContaining({ path: 'notes.md', hash: sha256('call Dana'), kind: 'file' })])
  })

  it('saves a change a moment after it happens: the bytes the store asks for, then the file list', async () => {
    const { post, store } = await running()
    await post('/launch')

    await mkdir(join(root, 'reports'))
    await writeFile(join(root, 'reports/q3.md'), '# Q3 report')

    await vi.waitFor(() => expect(store.files.get('reports/q3.md')?.hash).toBe(sha256('# Q3 report')), { timeout: 5_000 })
    expect(store.blobs.get(sha256('# Q3 report'))).toBe('# Q3 report')

    await rm(join(root, 'reports'), { recursive: true })
    await vi.waitFor(() => expect(store.files.size).toBe(0), { timeout: 5_000 })
  })

  it('tries a save again after the store failed it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { post, store } = await running()
    await post('/launch')
    store.state.failChanges = 1

    await writeFile(join(root, 'notes.md'), 'call Dana')

    await vi.waitFor(() => expect(store.files.has('notes.md')).toBe(true), { timeout: 5_000 })
  })

  it('on a stop, stops the agent, saves the last changes, and only then exits', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { post, store, agent, exits } = await running()
    await post('/launch')
    // The first save fails, so the change is seen and still waiting when the stop comes.
    store.state.failChanges = 1
    await writeFile(join(root, 'last-words.md'), 'saved on the way out')
    await vi.waitFor(() => expect(logged).toHaveBeenCalled(), { timeout: 5_000 })

    service!.stop('SIGTERM')
    // A second signal changes nothing.
    service!.stop('SIGTERM')

    await vi.waitFor(() => expect(exits).toEqual([0]), { timeout: 5_000 })
    expect(agent.signals).toEqual(['SIGTERM'])
    expect(store.files.get('last-words.md')?.hash).toBe(sha256('saved on the way out'))
  })

  it('saves the last changes before it exits when the agent ends by itself', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { post, store, agent, exits } = await running()
    await post('/launch')
    // The first save fails, so the change is seen and still waiting when the agent ends.
    store.state.failChanges = 1
    await writeFile(join(root, 'last-words.md'), 'written right before the crash')
    await vi.waitFor(() => expect(logged).toHaveBeenCalled(), { timeout: 5_000 })

    agent.exitCode = 1
    agent.emit('exit', 1)

    await vi.waitFor(() => expect(exits).toEqual([1]), { timeout: 5_000 })
    expect(store.files.get('last-words.md')?.hash).toBe(sha256('written right before the crash'))
  })

  it('exits at once on a stop before the agent was launched', async () => {
    const { exits } = await running()
    service!.stop('SIGTERM')
    expect(exits).toEqual([0])
  })
})

describe('the cf-workspace-server appending to a file', () => {
  const append = (origin: string, path: string, body: string) => fetch(`${origin}/append?path=${encodeURIComponent(path)}`, { method: 'POST', body })

  it('appends to the end of a file, makes it and its folders when missing, and refuses a folder or a path outside the workspace', async () => {
    const { origin } = await running()
    await writeFile(join(root, 'session.jsonl'), '{"turn":1}\n')

    expect((await append(origin, 'session.jsonl', '{"turn":2}\n')).status).toBe(200)
    expect(await readFile(join(root, 'session.jsonl'), 'utf8')).toBe('{"turn":1}\n{"turn":2}\n')

    expect((await append(origin, 'voice/2026/notes.txt', 'hello')).status).toBe(200)
    expect(await readFile(join(root, 'voice/2026/notes.txt'), 'utf8')).toBe('hello')

    expect((await append(origin, 'voice', 'x')).status).toBe(409)
    expect((await append(origin, '../outside.txt', 'x')).status).toBe(400)
  })

  it('keeps every line of appends made at the same time', async () => {
    const { origin } = await running()
    const lines = Array.from({ length: 20 }, (_, i) => `{"line":${i}}\n`)

    await Promise.all(lines.map((line) => append(origin, 'session.jsonl', line)))

    const saved = (await readFile(join(root, 'session.jsonl'), 'utf8')).split('\n').filter(Boolean)
    expect(saved.sort()).toEqual(lines.map((line) => line.trim()).sort())
  })
})
