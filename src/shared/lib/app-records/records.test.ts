import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  appRecordStore,
  getOrCreateRecord,
  installAppRecordStore,
  InvalidAppRecordError,
  readRecord,
  serializeRecordValue,
  uninstallAppRecordStore,
} from './records'
import { MemoryAppRecordStore } from './testing/memory-record-store'

afterEach(() => {
  uninstallAppRecordStore()
})

describe('the installed store', () => {
  it('is an error to read before the entry point installs one', () => {
    expect(() => appRecordStore()).toThrow(/installAppRecordStore\(\) after openDatabase\(\)/)
  })

  it('refuses a second, different store', () => {
    const first = new MemoryAppRecordStore()
    installAppRecordStore(first)
    installAppRecordStore(first) // the same one again is harmless
    expect(() => installAppRecordStore(new MemoryAppRecordStore())).toThrow(/already installed/)
    expect(appRecordStore()).toBe(first)
  })
})

describe('typed records', () => {
  const schema = z.string().min(3)

  it('refuses to write a value its schema rejects', () => {
    expect(() => serializeRecordValue('k', 'no', schema)).toThrow(InvalidAppRecordError)
  })

  it('reads a value that is not JSON, or not its schema, as an error rather than absence', async () => {
    const store = new MemoryAppRecordStore()
    store.rows.set('torn', { value: '{"half', revision: 1 })
    store.rows.set('short', { value: '"no"', revision: 1 })
    await expect(readRecord(store, 'torn', schema)).rejects.toThrow(InvalidAppRecordError)
    await expect(readRecord(store, 'short', schema)).rejects.toThrow(InvalidAppRecordError)
  })
})

describe('getOrCreateRecord', () => {
  const schema = z.string().min(1)

  it('creates once and then returns the stored value', async () => {
    const store = new MemoryAppRecordStore()
    const create = vi.fn(() => 'created')
    expect(await getOrCreateRecord(store, 'k', schema, create)).toBe('created')
    expect(await getOrCreateRecord(store, 'k', schema, () => 'other')).toBe('created')
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('concurrent first uses all return the one committed value', async () => {
    const store = new MemoryAppRecordStore()
    let n = 0
    const values = await Promise.all(
      Array.from({ length: 10 }, () => getOrCreateRecord(store, 'k', schema, () => `candidate-${n++}`)),
    )
    expect(new Set(values).size).toBe(1)
    expect(values[0]).toBe(JSON.parse(store.rows.get('k')!.value))
  })

  it('a creator whose insert lost returns the winner, never its own candidate', async () => {
    const store = new MemoryAppRecordStore()
    // Another process commits between this caller's miss and its insert.
    const insert = store.insertIfAbsent.bind(store)
    vi.spyOn(store, 'insertIfAbsent').mockImplementationOnce(async (key, value) => {
      await insert(key, JSON.stringify('winner'))
      return insert(key, value)
    })
    expect(await getOrCreateRecord(store, 'k', schema, () => 'loser')).toBe('winner')
  })

  it('an invalid stored value throws and is never replaced', async () => {
    const store = new MemoryAppRecordStore()
    store.rows.set('k', { value: '""', revision: 1 })
    const create = vi.fn(() => 'new')
    await expect(getOrCreateRecord(store, 'k', schema, create)).rejects.toThrow(InvalidAppRecordError)
    expect(create).not.toHaveBeenCalled()
    expect(store.rows.get('k')).toEqual({ value: '""', revision: 1 })
  })

  it('a database error is not absence: it propagates and nothing is created', async () => {
    const store = new MemoryAppRecordStore()
    vi.spyOn(store, 'read').mockRejectedValueOnce(new Error('SQLITE_BUSY'))
    const create = vi.fn(() => 'new')
    await expect(getOrCreateRecord(store, 'k', schema, create)).rejects.toThrow('SQLITE_BUSY')
    expect(create).not.toHaveBeenCalled()
    expect(store.calls.insertIfAbsent).toBe(0)
  })
})
