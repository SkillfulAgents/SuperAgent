/**
 * `SessionIndex` over an in-memory workspace and storage: how it follows the
 * transcripts directory, and how recorded activity reaches storage. What a
 * read costs on a real filesystem is pinned in the session service's
 * summary and listing-cost suites.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

// A failure of work nobody awaits fails a test run by design. The index
// stores activity that way, so the suite collects those failures instead,
// for the one test that provokes one to assert on.
const backgroundFailures = vi.hoisted(() => [] as unknown[])
vi.mock('@shared/lib/background', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/lib/background')>()
  return {
    ...actual,
    background: (work: PromiseLike<unknown>, options: { name: string }) =>
      actual.background(Promise.resolve(work).catch((error: unknown) => backgroundFailures.push(error)), options),
  }
})

import { backgroundSettled } from '@shared/lib/background'
import { ACTIVITY_STORE_INTERVAL_MS, SessionIndex, type SessionIndexStorage } from './session-index'
import { CLI_TRANSCRIPTS_DIR } from './session-store'
import { InMemoryFileOps } from './testing/in-memory-file-ops'
import { createInMemorySessionIndexStorage } from './testing/in-memory-session-index-storage'

const transcript = (sessionId: string) => `${CLI_TRANSCRIPTS_DIR}/${sessionId}.jsonl`

/**
 * `directoryTickMs` is 0 unless a test is about it: the in-memory files stamp
 * every change with a later mtime, so one listing is always enough.
 */
function setup(overrides: Partial<SessionIndexStorage> = {}, directoryTickMs = 0) {
  const files = new InMemoryFileOps()
  const storage = { ...createInMemorySessionIndexStorage(), ...overrides }
  let key = 'workspace-one'
  const index = new SessionIndex({ files, transcriptsDir: CLI_TRANSCRIPTS_DIR, key: () => key, storage, directoryTickMs })
  return {
    files,
    storage,
    index,
    moveTo: (next: string) => {
      key = next
    },
    /** A second index over the same workspace and storage: the agent's actor after a restart. */
    restarted: () => new SessionIndex({ files, transcriptsDir: CLI_TRANSCRIPTS_DIR, key: () => key, storage, directoryTickMs }),
  }
}

const activityOf = async (index: SessionIndex) =>
  Object.fromEntries((await index.entries()).map((entry) => [entry.sessionId, entry.transcript?.mtimeMs ?? null]))

afterEach(async () => {
  await backgroundSettled()
  vi.useRealTimers()
  vi.restoreAllMocks()
  expect(backgroundFailures.splice(0)).toEqual([])
})

describe('SessionIndex holding on to what it read', () => {
  it('reads its entries from storage once for any number of reads, and again after each kind of write', async () => {
    const { index, files, storage } = setup()
    await index.update('s1', () => ({ name: 'One' }))
    await files.putDoc(transcript('s1'), 'x')
    await index.entries()
    const list = vi.spyOn(storage, 'list')

    await index.entries()
    await index.metadata()
    await index.entries()
    expect(list).not.toHaveBeenCalled()

    const writes: Array<[string, () => Promise<unknown> | void]> = [
      ['update', () => index.update('s1', () => ({ name: 'Renamed' }))],
      ['fill', () => index.fill([{ sessionId: 's2', meta: { name: 'Two' }, transcript: null }])],
      ['activity', () => index.recordActivity('s1', 9_000_000_000_000)],
      ['delete', () => index.delete(['s2'])],
    ]
    for (const [name, write] of writes) {
      list.mockClear()
      await write()
      await index.entries()
      await index.metadata()
      expect(list, name).toHaveBeenCalledTimes(1)
    }
    expect(await index.metadata()).toEqual({ s1: { name: 'Renamed' } })
    expect(await activityOf(index)).toEqual({ s1: 9_000_000_000_000 })
  })

  it('hands every reader the same entries, which none of them can change', async () => {
    const { index, files } = setup()
    await index.update('s1', () => ({ name: 'One' }))
    await files.putDoc(transcript('s1'), 'x')

    const [entry] = await index.entries()
    expect(() => {
      entry.meta!.name = 'Changed by a reader'
    }).toThrow(TypeError)
    expect(() => {
      entry.transcript!.mtimeMs = 0
    }).toThrow(TypeError)
    expect((await index.metadata()).s1).toEqual({ name: 'One' })
  })

  it('does not hold on to a listing that failed', async () => {
    const { index, storage } = setup()
    await index.update('s1', () => ({ name: 'One' }))
    vi.spyOn(storage, 'list').mockRejectedValueOnce(new Error('database is locked'))

    await expect(index.metadata()).rejects.toThrow('database is locked')
    expect(await index.metadata()).toEqual({ s1: { name: 'One' } })
  })

  it('does not hand out a listing that started before a write finished', async () => {
    const { index, storage } = setup()
    await index.update('s1', () => ({ name: 'Before' }))
    // The write is under way when the listing reads the rows.
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const update = storage.update.bind(storage)
    vi.spyOn(storage, 'update').mockImplementationOnce(async (sessionId, mutate) => {
      await held
      return update(sessionId, mutate)
    })

    const writing = index.update('s1', () => ({ name: 'After' }))
    const during = await index.metadata()
    release()
    await writing

    expect(during).toEqual({ s1: { name: 'Before' } })
    expect(await index.metadata()).toEqual({ s1: { name: 'After' } })
  })
})

describe('SessionIndex and a directory clock that ticks slowly', () => {
  /** The files, stamping directories as a filesystem with a one-second clock does. */
  function coarse(files: InMemoryFileOps): void {
    const stat = InMemoryFileOps.prototype.stat
    vi.spyOn(files, 'stat').mockImplementation(async (path) => {
      const found = await stat.call(files, path)
      return found?.kind === 'directory' ? { ...found, mtimeMs: Math.floor(found.mtimeMs / 1000) * 1000 } : found
    })
  }

  it('sees a transcript removed, and one added, in the same tick as the listing before', async () => {
    vi.useFakeTimers({ now: new Date('2030-01-01T00:00:00.100Z'), toFake: ['Date'] })
    const { index, files } = setup({}, 1_000)
    coarse(files)
    await index.update('removed', () => ({ name: 'Removed' }))
    await files.putDoc(transcript('kept'), 'x')
    await files.putDoc(transcript('removed'), 'x')
    expect((await index.entries()).map((entry) => entry.sessionId).sort()).toEqual(['kept', 'removed'])

    // The directory's mtime says nothing of either change.
    vi.setSystemTime(new Date('2030-01-01T00:00:00.500Z'))
    await files.delete(transcript('removed'))
    await files.putDoc(transcript('added'), 'x')

    expect((await index.entries()).map((entry) => entry.sessionId).sort()).toEqual(['added', 'kept'])
    expect(await index.metadata()).toEqual({})
  })

  it('lists on every read until a tick has passed since it first saw the directory\'s mtime, then trusts it', async () => {
    vi.useFakeTimers({ now: new Date('2030-01-01T00:00:00.100Z'), toFake: ['Date'] })
    const { index, files } = setup({}, 1_000)
    await files.putDoc(transcript('s1'), 'x')
    const list = vi.spyOn(files, 'list')
    const stat = vi.spyOn(files, 'stat')

    await index.entries()
    await index.entries()
    expect(list).toHaveBeenCalledTimes(2)
    // Known transcripts are not statted again: listing is all it costs.
    expect(stat.mock.calls.filter(([path]) => path !== CLI_TRANSCRIPTS_DIR)).toEqual([[transcript('s1')]])

    vi.setSystemTime(new Date('2030-01-01T00:00:01.100Z'))
    await index.entries()
    expect(list).toHaveBeenCalledTimes(3)
    await index.entries()
    await index.entries()
    expect(list).toHaveBeenCalledTimes(3)
  })

  it('takes in the transcript of a session deleted and made again under its id between two listings', async () => {
    vi.useFakeTimers({ now: new Date('2030-01-01T00:00:00.100Z'), toFake: ['Date'] })
    const { index, files } = setup({}, 1_000)
    coarse(files)
    await files.putDoc(transcript('reused'), 'x')
    await index.entries()

    // Deleted in the app, then a new session with the same id writes its transcript.
    await files.delete(transcript('reused'))
    await index.delete(['reused'])
    await index.update('reused', () => ({ name: 'New life' }))
    await files.putDoc(transcript('reused'), 'y')

    expect(await index.entries()).toEqual([
      { sessionId: 'reused', meta: { name: 'New life' }, transcript: expect.objectContaining({ size: 1 }) },
    ])
  })

  it('trusts at once a directory that has long been unchanged', async () => {
    vi.useFakeTimers({ now: new Date('2030-01-01T00:00:00.000Z'), toFake: ['Date'] })
    const { files, restarted } = setup({}, 1_000)
    await files.putDoc(transcript('s1'), 'x')
    vi.setSystemTime(new Date('2030-01-01T00:05:00.000Z'))
    const list = vi.spyOn(files, 'list')
    const index = restarted()

    await index.entries()
    await index.entries()

    expect(list).toHaveBeenCalledTimes(1)
  })

  it('lets readers that arrive together share one listing', async () => {
    vi.useFakeTimers({ now: new Date('2030-01-01T00:00:00.100Z'), toFake: ['Date'] })
    const { index, files } = setup({}, 1_000)
    await files.putDoc(transcript('s1'), 'x')
    const list = vi.spyOn(files, 'list')

    await Promise.all([index.entries(), index.entries(), index.entries(), index.entries()])

    expect(list.mock.calls.length).toBeLessThanOrEqual(2)
  })
})

describe('SessionIndex and the transcripts directory', () => {
  it('has no entries, and stores none, for an agent that never ran', async () => {
    const { index, storage } = setup()
    const fill = vi.spyOn(storage, 'fill')

    expect(await index.entries()).toEqual([])
    expect(await index.metadata()).toEqual({})
    expect(fill).not.toHaveBeenCalled()
  })

  it('takes in every transcript it finds, registered or not, and nothing that is not one', async () => {
    const { index, files } = setup()
    await index.update('registered', () => ({ name: 'Registered' }))
    await files.putDoc(transcript('registered'), 'x')
    await files.putDoc(transcript('found'), '')
    await files.putDoc(`${CLI_TRANSCRIPTS_DIR}/notes.txt`, 'not a transcript')
    await files.putDoc(`${CLI_TRANSCRIPTS_DIR}/registered/subagents/agent-1.jsonl`, 'a subagent, one level down')

    const entries = await index.entries()

    expect(entries.map((entry) => entry.sessionId).sort()).toEqual(['found', 'registered'])
    expect(entries.find((entry) => entry.sessionId === 'registered')).toMatchObject({ meta: { name: 'Registered' }, transcript: { size: 1 } })
    expect(entries.find((entry) => entry.sessionId === 'found')).toMatchObject({ meta: null, transcript: { size: 0 } })
  })

  it('does not look at the directory again while it is unchanged', async () => {
    const { index, files } = setup()
    await files.putDoc(transcript('s1'), 'x')
    await index.entries()
    const list = vi.spyOn(files, 'list')
    const stat = vi.spyOn(files, 'stat')

    await index.entries()
    await index.entries()

    expect(list).not.toHaveBeenCalled()
    expect(stat.mock.calls).toEqual([[CLI_TRANSCRIPTS_DIR], [CLI_TRANSCRIPTS_DIR]])
  })

  it('lists the directory once after a restart and stats nothing it has seen', async () => {
    const { index, files, restarted } = setup()
    await files.putDoc(transcript('s1'), 'x')
    await files.putDoc(transcript('s2'), 'x')
    await index.entries()
    const list = vi.spyOn(files, 'list')
    const stat = vi.spyOn(files, 'stat')

    expect((await restarted().entries()).map((entry) => entry.sessionId).sort()).toEqual(['s1', 's2'])

    expect(list).toHaveBeenCalledTimes(1)
    expect(stat.mock.calls).toEqual([[CLI_TRANSCRIPTS_DIR]])
  })

  it('drops the entry, metadata and all, of a transcript that is gone', async () => {
    const { index, files } = setup()
    await index.update('kept', () => ({ name: 'Kept' }))
    await index.update('removed', () => ({ name: 'Removed', starred: true }))
    await files.putDoc(transcript('kept'), 'x')
    await files.putDoc(transcript('removed'), 'x')
    await index.entries()

    await files.delete(transcript('removed'))

    expect((await index.entries()).map((entry) => entry.sessionId)).toEqual(['kept'])
    expect(await index.metadata()).toEqual({ kept: { name: 'Kept' } })
  })

  it('never drops a registration that is still waiting for its transcript', async () => {
    const { index, files } = setup()
    await index.update('pending', () => ({ name: 'Pending' }))
    await files.putDoc(transcript('other'), 'x')
    await index.entries()
    await files.putDoc(transcript('another'), 'x')

    const entries = await index.entries()

    expect(entries.find((entry) => entry.sessionId === 'pending')).toEqual({ sessionId: 'pending', meta: { name: 'Pending' }, transcript: null })
  })

  it('learns nothing from a directory that is not there', async () => {
    const { index, files } = setup()
    await index.update('s1', () => ({ name: 'Named' }))
    await files.putDoc(transcript('s1'), 'x')
    await index.entries()

    await files.delete(CLI_TRANSCRIPTS_DIR, { recursive: true })

    expect((await index.entries()).map((entry) => entry.sessionId)).toEqual(['s1'])
    expect(await index.metadata()).toEqual({ s1: { name: 'Named' } })
  })

  it('learns nothing from a directory left empty: a volume that went away, with its names due back', async () => {
    const { index, files, storage } = setup()
    await index.update('s1', () => ({ name: 'Named', starred: true }))
    await index.update('s2', () => ({ name: 'Also named' }))
    await files.putDoc(transcript('s1'), 'x')
    await files.putDoc(transcript('s2'), 'x')
    await index.entries()
    const remove = vi.spyOn(storage, 'delete')

    await files.delete(transcript('s1'))
    await files.delete(transcript('s2'))

    expect(await index.canConfirmGone()).toBe(false)
    expect((await index.entries()).map((entry) => entry.sessionId).sort()).toEqual(['s1', 's2'])
    expect(await index.metadata()).toEqual({ s1: { name: 'Named', starred: true }, s2: { name: 'Also named' } })
    expect(remove).not.toHaveBeenCalled()

    // One transcript back is evidence again: the other really is gone.
    await files.putDoc(transcript('s1'), 'x')
    expect(await index.canConfirmGone()).toBe(true)
    expect((await index.entries()).map((entry) => entry.sessionId)).toEqual(['s1'])
  })

  it('stores what it could stat before a transcript it could not fails the read', async () => {
    const { index, files, storage } = setup()
    for (const id of ['s1', 'broken', 's2']) await files.putDoc(transcript(id), 'x')
    const stat = vi.spyOn(files, 'stat')
    const realStat = InMemoryFileOps.prototype.stat
    stat.mockImplementation(async (path) => {
      if (path === transcript('broken')) throw new Error('EIO')
      return realStat.call(files, path)
    })

    await expect(index.entries()).rejects.toThrow('EIO')
    expect((await storage.list()).map((entry) => entry.sessionId).sort()).toEqual(['s1', 's2'])

    // The next read goes back for the one it could not stat, and only that one.
    stat.mockClear()
    await expect(index.entries()).rejects.toThrow('EIO')
    expect(stat.mock.calls.map(([path]) => path)).toEqual([CLI_TRANSCRIPTS_DIR, transcript('broken'), transcript('broken')])

    stat.mockImplementation((path) => realStat.call(files, path))
    expect((await index.entries()).map((entry) => entry.sessionId).sort()).toEqual(['broken', 's1', 's2'])
  })

  it('takes a file\'s word for when a transcript was last written over a stat made while it was being imported', async () => {
    const { index, files } = setup()
    await files.putDoc(transcript('imported'), 'x')
    await files.putDoc(transcript('named-already'), 'x')
    await index.update('named-already', () => ({ name: 'Kept' }))
    // The agents list polls while the archive is still being extracted.
    const statted = await activityOf(index)

    await index.fill([
      { sessionId: 'imported', meta: { name: 'From the archive' }, transcript: { mtimeMs: 1_000, birthtimeMs: 0, size: 1 } },
      { sessionId: 'named-already', meta: { name: 'From the archive' }, transcript: { mtimeMs: 1_000, birthtimeMs: 0, size: 1 } },
      { sessionId: 'undated', meta: { name: 'No date' }, transcript: null },
    ])

    expect(await activityOf(index)).toEqual({ imported: 1_000, 'named-already': statted['named-already'], undated: null })
    expect(await index.metadata()).toEqual({ imported: { name: 'From the archive' }, 'named-already': { name: 'Kept' }, undated: { name: 'No date' } })
  })

  it('looks again after a run that lookAgain() was called during', async () => {
    const { index, files } = setup()
    await files.putDoc(transcript('s1'), 'x')
    const list = vi.spyOn(files, 'list')
    // A transcript the run's listing missed is reported while the run is
    // still going, and lands in the same tick of the directory's clock.
    list.mockImplementationOnce(async (dir) => {
      const listed = await InMemoryFileOps.prototype.list.call(files, dir)
      index.lookAgain()
      return listed
    })

    await index.entries()
    await index.entries()

    expect(list).toHaveBeenCalledTimes(2)
    await index.entries()
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('reads what it has when the directory goes between its stat and its listing', async () => {
    const { index, files } = setup()
    await index.update('s1', () => ({ name: 'Named' }))
    await files.putDoc(transcript('s1'), 'x')
    await index.entries()
    await files.putDoc(transcript('s2'), 'x')
    // The agent is being removed while its sessions are listed.
    vi.spyOn(files, 'list').mockImplementation(async (dir) => {
      await files.delete(CLI_TRANSCRIPTS_DIR, { recursive: true })
      return InMemoryFileOps.prototype.list.call(files, dir)
    })

    expect((await index.entries()).map((entry) => entry.sessionId)).toEqual(['s1'])
    expect(await index.metadata()).toEqual({ s1: { name: 'Named' } })
  })

  it('fails the read, and tries again on the next, when a new transcript cannot be statted', async () => {
    const { index, files } = setup()
    await files.putDoc(transcript('s1'), 'x')
    const stat = files.stat.bind(files)
    let failures = 2
    vi.spyOn(files, 'stat').mockImplementation(async (path) => {
      if (path === transcript('s1') && failures-- > 0) throw Object.assign(new Error('ESTALE'), { code: 'ESTALE' })
      return stat(path)
    })

    await expect(index.entries()).rejects.toThrow('ESTALE')
    expect((await index.entries()).map((entry) => entry.sessionId)).toEqual(['s1'])
  })

  it('keeps an entry when the stat that would confirm its transcript gone fails', async () => {
    const { index, files } = setup()
    await index.update('s1', () => ({ name: 'Named' }))
    await files.putDoc(transcript('s1'), 'x')
    await files.putDoc(transcript('s2'), 'x')
    await index.entries()
    await files.delete(transcript('s1'))
    const stat = files.stat.bind(files)
    vi.spyOn(files, 'stat').mockImplementation(async (path) => {
      if (path === transcript('s1')) throw Object.assign(new Error('EIO'), { code: 'EIO' })
      return stat(path)
    })

    await expect(index.entries()).rejects.toThrow('EIO')

    expect(await index.metadata()).toEqual({ s1: { name: 'Named' } })
  })

  it('reconciles again when the store is pointed at another workspace', async () => {
    const { index, files, moveTo } = setup()
    await files.putDoc(transcript('s1'), 'x')
    await index.entries()
    const list = vi.spyOn(files, 'list')

    moveTo('workspace-two')
    await index.entries()

    expect(list).toHaveBeenCalledTimes(1)
  })
})

describe('SessionIndex activity', () => {
  it('stores recorded activity without being read, so a restart sees it', async () => {
    const { index, files, restarted } = setup()
    await files.putDoc(transcript('s1'), 'x')
    const seenAt = (await activityOf(index)).s1!

    index.recordActivity('s1', seenAt + 5000)
    await backgroundSettled()

    expect(await activityOf(restarted())).toEqual({ s1: seenAt + 5000 })
  })

  it('stores a burst of records as few writes, keeping the latest per session', async () => {
    const { index, files, storage } = setup()
    await files.putDoc(transcript('s1'), 'x')
    await files.putDoc(transcript('s2'), 'x')
    const seenAt = (await activityOf(index)).s1!
    const touch = vi.spyOn(storage, 'touch')

    for (let i = 1; i <= 50; i++) index.recordActivity('s1', seenAt + i)
    index.recordActivity('s2', seenAt + 7)

    expect(await activityOf(index)).toEqual({ s1: seenAt + 50, s2: seenAt + 7 })
    expect(touch.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('holds activity for a transcript it has not seen until it sees it', async () => {
    const { index, files, storage } = setup()
    await index.update('s1', () => ({ name: 'Registered' }))
    // The send is recorded, and its storing attempted, before any listing.
    index.recordActivity('s1', 9_000_000_000_000)
    await backgroundSettled()
    expect((await storage.get('s1'))?.transcript).toBeNull()

    await files.putDoc(transcript('s1'), 'x')

    expect(await activityOf(index)).toEqual({ s1: 9_000_000_000_000 })
    expect((await storage.get('s1'))?.transcript?.mtimeMs).toBe(9_000_000_000_000)
  })

  it('loses no activity left alone just as its transcript is being taken in', async () => {
    const base = createInMemorySessionIndexStorage()
    let releaseTouch!: () => void
    const touchHeld = new Promise<void>((resolve) => { releaseTouch = resolve })
    // The storing of the activity is slow: it decides before the transcript
    // is taken in, and answers after.
    const { index, files, storage } = setup({
      ...base,
      touch: async (activity) => {
        const leftAlone = await base.touch(activity)
        await touchHeld
        return leftAlone
      },
    })
    await base.update('s1', () => ({ name: 'Registered' }))
    await files.putDoc(transcript('s1'), 'x')

    index.recordActivity('s1', 9_000_000_000_000)
    const reading = activityOf(index)
    releaseTouch()

    expect(await reading).toEqual({ s1: 9_000_000_000_000 })
    expect((await storage.get('s1'))?.transcript?.mtimeMs).toBe(9_000_000_000_000)
  })

  it('never fabricates a session from activity alone', async () => {
    const { index, files } = setup()
    await files.putDoc(transcript('real'), 'x')
    await index.entries()

    index.recordActivity('not-a-session', 9_000_000_000_000)

    expect((await index.entries()).map((entry) => entry.sessionId)).toEqual(['real'])
  })

  it('keeps activity whose storing failed and stores it with the next', async () => {
    const base = createInMemorySessionIndexStorage()
    let failing = true
    const { index, files, storage } = setup({
      ...base,
      touch: async (activity) => {
        if (failing) throw new Error('storage unavailable')
        return base.touch(activity)
      },
    })
    await files.putDoc(transcript('s1'), 'x')
    await index.entries()
    const seenAt = (await storage.get('s1'))!.transcript!.mtimeMs

    index.recordActivity('s1', seenAt + 1000)
    // A read does not answer with less than was recorded: it fails instead.
    await expect(index.entries()).rejects.toThrow('storage unavailable')
    await backgroundSettled()
    expect(backgroundFailures.splice(0)).toEqual([new Error('storage unavailable')])

    failing = false
    index.recordActivity('s1', seenAt + 500)
    expect(await activityOf(index)).toEqual({ s1: seenAt + 1000 })
  })

  it('shows a provisional record and stores none of it until a write follows', async () => {
    const { index, files, storage } = setup()
    await files.putDoc(transcript('s1'), 'x')
    const seenAt = (await activityOf(index)).s1!

    index.recordProvisionalActivity('s1', seenAt + 1000)
    expect(await activityOf(index)).toEqual({ s1: seenAt + 1000 })
    expect((await storage.get('s1'))?.transcript?.mtimeMs).toBe(seenAt)

    // The turn is real: a frame arrives, stamped earlier than the send was recorded.
    index.recordActivity('s1', seenAt + 400)
    expect(await activityOf(index)).toEqual({ s1: seenAt + 1000 })
    expect((await storage.get('s1'))?.transcript?.mtimeMs).toBe(seenAt + 1000)
  })

  it('takes a provisional record back, restoring the one before it', async () => {
    const { index, files } = setup()
    await files.putDoc(transcript('s1'), 'x')
    const seenAt = (await activityOf(index)).s1!

    const first = index.recordProvisionalActivity('s1', seenAt + 1000)
    const second = index.recordProvisionalActivity('s1', seenAt + 2000)
    index.revertProvisionalActivity('s1', second)
    expect(await activityOf(index)).toEqual({ s1: seenAt + 1000 })

    index.revertProvisionalActivity('s1', first)
    expect(await activityOf(index)).toEqual({ s1: seenAt })
  })

  it('ignores a rollback once a write was recorded after the mark', async () => {
    const { index, files } = setup()
    await files.putDoc(transcript('s1'), 'x')
    const seenAt = (await activityOf(index)).s1!

    const mark = index.recordProvisionalActivity('s1', seenAt + 1000)
    index.recordActivity('s1', seenAt + 1500)
    index.revertProvisionalActivity('s1', mark)

    expect(await activityOf(index)).toEqual({ s1: seenAt + 1500 })
  })

  it('forgets everything recorded for a session that is deleted', async () => {
    const { index, files, storage } = setup()
    await files.putDoc(transcript('s1'), 'x')
    await index.entries()
    index.recordProvisionalActivity('s1', 9_000_000_000_000)

    await files.delete(transcript('s1'))
    await index.delete(['s1'])
    // The id is reused by a new transcript.
    await files.putDoc(transcript('s1'), 'x')

    const reused = (await index.entries())[0]
    expect(reused.transcript!.mtimeMs).toBeLessThan(9_000_000_000_000)
    expect(await storage.list()).toHaveLength(1)
  })

  it('looks at the directory again when activity arrives for a transcript it has not seen', async () => {
    const { index, files } = setup()
    await files.putDoc(transcript('s1'), 'x')
    await index.entries()
    // A transcript whose arrival the directory's mtime did not show: two
    // changes in one tick of a coarse filesystem clock look like this.
    const stat = files.stat.bind(files)
    const frozen = await stat(CLI_TRANSCRIPTS_DIR)
    vi.spyOn(files, 'stat').mockImplementation(async (path) => (path === CLI_TRANSCRIPTS_DIR ? frozen : stat(path)))
    await files.putDoc(transcript('s2'), 'x')
    expect((await index.entries()).map((entry) => entry.sessionId)).toEqual(['s1'])

    index.recordActivity('s2', 9_000_000_000_000)

    expect(await activityOf(index)).toMatchObject({ s2: 9_000_000_000_000 })
  })
})

describe('SessionIndex storing activity on a wakeup', () => {
  /** An index whose owner arranges wakeups: the test is the alarm, and fires it with `due()`. */
  function setupWithWakeups(overrides: Partial<SessionIndexStorage> = {}, canArrange = () => true) {
    const files = new InMemoryFileOps()
    const storage = { ...createInMemorySessionIndexStorage(), ...overrides }
    const wakeups: number[] = []
    const index: SessionIndex = new SessionIndex({
      files,
      transcriptsDir: CLI_TRANSCRIPTS_DIR,
      key: () => 'workspace-one',
      storage,
      directoryTickMs: 0,
      storeActivityLater: (atMs) => {
        if (!canArrange()) return false
        wakeups.push(atMs)
        return true
      },
    })
    return { files, storage, index, wakeups, due: () => index.storeRecordedActivity() }
  }

  it('stores a turn\'s frames as one write when the wakeup comes, not one per frame', async () => {
    const { index, files, storage, wakeups, due } = setupWithWakeups()
    await files.putDoc(transcript('s1'), 'x')
    const seenAt = (await activityOf(index)).s1!
    const touch = vi.spyOn(storage, 'touch')
    vi.useFakeTimers({ now: seenAt + 10, toFake: ['Date'] })

    for (let frame = 1; frame <= 200; frame++) {
      index.recordActivity('s1', seenAt + 10 + frame)
      vi.advanceTimersByTime(10)
    }
    await backgroundSettled()

    // 2 s of frames: one wakeup arranged, an interval after the first, and nothing stored yet.
    expect(wakeups).toEqual([seenAt + 10 + ACTIVITY_STORE_INTERVAL_MS])
    expect(touch).not.toHaveBeenCalled()

    await due()

    expect(touch).toHaveBeenCalledTimes(1)
    expect(touch).toHaveBeenCalledWith(new Map([['s1', seenAt + 210]]))
    expect((await storage.get('s1'))?.transcript?.mtimeMs).toBe(seenAt + 210)
  })

  it('arranges one wakeup per interval in which something is recorded, and none while nothing is', async () => {
    const { index, files, wakeups, due } = setupWithWakeups()
    await files.putDoc(transcript('s1'), 'x')
    const seenAt = (await activityOf(index)).s1!

    index.recordActivity('s1', seenAt + 10)
    index.recordActivity('s1', seenAt + 11)
    expect(wakeups).toHaveLength(1)
    await due()
    // Due again with nothing recorded: nothing to arrange.
    await due()
    expect(wakeups).toHaveLength(1)

    index.recordActivity('s1', seenAt + 12)
    index.recordActivity('s1', seenAt + 13)
    expect(wakeups).toHaveLength(2)
    await due()
  })

  it('answers a read with everything recorded, without waiting for the wakeup', async () => {
    const { index, files, storage } = setupWithWakeups()
    await files.putDoc(transcript('s1'), 'x')
    await files.putDoc(transcript('s2'), 'x')
    const seenAt = (await activityOf(index)).s1!

    index.recordActivity('s1', seenAt + 5000)

    expect((await index.entry('s1'))?.transcript?.mtimeMs).toBe(seenAt + 5000)
    index.recordActivity('s2', seenAt + 7000)
    expect(await activityOf(index)).toEqual({ s1: seenAt + 5000, s2: seenAt + 7000 })
    expect((await storage.get('s2'))?.transcript?.mtimeMs).toBe(seenAt + 7000)
  })

  it('stores what is recorded when told a turn ended, whenever the wakeup is due', async () => {
    const { index, files, storage, due } = setupWithWakeups()
    await files.putDoc(transcript('s1'), 'x')
    const seenAt = (await activityOf(index)).s1!

    index.recordActivity('s1', seenAt + 100)
    index.recordActivity('s1', seenAt + 200)
    await index.storeRecordedActivity()

    expect((await storage.get('s1'))?.transcript?.mtimeMs).toBe(seenAt + 200)
    // The wakeup still comes, and finds nothing left to store.
    const touch = vi.spyOn(storage, 'touch')
    await due()
    expect(touch).not.toHaveBeenCalled()
  })

  it('does not chain a write for what is recorded while one is under way', async () => {
    const base = createInMemorySessionIndexStorage()
    const held: Array<() => void> = []
    const touched: Array<Map<string, number>> = []
    const { index, files, storage, wakeups, due } = setupWithWakeups({
      ...base,
      touch: async (activity) => {
        touched.push(new Map(activity))
        await new Promise<void>((resolve) => held.push(resolve))
        return base.touch(activity)
      },
    })
    await files.putDoc(transcript('s1'), 'x')
    await index.entries()
    const seenAt = (await storage.get('s1'))!.transcript!.mtimeMs

    index.recordActivity('s1', seenAt + 1)
    const storing = due()
    await vi.waitFor(() => expect(held).toHaveLength(1))
    // Frames keep coming while the write is out: they wait for a wakeup of their own.
    for (let frame = 2; frame <= 20; frame++) index.recordActivity('s1', seenAt + frame)
    held.shift()!()
    await storing

    expect(touched).toEqual([new Map([['s1', seenAt + 1]])])
    expect(wakeups).toHaveLength(2)

    // A read that comes meanwhile still gets all of it, in one more write.
    const reading = activityOf(index)
    await vi.waitFor(() => expect(held).toHaveLength(1))
    held.shift()!()
    expect(await reading).toEqual({ s1: seenAt + 20 })
    expect(touched).toHaveLength(2)
  })

  it('a read that arrives during a write waits for it, then stores what was recorded since', async () => {
    const base = createInMemorySessionIndexStorage()
    const held: Array<() => void> = []
    const { index, files, storage, due } = setupWithWakeups({
      ...base,
      touch: async (activity) => {
        await new Promise<void>((resolve) => held.push(resolve))
        return base.touch(activity)
      },
    })
    await files.putDoc(transcript('s1'), 'x')
    await index.entries()
    const seenAt = (await storage.get('s1'))!.transcript!.mtimeMs

    index.recordActivity('s1', seenAt + 1)
    const storing = due()
    await vi.waitFor(() => expect(held).toHaveLength(1))
    index.recordActivity('s1', seenAt + 2)
    const reading = index.entry('s1')
    held.shift()!()
    await storing
    await vi.waitFor(() => expect(held).toHaveLength(1))
    held.shift()!()

    expect((await reading)?.transcript?.mtimeMs).toBe(seenAt + 2)
  })

  it('keeps activity a wakeup could not store, arranges another, and stores it then', async () => {
    const base = createInMemorySessionIndexStorage()
    let failing = true
    const { index, files, storage, wakeups, due } = setupWithWakeups({
      ...base,
      touch: async (activity) => {
        if (failing) throw new Error('storage unavailable')
        return base.touch(activity)
      },
    })
    await files.putDoc(transcript('s1'), 'x')
    await index.entries()
    const seenAt = (await storage.get('s1'))!.transcript!.mtimeMs

    index.recordActivity('s1', seenAt + 1000)
    await expect(due()).rejects.toThrow('storage unavailable')
    expect(wakeups).toHaveLength(2)
    expect((await storage.get('s1'))?.transcript?.mtimeMs).toBe(seenAt)

    failing = false
    await due()
    expect((await storage.get('s1'))?.transcript?.mtimeMs).toBe(seenAt + 1000)
    expect(wakeups).toHaveLength(2)
  })

  it('stops waiting for a wakeup that is an interval late, and stores as the next write is recorded', async () => {
    const { index, files, storage, wakeups } = setupWithWakeups()
    await files.putDoc(transcript('s1'), 'x')
    const seenAt = (await activityOf(index)).s1!
    vi.useFakeTimers({ now: seenAt + 10, toFake: ['Date'] })

    index.recordActivity('s1', seenAt + 10)
    // The wakeup never comes: dispatch stopped, or its manager is gone.
    vi.setSystemTime(seenAt + 10 + 2 * ACTIVITY_STORE_INTERVAL_MS - 1)
    index.recordActivity('s1', seenAt + 20)
    await backgroundSettled()
    expect((await storage.get('s1'))?.transcript?.mtimeMs).toBe(seenAt)

    vi.setSystemTime(seenAt + 10 + 2 * ACTIVITY_STORE_INTERVAL_MS)
    index.recordActivity('s1', seenAt + 30)
    await backgroundSettled()

    expect((await storage.get('s1'))?.transcript?.mtimeMs).toBe(seenAt + 30)
    // And asks for another, in case wakeups come again.
    expect(wakeups).toHaveLength(2)
  })

  it('stores each write as it is recorded when no wakeup can be arranged', async () => {
    let canArrange = false
    const { index, files, storage, wakeups } = setupWithWakeups({}, () => canArrange)
    await files.putDoc(transcript('s1'), 'x')
    const seenAt = (await activityOf(index)).s1!

    index.recordActivity('s1', seenAt + 100)
    await backgroundSettled()
    expect((await storage.get('s1'))?.transcript?.mtimeMs).toBe(seenAt + 100)
    expect(wakeups).toEqual([])

    // Arranged from the first write after it becomes possible.
    canArrange = true
    index.recordActivity('s1', seenAt + 200)
    await backgroundSettled()
    expect(wakeups).toHaveLength(1)
    expect((await storage.get('s1'))?.transcript?.mtimeMs).toBe(seenAt + 100)
  })

  it('stores nothing for a session deleted before the wakeup', async () => {
    const { index, files, storage, due } = setupWithWakeups()
    await files.putDoc(transcript('s1'), 'x')
    await index.entries()
    const touch = vi.spyOn(storage, 'touch')

    index.recordActivity('s1', 9_000_000_000_000)
    await files.delete(transcript('s1'))
    await index.delete(['s1'])
    await due()

    expect(touch).not.toHaveBeenCalled()
    expect(await storage.list()).toEqual([])
  })

  it('holds activity for a transcript it has not seen across a wakeup, until it sees it', async () => {
    const { index, files, storage, due } = setupWithWakeups()
    await index.update('s1', () => ({ name: 'Registered' }))
    index.recordActivity('s1', 9_000_000_000_000)
    await due()
    expect((await storage.get('s1'))?.transcript).toBeNull()

    await files.putDoc(transcript('s1'), 'x')

    expect(await activityOf(index)).toEqual({ s1: 9_000_000_000_000 })
    expect((await storage.get('s1'))?.transcript?.mtimeMs).toBe(9_000_000_000_000)
  })
})
