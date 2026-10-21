import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Hono } from 'hono'
import { createContainerFileOps } from './container-file-ops'
import type { FileOps } from './types'
import { WorkspaceFileError } from './workspace-path'

// The container's file API (agent-container legacy-file-routes.ts and
// server.ts) over a temp workspace: same paths, statuses, and JSON shapes.
function containerApp(workspaceRoot: string): Hono {
  const app = new Hono()
  const relOf = (url: string) => decodeURIComponent(new URL(url).pathname.slice('/files/'.length))
  const entry = (rel: string, full: string) => {
    const stats = fs.statSync(full)
    return {
      name: path.posix.basename(rel),
      path: rel,
      type: stats.isDirectory() ? 'directory' : 'file',
      size: stats.isFile() ? stats.size : undefined,
      modifiedAt: stats.mtime,
    }
  }
  app.get('/files/*', (c) => {
    const rel = relOf(c.req.url)
    const full = path.join(workspaceRoot, rel)
    if (!fs.existsSync(full) && rel.endsWith('/content')) {
      const source = path.join(workspaceRoot, rel.slice(0, -'/content'.length))
      if (!fs.existsSync(source)) return c.json({ error: 'File not found' }, 404)
      return c.body(new Uint8Array(fs.readFileSync(source)))
    }
    if (!fs.existsSync(full)) return c.json({ error: 'File or directory not found' }, 404)
    if (fs.statSync(full).isDirectory()) {
      return c.json(fs.readdirSync(full).map((name) => entry(path.posix.join(rel, name), path.join(full, name))))
    }
    return c.json(entry(rel, full))
  })
  app.post('/files/*', async (c) => {
    const rel = relOf(c.req.url)
    if (rel.endsWith('/mkdir')) {
      fs.mkdirSync(path.join(workspaceRoot, rel.slice(0, -'/mkdir'.length)), { recursive: true })
      return c.json({ success: true })
    }
    const full = path.join(workspaceRoot, rel.slice(0, -'/upload'.length))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, new Uint8Array(await c.req.arrayBuffer()))
    return c.json({ success: true })
  })
  app.delete('/files/*', (c) => {
    const full = path.join(workspaceRoot, relOf(c.req.url))
    if (!fs.existsSync(full)) return c.json({ error: 'File or directory not found' }, 404)
    fs.rmSync(full, { recursive: true })
    return c.json({ success: true })
  })
  return app
}

const text = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : null)
const readStream = async (stream: ReadableStream<Uint8Array>) => new TextDecoder().decode(await new Response(stream).arrayBuffer())

let workspace: string
let running: boolean
let calls: string[]
let files: FileOps

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'container-file-ops-'))
  running = true
  calls = []
  const app = containerApp(workspace)
  files = createContainerFileOps(async (requestPath, init) => {
    if (!running) return null
    calls.push(`${init?.method ?? 'GET'} ${requestPath}`)
    return app.request(requestPath, init)
  })
})

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true })
})

describe('createContainerFileOps while the container runs', () => {
  it('writes, reads, and stats a file in the container workspace', async () => {
    await files.putDoc('.claude/AGENTS.md', '# Research agent\n')

    expect(fs.readFileSync(path.join(workspace, '.claude/AGENTS.md'), 'utf8')).toBe('# Research agent\n')
    expect(text(await files.getDoc('.claude/AGENTS.md'))).toBe('# Research agent\n')
    expect(await files.stat('.claude/AGENTS.md')).toMatchObject({ kind: 'file', size: 17 })
    expect(await files.stat('.claude')).toMatchObject({ kind: 'directory' })
    expect(await files.resolve('.claude/AGENTS.md')).toBe('.claude/AGENTS.md')
  })

  it('encodes each path segment', async () => {
    await files.putDoc('reports/Q3 plan #1.md', 'draft')

    expect(calls).toEqual(['POST /files/reports/Q3%20plan%20%231.md/upload'])
    expect(fs.readFileSync(path.join(workspace, 'reports/Q3 plan #1.md'), 'utf8')).toBe('draft')
  })

  it('lists a directory and refuses to list a file', async () => {
    await files.putDoc('notes/a.md', 'a')
    await files.mkdir('notes/archive')

    const entries = await files.list('notes')
    expect(entries.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'a.md', path: 'notes/a.md', kind: 'file' },
      { name: 'archive', path: 'notes/archive', kind: 'directory' },
    ])
    await expect(files.list('notes/a.md')).rejects.toMatchObject({ code: 'not-a-directory' })
  })

  it('reads a byte range and pages through an open file', async () => {
    await files.putDoc('session.jsonl', '{"n":1}\n{"n":2}\n')

    expect(await readStream(await files.read('session.jsonl', { start: 8, end: 15 }))).toBe('{"n":2}\n')
    const handle = await files.open('session.jsonl')
    expect(await handle.size()).toBe(16)
    expect(text(await handle.readAt(0, 8))).toBe('{"n":1}\n')
    await handle.close()
    await expect(handle.size()).rejects.toThrow('session.jsonl is closed')
  })

  it('appends to an existing or missing file', async () => {
    await files.append('logs/run.log', 'first\n')
    await files.append('logs/run.log', 'second\n')

    expect(fs.readFileSync(path.join(workspace, 'logs/run.log'), 'utf8')).toBe('first\nsecond\n')
  })

  it('reports a missing file as not found and deletes idempotently', async () => {
    expect(await files.getDoc('missing.md')).toBeNull()
    expect(await files.stat('missing.md')).toBeNull()
    await expect(files.read('missing.md')).rejects.toBeInstanceOf(WorkspaceFileError)

    await files.putDoc('old.md', 'x')
    await files.delete('old.md')
    await files.delete('old.md')
    expect(fs.existsSync(path.join(workspace, 'old.md'))).toBe(false)
  })
})

describe('createContainerFileOps while the container sleeps', () => {
  it('holds writes and deletes without calling the container, then sends them on the next call once it runs', async () => {
    await files.putDoc('keep.md', 'old')
    await files.putDoc('drop.md', 'x')
    calls = []
    running = false

    await files.putDoc('keep.md', 'new')
    await files.delete('drop.md')

    expect(text(await files.getDoc('keep.md'))).toBe('new')
    expect(await files.stat('keep.md')).toMatchObject({ kind: 'file', size: 3 })
    expect(await files.getDoc('drop.md')).toBeNull()
    expect(fs.readFileSync(path.join(workspace, 'keep.md'), 'utf8')).toBe('old')

    running = true
    await files.list('')

    expect(calls).toEqual(['POST /files/keep.md/upload', 'DELETE /files/drop.md', 'GET /files/'])
    expect(fs.readFileSync(path.join(workspace, 'keep.md'), 'utf8')).toBe('new')
    expect(fs.existsSync(path.join(workspace, 'drop.md'))).toBe(false)
  })

  it('reads nothing it has not written while asleep', async () => {
    await files.putDoc('AGENTS.md', 'on disk')
    running = false

    expect(await files.getDoc('AGENTS.md')).toBeNull()
    expect(await files.list('')).toEqual([])
  })
})
