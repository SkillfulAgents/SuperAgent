/**
 * App records over the app database, on the test driver (DB_DRIVER=libsql
 * runs them on libsql): the stored-text operations' contract, typed reads,
 * and getOrCreateRecord's convergence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import {
  compareAndSetRecord,
  deleteRecord,
  getOrCreateRecord,
  insertRecordIfAbsent,
  InvalidAppRecordError,
  listStoredRecords,
  readRecord,
  readStoredRecord,
  serializeRecordValue,
} from './records'

let handle: TestDatabase
let db: TestDatabase['db']

beforeEach(async () => {
  handle = await createTestDatabase()
  db = handle.db
})
afterEach(async () => {
  vi.restoreAllMocks()
  await handle.close()
})

it('defaults to the app database, which the entry point must open first', async () => {
  await expect(readStoredRecord('k')).rejects.toThrow(/The database is not open/)
})

describe('stored records', () => {
  it('reads null for an absent key', async () => {
    expect(await readStoredRecord('absent', db)).toBeNull()
  })

  it('inserts once: a second insert of the same key does nothing and reports it', async () => {
    expect(await insertRecordIfAbsent('k', '"first"', db)).toBe(true)
    expect(await insertRecordIfAbsent('k', '"second"', db)).toBe(false)
    expect(await readStoredRecord('k', db)).toEqual({ value: '"first"', revision: 1 })
  })

  it('writes only at the revision the writer read, and bumps it', async () => {
    await insertRecordIfAbsent('k', '1', db)
    expect(await compareAndSetRecord('k', 1, '2', db)).toBe(true)
    expect(await readStoredRecord('k', db)).toEqual({ value: '2', revision: 2 })
    // A writer still holding revision 1 lost: nothing changes.
    expect(await compareAndSetRecord('k', 1, 'stale', db)).toBe(false)
    expect(await readStoredRecord('k', db)).toEqual({ value: '2', revision: 2 })
  })

  it('does not create a record through compare-and-set', async () => {
    expect(await compareAndSetRecord('absent', 0, '1', db)).toBe(false)
    expect(await readStoredRecord('absent', db)).toBeNull()
  })

  it('lists exactly the keys with a prefix: case and wildcard characters are literal', async () => {
    for (const key of ['tok:a', 'tok:b_c', 'tok_x', 'TOK:upper', 'tok', 'other']) {
      await insertRecordIfAbsent(key, '1', db)
    }
    const keys = (await listStoredRecords('tok:', db)).map((row) => row.key).sort()
    expect(keys).toEqual(['tok:a', 'tok:b_c'])
  })

  it('deletes a key', async () => {
    await insertRecordIfAbsent('k', '1', db)
    await deleteRecord('k', db)
    expect(await readStoredRecord('k', db)).toBeNull()
    // A deleted key can be created again.
    expect(await insertRecordIfAbsent('k', '2', db)).toBe(true)
  })
})

describe('typed records', () => {
  const schema = z.string().min(3)

  it('refuses to write a value its schema rejects', () => {
    expect(() => serializeRecordValue('k', 'no', schema)).toThrow(InvalidAppRecordError)
  })

  it('reads a value that is not JSON, or not its schema, as an error rather than absence', async () => {
    await insertRecordIfAbsent('torn', '{"half', db)
    await insertRecordIfAbsent('short', '"no"', db)
    await expect(readRecord('torn', schema, db)).rejects.toThrow(InvalidAppRecordError)
    await expect(readRecord('short', schema, db)).rejects.toThrow(InvalidAppRecordError)
  })
})

describe('getOrCreateRecord', () => {
  const schema = z.string().min(1)

  it('creates once and then returns the stored value', async () => {
    const create = vi.fn(() => 'created')
    expect(await getOrCreateRecord('k', schema, create, db)).toBe('created')
    expect(await getOrCreateRecord('k', schema, () => 'other', db)).toBe('created')
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('concurrent first uses all return the one committed value', async () => {
    let n = 0
    const values = await Promise.all(
      Array.from({ length: 10 }, () => getOrCreateRecord('k', schema, () => `candidate-${n++}`, db)),
    )
    expect(new Set(values).size).toBe(1)
    expect(values[0]).toBe(JSON.parse((await readStoredRecord('k', db))!.value))
  })

  it('a creator whose insert lost returns the winner, never its own candidate', async () => {
    // Another process committed after this caller's read missed: the read
    // finds nothing, the winner is already stored when this caller inserts.
    await insertRecordIfAbsent('k', JSON.stringify('winner'), db)
    const miss = { from: () => miss, where: () => miss, get: async () => undefined }
    vi.spyOn(db, 'select').mockReturnValueOnce(miss as never)
    const create = vi.fn(() => 'loser')
    expect(await getOrCreateRecord('k', schema, create, db)).toBe('winner')
    expect(create).toHaveBeenCalledTimes(1)
    expect(await readStoredRecord('k', db)).toEqual({ value: JSON.stringify('winner'), revision: 1 })
  })

  it('an invalid stored value throws and is never replaced', async () => {
    await insertRecordIfAbsent('k', '""', db)
    const create = vi.fn(() => 'new')
    await expect(getOrCreateRecord('k', schema, create, db)).rejects.toThrow(InvalidAppRecordError)
    expect(create).not.toHaveBeenCalled()
    expect(await readStoredRecord('k', db)).toEqual({ value: '""', revision: 1 })
  })

  it('a database error is not absence: it propagates and nothing is created', async () => {
    vi.spyOn(db, 'select').mockImplementationOnce(() => {
      throw new Error('SQLITE_BUSY')
    })
    const insert = vi.spyOn(db, 'insert')
    const create = vi.fn(() => 'new')
    await expect(getOrCreateRecord('k', schema, create, db)).rejects.toThrow('SQLITE_BUSY')
    expect(create).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
  })
})
