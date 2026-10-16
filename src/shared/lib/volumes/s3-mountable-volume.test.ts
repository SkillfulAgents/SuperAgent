import { afterEach, describe, expect, it, vi } from 'vitest'
import { s3Fixture } from './testing/s3-fixture'
import { S3_PART_BYTES } from './s3-mountable-volume'
vi.mock('@shared/lib/proxy/audit', () => ({ writeProxyAuditEntry: async () => {} }))
afterEach(() => vi.restoreAllMocks())
const bytes = (text: string) => Buffer.from(text)

describe('S3 object-store filesystem behavior', () => {
  it('paginates files and implicit directories without escaping the configured prefix', async () => {
    const f = s3Fixture(); f.setPageSize(2)
    f.put('a', bytes('a')); f.put('b', bytes('bb')); f.put('implicit/child', bytes('child'))
    f.putObject('mounted-neighbor/private', bytes('outside')); f.putObject('other/private', bytes('outside'))
    expect((await f.volume().list('')).map(entry => entry.name).sort()).toEqual(['a', 'b', 'implicit'])
    expect((await f.volume().stat('implicit')).kind).toBe('directory')
    expect((await f.volume().list('implicit')).map(entry => entry.name)).toEqual(['child'])
    expect(f.requests.some(request => request.query['continuation-token'])).toBe(true)
    expect(f.requests.every(request => request.key.startsWith('mounted') || request.query['list-type'])).toBe(true)
  })

  it('retains an implicit parent directory after its last child is deleted or moved', async () => {
    const f = s3Fixture(); f.put('parent/file', bytes('keep'))
    await f.volume().move('parent/file', 'moved')
    expect((await f.volume().stat('parent')).kind).toBe('directory')
    f.put('another/file', bytes('keep'))
    await f.volume().delete('another/file')
    expect((await f.volume().stat('another')).kind).toBe('directory')
  })

  it('does not mistake hidden, unrepresentable keys for an empty directory', async () => {
    const f = s3Fixture(); f.mkdir('dir'); f.putObject('mounted/dir/../hidden', bytes('keep'))
    await expect(f.volume().delete('dir')).rejects.toMatchObject({ code: 'not-empty' })
    expect(f.objects.has('mounted/dir/../hidden')).toBe(true)
  })

  it('renames a populated directory including empty children and encoded names', async () => {
    const f = s3Fixture(); f.setPageSize(2)
    f.mkdir('from'); f.mkdir('from/empty'); f.put('from/café & + # %.txt', bytes('keep')); f.put('from/nested/file', bytes('nested'))
    await f.volume().move('from', 'to')
    expect(f.exists('from')).toBe(false)
    expect(f.bytes('to/café & + # %.txt')).toEqual(bytes('keep'))
    expect(f.exists('to/empty')).toBe(true)
    expect(f.bytes('to/nested/file')).toEqual(bytes('nested'))
  })

  it('copies all directory members before deleting any, preserving originals on copy failure', async () => {
    const f = s3Fixture(); f.put('from/a', bytes('a')); f.put('from/b', bytes('b'))
    let copies = 0
    f.deny(request => request.headers['x-amz-copy-source'] && ++copies === 2 ? 'AccessDenied' : undefined)
    await expect(f.volume().move('from', 'to')).rejects.toMatchObject({ code: 'not-accessible' })
    expect(f.bytes('from/a')).toEqual(bytes('a')); expect(f.bytes('from/b')).toEqual(bytes('b'))
    expect(f.requests.some(request => request.method === 'DELETE')).toBe(false)
  })

  it('lets sibling commits proceed but holds a folder rename until its child write settles', async () => {
    const f = s3Fixture(); f.mkdir('dir')
    const original = f.transport.getMockImplementation()!
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    f.transport.mockImplementation(async (...args) => {
      if (args[0].method === 'PUT' && args[0].path.endsWith('/dir/file') && !args[0].headers['x-amz-copy-source']) { entered(); await gate }
      return original(...args)
    })
    const writing = f.volume().write('dir/file', new Blob(['child']).stream())
    await started
    const moving = f.volume().move('dir', 'moved')
    try {
      await f.volume().write('sibling', new Blob(['independent']).stream())
      expect(f.exists('sibling')).toBe(true)
      expect(f.exists('moved')).toBe(false)
    } finally { release() }
    await writing; await moving
    expect(Buffer.from(f.bytes('moved/file')!).toString()).toBe('child')
  })

  it('uses multipart upload above 8 MiB and cleans up a refused commit', async () => {
    const f = s3Fixture()
    const input = new Uint8Array(S3_PART_BYTES + 7).fill(42)
    await f.volume().write('large', new Blob([input]).stream())
    expect(Buffer.from(f.bytes('large')!).equals(Buffer.from(input))).toBe(true)
    expect(f.sessions.size).toBe(0)
    expect(f.requests.filter(request => request.method === 'PUT' && request.query.uploadId)).toHaveLength(2)
    f.failWrite()
    await expect(f.volume().write('large', new Blob([input]).stream())).rejects.toThrow()
    expect(f.sessions.size).toBe(0)
    expect(Buffer.from(f.bytes('large')!).equals(Buffer.from(input))).toBe(true)
  })

  it('aborts staged multipart data after a stream fails and preserves the old file', async () => {
    const f = s3Fixture(); f.put('large', bytes('old'))
    let count = 0
    const body = new ReadableStream<Uint8Array>({ pull(c) { if (++count <= 3) c.enqueue(new Uint8Array(S3_PART_BYTES)); else c.error(new Error('body lost')) } })
    await expect(f.volume().write('large', body)).rejects.toThrow('body lost')
    expect(f.sessions.size).toBe(0)
    expect(f.bytes('large')).toEqual(bytes('old'))
  })

  it('pins downloads to the metadata ETag when a file changes between HEAD and GET', async () => {
    const f = s3Fixture(); f.put('file', bytes('before'))
    const opened = await f.volume().read('file')
    f.put('file', bytes('after'))
    await expect(opened.stream()).rejects.toMatchObject({ status: 409 })
  })

  it.each(['../outside', 'a/../../outside', '/outside', 'a//b', 'a/./b', 'a\\b', 'a\0b'])('rejects invalid path %j before any S3 request', async name => {
    const f = s3Fixture()
    await expect(f.volume().write(name, new Blob(['x']).stream())).rejects.toMatchObject({ code: 'invalid-path' })
    expect(f.requests).toHaveLength(0)
  })

  it('refuses destructive operations when an object and directory share a name', async () => {
    const f = s3Fixture(); f.put('collision', bytes('keep')); f.put('collision/file', bytes('also keep'))
    await expect(f.volume().delete('collision')).rejects.toMatchObject({ code: 'not-accessible' })
    await expect(f.volume().write('collision', new Blob(['replace']).stream())).rejects.toMatchObject({ code: 'not-a-file' })
    expect(f.bytes('collision')).toEqual(bytes('keep')); expect(f.bytes('collision/file')).toEqual(bytes('also keep'))
  })

  it('answers lookups of new names from a warm listing and keeps it warm through its own changes', async () => {
    const f = s3Fixture(); const volume = f.volume()
    await volume.list('')
    const before = f.requests.length
    await expect(volume.stat('new.txt')).rejects.toMatchObject({ code: 'not-found' })
    expect(f.requests.length).toBe(before)
    await volume.write('new.txt', new Blob(['hello']).stream())
    await volume.mkdir('dir')
    const settled = f.requests.length
    expect((await volume.list('')).find(entry => entry.name === 'new.txt')).toMatchObject({ kind: 'file', size: 5 })
    expect(await volume.list('dir')).toEqual([])
    await expect(volume.stat('dir/missing')).rejects.toMatchObject({ code: 'not-found' })
    expect(f.requests.length).toBe(settled)
    await volume.delete('new.txt')
    const deleted = f.requests.length
    expect((await volume.list('')).some(entry => entry.name === 'new.txt')).toBe(false)
    expect(f.requests.length).toBe(deleted)
  })

  it('reads a warm listing again after a change fails', async () => {
    const f = s3Fixture(); const volume = f.volume()
    await volume.list('')
    f.failWrite()
    await expect(volume.write('new.txt', new Blob(['hello']).stream())).rejects.toBeTruthy()
    const lists = f.count('list', '')
    await volume.list('')
    expect(f.count('list', '')).toBe(lists + 1)
  })

  it('does not let a listing read before a write hide that write', async () => {
    const f = s3Fixture(); const volume = f.volume()
    const original = f.transport.getMockImplementation()!
    let held = false, release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    f.transport.mockImplementation(async (...args) => {
      const response = await original(...args)
      if (!held && (args[0] as { query?: Record<string, unknown> }).query?.delimiter) { held = true; await gate }
      return response
    })
    const reading = volume.list('')
    await vi.waitFor(() => expect(held).toBe(true))
    await volume.write('new.txt', new Blob(['hello']).stream())
    release()
    await reading
    expect(await volume.stat('new.txt')).toMatchObject({ kind: 'file', size: 5 })
  })

  it('checks the parent afresh even when its listing is warm', async () => {
    const f = s3Fixture(); const volume = f.volume()
    f.mkdir('dir'); await volume.list('dir')
    f.putObject('mounted/dir', bytes('a file with the folder name'))
    await expect(volume.write('dir/child', new Blob(['x']).stream())).rejects.toBeTruthy()
    expect(f.objects.has('mounted/dir/child')).toBe(false)
  })
})
