import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('./google-drive-client', () => ({ driveRequest: request }))
import { GoogleDriveChangeFeed, staleAfter, type DriveChange } from './google-drive-changes'
import { RemoteListingCache } from './remote-listing-cache'
import type { DriveFile } from './google-drive-schema'

const at = '2026-10-09T12:00:00.000Z'
const file = (id: string, name: string, fields: Partial<DriveFile> = {}): DriveFile => ({ id, name, mimeType: 'text/plain', size: 3, modifiedTime: at, ...fields })
const changed = (id: string, name: string, parents: string[], fields: Partial<DriveFile> = {}): DriveChange => ({ fileId: id, file: { ...file(id, name, fields), parents } })

describe('staleAfter', () => {
  const entries = [file('a', 'a.txt'), { ...file('t', 'link.txt'), shortcutId: 's' }]
  it.each([
    ['a file it lists, unchanged', changed('a', 'a.txt', ['f']), false],
    ['a file it lists, renamed', changed('a', 'b.txt', ['f']), true],
    ['a file it lists, edited', changed('a', 'a.txt', ['f'], { modifiedTime: '2026-10-09T12:00:05.000Z', size: 9 }), true],
    ['a file it lists, moved out', changed('a', 'a.txt', ['g']), true],
    ['a file it lists, trashed', changed('a', 'a.txt', ['f'], { trashed: true }), true],
    ['a file it lists, deleted or no longer shared', { fileId: 'a', removed: true }, true],
    ['a new file in it', changed('n', 'n.txt', ['f']), true],
    ['a file moved in', changed('n', 'n.txt', ['g', 'f']), true],
    ['a file elsewhere', changed('n', 'n.txt', ['g']), false],
    ['a file elsewhere, deleted', { fileId: 'n', removed: true }, false],
    ['a file trashed elsewhere', changed('n', 'n.txt', ['f'], { trashed: true }), false],
    ['the folder itself, renamed', changed('f', 'renamed', ['root']), false],
    ['a shortcut target it follows, edited where it lives', changed('t', 'target.txt', ['elsewhere']), true],
    ['a shortcut it follows, renamed', changed('s', 'other link', ['f'], { mimeType: 'application/vnd.google-apps.shortcut' }), true],
  ] as const)('%s', (_label, change, stale) => {
    expect(staleAfter('f', entries, change)).toBe(stale)
  })
})

describe('Google Drive change feed', () => {
  const key = (folderId: string) => JSON.stringify(['a', folderId])
  let listings: RemoteListingCache<DriveFile>
  let feed: GoogleDriveChangeFeed
  let pages: Record<string, unknown>[]
  const read = vi.fn(async () => [file('x', 'x.txt')])
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)) }
  const tick = async (ms: number) => { vi.setSystemTime(Date.now() + ms); await settle() }
  const changeCalls = () => request.mock.calls.filter(([, req]) => req.path === 'drive/v3/changes').length
  const startCalls = () => request.mock.calls.filter(([, req]) => req.path === 'drive/v3/changes/startPageToken').length

  beforeEach(() => {
    vi.useFakeTimers({ now: 0, toFake: ['Date'] })
    vi.resetAllMocks()
    read.mockImplementation(async () => [file('x', 'x.txt')])
    listings = new RemoteListingCache<DriveFile>()
    feed = new GoogleDriveChangeFeed(listings, k => (JSON.parse(k) as string[])[1])
    pages = [{ changes: [], newStartPageToken: 't2' }]
    request.mockImplementation(async (_account, req: { path: string }) =>
      Response.json(req.path.endsWith('startPageToken') ? { startPageToken: 't1' } : pages.shift() ?? { changes: [], newStartPageToken: 't3' }))
  })
  afterEach(() => { vi.useRealTimers() })

  /** Start the feed, then read the folder after it, so the listing is one the feed can vouch for. */
  async function started() {
    await listings.list('a', key('f'), read)
    await tick(4_000)
    feed.keepFresh('a', key('f'))
    await settle()
    expect(startCalls()).toBe(1)
    listings.forget(key('f'))
    await listings.list('a', key('f'), read)
  }

  it('keeps a listing current past its expiry while polls find nothing in its folder', async () => {
    await started()
    await tick(12_000)
    feed.keepFresh('a', key('f'))
    await settle()
    expect(changeCalls()).toBe(1)
    // Read at 4 s, it would expire at 19 s. The poll at 16 s vouches for it as of 6 s.
    await tick(4_000)
    await listings.list('a', key('f'), read)
    expect(read).toHaveBeenCalledTimes(2)
    await tick(2_000)
    await listings.list('a', key('f'), read)
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('drops a listing a change touches, so the next read goes to Drive', async () => {
    await started()
    pages = [{ changes: [changed('n', 'new.txt', ['f'])], newStartPageToken: 't2' }]
    await tick(12_000)
    feed.keepFresh('a', key('f'))
    await settle()
    expect(listings.recent(key('f'), Infinity)).toBeUndefined()
    await listings.list('a', key('f'), read)
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('never vouches for a listing read before the feed started', async () => {
    await listings.list('a', key('f'), read)
    await tick(4_000)
    feed.keepFresh('a', key('f'))
    await settle()
    await tick(12_000)
    feed.keepFresh('a', key('f'))
    await settle()
    expect(changeCalls()).toBe(1)
    expect(listings.recent(key('f'), Infinity)?.readAt).toBe(0)
  })

  it('starts again after a failed poll, and reads every folder again rather than page through a long backlog', async () => {
    await started()
    request.mockImplementationOnce(async () => { throw new Error('upstream') })
    await tick(12_000)
    feed.keepFresh('a', key('f'))
    await settle()
    await tick(4_000)
    feed.keepFresh('a', key('f'))
    await settle()
    expect(startCalls()).toBe(2)
    pages = [{ changes: [], nextPageToken: 'p2' }, { changes: [], nextPageToken: 'p3' }, { changes: [], nextPageToken: 'p4' }]
    await tick(4_000)
    feed.keepFresh('a', key('f'))
    await settle()
    expect(listings.recent(key('f'), Infinity)).toBeUndefined()
    expect(startCalls()).toBe(3)
  })
})
