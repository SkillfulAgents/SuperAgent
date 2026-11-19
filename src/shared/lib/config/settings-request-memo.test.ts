/**
 * The settings read shared inside one API request: one read per request, and
 * the rules that keep it from being a cache (ends with the request, dropped by
 * a write, never used by a write, own copy per caller).
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'

let handle: TestDatabase
vi.mock('@shared/lib/db', () => ({
  get db() {
    return handle.db
  },
}))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))

import * as records from '@shared/lib/app-records/records'
import { compareAndSetRecord, readStoredRecord } from '@shared/lib/app-records/records'
import { SETTINGS_RECORD_KEY } from '@shared/lib/app-records/record-schemas'
import { getSettings, mutateSettings, updateSettings } from './settings'
import { runWithSettingsMemo, settingsWritten } from './settings-request-memo'

let reads: MockInstance<typeof records.readStoredRecord>

beforeEach(async () => {
  handle = await createTestDatabase()
  await mutateSettings((s) => { s.app = { ...s.app, theme: 'dark' } })
  reads = vi.spyOn(records, 'readStoredRecord')
})
afterEach(async () => {
  vi.restoreAllMocks()
  await handle.close()
})

/** Another process writes the theme straight into the record. */
async function writeElsewhere(theme: string): Promise<void> {
  const row = (await readStoredRecord(SETTINGS_RECORD_KEY))!
  const value = JSON.stringify({ ...JSON.parse(row.value), app: { theme } })
  expect(await compareAndSetRecord(SETTINGS_RECORD_KEY, row.revision, value)).toBe(true)
  reads.mockClear()
}

describe('outside a request', () => {
  it('every call reads the database', async () => {
    await getSettings()
    await getSettings()
    expect(reads).toHaveBeenCalledTimes(2)
  })
})

describe('inside a request', () => {
  it('sequential and concurrent calls share one read', async () => {
    await runWithSettingsMemo(async () => {
      const [a, b] = await Promise.all([getSettings(), getSettings()])
      const c = await getSettings()
      expect(a.app?.theme).toBe('dark')
      expect(b).toEqual(a)
      expect(c).toEqual(a)
    })
    expect(reads).toHaveBeenCalledTimes(1)
  })

  it('each caller gets its own copy: changing one does not reach the next', async () => {
    await runWithSettingsMemo(async () => {
      const first = await getSettings()
      first.app!.theme = 'light'
      first.customEnvVars = { LEAKED: '1' }
      const second = await getSettings()
      expect(second).not.toBe(first)
      expect(second.app).not.toBe(first.app)
      expect(second.app?.theme).toBe('dark')
      expect(second.customEnvVars).toBeUndefined()
    })
  })

  it('the next request reads again and sees what was written in between', async () => {
    await runWithSettingsMemo(async () => { await getSettings() })
    await writeElsewhere('light')
    await runWithSettingsMemo(async () => {
      expect((await getSettings()).app?.theme).toBe('light')
    })
    expect(reads).toHaveBeenCalledTimes(1)
  })

  it('concurrent requests do not share a read', async () => {
    await Promise.all([
      runWithSettingsMemo(async () => { await getSettings() }),
      runWithSettingsMemo(async () => { await getSettings() }),
    ])
    expect(reads).toHaveBeenCalledTimes(2)
  })

  it('an explicit database handle always reads', async () => {
    await runWithSettingsMemo(async () => {
      await getSettings()
      await getSettings(handle.db)
      await getSettings(handle.db)
    })
    expect(reads).toHaveBeenCalledTimes(3)
  })

  it('a read that fails is not kept: the next call reads again', async () => {
    await runWithSettingsMemo(async () => {
      reads.mockRejectedValueOnce(new Error('SQLITE_IOERR'))
      await expect(getSettings()).rejects.toThrow('SQLITE_IOERR')
      expect((await getSettings()).app?.theme).toBe('dark')
    })
    expect(reads).toHaveBeenCalledTimes(2)
  })
})

describe('writes', () => {
  it('a write in the request drops the shared read: the next call sees the write', async () => {
    await runWithSettingsMemo(async () => {
      expect((await getSettings()).app?.theme).toBe('dark')
      await mutateSettings((s) => { s.app = { ...s.app, theme: 'light' } })
      expect((await getSettings()).app?.theme).toBe('light')
      // ...and that read is shared again.
      reads.mockClear()
      await getSettings()
      expect(reads).not.toHaveBeenCalled()
    })
  })

  it('a write never starts from the shared read: the mutator sees the stored settings', async () => {
    await runWithSettingsMemo(async () => {
      await getSettings()
      await writeElsewhere('light')
      // The request still holds the settings it read...
      expect((await getSettings()).app?.theme).toBe('dark')
      expect(reads).not.toHaveBeenCalled()
      // ...but its write is applied to what is stored now.
      const seen: Array<string | undefined> = []
      const { before, after } = await updateSettings((draft) => {
        seen.push(draft.app?.theme)
        draft.shareAnalytics = false
      })
      expect(seen).toEqual(['light'])
      expect(before.app?.theme).toBe('light')
      expect(after.app?.theme).toBe('light')
      expect((await getSettings()).app?.theme).toBe('light')
    })
  })

  it('an update that writes nothing keeps the shared read', async () => {
    await runWithSettingsMemo(async () => {
      await getSettings()
      await updateSettings(() => false)
      reads.mockClear()
      await getSettings()
      expect(reads).not.toHaveBeenCalled()
    })
  })

  it('a write made by another request of this process makes the shared read stale', async () => {
    let wrote!: () => void
    const written = new Promise<void>((resolve) => { wrote = resolve })
    let readFirst!: () => void
    const firstRead = new Promise<void>((resolve) => { readFirst = resolve })

    const reader = runWithSettingsMemo(async () => {
      expect((await getSettings()).app?.theme).toBe('dark')
      readFirst()
      await written
      return (await getSettings()).app?.theme
    })
    const writer = runWithSettingsMemo(async () => {
      await firstRead
      await mutateSettings((s) => { s.app = { ...s.app, theme: 'light' } })
      wrote()
    })
    await writer
    expect(await reader).toBe('light')
  })

  it('a read still in flight when a write lands is not served afterwards', async () => {
    await runWithSettingsMemo(async () => {
      const real = records.readStoredRecord
      let release!: () => void
      const held = new Promise<void>((resolve) => { release = resolve })
      // The first read gets the row as it was, and answers only after the write.
      reads.mockImplementationOnce(async (key, on) => {
        const row = await real(key, on)
        await held
        return row
      })
      const early = getSettings()
      await mutateSettings((s) => { s.app = { ...s.app, theme: 'light' } })
      release()
      expect((await early).app?.theme).toBe('dark')
      expect((await getSettings()).app?.theme).toBe('light')
    })
  })

  it('settingsWritten() drops it for a write that bypasses updateSettings', async () => {
    await runWithSettingsMemo(async () => {
      await getSettings()
      await writeElsewhere('light')
      settingsWritten()
      expect((await getSettings()).app?.theme).toBe('light')
    })
  })
})

describe('after the request settles', () => {
  it('work the request left running reads the database every time', async () => {
    let go!: () => void
    const requestOver = new Promise<void>((resolve) => { go = resolve })
    let leftRunning!: Promise<string | undefined>

    await runWithSettingsMemo(async () => {
      expect((await getSettings()).app?.theme).toBe('dark')
      // A stream callback or fire-and-forget work: same async scope, outlives the handler.
      leftRunning = (async () => {
        await requestOver
        await getSettings()
        return (await getSettings()).app?.theme
      })()
    })

    await writeElsewhere('light')
    go()
    expect(await leftRunning).toBe('light')
    expect(reads).toHaveBeenCalledTimes(2)
  })

  it('a request that throws ends too', async () => {
    let go!: () => void
    const requestOver = new Promise<void>((resolve) => { go = resolve })
    let leftRunning!: Promise<void>

    await expect(runWithSettingsMemo(async () => {
      await getSettings()
      leftRunning = (async () => {
        await requestOver
        await getSettings()
        await getSettings()
      })()
      throw new Error('handler failed')
    })).rejects.toThrow('handler failed')

    reads.mockClear()
    go()
    await leftRunning
    expect(reads).toHaveBeenCalledTimes(2)
  })
})
