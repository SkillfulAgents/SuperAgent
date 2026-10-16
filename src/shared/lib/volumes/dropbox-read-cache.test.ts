import { afterEach, describe, expect, it, vi } from 'vitest'
import { DropboxReadCache } from './dropbox-read-cache'
import { dropboxMetadataSchema, type DropboxMetadata } from './dropbox-schema'

const folder = (name: string) => dropboxMetadataSchema.parse({ '.tag': 'folder', name, id: `id:${name}` })
const file = (name: string) => dropboxMetadataSchema.parse({
  '.tag': 'file', name, id: `id:${name}`, size: 10, rev: 'abc', server_modified: '2026-10-07T12:00:00Z',
})
afterEach(() => { vi.restoreAllMocks() })

describe('Dropbox listing cache', () => {
  it('reuses listings and their child metadata across case-insensitive paths', async () => {
    const cache = new DropboxReadCache()
    const read = vi.fn(async () => [folder('Sub'), file('Notes.txt')])
    await cache.list('a', '/Team', '/Team', read)
    expect(await cache.list('a', '/team', '/TEAM', read)).toHaveLength(2)
    expect(cache.metadata('a', '/Team', '/team/NOTES.txt')).toMatchObject({ size: 10 })
    expect(read).toHaveBeenCalledOnce()
    expect(cache.metadata('a', '/Other', '/Team/Notes.txt')).toBeUndefined()
    expect(cache.metadata('b', '/Team', '/Team/Notes.txt')).toBeUndefined()
  })

  it('coalesces simultaneous listings and expires each directory without sliding its lifetime', async () => {
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const cache = new DropboxReadCache()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const read = vi.fn(async () => { await gate; return [folder('Sub')] })
    const first = cache.list('a', '/Team', '/Team', read)
    const second = cache.list('a', '/Team', '/Team', read)
    expect(read).toHaveBeenCalledOnce()
    release()
    await Promise.all([first, second])
    now = 14_999
    await cache.list('a', '/Team', '/Team', read)
    await cache.list('a', '/Team', '/Team/Sub', async () => [file('new.txt')])
    expect(read).toHaveBeenCalledOnce()
    now = 15_001
    expect(cache.metadata('a', '/Team', '/Team/Sub')).toBeUndefined()
    expect(cache.metadata('a', '/Team', '/Team/Sub/new.txt')).toBeDefined()
    await cache.list('a', '/Team', '/Team', read)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('invalidates every root of an account while retaining other accounts', async () => {
    const cache = new DropboxReadCache()
    const read = async () => [file('notes.txt')]
    await cache.list('a', '/Team', '/Team', read)
    await cache.list('b', '/Team', '/Team', read)
    await cache.list('a', '/Other', '/Other', read)
    cache.invalidate('a')
    expect(cache.metadata('a', '/Team', '/Team/notes.txt')).toBeUndefined()
    expect(cache.metadata('a', '/Other', '/Other/notes.txt')).toBeUndefined()
    expect(cache.metadata('b', '/Team', '/Team/notes.txt')).toBeDefined()
  })

  it('does not repopulate an invalidated cache when an earlier listing finishes', async () => {
    const cache = new DropboxReadCache()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const pending = cache.list('a', '/Team', '/Team', async () => { await gate; return [file('old.txt')] })
    cache.invalidate('a')
    await cache.list('a', '/Team', '/Team', async () => [file('new.txt')])
    release()
    await pending
    expect(cache.metadata('a', '/Team', '/Team/old.txt')).toBeUndefined()
    expect(cache.metadata('a', '/Team', '/Team/new.txt')).toBeDefined()
  })

  it('does not retain failures and caches an empty listing', async () => {
    const cache = new DropboxReadCache()
    const read = vi.fn<() => Promise<DropboxMetadata[]>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue([])
    await expect(cache.list('a', '/Team', '/Team', read)).rejects.toThrow('offline')
    expect(await cache.list('a', '/Team', '/Team', read)).toEqual([])
    expect(await cache.list('a', '/Team', '/Team', read)).toEqual([])
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('bounds retained directories and entries without truncating oversized responses', async () => {
    const cache = new DropboxReadCache()
    const empty = vi.fn(async () => [])
    for (let i = 0; i < 257; i++) await cache.list('a', '/Team', `/Team/sub${i}`, empty)
    await cache.list('a', '/Team', '/Team/sub0', empty)
    expect(empty).toHaveBeenCalledTimes(258)
    const many = Array.from({ length: 4_001 }, (_, i) => file(`file${i}.txt`))
    await cache.list('a', '/Team', '/Team/a', async () => many)
    await cache.list('a', '/Team', '/Team/b', async () => many)
    expect(cache.metadata('a', '/Team', '/Team/a/file0.txt')).toBeUndefined()
    expect(cache.metadata('a', '/Team', '/Team/b/file0.txt')).toBeDefined()
    const huge = vi.fn(async () => [...many, ...many])
    expect(await cache.list('a', '/Team', '/Team/huge', huge)).toHaveLength(8_002)
    expect(await cache.list('a', '/Team', '/Team/huge', huge)).toHaveLength(8_002)
    expect(huge).toHaveBeenCalledTimes(2)
  })
})
