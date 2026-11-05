/**
 * Settings stored as an app record: fresh reads, fail-closed writes, and
 * revision compare-and-set instead of a process cache or a transaction.
 * Runs on the test driver (DB_DRIVER=libsql for libsql).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import * as records from '@shared/lib/app-records/records'
import {
  compareAndSetRecord,
  deleteRecord,
  insertRecordIfAbsent,
  InvalidAppRecordError,
  readStoredRecord,
} from '@shared/lib/app-records/records'
import { SETTINGS_RECORD_KEY } from '@shared/lib/app-records/record-schemas'

vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))

import {
  DEFAULT_SETTINGS,
  getSettings,
  loadSettingsStrict,
  mutateSettings,
  readSettingsSnapshot,
  updateSettings,
  SettingsWriteConflictError,
} from './settings'

let handle: TestDatabase
let db: TestDatabase['db']

beforeEach(async () => {
  handle = await createTestDatabase()
  db = handle.db
})
afterEach(async () => {
  await handle.close()
  vi.restoreAllMocks()
})

async function storedJson(): Promise<{ value: Record<string, unknown>; revision: number } | null> {
  const row = await readStoredRecord(SETTINGS_RECORD_KEY, db)
  return row && { value: JSON.parse(row.value), revision: row.revision }
}

describe('reads', () => {
  it('a fresh install reads the defaults at revision 0 and stores nothing', async () => {
    const snapshot = await readSettingsSnapshot(db)
    expect(snapshot.revision).toBe(0)
    expect(snapshot.settings).toEqual(DEFAULT_SETTINGS)
    expect(snapshot.settings).not.toBe(DEFAULT_SETTINGS)
    expect(await storedJson()).toBeNull()
  })

  it('every read goes to the database: a value written elsewhere is the next read', async () => {
    await mutateSettings((s) => { s.app = { ...s.app, theme: 'dark' } }, db)
    const first = await getSettings(db)
    // Another writer, straight into the record.
    const row = (await readStoredRecord(SETTINGS_RECORD_KEY, db))!
    await compareAndSetRecord(SETTINGS_RECORD_KEY, row.revision, JSON.stringify({ ...JSON.parse(row.value), app: { theme: 'light' } }), db)
    const second = await getSettings(db)
    expect(first.app?.theme).toBe('dark')
    expect(second.app?.theme).toBe('light')
    expect(second).not.toBe(first)
  })

  it('invalid stored settings: tolerant reads get defaults, strict reads and writes refuse, the value is kept', async () => {
    for (const bad of ['{"torn', '[1,2]', '"text"']) {
      await deleteRecord(SETTINGS_RECORD_KEY, db)
      await insertRecordIfAbsent(SETTINGS_RECORD_KEY, bad, db)
      vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(await getSettings(db)).toEqual(DEFAULT_SETTINGS)
      await expect(loadSettingsStrict(db)).rejects.toThrow(InvalidAppRecordError)
      await expect(mutateSettings((s) => { s.shareAnalytics = false }, db)).rejects.toThrow(InvalidAppRecordError)
      expect((await readStoredRecord(SETTINGS_RECORD_KEY, db))?.value).toBe(bad)
    }
  })

  it('reports invalid stored settings once per stored value, not on every read', async () => {
    const { captureException } = await import('@shared/lib/error-reporting')
    vi.mocked(captureException).mockClear()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await insertRecordIfAbsent(SETTINGS_RECORD_KEY, '{"first-broken', db)
    await getSettings(db)
    await getSettings(db)
    expect(captureException).toHaveBeenCalledTimes(1)
    const row = (await readStoredRecord(SETTINGS_RECORD_KEY, db))!
    await compareAndSetRecord(SETTINGS_RECORD_KEY, row.revision, '{"second-broken', db)
    await getSettings(db)
    expect(captureException).toHaveBeenCalledTimes(2)
  })

  it('a database error is not invalid data: it propagates from the tolerant read too', async () => {
    vi.spyOn(records, 'readStoredRecord').mockRejectedValueOnce(new Error('SQLITE_IOERR'))
    await expect(getSettings(db)).rejects.toThrow('SQLITE_IOERR')
  })
})

describe('writes', () => {
  it('the first write inserts at revision 1, later writes bump the revision', async () => {
    await mutateSettings((s) => { s.shareAnalytics = false }, db)
    expect((await storedJson())?.revision).toBe(1)
    await mutateSettings((s) => { s.shareErrorReports = false }, db)
    const stored = await storedJson()
    expect(stored?.revision).toBe(2)
    expect(stored?.value).toMatchObject({ shareAnalytics: false, shareErrorReports: false })
  })

  it('a mutation that loses the race is applied again to the newer settings: no lost update', async () => {
    await mutateSettings((s) => { s.customEnvVars = { A: '1' } }, db)
    // Another process writes between this mutation's read and its write, once.
    const cas = records.compareAndSetRecord
    vi.spyOn(records, 'compareAndSetRecord').mockImplementationOnce(async (key, revision, value, on) => {
      const current = JSON.parse((await readStoredRecord(key, on))!.value)
      await cas(key, revision, JSON.stringify({ ...current, customEnvVars: { ...current.customEnvVars, B: '2' } }), on)
      return cas(key, revision, value, on)
    })
    const mutator = vi.fn((s: typeof DEFAULT_SETTINGS) => { s.customEnvVars = { ...s.customEnvVars, C: '3' } })
    const written = await mutateSettings(mutator, db)
    expect(mutator).toHaveBeenCalledTimes(2)
    expect(written.customEnvVars).toEqual({ A: '1', B: '2', C: '3' })
    expect((await storedJson())?.value.customEnvVars).toEqual({ A: '1', B: '2', C: '3' })
  })

  it('concurrent mutations of different fields all land', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        mutateSettings((s) => { s.customEnvVars = { ...s.customEnvVars, [`K${i}`]: String(i) } }, db),
      ),
    )
    const vars = (await getSettings(db)).customEnvVars
    expect(Object.keys(vars ?? {}).sort()).toEqual(['K0', 'K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7'])
  })

  it('concurrent first writes on an empty database converge through insert-if-absent', async () => {
    await Promise.all([
      mutateSettings((s) => { s.shareAnalytics = false }, db),
      mutateSettings((s) => { s.shareErrorReports = false }, db),
    ])
    expect((await getSettings(db))).toMatchObject({ shareAnalytics: false, shareErrorReports: false })
  })

  it('an operation keeps its own snapshot, but a write at its stale revision is refused', async () => {
    await mutateSettings((s) => { s.app = { ...s.app, theme: 'dark' } }, db)
    const earlier = await readSettingsSnapshot(db)
    await mutateSettings((s) => { s.app = { ...s.app, theme: 'light' } }, db)
    // The earlier operation's value is its own copy…
    expect(earlier.settings.app?.theme).toBe('dark')
    // …the next operation reads the committed state…
    expect((await getSettings(db)).app?.theme).toBe('light')
    // …and a write at the stale revision cannot overwrite the newer one.
    expect(await compareAndSetRecord(SETTINGS_RECORD_KEY, earlier.revision, JSON.stringify(earlier.settings), db)).toBe(false)
    expect((await getSettings(db)).app?.theme).toBe('light')
  })

  it('returning false writes nothing', async () => {
    await mutateSettings((s) => { s.shareAnalytics = false }, db)
    const result = await updateSettings(() => false, db)
    expect(result.written).toBe(false)
    expect(result.after).toBe(result.before)
    expect((await storedJson())?.revision).toBe(1)
  })

  it('gives `before` as read and `after` as written', async () => {
    await mutateSettings((s) => { s.app = { ...s.app, theme: 'dark' } }, db)
    const { before, after, written } = await updateSettings((draft) => { draft.app = { ...draft.app, theme: 'light' } }, db)
    expect(written).toBe(true)
    expect(before.app?.theme).toBe('dark')
    expect(after.app?.theme).toBe('light')
  })

  it('gives up after losing every attempt instead of spinning', async () => {
    await mutateSettings((s) => { s.shareAnalytics = false }, db)
    vi.spyOn(records, 'compareAndSetRecord').mockResolvedValue(false)
    await expect(mutateSettings((s) => { s.shareAnalytics = true }, db)).rejects.toThrow(SettingsWriteConflictError)
  })

  it('a first-run nested mutation does not pollute the defaults', async () => {
    const before = structuredClone(DEFAULT_SETTINGS)
    await mutateSettings((s) => {
      s.container.resourceLimits.cpu = 99
      s.skillsets!.push({ id: 'x' } as never)
    }, db)
    expect(DEFAULT_SETTINGS).toEqual(before)
  })
})

describe('two processes sharing one database', () => {
  let dir: string
  let a: TestDatabase
  let b: TestDatabase

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-two-instances-'))
    const file = path.join(dir, 'shared.db')
    a = await createTestDatabase({ file })
    b = await createTestDatabase({ file })
  })
  afterEach(async () => {
    await a.close()
    await b.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('a write through one is what the next operation of the other reads, with no restart or message', async () => {
    // Warm both.
    expect((await getSettings(a.db)).app?.autoSleepTimeoutMinutes).toBe(30)
    expect((await getSettings(b.db)).app?.autoSleepTimeoutMinutes).toBe(30)

    await mutateSettings((s) => { s.app = { ...s.app, autoSleepTimeoutMinutes: 5 } }, a.db)
    const committed = await readSettingsSnapshot(a.db)

    const seenByB = await readSettingsSnapshot(b.db)
    expect(seenByB.revision).toBe(committed.revision)
    expect(seenByB.settings.app?.autoSleepTimeoutMinutes).toBe(5)

    // B's write builds on A's, and A sees it.
    await mutateSettings((s) => { s.shareAnalytics = false }, b.db)
    expect(await getSettings(a.db)).toMatchObject({ shareAnalytics: false, app: { autoSleepTimeoutMinutes: 5 } })
  })

  it('concurrent writers on the two handles lose nothing', async () => {
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        mutateSettings((s) => { s.customEnvVars = { ...s.customEnvVars, [`K${i}`]: String(i) } }, i % 2 ? a.db : b.db),
      ),
    )
    expect(Object.keys((await getSettings(a.db)).customEnvVars ?? {}).sort()).toEqual(['K0', 'K1', 'K2', 'K3', 'K4', 'K5'])
  })
})
