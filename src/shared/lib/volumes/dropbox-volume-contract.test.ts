import { randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import { volumeContract, type VolumeContractFixture } from './testing/volume-contract'
import { MemoryVolumeTree, type MemoryEntry } from './testing/memory-volume-tree'

const { forward, lookup } = vi.hoisted(() => ({ forward: vi.fn(), lookup: vi.fn() }))
vi.mock('@shared/lib/db', () => ({ db: { select: () => ({ from: () => ({ where: () => ({ get: lookup }) }) }) } }))
vi.mock('@shared/lib/account-providers/provider-factory', () => ({ getAccountProviderByName: () => ({ makeApiCall: forward }) }))
vi.mock('@shared/lib/platform-attribution', () => ({ attribution: { fromResourceCreator: async () => null }, runWithAttribution: (_owner: unknown, run: () => unknown) => run() }))
vi.mock('@shared/lib/proxy/audit', () => ({ writeProxyAuditEntry: async () => {} }))
import { DropboxMountableVolume } from './dropbox-mountable-volume'

function fixture(): VolumeContractFixture {
  const tree = new MemoryVolumeTree(true)
  const id = randomUUID()
  let active = true
  let fail = false
  let onCommit = () => {}
  const calls: { kind: string; path: string }[] = []
  const sessions = new Map<string, Uint8Array[]>()
  const revision = (entry: MemoryEntry) => `${entry.id}@${entry.version}`
  const metadata = (entry: MemoryEntry) => ({
    '.tag': entry.bytes ? 'file' : 'folder', id: entry.id, name: entry.path.split('/').at(-1) || 'Team',
    ...(entry.bytes ? { rev: revision(entry), size: entry.bytes.length, server_modified: new Date(1_700_000_000_000 + entry.version * 1000).toISOString() } : {}),
  })
  const error = (tag: string, status = 409) => Response.json({ error_summary: `path/${tag}/` }, { status })
  lookup.mockImplementation(async () => ({ id, toolkitSlug: 'dropbox', status: active ? 'active' : 'expired', userId: null, providerName: 'composio', providerConnectionId: id }))
  forward.mockImplementation(async ({ targetUrl, headers, body }: { targetUrl: string; headers: Headers; body: ArrayBuffer | null }) => {
    const endpoint = targetUrl.split('/2/files/')[1]
    const args = JSON.parse(headers.get('Dropbox-API-Arg') ?? new TextDecoder().decode(body!))
    const relative = (path: string) => path === '/Team' ? '' : path.slice('/Team/'.length)
    const path = args.path ? relative(args.path) : ''
    if (endpoint === 'get_metadata') {
      if (!path) calls.push({ kind: 'health', path })
      const entry = tree.get(path)
      return entry ? Response.json(metadata(entry)) : error('not_found')
    }
    if (endpoint === 'list_folder') {
      calls.push({ kind: 'list', path })
      return Response.json({ entries: tree.children(path).map(metadata), cursor: 'end', has_more: false })
    }
    if (endpoint === 'download') {
      const entry = [...tree.entries.values()].find(entry => `rev:${revision(entry)}` === args.path)
      if (!entry?.bytes) return error('not_found')
      const [start, end] = headers.get('Range')!.slice(6).split('-').map(Number)
      return new Response(entry.bytes.slice(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${entry.bytes.length}` } })
    }
    if (endpoint.startsWith('upload')) calls.push({ kind: 'content', path })
    if (endpoint === 'upload_session/start') {
      const sessionId = randomUUID()
      sessions.set(sessionId, [new Uint8Array(body!)])
      return Response.json({ session_id: sessionId })
    }
    if (endpoint === 'upload_session/append_v2') {
      sessions.get(args.cursor.session_id)!.push(new Uint8Array(body!))
      return Response.json(null)
    }
    if (endpoint === 'upload' || endpoint === 'upload_session/finish') {
      if (fail) { fail = false; return error('unavailable', 503) }
      const commit = args.commit ?? args
      const target = relative(commit.path)
      const current = tree.get(target)
      if ((commit.mode === 'add' && current) || (commit.mode !== 'add' && (!current || revision(current) !== commit.mode.update))) return error('conflict')
      const content = endpoint === 'upload' ? new Uint8Array(body ?? new ArrayBuffer(0)) : new Uint8Array(Buffer.concat(sessions.get(args.cursor.session_id)!))
      onCommit(); onCommit = () => {}
      return Response.json(metadata(tree.put(target, content)))
    }
    if (endpoint === 'create_folder_v2') {
      if (tree.get(path)) return error('conflict')
      return Response.json({ metadata: metadata(tree.mkdir(path)) })
    }
    if (endpoint === 'delete_v2') {
      const entry = tree.get(path)
      if (!entry) return error('not_found')
      if (args.parent_rev && args.parent_rev !== revision(entry)) return error('conflict')
      tree.remove(path)
      return Response.json({ metadata: metadata(entry) })
    }
    if (endpoint === 'move_v2') {
      const from = relative(args.from_path), to = relative(args.to_path)
      if (!tree.get(from)) return error('not_found')
      if (tree.get(to) && from.toLowerCase() !== to.toLowerCase()) return error('conflict')
      return Response.json({ metadata: metadata(tree.move(from, to)) })
    }
    throw new Error(`Unexpected Dropbox endpoint: ${endpoint}`)
  })
  return {
    volume: () => new DropboxMountableVolume(id, 'Team', { accountId: id, path: '/Team' }, 'agent'),
    put: (path, bytes) => { tree.put(path, bytes) }, mkdir: path => { tree.mkdir(path) },
    bytes: path => tree.get(path)?.bytes, exists: path => !!tree.get(path),
    failWrite: () => { fail = true }, beforeCommit: run => { onCommit = run }, revoke: () => { active = false },
    count: (kind, path) => calls.filter(call => call.kind === kind && (path === undefined || call.path === path)).length,
  }
}

volumeContract('Dropbox', fixture)
