/**
 * Host-browser context mappings (browserbase-provider / platform-provider),
 * one app record per key. Creating a context is a paid network call, so a
 * mapping must be created at most once per key, never lost to another key's
 * write, and never treated as absent when it cannot be read.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getOrCreateMapping, readContextMapping } from './context-map-store'
import { MemoryAppRecordStore } from '@shared/lib/app-records/testing/memory-record-store'
import { InvalidAppRecordError } from '@shared/lib/app-records/records'
import { browserContextKey } from '@shared/lib/app-records/record-schemas'

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException }))

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

let store: MemoryAppRecordStore

beforeEach(() => {
  store = new MemoryAppRecordStore()
  captureException.mockClear()
})

describe('readContextMapping', () => {
  it('absent → null; stored → the id; the two providers do not share keys', async () => {
    expect(await readContextMapping('browserbase', 'inst1', store)).toBeNull()
    await getOrCreateMapping('browserbase', 'inst1', async () => 'ctx-1', store)
    expect(await readContextMapping('browserbase', 'inst1', store)).toBe('ctx-1')
    expect(await readContextMapping('platform', 'inst1', store)).toBeNull()
  })

  it('an unreadable stored id THROWS instead of reading as absent', async () => {
    store.rows.set(browserContextKey('browserbase', 'inst1'), { value: '{"torn', revision: 1 })
    await expect(readContextMapping('browserbase', 'inst1', store)).rejects.toThrow(InvalidAppRecordError)
  })
})

describe('getOrCreateMapping', () => {
  it('returns an existing mapping without creating', async () => {
    await getOrCreateMapping('browserbase', 'a', async () => 'ctx-a', store)
    const create = vi.fn(async () => 'never')
    expect(await getOrCreateMapping('browserbase', 'a', create, store)).toBe('ctx-a')
    expect(create).not.toHaveBeenCalled()
  })

  it('concurrent first opens of one key create exactly one context', async () => {
    const create = vi.fn(async () => {
      await delay(10)
      return 'ctx-once'
    })
    const results = await Promise.all(
      Array.from({ length: 5 }, () => getOrCreateMapping('browserbase', 'a', create, store)),
    )
    expect(results).toEqual(Array(5).fill('ctx-once'))
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('different keys create in parallel and keep each other', async () => {
    await Promise.all([
      getOrCreateMapping('browserbase', 'a', async () => { await delay(5); return 'ctx-a' }, store),
      getOrCreateMapping('browserbase', 'b', async () => 'ctx-b', store),
    ])
    expect(await readContextMapping('browserbase', 'a', store)).toBe('ctx-a')
    expect(await readContextMapping('browserbase', 'b', store)).toBe('ctx-b')
  })

  it('an unreadable stored mapping aborts without creating (and billing) a new context', async () => {
    store.rows.set(browserContextKey('browserbase', 'a'), { value: '""', revision: 1 })
    const create = vi.fn(async () => 'ctx-new')
    await expect(getOrCreateMapping('browserbase', 'a', create, store)).rejects.toThrow(InvalidAppRecordError)
    expect(create).not.toHaveBeenCalled()
  })

  it('another process committing first wins; the context made here is reported as orphaned', async () => {
    const create = vi.fn(async () => {
      // The other process's mapping lands while this one is creating.
      await store.insertIfAbsent(browserContextKey('platform', 'k'), JSON.stringify('ctx-theirs'))
      return 'ctx-ours'
    })
    expect(await getOrCreateMapping('platform', 'k', create, store)).toBe('ctx-theirs')
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ extra: expect.objectContaining({ orphanedContextId: 'ctx-ours' }) }),
    )
  })

  it('a failed persist reports the orphaned (billed) context id and rethrows', async () => {
    vi.spyOn(store, 'insertIfAbsent').mockRejectedValueOnce(new Error('SQLITE_FULL'))
    await expect(getOrCreateMapping('browserbase', 'a', async () => 'ctx-billed', store)).rejects.toThrow('SQLITE_FULL')
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ extra: expect.objectContaining({ orphanedContextId: 'ctx-billed' }) }),
    )
  })

  it('a failed create leaves nothing behind, so the next open can create again', async () => {
    await expect(getOrCreateMapping('browserbase', 'a', async () => { throw new Error('402') }, store)).rejects.toThrow('402')
    expect(await getOrCreateMapping('browserbase', 'a', async () => 'ctx-2', store)).toBe('ctx-2')
  })
})
