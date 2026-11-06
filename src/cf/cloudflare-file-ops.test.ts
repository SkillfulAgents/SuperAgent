import { describe, expect, it } from 'vitest'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import type { SleepingStore } from './cloudflare-container-control'
import { createCloudflareFileOps } from './cloudflare-file-ops'

const text = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : null)
const readStream = async (stream: ReadableStream<Uint8Array>) => text(new Uint8Array(await new Response(stream).arrayBuffer()))

/** An in-memory container file API (GET, /content, /upload, /mkdir, DELETE) that can be asleep. */
function fakeContainer(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial).map(([path, body]) => [path, new TextEncoder().encode(body)]))
  const dirs = new Set<string>([''])
  const calls: string[] = []
  // How each upload's body arrived: streamed, or as bytes.
  const uploads: string[] = []
  const state = { running: true, failWith: 0 }

  const entry = (path: string) => {
    const body = files.get(path)
    return { name: path.split('/').pop(), path, type: body ? 'file' : 'directory', size: body?.byteLength, modifiedAt: '2026-10-22T12:00:00.000Z' }
  }
  const isDir = (path: string) => dirs.has(path) || [...files.keys()].some((file) => file.startsWith(`${path}/`))

  const call = async (url: string, init?: RequestInit): Promise<Response | null> => {
    if (!state.running) return null
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${url}`)
    if (state.failWith) return new Response('disk full', { status: state.failWith })
    const match = /^\/files\/(.*?)(\/content|\/upload|\/mkdir)?$/.exec(url)!
    const path = match[1].split('/').map(decodeURIComponent).join('/')
    const action = match[2]
    if (action === '/upload') {
      const body = init!.body
      uploads.push(body instanceof ReadableStream ? 'stream' : 'bytes')
      files.set(path, body instanceof ReadableStream ? new Uint8Array(await new Response(body).arrayBuffer()) : new Uint8Array(body as Uint8Array))
      return new Response(null, { status: 201 })
    }
    if (action === '/mkdir') {
      dirs.add(path)
      return new Response(null, { status: 201 })
    }
    if (method === 'DELETE') return files.delete(path) ? new Response(null) : new Response(null, { status: 404 })
    if (action === '/content') {
      const body = files.get(path)
      if (!body) return new Response(null, { status: 404 })
      const range = /^bytes=(\d+)-(\d*)$/.exec(new Headers(init?.headers).get('range') ?? '')
      if (!range) return new Response(body)
      const end = range[2] ? Number(range[2]) + 1 : body.byteLength
      return new Response(body.subarray(Number(range[1]), end), { status: 206 })
    }
    if (files.has(path)) return Response.json(entry(path))
    if (isDir(path)) {
      const prefix = path ? `${path}/` : ''
      const children = new Set([...files.keys()].filter((file) => file.startsWith(prefix)).map((file) => prefix + file.slice(prefix.length).split('/')[0]))
      return Response.json([...children].map(entry))
    }
    return new Response(null, { status: 404 })
  }
  return { call, files, calls, uploads, state }
}

/** The saved workspace (AgentDurableObject's file list in R2), in memory. */
function fakeSleeping(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial).map(([path, body]) => [path, new TextEncoder().encode(body)]))
  const state = { runningOnNextChange: false }
  const fileEntry = (path: string) => ({ name: path.split('/').pop()!, path, type: 'file' as const, size: files.get(path)!.byteLength })
  // A change made while the container is starting is refused once, the way AgentDurableObject does.
  const refused = () => {
    if (!state.runningOnNextChange) return false
    state.runningOnNextChange = false
    return true
  }
  const store: SleepingStore = {
    async entry(path) {
      if (files.has(path)) return fileEntry(path)
      const prefix = path ? `${path}/` : ''
      const under = [...files.keys()].filter((file) => file.startsWith(prefix))
      if (under.length === 0 && path) return null
      const children = new Map<string, { name: string; path: string; type: 'file' | 'directory'; size?: number }>()
      for (const file of under) {
        const rest = file.slice(prefix.length)
        const dir = rest.split('/')[0]
        children.set(prefix + dir, rest.includes('/') ? { name: dir, path: prefix + dir, type: 'directory' } : fileEntry(file))
      }
      return [...children.values()]
    },
    async read(path) {
      return files.get(path) ?? null
    },
    async write(path, bytes) {
      if (refused()) return false
      files.set(path, bytes)
      return true
    },
    async remove(path) {
      if (refused()) return false
      for (const file of [...files.keys()]) if (file === path || file.startsWith(`${path}/`)) files.delete(file)
      return true
    },
  }
  return { store, files, state }
}

/** For tests of a running container: the saved workspace must not be touched. */
const unused: SleepingStore = {
  entry: () => Promise.reject(new Error('saved workspace used while awake')),
  read: () => Promise.reject(new Error('saved workspace used while awake')),
  write: () => Promise.reject(new Error('saved workspace used while awake')),
  remove: () => Promise.reject(new Error('saved workspace used while awake')),
}

describe('Cloudflare file ops while the container runs', () => {
  it('lists, stats and reads files through the container API', async () => {
    const container = fakeContainer({ 'notes/todo.md': '- ship CI', 'notes/done.md': 'tests' })
    const files = createCloudflareFileOps(container.call, unused)

    expect(await files.list('notes')).toEqual([
      { name: 'todo.md', path: 'notes/todo.md', kind: 'file' },
      { name: 'done.md', path: 'notes/done.md', kind: 'file' },
    ])
    expect(await files.stat('/workspace/notes/todo.md')).toEqual({ kind: 'file', size: 9, mtimeMs: Date.parse('2026-10-22T12:00:00.000Z') })
    expect(await files.stat('notes')).toEqual({ kind: 'directory', size: 0, mtimeMs: 0 })
    expect(await readStream(await files.read('notes/todo.md'))).toBe('- ship CI')
    expect(await readStream(await files.read('notes/todo.md', { start: 2, end: 5 }))).toBe('ship')
  })

  it('streams a file from the container, asking it for only the range read', async () => {
    const container = fakeContainer({ 'exports/report.csv': 'region,total\nwest,42\n' })
    const files = createCloudflareFileOps(container.call, unused)

    const sized = await files.readSized('exports/report.csv')
    expect(sized.size).toBe(21)
    expect(await readStream(sized.stream)).toBe('region,total\nwest,42\n')

    const callsBefore = container.calls.length
    expect(await readStream(await files.read('exports/report.csv', { start: 13, end: 16 }))).toBe('west')
    expect(container.calls.slice(callsBefore)).toEqual(['GET /files/exports/report.csv', 'GET /files/exports/report.csv/content'])
  })

  it('encodes each path segment in the URL', async () => {
    const container = fakeContainer({ 'my files/report #1.md': 'q3' })
    const files = createCloudflareFileOps(container.call, unused)
    expect(text(await files.getDoc('my files/report #1.md'))).toBe('q3')
    expect(container.calls).toContain('GET /files/my%20files/report%20%231.md/content')
  })

  it('reports missing files as empty or null, and a directory read as not-a-file', async () => {
    const container = fakeContainer({ 'notes/todo.md': 'x' })
    const files = createCloudflareFileOps(container.call, unused)
    expect(await files.list('missing')).toEqual([])
    expect(await files.stat('missing.md')).toBeNull()
    expect(await files.resolve('missing.md')).toBeNull()
    expect(await files.getDoc('missing.md')).toBeNull()
    await expect(files.read('missing.md')).rejects.toMatchObject({ code: 'not-found' })
    await expect(files.read('notes')).rejects.toMatchObject({ code: 'not-a-file' })
    await expect(files.list('notes/todo.md')).rejects.toMatchObject({ code: 'not-a-directory' })
  })

  it('refuses a path that leaves the workspace before calling the container', async () => {
    const container = fakeContainer()
    const files = createCloudflareFileOps(container.call, unused)
    await expect(files.read('../etc/passwd')).rejects.toBeInstanceOf(WorkspaceFileError)
    expect(container.calls).toEqual([])
  })

  it('writes, appends and deletes', async () => {
    const container = fakeContainer({ 'log.txt': 'one\n' })
    const files = createCloudflareFileOps(container.call, unused)
    expect(await files.write('out.txt', new Response('streamed').body!)).toEqual({ size: 8 })
    await files.append('log.txt', 'two\n')
    await files.delete('log.txt')
    await files.delete('never-existed.txt')
    expect(text(container.files.get('out.txt')!)).toBe('streamed')
    expect(container.files.has('log.txt')).toBe(false)
  })

  it('streams a written stream to a running container, and reads it whole only for the saved workspace', async () => {
    const container = fakeContainer()
    const files = createCloudflareFileOps(container.call, unused)
    expect(await files.write('uploads/video.mp4', new Response('a large upload').body!)).toEqual({ size: 14 })
    expect(container.uploads).toEqual(['stream'])
    expect(text(container.files.get('uploads/video.mp4')!)).toBe('a large upload')

    const asleep = fakeContainer()
    asleep.state.running = false
    const saved = fakeSleeping()
    const sleeping = createCloudflareFileOps(asleep.call, saved.store)
    expect(await sleeping.write('uploads/notes.txt', new Response('saved while asleep').body!)).toEqual({ size: 18 })
    expect(text(saved.files.get('uploads/notes.txt')!)).toBe('saved while asleep')
  })

  it('raises the status and body of a failed container call', async () => {
    const container = fakeContainer()
    container.state.failWith = 500
    const files = createCloudflareFileOps(container.call, unused)
    await expect(files.putDoc('a.md', 'x')).rejects.toThrow('Container file API 500 for a.md: disk full')
  })

  it('reads an opened file from one fetch, and not after close', async () => {
    const container = fakeContainer({ 'session.jsonl': '{"a":1}\n{"b":2}\n' })
    const files = createCloudflareFileOps(container.call, unused)
    const file = await files.open('session.jsonl')
    const fetches = container.calls.length
    expect(await file.size()).toBe(16)
    expect(text(await file.readAt(8, 7))).toBe('{"b":2}')
    expect(container.calls.length).toBe(fetches)
    await file.close()
    await expect(file.readAt(0, 1)).rejects.toThrow('session.jsonl is closed')
  })
})

describe('Cloudflare file ops while the container is asleep', () => {
  it('reads, writes and deletes the saved workspace, without calling the container', async () => {
    const container = fakeContainer()
    container.state.running = false
    const saved = fakeSleeping({ 'AGENTS.md': 'be brief', '.claude/projects/-workspace/s1.jsonl': '{"a":1}\n' })
    const files = createCloudflareFileOps(container.call, saved.store)

    expect(await files.list('')).toEqual([
      { name: 'AGENTS.md', path: 'AGENTS.md', kind: 'file' },
      { name: '.claude', path: '.claude', kind: 'directory' },
    ])
    expect(text(await files.getDoc('AGENTS.md'))).toBe('be brief')
    expect(await files.stat('.claude/projects/-workspace/s1.jsonl')).toMatchObject({ kind: 'file', size: 8 })
    expect(await files.stat('missing.md')).toBeNull()

    await files.putDoc('notes.md', 'written while asleep')
    await files.append('.claude/projects/-workspace/s1.jsonl', '{"b":2}\n')
    await files.delete('AGENTS.md')

    expect(text(saved.files.get('notes.md')!)).toBe('written while asleep')
    expect(text(saved.files.get('.claude/projects/-workspace/s1.jsonl')!)).toBe('{"a":1}\n{"b":2}\n')
    expect(saved.files.has('AGENTS.md')).toBe(false)
    expect(container.calls).toEqual([])
  })

  it('reads a large saved file in small chunks, so no single frame holds the whole file', async () => {
    const sleeping = fakeSleeping()
    sleeping.files.set('uploads/video.bin', new Uint8Array(200 * 1024).fill(7))
    const container = fakeContainer()
    container.state.running = false
    const files = createCloudflareFileOps(container.call, sleeping.store)

    const reader = (await files.read('uploads/video.bin')).getReader()
    const sizes: number[] = []
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) sizes.push(chunk.value.byteLength)

    expect(sizes).toEqual([65536, 65536, 65536, 8192])
  })

  it('sends a write to the container when it started meanwhile', async () => {
    const container = fakeContainer()
    container.state.running = false
    const saved = fakeSleeping()
    const files = createCloudflareFileOps(container.call, saved.store)

    saved.state.runningOnNextChange = true
    const write = saved.store.write
    saved.store.write = async (path, bytes) => {
      const done = await write(path, bytes)
      if (!done) container.state.running = true
      return done
    }
    await files.putDoc('notes.md', 'late')

    expect(text(container.files.get('notes.md')!)).toBe('late')
    expect(saved.files.has('notes.md')).toBe(false)
  })
})
