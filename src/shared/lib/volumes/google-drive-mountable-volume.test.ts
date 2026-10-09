import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'

import type { DriveRequest } from './google-drive-client'

const { request, upload, requireAccount, TooLarge } = vi.hoisted(() => ({
  request: vi.fn<(accountId: string, request: DriveRequest, options?: { agentSlug?: string }) => Promise<Response>>(),
  upload: vi.fn(), requireAccount: vi.fn(), TooLarge: class extends Error {},
}))
vi.mock('./google-drive-client', () => ({ driveRequest: request, driveUpload: upload, requireGoogleDriveAccount: requireAccount, DriveExportTooLargeError: TooLarge }))
let exportCache: GoogleDriveExportCache
vi.mock('./google-drive-export-cache', async importOriginal => ({ ...await importOriginal<object>(), get googleDriveExportCache() { return exportCache } }))
import { GoogleDriveMountableVolume, googleDriveChangedDownloads, googleDriveListingCache, googleDriveRecentListings, googleDriveRootChecks, prepareGoogleDriveVolume } from './google-drive-mountable-volume'
import { GoogleDriveExportCache } from './google-drive-export-cache'
import { DRIVE_FILE_FIELDS } from './google-drive-schema'

const FOLDER = 'application/vnd.google-apps.folder'
const at = '2026-10-07T12:00:00Z'
const folder = (id: string, name = id, fields: Record<string, unknown> = {}) => ({ id, name, mimeType: FOLDER, modifiedTime: at, ...fields })
const blob = (id: string, name: string, size = 11, fields: Record<string, unknown> = {}) => ({ id, name, mimeType: 'text/plain', size: String(size), modifiedTime: at, ...fields })
const doc = (id: string, name: string) => ({ id, name, mimeType: 'application/vnd.google-apps.document', modifiedTime: at })
const shortcut = (id: string, name: string) => ({ id, name, mimeType: 'application/vnd.google-apps.shortcut', modifiedTime: at })
const volume = () => new GoogleDriveMountableVolume('attachment', 'Team', { accountId: 'account', folderId: 'root1', folderName: 'Team', driveName: 'My Drive' }, 'agent')

/** Answer Drive calls from a tree of folder children, export bodies, file contents and the root's own metadata. */
function serve(options: { folders?: Record<string, unknown[]>; exports?: Record<string, string | Error>; content?: Record<string, string>; root?: unknown; targets?: Record<string, unknown> } = {}) {
  request.mockImplementation(async (_account, req) => {
    if (req.path.startsWith('drive/v3/drives/')) return Response.json({ id: 'shared1', name: 'Gamut' })
    const parent = /'([^']+)' in parents/.exec(req.query?.q ?? '')
    if (req.method === 'GET' && req.path === 'drive/v3/files' && parent) return Response.json({ files: options.folders?.[parent[1]] ?? [] })
    const exported = /^drive\/v3\/files\/([^/]+)\/export$/.exec(req.path)
    if (exported) {
      const body = options.exports?.[exported[1]] ?? 'exported'
      if (body instanceof Error) throw body
      return new Response(body)
    }
    const one = /^drive\/v3\/files\/([^/]+)$/.exec(req.path)
    if (one && req.method === 'GET' && req.query?.alt === 'media') return new Response(options.content?.[one[1]] ?? 'hello world')
    if (one && req.method === 'GET') return Response.json(options.targets?.[one[1]] ?? options.root ?? folder('root1', 'Team'))
    // A change answers with the file as Drive now stores it.
    const json = req.json as { name?: string; mimeType?: string }
    if (req.method === 'POST') return Response.json({ id: 'made', name: json.name, mimeType: json.mimeType, modifiedTime: at })
    const known = Object.values(options.folders ?? {}).flat().find(file => (file as { id: string }).id === one?.[1])
    return Response.json({ ...known as object, ...json })
  })
}
const calls = () => request.mock.calls.map(([, req]) => `${req.method} ${req.path}`)
const exportsOf = () => calls().filter(call => call.endsWith('/export'))

beforeEach(() => {
  vi.resetAllMocks()
  googleDriveListingCache.invalidate('account')
  googleDriveRootChecks.clear()
  googleDriveRecentListings.clear()
  googleDriveChangedDownloads.clear()
  exportCache = new GoogleDriveExportCache()
  requireAccount.mockResolvedValue({})
  upload.mockImplementation(async (_account, session: { path: string; json: { name?: string } }, _body, options?: { publish?: (send: () => Promise<unknown>) => Promise<unknown> }) => {
    const id = session.json.name ? `made_${session.json.name.replace(/\W/g, '_')}` : session.path.split('/').at(-1)!
    const stored = blob(id, session.json.name ?? 'updated', 1)
    return options?.publish ? options.publish(async () => stored) : stored
  })
})

describe('Google Drive filesystem', () => {
  it('deletes what the folder holds now: never a cached name renamed in Drive since, and finds the new name', async () => {
    serve({ folders: { root1: [blob('n', 'notes.txt')] } })
    await volume().stat('notes.txt')
    serve({ folders: { root1: [blob('n', 'keep.txt')] } })
    await expect(volume().delete('notes.txt')).rejects.toMatchObject({ code: 'not-found' })
    expect(calls()).not.toContain('PATCH drive/v3/files/n')
    serve({ folders: { root1: [blob('n', 'notes.txt')] } })
    await volume().stat('notes.txt')
    serve({ folders: { root1: [blob('n', 'keep.txt')] } })
    await volume().delete('keep.txt')
    expect(calls()).toContain('PATCH drive/v3/files/n')
  })

  it('refuses at once a file the account proxy changed on download, at any length, and leaves a size changed in Drive to the retry', async () => {
    const md5 = (text: string) => createHash('md5').update(text).digest('hex')
    serve({ folders: { root1: [
      blob('j', 'package.json', 28, { mimeType: 'application/json' }),
      blob('b', 'ids.json', 27, { mimeType: 'application/json', md5Checksum: md5('{"id":12345678901234567891}') }),
      blob('t', 'notes.txt', 11, { md5Checksum: md5('hello world') }),
    ] } })
    const served = request.getMockImplementation()
    if (!served) throw new Error('serve() sets the Drive stand-in')
    let total = 28
    const bodies: Record<string, string> = { j: '{"a":1}', b: '{"id":12345678901234567000}', t: 'hello world' }
    request.mockImplementation(async (account, req, options) => {
      const id = /^drive\/v3\/files\/([^/]+)$/.exec(req.path)?.[1]
      if (req.query?.alt !== 'media' || !id) return served(account, req, options)
      const body = bodies[id] ?? ''
      const size = id === 'j' ? total : body.length
      return new Response(body, { status: 206, headers: { 'content-type': id === 't' ? 'text/plain' : 'application/json', 'content-range': `bytes 0-${(id === 'j' ? 28 : size) - 1}/${size}` } })
    })
    await expect((await volume().read('package.json')).stream({ start: 0, end: 27 })).rejects.toMatchObject({ code: 'not-accessible' })
    // Rounding a large number keeps the length. Drive's checksum still tells the bytes apart.
    await expect((await volume().read('ids.json')).stream({ start: 0, end: 26 })).rejects.toMatchObject({ code: 'not-accessible' })
    expect(await new Response(await (await volume().read('notes.txt')).stream({ start: 0, end: 10 })).text()).toBe('hello world')
    // rclone retries the read. The same version is refused without another download.
    const downloads = () => request.mock.calls.filter(([, req]) => req.query?.alt === 'media').length
    await expect(volume().read('package.json')).rejects.toMatchObject({ code: 'not-accessible' })
    expect(downloads()).toBe(3)
    googleDriveChangedDownloads.clear()
    total = 7
    await expect((await volume().read('package.json')).stream({ start: 0, end: 27 })).rejects.toThrow('unexpected byte range')
  })

  it('lists ahead of a tree walk, never for a single listing', async () => {
    serve({ folders: { root1: [folder('a', 'a'), folder('b', 'b')], a: [folder('x', 'x')], b: [], x: [] } })
    const listed = (id: string) => request.mock.calls.filter(([, req]) => req.path === 'drive/v3/files' && req.query?.q?.startsWith(`'${id}' in parents`)).length
    await volume().list('')
    await new Promise(resolve => setImmediate(resolve))
    expect(listed('b') + listed('a')).toBe(0)
    await volume().list('a')
    await vi.waitFor(() => { expect([listed('b'), listed('x')]).toEqual([1, 1]) })
    await volume().list('b')
    await volume().list('a/x')
    expect([listed('b'), listed('x')]).toEqual([1, 1])
  })

  it('reads a folder again when the change feed dropped the listing a change started from', async () => {
    serve({ folders: { root1: [] } })
    const listings = () => calls().filter(call => call === 'GET drive/v3/files').length
    await volume().write('one.txt', new Blob(['x']).stream())
    const before = listings()
    upload.mockImplementationOnce(async (_account, _session, _body, options: { publish: (send: () => Promise<unknown>) => Promise<unknown> }) => options.publish(async () => {
      // A poll finds root1 changed in Drive while this write holds it.
      googleDriveListingCache.confirm('account', 0, 0, () => 'stale')
      return blob('made_two', 'two.txt', 1)
    }))
    await volume().write('two.txt', new Blob(['x']).stream())
    await volume().list('')
    expect(listings()).toBe(before + 1)
  })

  it('re-reads only the folders a change touches, and caches what the change made instead of re-listing', async () => {
    serve({ folders: { root1: [folder('a', 'a')], a: [folder('b', 'b')], b: [] } })
    const listings = () => calls().filter(call => call === 'GET drive/v3/files').length
    await volume().write('a/b/one.txt', new Blob(['x']).stream())
    await volume().write('a/b/two.txt', new Blob(['x']).stream())
    await volume().mkdir('a/b/c')
    // root1, a and b once each. Each change checks against the listing the previous one left.
    expect(listings()).toBe(3)
    expect((await volume().list('a/b')).map(entry => entry.name)).toEqual(['one.txt', 'two.txt', 'c'])
    // A folder this app made starts empty, so listing it reads nothing.
    expect(await volume().list('a/b/c')).toEqual([])
    expect(listings()).toBe(3)
    // A failed change leaves Drive's state unknown, so the folder is read again.
    upload.mockImplementationOnce(async (_account, _session, _body, options) => options.publish(async () => { throw new Error('upstream') }))
    await expect(volume().write('a/b/three.txt', new Blob(['x']).stream())).rejects.toThrow('upstream')
    await volume().list('a/b')
    expect(listings()).toBe(4)
  })

  it('checks the root once per 5 s for writes at the top level, sharing a check in flight', async () => {
    vi.useFakeTimers()
    try {
      serve({ folders: { root1: [] } })
      const rootChecks = () => calls().filter(call => call === 'GET drive/v3/files/root1').length
      await Promise.all([volume().write('one.txt', new Blob(['x']).stream()), volume().write('two.txt', new Blob(['x']).stream())])
      await volume().write('four.txt', new Blob(['x']).stream())
      expect(rootChecks()).toBe(1)
      vi.advanceTimersByTime(6000)
      await volume().write('three.txt', new Blob(['x']).stream())
      expect(rootChecks()).toBe(2)
      // A root found trashed is checked again by the next write, not remembered.
      vi.advanceTimersByTime(6000)
      serve({ folders: { root1: [] }, root: folder('root1', 'Team', { trashed: true }) })
      await expect(volume().write('five.txt', new Blob(['x']).stream())).rejects.toMatchObject({ code: 'not-found' })
      serve({ folders: { root1: [] } })
      await volume().write('six.txt', new Blob(['x']).stream())
      expect(rootChecks()).toBe(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never seeds a made folder over a listing read, or a read begun, since it was made', async () => {
    const key = 'f:account'
    googleDriveListingCache.put('account', key, [{ id: 'x', name: 'x.txt', mimeType: 'text/plain', modifiedTime: at }], Date.now())
    googleDriveListingCache.seed('account', key, [], Date.now())
    expect(googleDriveListingCache.cached(key)).toHaveLength(1)
    googleDriveListingCache.forget(key)
    let answer = (_files: unknown[]) => {}
    const reading = googleDriveListingCache.list('account', key, () => new Promise(resolve => { answer = resolve as typeof answer }))
    googleDriveListingCache.seed('account', key, [], Date.now())
    answer([{ id: 'y', name: 'y.txt', mimeType: 'text/plain', modifiedTime: at }])
    await reading
    expect(googleDriveListingCache.cached(key)).toHaveLength(1)
  })

  it('trusts a listing for 5 s from its last Drive read, however often changes update it', async () => {
    vi.useFakeTimers()
    try {
      serve({ folders: { root1: [] } })
      const listings = () => calls().filter(call => call === 'GET drive/v3/files').length
      await volume().write('one.txt', new Blob(['x']).stream())
      vi.advanceTimersByTime(3000)
      await volume().write('two.txt', new Blob(['x']).stream())
      expect(listings()).toBe(1)
      vi.advanceTimersByTime(3000)
      await volume().write('three.txt', new Blob(['x']).stream())
      expect(listings()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds only the folders a change touches: a held change blocks its own folder, not another', async () => {
    serve({ folders: { root1: [folder('a', 'a'), folder('b', 'b')], a: [], b: [] } })
    let release = () => {}
    const held = new Promise<void>(resolve => { release = resolve })
    const answer = request.getMockImplementation()!
    request.mockImplementation(async (account, req, options) => {
      if (req.method === 'POST' && (req.json as { name: string }).name === 'slow') await held
      return answer(account, req, options)
    })
    const slow = volume().mkdir('a/slow')
    await vi.waitFor(() => expect(calls()).toContain('POST drive/v3/files'))
    await volume().mkdir('b/quick')
    let queuedDone = false
    const queued = volume().mkdir('a/next').then(() => { queuedDone = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(queuedDone).toBe(false)
    release()
    await Promise.all([slow, queued])
  })

  it('makes one Drive file when two uploads of a new name race, refusing the one that finishes second', async () => {
    serve({ folders: { root1: [] } })
    let release = () => {}
    const uploading = new Promise<void>(resolve => { release = resolve })
    const sent = vi.fn()
    upload.mockImplementation(async (_account, _session, _body, options) => {
      await uploading
      return options.publish(async () => { sent(); return blob('x', 'x.txt', 1) })
    })
    const writes = Promise.allSettled([volume().write('x.txt', new Blob(['1']).stream()), volume().write('x.txt', new Blob(['2']).stream())])
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(2))
    release()
    expect((await writes).map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(sent).toHaveBeenCalledOnce()
  })

  it('resolves paths without exporting, lists with export sizes once per version, and shares listings across adapters', async () => {
    serve({ folders: { root1: [folder('sub', 'Sub'), doc('doc1', 'Plan'), blob('n', 'notes.txt')], sub: [blob('a', 'a.txt', 5)] }, exports: { doc1: 'exported' } })
    expect(volume().cacheMode).toBe('remote')
    expect(await volume().stat('Sub/a.txt')).toEqual({ name: 'a.txt', kind: 'file', size: 5, mtimeMs: Date.parse(at) })
    expect(await volume().stat('Sub')).toMatchObject({ kind: 'directory' })
    expect(exportsOf()).toEqual([])
    expect(await volume().list('')).toEqual([
      { name: 'Sub', kind: 'directory', size: 0, mtimeMs: Date.parse(at) },
      { name: 'Plan.md', kind: 'file', size: 8, mtimeMs: Date.parse(at) },
      { name: 'notes.txt', kind: 'file', size: 11, mtimeMs: Date.parse(at) },
    ])
    expect(await volume().stat('Plan.md')).toMatchObject({ size: 8 })
    await volume().list('')
    expect(exportsOf()).toEqual(['GET drive/v3/files/doc1/export'])
    expect(calls().filter(call => call === 'GET drive/v3/files')).toHaveLength(2)
    expect(request.mock.calls[0][1].query).toMatchObject({ includeItemsFromAllDrives: 'true', q: "'root1' in parents and trashed = false" })
    await expect(volume().stat('Sub/a.txt/x')).rejects.toMatchObject({ code: 'not-a-directory' })
    await expect(volume().stat('sub/a.txt')).rejects.toMatchObject({ code: 'not-found' })
    await expect(volume().list('missing')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('hides and remembers an export over 10 MB, and fails the listing on a transient export failure', async () => {
    const exports: Record<string, string | Error> = { big: new TooLarge(), flaky: new Error('rate limited') }
    serve({ folders: { root1: [doc('big', 'Huge'), doc('flaky', 'Flaky')] }, exports })
    await expect(volume().list('')).rejects.toThrow('rate limited')
    exports.flaky = 'ok'
    expect((await volume().list('')).map(entry => entry.name)).toEqual(['Flaky.md'])
    await volume().list('')
    expect(exportsOf()).toEqual(['GET drive/v3/files/big/export', 'GET drive/v3/files/flaky/export', 'GET drive/v3/files/flaky/export'])
    await expect(volume().stat('Huge.md')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('shows the newest of duplicate names and resolves slash-mapped names to the right file', async () => {
    serve({ folders: { root1: [blob('old', 'notes.txt', 3), blob('new', 'notes.txt', 11, { modifiedTime: '2026-10-07T12:00:09Z' }), blob('ab', 'a/b.txt')] }, content: { new: 'hello world' } })
    expect((await volume().list('')).map(entry => entry.name)).toEqual(['notes.txt', 'a／b.txt'])
    expect(await new Response(await (await volume().read('notes.txt')).stream()).text()).toBe('hello world')
    expect(request).toHaveBeenLastCalledWith('account', expect.objectContaining({ path: 'drive/v3/files/new', query: { alt: 'media' }, headers: { Range: 'bytes=0-10' } }), expect.objectContaining({ agentSlug: 'agent' }))
    await (await volume().read('a／b.txt')).close()
    await expect(volume().read('a/b.txt')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('writes to the visible file, creates a real file under any other name, never writes a Google file, and refuses a folder', async () => {
    serve({ folders: { root1: [doc('doc1', 'Plan'), blob('n', 'notes.txt'), shortcut('s', 'Link'), folder('sub', 'Sub')] } })
    const cancel = vi.fn()
    await expect(volume().write('Sub', new ReadableStream({ cancel }))).rejects.toMatchObject({ code: 'not-a-file' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(upload).not.toHaveBeenCalled()
    for (const name of ['Plan', 'Link']) {
      await volume().write(name, new Blob(['x']).stream())
      expect(upload).toHaveBeenLastCalledWith('account', { method: 'POST', path: 'upload/drive/v3/files', json: { name, parents: ['root1'] } }, expect.any(ReadableStream), expect.objectContaining({ agentSlug: 'agent' }))
    }
    await volume().write('notes.txt', new Blob(['x']).stream())
    expect(upload).toHaveBeenLastCalledWith('account', { method: 'PATCH', path: 'upload/drive/v3/files/n', json: {} }, expect.any(ReadableStream), expect.objectContaining({ agentSlug: 'agent', signal: undefined }))
    await volume().write('Plan.md', new Blob(['x']).stream())
    expect(upload).toHaveBeenLastCalledWith('account', { method: 'PATCH', path: 'upload/drive/v3/files/doc1', json: {}, contentType: 'text/markdown' }, expect.any(ReadableStream), expect.objectContaining({ agentSlug: 'agent' }))
    await volume().write('Sub/new.txt', new Blob(['x']).stream())
    expect(upload).toHaveBeenLastCalledWith('account', expect.objectContaining({ json: { name: 'new.txt', parents: ['sub'] } }), expect.anything(), expect.anything())
    expect(calls().filter(call => call.includes('/export') || call.startsWith('PATCH'))).toEqual([])
  })

  it('fails a file read whose body is not the listed size, and serves an export from the bytes its listing was sized from', async () => {
    const content: Record<string, string> = { n: 'hello world' }
    const exports: Record<string, string | Error> = { doc1: 'exported' }
    serve({ folders: { root1: [blob('n', 'notes.txt'), doc('doc1', 'Plan')] }, content, exports })
    expect(await new Response(await (await volume().read('notes.txt')).stream({ start: 6, end: 10 })).text()).toBe('world')
    content.n = 'short'
    await expect(new Response(await (await volume().read('notes.txt')).stream()).text()).rejects.toThrow('ended early')
    content.n = 'hello world, and more'
    await expect(new Response(await (await volume().read('notes.txt')).stream()).text()).rejects.toThrow('more than its listed size')
    expect((await volume().list('')).find(entry => entry.name === 'Plan.md')?.size).toBe(8)
    exports.doc1 = 'exported!'
    const opened = await volume().read('Plan.md')
    expect(await new Response(await opened.stream({ start: 2, end: 7 })).text()).toBe('ported')
    expect(exportsOf()).toEqual(['GET drive/v3/files/doc1/export'])
    await expect(volume().read('')).rejects.toMatchObject({ code: 'not-a-file' })
  })

  it('checks names and emptiness against raw children, hidden ones included, and trashes instead of deleting', async () => {
    serve({ folders: { root1: [doc('doc1', 'Plan'), shortcut('s', 'Link'), folder('sub', 'Sub'), folder('empty', 'Empty')], sub: [shortcut('s2', 'Hidden')] } })
    for (const name of ['Link', 'Plan', 'Plan.md', 'Sub']) await expect(volume().mkdir(name)).rejects.toMatchObject({ code: 'already-exists' })
    expect(calls().filter(call => call.startsWith('POST'))).toEqual([])
    await volume().mkdir('Fresh')
    expect(request).toHaveBeenLastCalledWith('account', { method: 'POST', path: 'drive/v3/files', query: { fields: DRIVE_FILE_FIELDS }, json: { name: 'Fresh', mimeType: FOLDER, parents: ['root1'] } }, expect.anything())
    expect(await volume().list('Sub')).toEqual([])
    await expect(volume().delete('Sub')).rejects.toMatchObject({ code: 'not-empty' })
    await volume().delete('Empty')
    expect(request).toHaveBeenLastCalledWith('account', { method: 'PATCH', path: 'drive/v3/files/empty', json: { trashed: true } }, expect.anything())
    await volume().delete('Plan.md')
    expect(request).toHaveBeenLastCalledWith('account', expect.objectContaining({ path: 'drive/v3/files/doc1', json: { trashed: true } }), expect.anything())
    expect(calls().some(call => call.startsWith('DELETE'))).toBe(false)
  })

  it('moves in one update, keeps a taken folder name, and renames an export by its Drive name with the extension kept', async () => {
    serve({ folders: { root1: [doc('doc1', 'Plan'), blob('n', 'notes.txt'), blob('r', 'Plan.md'), folder('sub', 'Sub')] } })
    await expect(volume().move('notes.txt', 'Sub')).rejects.toMatchObject({ code: 'already-exists' })
    await expect(volume().move('Sub', 'notes.txt')).rejects.toMatchObject({ code: 'already-exists' })
    await expect(volume().move('Plan (Google Doc).md', 'Plan.md')).rejects.toMatchObject({ code: 'already-exists' })
    await expect(volume().move('Plan (Google Doc).md', 'Plan.txt')).rejects.toMatchObject({ code: 'invalid-path' })
    await expect(volume().move('Sub', 'Sub/inner')).rejects.toMatchObject({ code: 'invalid-path' })
    await expect(volume().move('notes.txt', 'missing/notes.txt')).rejects.toMatchObject({ code: 'not-a-directory' })
    expect(calls().filter(call => call.startsWith('PATCH'))).toEqual([])
    await volume().move('Plan (Google Doc).md', 'Roadmap.md')
    expect(request).toHaveBeenLastCalledWith('account', { method: 'PATCH', path: 'drive/v3/files/doc1', json: { name: 'Roadmap' }, query: { fields: DRIVE_FILE_FIELDS } }, expect.anything())
    await volume().move('notes.txt', 'Sub/notes.txt')
    expect(request).toHaveBeenLastCalledWith('account', { method: 'PATCH', path: 'drive/v3/files/n', json: { name: 'notes.txt' }, query: { fields: DRIVE_FILE_FIELDS, addParents: 'sub', removeParents: 'root1' } }, expect.anything())
  })

  it('saves by rename: a file moved onto a file replaces its content, a Doc copy saves into the Doc, then the source is trashed', async () => {
    serve({ folders: { root1: [doc('doc1', 'Plan'), blob('n', 'notes.txt'), blob('t1', 'notes.txt.tmp'), blob('t2', 'Plan.md.tmp')] }, content: { t1: 'new notes', t2: '# Plan' } })
    await volume().move('notes.txt.tmp', 'notes.txt')
    expect(upload).toHaveBeenLastCalledWith('account', { method: 'PATCH', path: 'upload/drive/v3/files/n', json: {} }, expect.any(ReadableStream), { agentSlug: 'agent' })
    expect(await new Response(upload.mock.lastCall![2]).text()).toBe('new notes')
    expect(request).toHaveBeenLastCalledWith('account', { method: 'PATCH', path: 'drive/v3/files/t1', json: { trashed: true } }, expect.anything())
    await volume().move('Plan.md.tmp', 'Plan.md')
    expect(upload).toHaveBeenLastCalledWith('account', { method: 'PATCH', path: 'upload/drive/v3/files/doc1', json: {}, contentType: 'text/markdown' }, expect.any(ReadableStream), { agentSlug: 'agent' })
    expect(request).toHaveBeenLastCalledWith('account', { method: 'PATCH', path: 'drive/v3/files/t2', json: { trashed: true } }, expect.anything())
  })

  it('follows a shortcut like a subfolder or file: reads and writes reach the target, delete and rename act on the shortcut', async () => {
    const pointer = (id: string, name: string, targetId: string) => ({ ...shortcut(id, name), shortcutDetails: { targetId } })
    serve({
      folders: {
        root1: [pointer('s1', 'Team docs', 'tf'), pointer('s2', 'Plan link', 'doc9'), pointer('s3', 'Up', 'root1'), pointer('s4', 'Gone', 'missing'), blob('lf', 'local.txt'), pointer('s5', 'local alias', 'lf')],
        tf: [blob('n', 'notes.txt')],
      },
      targets: { tf: folder('tf', 'Elsewhere'), doc9: doc('doc9', 'Plan'), root1: folder('root1', 'Team'), lf: blob('lf', 'local.txt') },
    })
    const original = request.getMockImplementation()!
    request.mockImplementation(async (account, req) => req.path === 'drive/v3/files/missing' ? Promise.reject(new WorkspaceFileError('not-found')) : original(account, req))
    expect((await volume().list('')).map(entry => entry.name)).toEqual(['Team docs', 'Plan link.md', 'Up', 'local.txt', 'local alias'])
    expect((await volume().list('Team docs')).map(entry => entry.name)).toEqual(['notes.txt'])
    await expect(volume().list('Up')).rejects.toMatchObject({ code: 'not-found' })
    await volume().write('Team docs/new.txt', new Blob(['x']).stream())
    expect(upload).toHaveBeenLastCalledWith('account', { method: 'POST', path: 'upload/drive/v3/files', json: { name: 'new.txt', parents: ['tf'] } }, expect.anything(), expect.anything())
    await volume().write('Plan link.md', new Blob(['x']).stream())
    expect(upload).toHaveBeenLastCalledWith('account', expect.objectContaining({ path: 'upload/drive/v3/files/doc9', contentType: 'text/markdown' }), expect.anything(), expect.anything())
    await volume().move('Team docs', 'Renamed')
    expect(request).toHaveBeenLastCalledWith('account', expect.objectContaining({ method: 'PATCH', path: 'drive/v3/files/s1', json: { name: 'Renamed' } }), expect.anything())
    expect((await volume().list('')).map(entry => entry.name)).toContain('Renamed')
    await volume().delete('Plan link.md')
    expect(request).toHaveBeenLastCalledWith('account', { method: 'PATCH', path: 'drive/v3/files/s2', json: { trashed: true } }, expect.anything())
    // A file moved onto its own shortcut is the same file: nothing is copied or trashed.
    const changes = () => calls().filter(call => call.startsWith('PATCH')).length + upload.mock.calls.length
    const before = changes()
    await volume().move('local.txt', 'local alias')
    await volume().move('local alias', 'local.txt')
    expect(changes()).toBe(before)
    // The listing kept after each change shows a saved shortcut under its own name, and deleting it keeps the file.
    await volume().write('local alias', new Blob(['x']).stream())
    expect((await volume().list('')).map(entry => entry.name)).toEqual(expect.arrayContaining(['local.txt', 'local alias']))
    await volume().delete('local alias')
    const names = (await volume().list('')).map(entry => entry.name)
    expect(names).toContain('local.txt')
    expect(names).not.toContain('local alias')
  })

  it('trashes a new file whose upload was cancelled while Drive committed it, as rclone sends it again under its new name', async () => {
    serve({ folders: { root1: [] } })
    const cancelled = new AbortController()
    upload.mockImplementationOnce(async (_account, session, _body, options) => options.publish(async () => { cancelled.abort(); return blob('made', session.json.name, 1) }))
    await volume().write('replacement.svg', new Blob(['x']).stream(), cancelled.signal)
    expect(request).toHaveBeenLastCalledWith('account', { method: 'PATCH', path: 'drive/v3/files/made', json: { trashed: true } }, expect.anything())
    expect((await volume().list('')).map(entry => entry.name)).not.toContain('replacement.svg')
  })

  it('keeps a file when rclone deletes it right after its overwrite failed, and trashes it on a later delete', async () => {
    serve({ folders: { root1: [blob('n', 'notes.txt')] } })
    upload.mockRejectedValueOnce(new Error('rate limited'))
    await expect(volume().write('notes.txt', new Blob(['x']).stream())).rejects.toThrow('rate limited')
    await volume().delete('notes.txt')
    expect(calls()).not.toContain('PATCH drive/v3/files/n')
    await volume().delete('notes.txt')
    expect(calls()).toContain('PATCH drive/v3/files/n')
  })

  it('reports a trashed root as not found and checks revoked accounts even on cache hits', async () => {
    serve({ folders: { root1: [blob('n', 'notes.txt')] }, root: folder('root1', 'Team', { trashed: true }) })
    await expect(volume().stat('')).rejects.toMatchObject({ code: 'not-found' })
    serve({ folders: { root1: [blob('n', 'notes.txt')] }, root: blob('root1', 'Team') })
    await expect(volume().stat('')).rejects.toMatchObject({ code: 'not-found' })
    serve({ folders: { root1: [blob('n', 'notes.txt')] } })
    expect(await volume().stat('')).toMatchObject({ name: '', kind: 'directory' })
    await volume().list('')
    requireAccount.mockRejectedValue(new WorkspaceFileError('not-accessible'))
    await expect(volume().list('')).rejects.toMatchObject({ code: 'not-accessible' })
    await expect(volume().stat('notes.txt')).rejects.toMatchObject({ code: 'not-accessible' })
  })

  it('refuses root mutations and missing parents, and prepares with the folder name Drive returns', async () => {
    serve({ folders: { root1: [] } })
    for (const operation of [() => volume().mkdir(''), () => volume().delete(''), () => volume().move('', 'a'), () => volume().move('a', '')]) {
      await expect(operation()).rejects.toMatchObject({ code: 'invalid-path' })
    }
    const cancel = vi.fn()
    await expect(volume().write('', new ReadableStream({ cancel }))).rejects.toMatchObject({ code: 'invalid-path' })
    expect(cancel).toHaveBeenCalledOnce()
    await expect(volume().write('missing/file', new Blob(['x']).stream())).rejects.toMatchObject({ code: 'not-found' })
    expect(upload).not.toHaveBeenCalled()
    const config = { accountId: 'account', folderId: 'root1', folderName: 'Client name', driveName: 'Client drive' }
    expect(await prepareGoogleDriveVolume(config, { userId: 'alice' })).toEqual({ name: 'Team', config: { ...config, folderName: 'Team', driveName: 'My Drive' } })
    expect(requireAccount).toHaveBeenCalledWith('account', { userId: 'alice' })
    await expect(prepareGoogleDriveVolume(config)).rejects.toThrow('creator')
    serve({ root: folder('shared1', 'Drive', { driveId: 'shared1' }) })
    expect(await prepareGoogleDriveVolume({ ...config, folderId: 'shared1' }, { userId: 'alice' })).toMatchObject({ name: 'Gamut', config: { folderName: 'Gamut', driveName: 'Gamut' } })
    serve({ root: folder('root1', 'Team', { trashed: true }) })
    await expect(prepareGoogleDriveVolume(config, { userId: 'alice' })).rejects.toMatchObject({ code: 'not-a-directory' })
  })
})
