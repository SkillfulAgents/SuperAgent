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
import { dbAppRecordStore, type AppRecordStore } from '@shared/lib/app-records/record-store'
import { InvalidAppRecordError } from '@shared/lib/app-records/records'
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
let store: AppRecordStore

beforeEach(async () => {
  handle = await createTestDatabase()
  store = dbAppRecordStore(handle.db)
})
afterEach(async () => {
  await handle.close()
  vi.restoreAllMocks()
})

async function storedJson(s: AppRecordStore = store): Promise<{ value: Record<string, unknown>; revision: number } | null> {
  const row = await s.read(SETTINGS_RECORD_KEY)
  return row && { value: JSON.parse(row.value), revision: row.revision }
}

describe('reads', () => {
  it('a fresh install reads the defaults at revision 0 and stores nothing', async () => {
    const snapshot = await readSettingsSnapshot(store)
    expect(snapshot.revision).toBe(0)
    expect(snapshot.settings).toEqual(DEFAULT_SETTINGS)
    expect(snapshot.settings).not.toBe(DEFAULT_SETTINGS)
    expect(await storedJson()).toBeNull()
  })

  it('every read goes to the store: a value written elsewhere is the next read', async () => {
    await mutateSettings((s) => { s.app = { ...s.app, theme: 'dark' } }, store)
    const first = await getSettings(store)
    // Another writer, straight into the record.
    const row = (await store.read(SETTINGS_RECORD_KEY))!
    await store.compareAndSet(SETTINGS_RECORD_KEY, row.revision, JSON.stringify({ ...JSON.parse(row.value), app: { theme: 'light' } }))
    const second = await getSettings(store)
    expect(first.app?.theme).toBe('dark')
    expect(second.app?.theme).toBe('light')
    expect(second).not.toBe(first)
  })

  it('invalid stored settings: tolerant reads get defaults, strict reads and writes refuse, the value is kept', async () => {
    for (const bad of ['{"torn', '[1,2]', '"text"']) {
      await store.delete(SETTINGS_RECORD_KEY)
      await store.insertIfAbsent(SETTINGS_RECORD_KEY, bad)
      vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(await getSettings(store)).toEqual(DEFAULT_SETTINGS)
      await expect(loadSettingsStrict(store)).rejects.toThrow(InvalidAppRecordError)
      await expect(mutateSettings((s) => { s.shareAnalytics = false }, store)).rejects.toThrow(InvalidAppRecordError)
      expect((await store.read(SETTINGS_RECORD_KEY))?.value).toBe(bad)
    }
  })

  it('reports invalid stored settings once per stored value, not on every read', async () => {
    const { captureException } = await import('@shared/lib/error-reporting')
    vi.mocked(captureException).mockClear()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await store.insertIfAbsent(SETTINGS_RECORD_KEY, '{"first-broken')
    await getSettings(store)
    await getSettings(store)
    expect(captureException).toHaveBeenCalledTimes(1)
    const row = (await store.read(SETTINGS_RECORD_KEY))!
    await store.compareAndSet(SETTINGS_RECORD_KEY, row.revision, '{"second-broken')
    await getSettings(store)
    expect(captureException).toHaveBeenCalledTimes(2)
  })

  it('a database error is not invalid data: it propagates from the tolerant read too', async () => {
    vi.spyOn(store, 'read').mockRejectedValueOnce(new Error('SQLITE_IOERR'))
    await expect(getSettings(store)).rejects.toThrow('SQLITE_IOERR')
  })
})

describe('writes', () => {
  it('the first write inserts at revision 1, later writes bump the revision', async () => {
    await mutateSettings((s) => { s.shareAnalytics = false }, store)
    expect((await storedJson())?.revision).toBe(1)
    await mutateSettings((s) => { s.shareErrorReports = false }, store)
    const stored = await storedJson()
    expect(stored?.revision).toBe(2)
    expect(stored?.value).toMatchObject({ shareAnalytics: false, shareErrorReports: false })
  })

  it('a mutation that loses the race is applied again to the newer settings: no lost update', async () => {
    await mutateSettings((s) => { s.customEnvVars = { A: '1' } }, store)
    // Another process writes between this mutation's read and its write, once.
    const cas = store.compareAndSet.bind(store)
    vi.spyOn(store, 'compareAndSet').mockImplementationOnce(async (key, revision, value) => {
      const current = JSON.parse((await store.read(key))!.value)
      await cas(key, revision, JSON.stringify({ ...current, customEnvVars: { ...current.customEnvVars, B: '2' } }))
      return cas(key, revision, value)
    })
    const mutator = vi.fn((s: typeof DEFAULT_SETTINGS) => { s.customEnvVars = { ...s.customEnvVars, C: '3' } })
    const written = await mutateSettings(mutator, store)
    expect(mutator).toHaveBeenCalledTimes(2)
    expect(written.customEnvVars).toEqual({ A: '1', B: '2', C: '3' })
    expect((await storedJson())?.value.customEnvVars).toEqual({ A: '1', B: '2', C: '3' })
  })

  it('concurrent mutations of different fields all land', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        mutateSettings((s) => { s.customEnvVars = { ...s.customEnvVars, [`K${i}`]: String(i) } }, store),
      ),
    )
    const vars = (await getSettings(store)).customEnvVars
    expect(Object.keys(vars ?? {}).sort()).toEqual(['K0', 'K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7'])
  })

  it('concurrent first writes on an empty database converge through insert-if-absent', async () => {
    await Promise.all([
      mutateSettings((s) => { s.shareAnalytics = false }, store),
      mutateSettings((s) => { s.shareErrorReports = false }, store),
    ])
    expect((await getSettings(store))).toMatchObject({ shareAnalytics: false, shareErrorReports: false })
  })

  it('an operation keeps its own snapshot, but a write at its stale revision is refused', async () => {
    await mutateSettings((s) => { s.app = { ...s.app, theme: 'dark' } }, store)
    const earlier = await readSettingsSnapshot(store)
    await mutateSettings((s) => { s.app = { ...s.app, theme: 'light' } }, store)
    // The earlier operation's value is its own copy…
    expect(earlier.settings.app?.theme).toBe('dark')
    // …the next operation reads the committed state…
    expect((await getSettings(store)).app?.theme).toBe('light')
    // …and a write at the stale revision cannot overwrite the newer one.
    expect(await store.compareAndSet(SETTINGS_RECORD_KEY, earlier.revision, JSON.stringify(earlier.settings))).toBe(false)
    expect((await getSettings(store)).app?.theme).toBe('light')
  })

  it('returning false writes nothing', async () => {
    await mutateSettings((s) => { s.shareAnalytics = false }, store)
    const result = await updateSettings(() => false, store)
    expect(result.written).toBe(false)
    expect(result.after).toBe(result.before)
    expect((await storedJson())?.revision).toBe(1)
  })

  it('gives `before` as read and `after` as written', async () => {
    await mutateSettings((s) => { s.app = { ...s.app, theme: 'dark' } }, store)
    const { before, after, written } = await updateSettings((draft) => { draft.app = { ...draft.app, theme: 'light' } }, store)
    expect(written).toBe(true)
    expect(before.app?.theme).toBe('dark')
    expect(after.app?.theme).toBe('light')
  })

  it('gives up after losing every attempt instead of spinning', async () => {
    await mutateSettings((s) => { s.shareAnalytics = false }, store)
    vi.spyOn(store, 'compareAndSet').mockResolvedValue(false)
    await expect(mutateSettings((s) => { s.shareAnalytics = true }, store)).rejects.toThrow(SettingsWriteConflictError)
  })

  it('a first-run nested mutation does not pollute the defaults', async () => {
    const before = structuredClone(DEFAULT_SETTINGS)
    await mutateSettings((s) => {
      s.container.resourceLimits.cpu = 99
      s.skillsets!.push({ id: 'x' } as never)
    }, store)
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
    const storeA = dbAppRecordStore(a.db)
    const storeB = dbAppRecordStore(b.db)
    // Warm both.
    expect((await getSettings(storeA)).app?.autoSleepTimeoutMinutes).toBe(30)
    expect((await getSettings(storeB)).app?.autoSleepTimeoutMinutes).toBe(30)

    await mutateSettings((s) => { s.app = { ...s.app, autoSleepTimeoutMinutes: 5 } }, storeA)
    const committed = await readSettingsSnapshot(storeA)

    const seenByB = await readSettingsSnapshot(storeB)
    expect(seenByB.revision).toBe(committed.revision)
    expect(seenByB.settings.app?.autoSleepTimeoutMinutes).toBe(5)

    // B's write builds on A's, and A sees it.
    await mutateSettings((s) => { s.shareAnalytics = false }, storeB)
    expect(await getSettings(storeA)).toMatchObject({ shareAnalytics: false, app: { autoSleepTimeoutMinutes: 5 } })
  })

  it('concurrent writers on the two handles lose nothing', async () => {
    const storeA = dbAppRecordStore(a.db)
    const storeB = dbAppRecordStore(b.db)
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        mutateSettings((s) => { s.customEnvVars = { ...s.customEnvVars, [`K${i}`]: String(i) } }, i % 2 ? storeA : storeB),
      ),
    )
    expect(Object.keys((await getSettings(storeA)).customEnvVars ?? {}).sort()).toEqual(['K0', 'K1', 'K2', 'K3', 'K4', 'K5'])
  })
})
