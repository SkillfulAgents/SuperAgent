import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'

const { request, requireAccount } = vi.hoisted(() => ({ request: vi.fn(), requireAccount: vi.fn() }))
vi.mock('./dropbox-client', () => ({
  dropboxRequest: request, requireDropboxAccount: requireAccount,
  withDropboxAccount: async (id: string, run: (account: unknown) => Promise<unknown>) => run(await requireAccount(id)),
}))
import { DropboxMountableVolume, prepareDropboxVolume, DROPBOX_UPLOAD_CHUNK_BYTES } from './dropbox-mountable-volume'
import { dropboxVolumeConfigSchema } from './dropbox-schema'
import { dropboxReadCache } from './dropbox-read-cache'
import { dropboxHealthCache } from './dropbox-health-cache'

const folder = (name = 'Team') => ({ '.tag': 'folder', name, id: `id:${name}` })
const file = { '.tag': 'file', name: 'notes.txt', id: 'id:notes', size: 11, rev: 'abc123', server_modified: '2026-10-07T12:00:00Z' }
const page = (entries: unknown[], has_more = false, cursor = 'next') => ({ entries, has_more, cursor })
const volume = () => new DropboxMountableVolume('attachment', 'Team', { accountId: 'account', path: '/Team' }, 'agent')

beforeEach(() => { vi.resetAllMocks(); dropboxReadCache.invalidate('account'); dropboxHealthCache.invalidate('account'); requireAccount.mockResolvedValue({}) })

describe('Dropbox filesystem', () => {
  it('validates account roots and refuses config or operation paths that escape the folder', async () => {
    expect(dropboxVolumeConfigSchema.parse({ accountId: 'a', path: '/' }).path).toBe('')
    for (const path of ['/a/../other', 'id:outside', '//other', '/a\\b', '/a\0b']) {
      expect(dropboxVolumeConfigSchema.safeParse({ accountId: 'a', path }).success).toBe(false)
    }
    for (const path of ['../outside', '/outside', 'a/../outside', 'a\\b']) await expect(volume().stat(path)).rejects.toMatchObject({ code: 'invalid-path' })
    for (const operation of [() => volume().mkdir(''), () => volume().delete(''), () => volume().move('', 'a'), () => volume().move('a', '')]) {
      await expect(operation()).rejects.toMatchObject({ code: 'invalid-path' })
    }
    const cancel = vi.fn()
    await expect(volume().write('', new ReadableStream({ cancel }))).rejects.toMatchObject({ code: 'invalid-path' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(request).not.toHaveBeenCalled()
  })

  it('checks the creator account before preparing a folder and supports the account root', async () => {
    request.mockResolvedValueOnce(Response.json(page([])))
    expect(await prepareDropboxVolume({ accountId: 'account', path: '' }, { userId: 'alice' })).toEqual({ name: 'Dropbox', config: { accountId: 'account', path: '' } })
    expect(requireAccount).toHaveBeenCalledWith('account', { userId: 'alice' })
    expect(request).toHaveBeenCalledWith('account', 'list_folder', { path: '', limit: 1, recursive: false }, expect.anything())
    requireAccount.mockRejectedValueOnce(new WorkspaceFileError('not-found'))
    await expect(prepareDropboxVolume({ accountId: 'other', path: '' }, { userId: 'alice' })).rejects.toThrow()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('lists all pages and keeps requests scoped to the configured folder', async () => {
    request.mockResolvedValueOnce(Response.json(page([{ ...folder('Subfolder'), path_lower: '/team/subfolder' }], true)))
      .mockResolvedValueOnce(Response.json(page([{ ...file, path_lower: '/team/notes.txt' }])))
    expect(await volume().list('')).toEqual([
      { name: 'Subfolder', kind: 'directory', size: 0, mtimeMs: 0 },
      { name: 'notes.txt', kind: 'file', size: 11, mtimeMs: Date.parse(file.server_modified) },
    ])
    expect(request.mock.calls[0].slice(0, 3)).toEqual(['account', 'list_folder', { path: '/Team', recursive: false, limit: 2000, include_deleted: false, include_non_downloadable_files: true }])
    expect(request.mock.calls[1].slice(0, 3)).toEqual(['account', 'list_folder/continue', { cursor: 'next' }])
    request.mockResolvedValueOnce(Response.json(folder()))
    expect(await volume().stat('')).toMatchObject({ name: '', kind: 'directory' })
  })

  it('applies deletion and replacement records arriving during pagination', async () => {
    request.mockResolvedValueOnce(Response.json(page([file, folder('Subfolder')], true, 'one')))
      .mockResolvedValueOnce(Response.json(page([
        { '.tag': 'deleted', name: 'NOTES.TXT', path_lower: '/team/notes.txt' },
        { ...folder('subfolder'), id: 'id:replacement' },
        { '.tag': 'deleted', name: 'already-gone', path_lower: '/team/already-gone' },
      ], true, 'two')))
      .mockResolvedValueOnce(Response.json(page([{ ...file, size: 99, rev: 'new' }])))
    expect(await volume().list('')).toEqual([
      { name: 'subfolder', kind: 'directory', size: 0, mtimeMs: 0 },
      { name: 'notes.txt', kind: 'file', size: 99, mtimeMs: Date.parse(file.server_modified) },
    ])
    // A subsequent stat must use the replacement folder, not an earlier page.
    expect(dropboxReadCache.metadata('account', '/Team', '/Team/subfolder')?.id).toBe('id:replacement')
  })

  it('keeps only the latest revision of a file repeated on later pages', async () => {
    request.mockResolvedValueOnce(Response.json(page([file], true)))
      .mockResolvedValueOnce(Response.json(page([{ ...file, name: 'NOTES.txt', size: 22, rev: 'updated' }])))
    expect(await volume().list('')).toEqual([
      { name: 'NOTES.txt', kind: 'file', size: 22, mtimeMs: Date.parse(file.server_modified) },
    ])
  })

  it('shares listings and child metadata across request-scoped adapters', async () => {
    request.mockResolvedValueOnce(Response.json(page([
      { ...folder('Subfolder'), path_lower: '/team/subfolder' },
    ]))).mockResolvedValueOnce(Response.json(page([file])))
    expect(volume().cacheMode).toBe('remote')
    expect(volume().caseInsensitive).toBe(true)
    expect(await volume().list('')).toHaveLength(1)
    expect(await volume().stat('Subfolder')).toMatchObject({ kind: 'directory' })
    expect(await volume().list('Subfolder')).toHaveLength(1)
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls.every(call => call[1] === 'list_folder')).toBe(true)
    expect(requireAccount).toHaveBeenCalledTimes(3)
  })

  it('checks revoked accounts even when listings and metadata are cached', async () => {
    request.mockResolvedValueOnce(Response.json(page([{ ...file, path_lower: '/team/notes.txt' }])))
    await volume().list('')
    requireAccount.mockRejectedValue(new WorkspaceFileError('not-accessible'))
    await expect(volume().list('')).rejects.toMatchObject({ code: 'not-accessible' })
    await expect(volume().stat('notes.txt')).rejects.toMatchObject({ code: 'not-accessible' })
    expect(request).toHaveBeenCalledOnce()
  })

  it('checks live folder contents before delete even if the cached folder was empty', async () => {
    request.mockResolvedValueOnce(Response.json(page([{ ...folder('sub'), path_lower: '/team/sub' }])))
    await volume().list('')
    request.mockResolvedValueOnce(Response.json(page([])))
    expect(await volume().list('sub')).toEqual([])
    request.mockResolvedValueOnce(Response.json(folder('sub'))).mockResolvedValueOnce(Response.json(page([file])))
    await expect(volume().delete('sub')).rejects.toMatchObject({ code: 'not-empty' })
    expect(request).toHaveBeenLastCalledWith('account', 'list_folder', expect.objectContaining({ path: '/Team/sub', recursive: false }), expect.anything())
    expect(request.mock.calls.some(call => call[1] === 'delete_v2')).toBe(false)
    expect(dropboxReadCache.metadata('account', '/Team', '/Team/sub')).toBeUndefined()
  })

  it('checks live parents before writing even if a deleted parent is in the scan cache', async () => {
    request.mockResolvedValueOnce(Response.json(page([{ ...folder('sub'), path_lower: '/team/sub' }])))
    await volume().list('')
    request.mockRejectedValueOnce(new WorkspaceFileError('not-found')).mockRejectedValueOnce(new WorkspaceFileError('not-found'))
    await expect(volume().write('sub/new.txt', new Blob(['x']).stream())).rejects.toMatchObject({ code: 'not-found' })
    expect(request).toHaveBeenLastCalledWith('account', 'get_metadata', { path: '/Team/sub' }, expect.anything())
    expect(request).toHaveBeenCalledTimes(3)
  })

  it.each([false, true])('invalidates listings populated during a mutation, including failure=%s', async fails => {
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    request.mockImplementation(async (_account, endpoint) => {
      if (endpoint === 'get_metadata') return Response.json(folder())
      if (endpoint === 'create_folder_v2') {
        await gate
        if (fails) throw new WorkspaceFileError('already-exists')
        return Response.json(null)
      }
      return Response.json(page([{ ...file, path_lower: '/team/notes.txt' }]))
    })
    const pending = volume().mkdir('new').catch(error => error)
    await vi.waitFor(() => expect(request.mock.calls.some(call => call[1] === 'create_folder_v2')).toBe(true))
    await volume().list('')
    expect(dropboxReadCache.metadata('account', '/Team', '/Team/notes.txt')).toBeDefined()
    finish()
    expect(await pending).toEqual(fails ? expect.any(WorkspaceFileError) : undefined)
    expect(dropboxReadCache.metadata('account', '/Team', '/Team/notes.txt')).toBeUndefined()
  })

  it('pins a download revision and streams only the requested range even if upstream ignores Range', async () => {
    request.mockResolvedValueOnce(Response.json(file)).mockResolvedValueOnce(new Response('hello world'))
    const opened = await volume().read('notes.txt')
    expect(opened.size).toBe(11)
    expect(await new Response(await opened.stream({ start: 6, end: 10 })).text()).toBe('world')
    expect(request).toHaveBeenLastCalledWith('account', 'download', { path: 'rev:abc123' }, expect.objectContaining({ range: 'bytes=6-10', agentSlug: 'agent' }))
    await expect(opened.stream()).rejects.toThrow('already been consumed')
  })

  it('uses upstream partial content, and rejects truncated streams or a wrong range', async () => {
    request.mockResolvedValueOnce(Response.json(file)).mockResolvedValueOnce(new Response('world', { status: 206, headers: { 'content-range': 'bytes 6-10/11' } }))
    expect(await new Response(await (await volume().read('notes.txt')).stream({ start: 6, end: 10 })).text()).toBe('world')
    request.mockResolvedValueOnce(Response.json(file)).mockResolvedValueOnce(new Response('short'))
    await expect(new Response(await (await volume().read('notes.txt')).stream()).text()).rejects.toThrow('ended early')
    request.mockResolvedValueOnce(Response.json(file)).mockResolvedValueOnce(new Response('world', { status: 206, headers: { 'content-range': 'bytes 0-4/11' } }))
    await expect((await volume().read('notes.txt')).stream({ start: 6, end: 10 })).rejects.toMatchObject({ status: 503 })
  })

  it('closes a metadata-only read without downloading and rejects folders and online-only documents', async () => {
    request.mockResolvedValueOnce(Response.json(file))
    await (await volume().read('notes.txt')).close()
    expect(request).toHaveBeenCalledTimes(1)
    for (const metadata of [folder(), { ...file, is_downloadable: false }, { ...file, symlink_info: { target: '/other' } }]) {
      request.mockResolvedValueOnce(Response.json(metadata))
      await expect(volume().read('notes.txt')).rejects.toBeInstanceOf(WorkspaceFileError)
    }
  })

  it('uploads binary data larger than the proxy limit without committing until all chunks arrive', async () => {
    request.mockImplementation(async (_account, endpoint, args) => {
      if (endpoint === 'get_metadata') {
        if (args.path === '/Team') return Response.json(folder())
        throw new WorkspaceFileError('not-found')
      }
      if (endpoint === 'upload_session/start') return Response.json({ session_id: 'session' })
      return Response.json(null)
    })
    const data = new Uint8Array(DROPBOX_UPLOAD_CHUNK_BYTES + 17).map((_, i) => i % 256)
    await volume().write('binary.dat', new Blob([data]).stream())
    const chunks = request.mock.calls.filter(call => ['upload_session/start', 'upload_session/append_v2'].includes(call[1]))
    expect(chunks.map(call => call[3].bytes.byteLength)).toEqual([DROPBOX_UPLOAD_CHUNK_BYTES, 17])
    expect(Buffer.concat(chunks.map(call => Buffer.from(call[3].bytes))).equals(Buffer.from(data))).toBe(true)
    expect(request).toHaveBeenLastCalledWith('account', 'upload_session/finish', {
      cursor: { session_id: 'session', offset: data.length }, commit: { path: '/Team/binary.dat', mode: 'add', autorename: false, strict_conflict: true },
    }, expect.anything())
  })

  it('replaces existing files using their revision and supports an empty upload', async () => {
    request.mockResolvedValueOnce(Response.json(file)).mockResolvedValueOnce(Response.json(folder())).mockResolvedValueOnce(Response.json(null))
    await volume().write('notes.txt', new Blob([]).stream())
    expect(request).toHaveBeenLastCalledWith('account', 'upload', {
      path: '/Team/notes.txt', mode: { '.tag': 'update', update: 'abc123' }, autorename: false, strict_conflict: true,
    }, expect.objectContaining({ bytes: new ArrayBuffer(0) }))
  })

  it('cancels a failed upload without publishing partial data and refuses missing parents', async () => {
    request.mockRejectedValueOnce(new WorkspaceFileError('not-found')).mockRejectedValueOnce(new WorkspaceFileError('not-found'))
    await expect(volume().write('missing/file', new Blob(['x']).stream())).rejects.toMatchObject({ code: 'not-found' })
    expect(request.mock.calls.map(call => call[1])).toEqual(['get_metadata', 'get_metadata'])
    request.mockRejectedValueOnce(new WorkspaceFileError('not-found'))
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('Disconnected')) }, cancel })
    await expect(volume().write('file', body)).rejects.toThrow('Disconnected')
    expect(request.mock.calls.some(call => call[1] === 'upload_session/finish')).toBe(false)
  })

  it('refuses nonempty folder deletion and conditions file deletion on its revision', async () => {
    request.mockResolvedValueOnce(Response.json(folder('sub'))).mockResolvedValueOnce(Response.json(page([file])))
    await expect(volume().delete('sub')).rejects.toMatchObject({ code: 'not-empty' })
    expect(request.mock.calls.some(call => call[1] === 'delete_v2')).toBe(false)
    request.mockResolvedValueOnce(Response.json(file)).mockResolvedValueOnce(Response.json(null))
    await volume().delete('notes.txt')
    expect(request).toHaveBeenLastCalledWith('account', 'delete_v2', { path: '/Team/notes.txt', parent_rev: 'abc123' }, expect.anything())
  })

  it('creates and moves only within the selected folder, retaining an occupied destination', async () => {
    request.mockResolvedValueOnce(Response.json(folder())).mockResolvedValueOnce(Response.json(null))
    await volume().mkdir('new')
    expect(request).toHaveBeenLastCalledWith('account', 'create_folder_v2', { path: '/Team/new', autorename: false }, expect.anything())
    request.mockResolvedValueOnce(Response.json(file)).mockResolvedValueOnce(Response.json(folder())).mockResolvedValueOnce(Response.json(folder('occupied')))
    await expect(volume().move('notes.txt', 'occupied')).rejects.toMatchObject({ code: 'already-exists' })
    expect(request.mock.calls.some(call => call[1] === 'move_v2')).toBe(false)
    expect(request.mock.calls.some(call => call[1] === 'delete_v2')).toBe(false)
  })
})

function writableFiles() {
  request.mockImplementation(async (_account, endpoint, args) => {
    if (endpoint === 'get_metadata') {
      if (args.path === '/Team') return Response.json(folder())
      throw new WorkspaceFileError('not-found')
    }
    if (endpoint === 'upload_session/start') return Response.json({ session_id: 'session' })
    return Response.json(null)
  })
}

describe('Dropbox upload concurrency and metadata freshness', () => {
  it.each([1, DROPBOX_UPLOAD_CHUNK_BYTES])('uploads %i bytes in one content call without starting a session', async size => {
    writableFiles()
    const bytes = new Uint8Array(size).fill(255)
    await volume().write('small.bin', new Blob([bytes]).stream())
    expect(request.mock.calls.map(call => call[1])).toEqual(['get_metadata', 'get_metadata', 'upload'])
    expect(Buffer.from(request.mock.calls[2][3].bytes).equals(Buffer.from(bytes))).toBe(true)
  })

  it('allows another mutation while an upload is waiting for its request body', async () => {
    writableFiles()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
    const pending = volume().write('slow.bin', body)
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    try {
      await volume().mkdir('unrelated')
      expect(request.mock.calls.some(call => call[1] === 'upload')).toBe(false)
    } finally { controller.close(); await pending }
  })

  it('stages four transfers together without blocking mkdir, then commits each complete upload', async () => {
    writableFiles()
    const base = request.getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    request.mockImplementation(async (...args) => {
      if (args[1] === 'upload_session/append_v2') await gate
      return base(...args)
    })
    const data = new Uint8Array(DROPBOX_UPLOAD_CHUNK_BYTES + 1)
    const uploads = Array.from({ length: 4 }, (_, i) => volume().write(`large${i}.bin`, new Blob([data]).stream()))
    try {
      await vi.waitFor(() => expect(request.mock.calls.filter(call => call[1] === 'upload_session/append_v2')).toHaveLength(4))
      await volume().mkdir('unrelated')
      expect(request.mock.calls.some(call => call[1] === 'upload_session/finish')).toBe(false)
    } finally { release(); await Promise.all(uploads) }
    expect(request.mock.calls.filter(call => call[1] === 'upload_session/finish')).toHaveLength(4)
  })

  it('serializes short commits across mounts and rechecks account revocation before publishing', async () => {
    writableFiles()
    const base = request.getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    request.mockImplementation(async (...args) => {
      if (args[1] === 'upload') await gate
      return base(...args)
    })
    const first = volume().write('first.txt', new Blob(['first']).stream())
    await vi.waitFor(() => expect(request.mock.calls.filter(call => call[1] === 'upload')).toHaveLength(1))
    const second = volume().write('second.txt', new Blob(['second']).stream()).catch(error => error)
    await vi.waitFor(() => expect(request.mock.calls.filter(call => call[1] === 'get_metadata')).toHaveLength(3))
    expect(request.mock.calls.filter(call => call[1] === 'upload')).toHaveLength(1)
    requireAccount.mockRejectedValue(new WorkspaceFileError('not-accessible'))
    release()
    await first
    expect(await second).toMatchObject({ code: 'not-accessible' })
    expect(request.mock.calls.filter(call => call[1] === 'upload')).toHaveLength(1)
  })

  it('reports fresh file sizes for stat and read after an external edit, retaining directory scan reuse', async () => {
    request.mockResolvedValueOnce(Response.json(page([file, folder('sub')])))
    await volume().list('')
    const updated = { ...file, size: 7, rev: 'new-revision' }
    request.mockResolvedValueOnce(Response.json(updated)).mockResolvedValueOnce(Response.json(updated))
      .mockResolvedValueOnce(new Response('updated'))
    expect((await volume().stat('notes.txt')).size).toBe(7)
    const opened = await volume().read('notes.txt')
    expect(opened.size).toBe(7)
    expect(await new Response(await opened.stream()).text()).toBe('updated')
    expect(request).toHaveBeenLastCalledWith('account', 'download', { path: 'rev:new-revision' }, expect.anything())
    expect(await volume().stat('sub')).toMatchObject({ kind: 'directory' })
    expect(request).toHaveBeenCalledTimes(4)
  })
})

function renameFixture(fail?: (endpoint: string, args: Record<string, string>, files: Map<string, typeof file>) => void) {
  const files = new Map([
    ['/Team/index.lock', { ...file, name: 'index.lock', id: 'id:new', rev: 'new' }],
    ['/Team/index', { ...file, name: 'index', id: 'id:old', rev: 'old' }],
  ])
  request.mockImplementation(async (_account, endpoint, args) => {
    fail?.(endpoint, args, files)
    if (endpoint === 'get_metadata') {
      if (args.path === '/Team') return Response.json(folder())
      if (!files.has(args.path)) throw new WorkspaceFileError('not-found')
      return Response.json(files.get(args.path))
    }
    if (endpoint === 'move_v2') {
      const source = files.get(args.from_path)
      if (!source) throw new WorkspaceFileError('not-found')
      if (files.has(args.to_path)) throw new WorkspaceFileError('already-exists')
      files.set(args.to_path, source)
      files.delete(args.from_path)
    }
    if (endpoint === 'delete_v2') {
      if (files.get(args.path)?.rev !== args.parent_rev) throw new WorkspaceFileError('already-exists')
      files.delete(args.path)
    }
    return Response.json(null)
  })
  return files
}

describe('Dropbox replacement renames', () => {
  it('replaces an existing file and removes its backup only after the source move succeeds', async () => {
    const files = renameFixture()
    await volume().move('index.lock', 'index')
    expect([...files.entries()]).toEqual([['/Team/index', expect.objectContaining({ id: 'id:new' })]])
    expect(request.mock.calls.filter(call => call[1] !== 'get_metadata').map(call => call[1])).toEqual(['move_v2', 'move_v2', 'delete_v2'])
  })

  it('restores the destination if moving the source fails', async () => {
    const files = renameFixture((endpoint, args) => {
      if (endpoint === 'move_v2' && args.from_path === '/Team/index.lock') throw new WorkspaceFileError('not-accessible')
    })
    await expect(volume().move('index.lock', 'index')).rejects.toMatchObject({ code: 'not-accessible' })
    expect(files.size).toBe(2)
    expect(files.get('/Team/index')?.id).toBe('id:old')
    expect(files.get('/Team/index.lock')?.id).toBe('id:new')
    expect(request.mock.calls.some(call => call[1] === 'delete_v2')).toBe(false)
  })

  it('preserves the backup and an external replacement when rollback cannot restore safely', async () => {
    const files = renameFixture((endpoint, args, files) => {
      if (endpoint === 'move_v2' && args.from_path === '/Team/index.lock') {
        files.set('/Team/index', { ...file, id: 'id:external' })
        throw new WorkspaceFileError('already-exists')
      }
    })
    await expect(volume().move('index.lock', 'index')).rejects.toThrow('previous destination is preserved at /Team/.gamut-rename-')
    expect(files.get('/Team/index')?.id).toBe('id:external')
    expect([...files.values()].map(value => value.id).sort()).toEqual(['id:external', 'id:new', 'id:old'])
    expect(request.mock.calls.some(call => call[1] === 'delete_v2')).toBe(false)
  })

  it('keeps a modified backup if cleanup fails without reporting the successful rename as failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const files = renameFixture((endpoint, args, files) => {
        if (endpoint === 'delete_v2') files.set(args.path, { ...file, id: 'id:changed-backup', rev: 'changed' })
      })
      await volume().move('index.lock', 'index')
      expect(files.get('/Team/index')?.id).toBe('id:new')
      expect([...files.values()].map(value => value.id).sort()).toEqual(['id:changed-backup', 'id:new'])
      expect(warn).toHaveBeenCalledOnce()
    } finally { warn.mockRestore() }
  })

  it('moves to an empty destination without a backup and supports case-only renames', async () => {
    const files = renameFixture()
    files.delete('/Team/index')
    await volume().move('index.lock', 'index')
    expect(request.mock.calls.filter(call => call[1] === 'move_v2')).toHaveLength(1)
    request.mockReset()
    request.mockResolvedValueOnce(Response.json(file)).mockResolvedValueOnce(Response.json(folder()))
      .mockResolvedValueOnce(Response.json(file)).mockResolvedValueOnce(Response.json(null))
    await volume().move('notes.txt', 'NOTES.txt')
    expect(request.mock.calls.filter(call => call[1] === 'move_v2')).toHaveLength(1)
    expect(request.mock.calls.some(call => call[1] === 'delete_v2')).toBe(false)
  })
})
