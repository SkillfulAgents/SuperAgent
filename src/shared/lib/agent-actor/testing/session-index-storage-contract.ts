/**
 * The `SessionIndexStorage` contract as a test suite, run against every implementation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REMOVE_SESSION, type SessionIndexEntry, type SessionIndexStorage } from '../session-index'

export interface SessionIndexStorageHarness {
  /** The storage of one agent. */
  storage: SessionIndexStorage
  /** The storage of another agent over the same backing store. */
  other: SessionIndexStorage
  dispose?: () => Promise<void> | void
}

const seen = (mtimeMs: number, size = 10) => ({ mtimeMs, birthtimeMs: mtimeMs - 1000, size })
const byId = (entries: SessionIndexEntry[]) => [...entries].sort((a, b) => a.sessionId.localeCompare(b.sessionId))

export function describeSessionIndexStorageContract(
  name: string,
  make: () => Promise<SessionIndexStorageHarness> | SessionIndexStorageHarness,
): void {
  describe(`${name} — SessionIndexStorage contract`, () => {
    let harness: SessionIndexStorageHarness
    let storage: SessionIndexStorage

    beforeEach(async () => {
      harness = await make()
      storage = harness.storage
    })

    afterEach(async () => {
      await harness.dispose?.()
    })

    it('has no entries to begin with', async () => {
      expect(await storage.get('s1')).toBeNull()
      expect(await storage.list()).toEqual([])
      expect(await storage.findByMeta('scheduledTaskId', 't1')).toEqual([])
    })

    describe('update', () => {
      it('creates an entry from a mutator that is shown none', async () => {
        const shown: (SessionIndexEntry | null)[] = []
        await storage.update('s1', (current) => {
          shown.push(current)
          return { name: 'First', createdAt: '2026-01-01T00:00:00.000Z' }
        })

        expect(shown).toEqual([null])
        expect(await storage.get('s1')).toEqual({
          sessionId: 's1',
          meta: { name: 'First', createdAt: '2026-01-01T00:00:00.000Z' },
          transcript: null,
        })
      })

      it('shows the mutator the stored entry and replaces its metadata', async () => {
        await storage.update('s1', () => ({ name: 'First', starred: true }))
        await storage.update('s1', (current) => ({ ...current!.meta, name: 'Renamed' }))

        expect((await storage.get('s1'))?.meta).toEqual({ name: 'Renamed', starred: true })
      })

      it('writes nothing when the mutator answers null', async () => {
        await storage.update('absent', () => null)
        expect(await storage.get('absent')).toBeNull()

        await storage.update('s1', () => ({ name: 'First' }))
        await storage.update('s1', () => null)
        expect((await storage.get('s1'))?.meta).toEqual({ name: 'First' })
      })

      it('removes the entry on REMOVE_SESSION, and an absent one is a no-op', async () => {
        await storage.update('s1', () => ({ name: 'First' }))
        await storage.update('s1', () => REMOVE_SESSION)
        expect(await storage.get('s1')).toBeNull()

        await storage.update('s1', () => REMOVE_SESSION)
        expect(await storage.list()).toEqual([])
      })

      it('keeps the transcript an entry has seen when its metadata is replaced', async () => {
        await storage.fill([{ sessionId: 's1', meta: null, transcript: seen(5000) }])
        await storage.update('s1', () => ({ name: 'Named later' }))

        expect(await storage.get('s1')).toEqual({ sessionId: 's1', meta: { name: 'Named later' }, transcript: seen(5000) })
      })

      it('loses no update when many race on one session', async () => {
        await storage.update('s1', () => ({ name: 'Start' }))
        const fields = Array.from({ length: 8 }, (_, i) => `field${i}`)

        await Promise.all(fields.map((field) =>
          storage.update('s1', (current) => ({ ...current?.meta, [field]: true }))))

        const meta = (await storage.get('s1'))?.meta as Record<string, unknown>
        expect(meta.name).toBe('Start')
        for (const field of fields) expect(meta[field]).toBe(true)
      })

      it('loses no session when many are created at once', async () => {
        const ids = Array.from({ length: 30 }, (_, i) => `session-${i}`)
        await Promise.all(ids.map((id) => storage.update(id, () => ({ name: id }))))

        expect((await storage.list()).map((entry) => entry.sessionId).sort()).toEqual([...ids].sort())
      })

      it('keeps unknown metadata fields and null values, and drops undefined ones', async () => {
        const meta = { name: 'First', alertDeviceId: null, futureField: { nested: [1, 2] }, starred: undefined }
        await storage.update('s1', () => meta)

        const stored = (await storage.get('s1'))?.meta
        expect(stored).toEqual({ name: 'First', alertDeviceId: null, futureField: { nested: [1, 2] } })
        expect(Object.hasOwn(stored!, 'starred')).toBe(false)
      })

      it('refuses metadata that does not fit the schema, and stores nothing', async () => {
        await expect(storage.update('s1', () => ({ name: 42 } as never))).rejects.toThrow()
        expect(await storage.get('s1')).toBeNull()
      })

      it('hands out copies: changing what was read changes nothing stored', async () => {
        await storage.update('s1', () => ({ name: 'First', errorProviders: { m1: 'anthropic' } }))
        const read = await storage.get('s1')
        read!.meta!.name = 'Changed in memory'
        ;(read!.meta!.errorProviders as Record<string, string>).m2 = 'openai'

        expect((await storage.get('s1'))?.meta).toEqual({ name: 'First', errorProviders: { m1: 'anthropic' } })
      })
    })

    describe('fill', () => {
      it('adds entries that do not exist, with whatever they carry', async () => {
        await storage.fill([
          { sessionId: 'registered', meta: { name: 'Registered' }, transcript: null },
          { sessionId: 'found', meta: null, transcript: seen(5000) },
          { sessionId: 'both', meta: { name: 'Both' }, transcript: seen(6000, 0) },
        ])

        expect(byId(await storage.list())).toEqual([
          { sessionId: 'both', meta: { name: 'Both' }, transcript: seen(6000, 0) },
          { sessionId: 'found', meta: null, transcript: seen(5000) },
          { sessionId: 'registered', meta: { name: 'Registered' }, transcript: null },
        ])
      })

      it('adds the metadata or the transcript an entry lacks', async () => {
        await storage.fill([
          { sessionId: 'registered', meta: { name: 'Registered' }, transcript: null },
          { sessionId: 'found', meta: null, transcript: seen(5000) },
        ])
        await storage.fill([
          { sessionId: 'registered', meta: null, transcript: seen(7000) },
          { sessionId: 'found', meta: { name: 'Named by an import' }, transcript: null },
        ])

        expect(byId(await storage.list())).toEqual([
          { sessionId: 'found', meta: { name: 'Named by an import' }, transcript: seen(5000) },
          { sessionId: 'registered', meta: { name: 'Registered' }, transcript: seen(7000) },
        ])
      })

      it('never replaces what is stored', async () => {
        await storage.fill([{ sessionId: 's1', meta: { name: 'Kept' }, transcript: seen(5000, 3) }])
        await storage.fill([{ sessionId: 's1', meta: { name: 'Stale copy' }, transcript: seen(9000, 99) }])

        expect(await storage.get('s1')).toEqual({ sessionId: 's1', meta: { name: 'Kept' }, transcript: seen(5000, 3) })
      })

      it('takes more entries than fit in one statement', async () => {
        const entries = Array.from({ length: 1203 }, (_, i) => ({
          sessionId: `session-${i}`,
          meta: { name: `Session ${i}` },
          transcript: seen(1000 + i),
        }))
        await storage.fill(entries)
        await storage.fill([])

        expect(await storage.list()).toHaveLength(1203)
        expect(await storage.get('session-1202')).toEqual(entries[1202])
      })

      it('keeps a file time\'s sub-millisecond part', async () => {
        const transcript = { mtimeMs: 1767225600123.456, birthtimeMs: 1767225600000.789, size: 12 }
        await storage.fill([{ sessionId: 's1', meta: null, transcript }])

        expect((await storage.get('s1'))?.transcript).toEqual(transcript)
      })
    })

    describe('touch', () => {
      it('moves a seen transcript forward, never back, and marks it non-empty', async () => {
        await storage.fill([{ sessionId: 's1', meta: null, transcript: seen(5000, 0) }])

        expect(await storage.touch(new Map([['s1', 8000]]))).toEqual([])
        expect((await storage.get('s1'))?.transcript).toEqual({ ...seen(5000), mtimeMs: 8000, size: 1 })

        expect(await storage.touch(new Map([['s1', 6000]]))).toEqual([])
        expect((await storage.get('s1'))?.transcript?.mtimeMs).toBe(8000)
      })

      it('keeps the size of a transcript that is not empty', async () => {
        await storage.fill([{ sessionId: 's1', meta: null, transcript: seen(5000, 4096) }])
        await storage.touch(new Map([['s1', 8000]]))

        expect((await storage.get('s1'))?.transcript?.size).toBe(4096)
      })

      it('leaves alone, and returns, a session with no entry or no seen transcript', async () => {
        await storage.update('registered', () => ({ name: 'Registered' }))
        await storage.fill([{ sessionId: 'found', meta: null, transcript: seen(5000) }])

        const leftAlone = await storage.touch(new Map([['registered', 8000], ['unknown', 8000], ['found', 8000]]))

        expect(leftAlone.sort()).toEqual(['registered', 'unknown'])
        expect((await storage.get('registered'))?.transcript).toBeNull()
        expect(await storage.get('unknown')).toBeNull()
      })
    })

    describe('findByMeta', () => {
      it('answers the entries whose metadata holds the value, and only those', async () => {
        await storage.update('run-1', () => ({ scheduledTaskId: 'task-a', isScheduledExecution: true }))
        await storage.update('run-2', () => ({ scheduledTaskId: 'task-a' }))
        await storage.update('run-3', () => ({ scheduledTaskId: 'task-b' }))
        await storage.update('hook', () => ({ webhookTriggerId: 'task-a' }))
        await storage.fill([{ sessionId: 'unregistered', meta: null, transcript: seen(5000) }])

        expect(byId(await storage.findByMeta('scheduledTaskId', 'task-a')).map((entry) => entry.sessionId))
          .toEqual(['run-1', 'run-2'])
        expect((await storage.findByMeta('webhookTriggerId', 'task-a')).map((entry) => entry.sessionId)).toEqual(['hook'])
        expect(await storage.findByMeta('webhookTriggerId', 'nothing')).toEqual([])
      })
    })

    describe('delete', () => {
      it('removes the named entries and leaves the rest', async () => {
        for (const id of ['s0', 's1', 's2', 's3']) await storage.update(id, () => ({ name: id }))

        await storage.delete(['s1', 's3', 'never-there'])
        await storage.delete([])

        expect((await storage.list()).map((entry) => entry.sessionId).sort()).toEqual(['s0', 's2'])
      })
    })

    it('treats every session id as a plain key', async () => {
      const ids = ['__proto__', 'constructor', 'with space', "quote'd", 'percent%', 'ünïcode']
      for (const id of ids) await storage.update(id, () => ({ name: id }))

      for (const id of ids) expect((await storage.get(id))?.meta).toEqual({ name: id })
      expect((await storage.list()).map((entry) => entry.sessionId).sort()).toEqual([...ids].sort())
    })

    it('never shows one agent another agent\'s entries, or lets it change them', async () => {
      await storage.update('shared-id', () => ({ name: 'Mine', scheduledTaskId: 'task-a' }))
      await storage.fill([{ sessionId: 'shared-id', meta: null, transcript: seen(5000) }])
      const { other } = harness

      expect(await other.get('shared-id')).toBeNull()
      expect(await other.list()).toEqual([])
      expect(await other.findByMeta('scheduledTaskId', 'task-a')).toEqual([])

      await other.update('shared-id', () => ({ name: 'Theirs' }))
      expect(await other.touch(new Map([['shared-id', 9000]]))).toEqual(['shared-id'])
      await other.delete(['shared-id'])

      expect(await storage.get('shared-id')).toEqual({
        sessionId: 'shared-id',
        meta: { name: 'Mine', scheduledTaskId: 'task-a' },
        transcript: seen(5000),
      })
    })
  })
}
