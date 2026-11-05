/**
 * Host-browser context mappings (browserbase-provider / platform-provider),
 * one app record per key. Creating a context is a paid network call, so a
 * mapping must be created at most once per key, never lost to another key's
 * write, and never treated as absent when it cannot be read.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getOrCreateMapping, readContextMapping } from './context-map-store'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import * as records from '@shared/lib/app-records/records'
import { insertRecordIfAbsent, InvalidAppRecordError } from '@shared/lib/app-records/records'
import { browserContextKey } from '@shared/lib/app-records/record-schemas'

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException }))

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

let handle: TestDatabase
let db: TestDatabase['db']

beforeEach(async () => {
  handle = await createTestDatabase()
  db = handle.db
  captureException.mockClear()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await handle.close()
})

describe('readContextMapping', () => {
  it('absent → null; stored → the id; the two providers do not share keys', async () => {
    expect(await readContextMapping('browserbase', 'inst1', db)).toBeNull()
    await getOrCreateMapping('browserbase', 'inst1', async () => 'ctx-1', db)
    expect(await readContextMapping('browserbase', 'inst1', db)).toBe('ctx-1')
    expect(await readContextMapping('platform', 'inst1', db)).toBeNull()
  })

  it('an unreadable stored id THROWS instead of reading as absent', async () => {
    await insertRecordIfAbsent(browserContextKey('browserbase', 'inst1'), '{"torn', db)
    await expect(readContextMapping('browserbase', 'inst1', db)).rejects.toThrow(InvalidAppRecordError)
  })
})

describe('getOrCreateMapping', () => {
  it('returns an existing mapping without creating', async () => {
    await getOrCreateMapping('browserbase', 'a', async () => 'ctx-a', db)
    const create = vi.fn(async () => 'never')
    expect(await getOrCreateMapping('browserbase', 'a', create, db)).toBe('ctx-a')
    expect(create).not.toHaveBeenCalled()
  })

  it('concurrent first opens of one key create exactly one context', async () => {
    const create = vi.fn(async () => {
      await delay(10)
      return 'ctx-once'
    })
    const results = await Promise.all(
      Array.from({ length: 5 }, () => getOrCreateMapping('browserbase', 'a', create, db)),
    )
    expect(results).toEqual(Array(5).fill('ctx-once'))
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('different keys create in parallel and keep each other', async () => {
    await Promise.all([
      getOrCreateMapping('browserbase', 'a', async () => { await delay(5); return 'ctx-a' }, db),
      getOrCreateMapping('browserbase', 'b', async () => 'ctx-b', db),
    ])
    expect(await readContextMapping('browserbase', 'a', db)).toBe('ctx-a')
    expect(await readContextMapping('browserbase', 'b', db)).toBe('ctx-b')
  })

  it('an unreadable stored mapping aborts without creating (and billing) a new context', async () => {
    await insertRecordIfAbsent(browserContextKey('browserbase', 'a'), '""', db)
    const create = vi.fn(async () => 'ctx-new')
    await expect(getOrCreateMapping('browserbase', 'a', create, db)).rejects.toThrow(InvalidAppRecordError)
    expect(create).not.toHaveBeenCalled()
  })

  it('another process committing first wins; the context made here is reported as orphaned', async () => {
    const create = vi.fn(async () => {
      // The other process's mapping lands while this one is creating.
      await insertRecordIfAbsent(browserContextKey('platform', 'k'), JSON.stringify('ctx-theirs'), db)
      return 'ctx-ours'
    })
    expect(await getOrCreateMapping('platform', 'k', create, db)).toBe('ctx-theirs')
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ extra: expect.objectContaining({ orphanedContextId: 'ctx-ours' }) }),
    )
  })

  it('a failed persist reports the orphaned (billed) context id and rethrows', async () => {
    vi.spyOn(records, 'insertRecordIfAbsent').mockRejectedValueOnce(new Error('SQLITE_FULL'))
    await expect(getOrCreateMapping('browserbase', 'a', async () => 'ctx-billed', db)).rejects.toThrow('SQLITE_FULL')
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ extra: expect.objectContaining({ orphanedContextId: 'ctx-billed' }) }),
    )
  })

  it('a failed create leaves nothing behind, so the next open can create again', async () => {
    await expect(getOrCreateMapping('browserbase', 'a', async () => { throw new Error('402') }, db)).rejects.toThrow('402')
    expect(await getOrCreateMapping('browserbase', 'a', async () => 'ctx-2', db)).toBe('ctx-2')
  })
})
