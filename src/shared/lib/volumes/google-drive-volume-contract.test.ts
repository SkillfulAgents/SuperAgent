import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { volumeContract, type VolumeContractFixture } from './testing/volume-contract'
import { MemoryVolumeTree, type MemoryEntry } from './testing/memory-volume-tree'

const { forward, lookup } = vi.hoisted(() => ({ forward: vi.fn(), lookup: vi.fn() }))
vi.mock('@shared/lib/db', () => ({ db: { select: () => ({ from: () => ({ where: () => ({ get: lookup }) }) }) } }))
vi.mock('@shared/lib/account-providers/provider-factory', () => ({ getAccountProviderByName: () => ({ makeApiCall: forward }) }))
vi.mock('@shared/lib/platform-attribution', () => ({ attribution: { fromResourceCreator: async () => null }, runWithAttribution: (_owner: unknown, run: () => unknown) => run() }))
vi.mock('@shared/lib/proxy/audit', () => ({ writeProxyAuditEntry: async () => {} }))
import { GoogleDriveMountableVolume } from './google-drive-mountable-volume'
import { FOLDER_MIME_TYPE } from './google-drive-schema'

type Metadata = { name?: string; parents?: string[]; mimeType?: string; trashed?: boolean }
function fixture(): VolumeContractFixture & { downloadWith(run: (bytes: Uint8Array) => ReadableStream<Uint8Array>): void } {
  const tree = new MemoryVolumeTree()
  const id = randomUUID()
  let active = true
  let fail = false
  let onCommit = () => {}
  let download: ((bytes: Uint8Array) => ReadableStream<Uint8Array>) | undefined
  const rootId = tree.get('')!.id
  const calls: { kind: string; path: string }[] = []
  const sessions = new Map<string, { target?: string; metadata: Metadata; chunks: Uint8Array[] }>()
  const metadata = (entry: MemoryEntry) => ({
    id: entry.id, name: entry.path.split('/').at(-1) || 'Team', version: String(entry.version),
    mimeType: entry.bytes ? 'application/octet-stream' : FOLDER_MIME_TYPE,
    modifiedTime: new Date(1_700_000_000_000 + entry.version * 1000).toISOString(),
    ...(entry.bytes ? { size: String(entry.bytes.length), md5Checksum: tree.md5(entry) } : {}),
  })
  const error = (status: number) => Response.json({ error: {} }, { status })
  const pathOf = (json: Metadata) => {
    const parent = tree.byId(json.parents![0])!
    return [parent.path, json.name].filter(Boolean).join('/')
  }
  const commit = (target: string | undefined, json: Metadata, content: Uint8Array) => {
    if (fail) { fail = false; return error(503) }
    const path = target ? tree.byId(target)!.path : pathOf(json)
    onCommit(); onCommit = () => {}
    return Response.json(metadata(tree.put(path, new Uint8Array(content))))
  }
  lookup.mockImplementation(async () => ({ id, toolkitSlug: 'googledrive', status: active ? 'active' : 'expired', userId: null, providerName: 'composio', providerConnectionId: id }))
  forward.mockImplementation(async ({ targetUrl, method, headers, body }: { targetUrl: string; method: string; headers: Headers; body: ArrayBuffer | null }) => {
    const url = new URL(targetUrl)
    const fileId = /^\/(?:upload\/)?drive\/v3\/files\/([^/]+)$/.exec(url.pathname)?.[1]
    const json = () => JSON.parse(new TextDecoder().decode(body!)) as Metadata
    if (url.pathname.endsWith('/changes/startPageToken')) return Response.json({ startPageToken: 'start' })
    if (url.pathname.endsWith('/changes')) return Response.json({ changes: [], newStartPageToken: 'next' })
    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      const parentId = /'([^']+)' in parents/.exec(url.searchParams.get('q') ?? '')![1]
      const parent = tree.byId(parentId)
      if (!parent) return error(404)
      calls.push({ kind: 'list', path: parent.path })
      return Response.json({ files: tree.children(parent.path).map(metadata) })
    }
    if (fileId && method === 'GET') {
      const entry = tree.byId(fileId)
      if (!entry) return error(404)
      if (url.searchParams.get('alt') === 'media') {
        if (download) return new Response(download(entry.bytes!))
        const range = headers.get('Range')
        if (!range) return new Response(new Uint8Array(entry.bytes!))
        const [start, end] = range.slice(6).split('-').map(Number)
        return new Response(entry.bytes!.slice(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${entry.bytes!.length}` } })
      }
      if (fileId === rootId) calls.push({ kind: 'health', path: '' })
      return Response.json(metadata(entry))
    }
    if (url.pathname.startsWith('/upload/')) {
      calls.push({ kind: 'content', path: fileId ?? '' })
      if (url.searchParams.get('uploadType') === 'multipart') {
        const boundary = headers.get('Content-Type')!.split('boundary=')[1]
        const bytes = Buffer.from(body!)
        const metaStart = bytes.indexOf('\r\n\r\n') + 4
        const metaEnd = bytes.indexOf(`\r\n--${boundary}`, metaStart)
        const contentStart = bytes.indexOf('\r\n\r\n', metaEnd) + 4
        const contentEnd = bytes.lastIndexOf(`\r\n--${boundary}--`)
        return commit(fileId, JSON.parse(bytes.subarray(metaStart, metaEnd).toString()), bytes.subarray(contentStart, contentEnd))
      }
      if (url.searchParams.get('uploadType') === 'resumable') {
        const token = randomUUID()
        sessions.set(token, { target: fileId, metadata: json(), chunks: [] })
        return new Response(null, { headers: { Location: `https://www.googleapis.com/upload/session/${token}` } })
      }
      const session = sessions.get(url.pathname.split('/').at(-1)!)!
      session.chunks.push(new Uint8Array(body!))
      return headers.get('Content-Range')!.endsWith('/*') ? new Response(null, { status: 308 })
        : commit(session.target, session.metadata, Buffer.concat(session.chunks))
    }
    if (method === 'POST') return Response.json(metadata(tree.mkdir(pathOf(json()))))
    if (fileId && method === 'PATCH') {
      const entry = tree.byId(fileId)
      if (!entry) return error(404)
      const change = json()
      if (change.trashed) { tree.remove(entry.path); return Response.json({ ...metadata(entry), trashed: true }) }
      const parent = url.searchParams.get('addParents')
      const folder = parent ? tree.byId(parent)!.path : entry.path.slice(0, Math.max(0, entry.path.lastIndexOf('/')))
      return Response.json(metadata(tree.move(entry.path, [folder, change.name].filter(Boolean).join('/'))))
    }
    throw new Error(`Unexpected Drive endpoint: ${method} ${url.pathname}`)
  })
  return {
    volume: () => new GoogleDriveMountableVolume(id, 'Team', { accountId: id, folderId: rootId, folderName: 'Team', driveName: 'My Drive' }, 'agent'),
    put: (path, bytes) => { tree.put(path, bytes) }, mkdir: path => { tree.mkdir(path) },
    bytes: path => tree.get(path)?.bytes, exists: path => !!tree.get(path),
    failWrite: () => { fail = true }, beforeCommit: run => { onCommit = run }, revoke: () => { active = false },
    count: (kind, path) => calls.filter(call => call.kind === kind && (path === undefined || call.path === path)).length,
    downloadWith: run => { download = run },
  }
}

volumeContract('Google Drive', fixture)

describe('Google Drive replacement transfers', () => {
  it.each(['truncated', 'same length corruption'])('preserves both files when a rename source download has %s', async kind => {
    const f = fixture()
    f.put('temporary', new TextEncoder().encode('{"id":12345678901234567891}'))
    f.put('saved', new TextEncoder().encode('keep'))
    f.downloadWith(bytes => new Blob([kind === 'truncated' ? bytes.slice(0, -1) : new TextEncoder().encode('{"id":12345678901234567000}')]).stream())
    await expect(f.volume().move('temporary', 'saved')).rejects.toThrow()
    expect(new TextDecoder().decode(f.bytes('saved'))).toBe('keep')
    expect(f.exists('temporary')).toBe(true)
    expect(f.count('content')).toBe(0)
  })

  it('allows another mutation while a replacement rename is downloading', async () => {
    const f = fixture()
    f.put('temporary', new TextEncoder().encode('source'))
    f.put('saved', new TextEncoder().encode('keep'))
    let controller!: ReadableStreamDefaultController<Uint8Array>
    f.downloadWith(() => new ReadableStream({ start(c) { controller = c } }))
    const moving = f.volume().move('temporary', 'saved')
    await vi.waitFor(() => expect(controller).toBeDefined())
    await f.volume().mkdir('other')
    expect(f.exists('other')).toBe(true)
    controller.enqueue(new TextEncoder().encode('source')); controller.close()
    await moving
    expect(new TextDecoder().decode(f.bytes('saved'))).toBe('source')
  })

  it('never publishes a large corrupted rename transfer after staging chunks', async () => {
    const f = fixture()
    f.put('temporary', new Uint8Array(2 * 1024 * 1024).fill(1))
    f.put('saved', new TextEncoder().encode('keep'))
    f.downloadWith(bytes => { const bad = bytes.slice(); bad[bad.length - 1] = 2; return new Blob([bad]).stream() })
    await expect(f.volume().move('temporary', 'saved')).rejects.toThrow()
    expect(f.count('content')).toBeGreaterThan(0)
    expect(new TextDecoder().decode(f.bytes('saved'))).toBe('keep')
    expect(f.exists('temporary')).toBe(true)
  })

  it('keeps an external edit to the source made while the destination commits', async () => {
    const f = fixture()
    f.put('temporary', new TextEncoder().encode('source'))
    f.put('saved', new TextEncoder().encode('keep'))
    f.beforeCommit(() => f.put('temporary', new TextEncoder().encode('external edit')))
    await expect(f.volume().move('temporary', 'saved')).rejects.toMatchObject({ status: 409 })
    expect(new TextDecoder().decode(f.bytes('temporary'))).toBe('external edit')
    expect(new TextDecoder().decode(f.bytes('saved'))).toBe('source')
  })

})
