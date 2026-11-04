import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase, type TestDatabase } from '../testing/create-test-database'
import * as settings from '../../config/settings'
import { dbAppRecordStore, type AppRecordStore } from '../../app-records/record-store'
import { SETTINGS_RECORD_KEY } from '../../app-records/record-schemas'
import { isAppRecordStoreInstalled } from '../../app-records/records'
import { dataMigrations } from '../schema'
import { runDataMigrations } from './index'
import { globalModelPricing } from './0002-global-model-pricing'

let handle: TestDatabase
let dir: string
/** The settings on the migration's handle: what the app reads once it boots. */
let store: AppRecordStore
beforeEach(async () => {
  // As at boot, no global record store: a migration that read one would throw.
  expect(isAppRecordStoreInstalled()).toBe(false)
  dir = mkdtempSync(join(tmpdir(), 'global-prices-'))
  vi.stubEnv('SUPERAGENT_DATA_DIR', dir)
  handle = await createTestDatabase()
  store = dbAppRecordStore(handle.db)
})
afterEach(async () => {
  await handle.close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

it('imports a legacy settings file once, preserves existing global rates, and removes provider-owned prices', async () => {
  // An install that skips versions still has its settings in the data dir.
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({
    modelCatalog: {
      generic: {
        overrides: [
          { id: 'custom-model', label: 'Custom', pricing: { inputPerMtok: 1, outputPerMtok: 2 } },
        ],
      },
    },
    modelPricing: { 'custom-model': { inputPerMtok: 3, outputPerMtok: 4 } },
  }))
  expect(await runDataMigrations(handle.db, [globalModelPricing])).toEqual([2])
  const migrated = await settings.loadSettingsStrict(store)
  expect(migrated.modelPricing).toEqual({
    'custom-model': { inputPerMtok: 3, outputPerMtok: 4 },
  })
  expect(migrated.modelCatalog?.generic.overrides).toEqual([
    { id: 'custom-model', label: 'Custom' },
  ])
  expect(await runDataMigrations(handle.db, [globalModelPricing])).toEqual([])
})

it('moves prices out of settings already in the database', async () => {
  await settings.mutateSettings((s) => {
    s.modelCatalog = {
      generic: {
        overrides: [
          { id: 'custom-model', label: 'Custom', pricing: { inputPerMtok: 1, outputPerMtok: 2 } },
        ],
      },
    }
    s.modelPricing = { 'custom-model': { inputPerMtok: 3, outputPerMtok: 4 } }
  }, store)
  expect(await runDataMigrations(handle.db, [globalModelPricing])).toEqual([2])
  const migrated = await settings.loadSettingsStrict(store)
  expect(migrated.modelPricing).toEqual({ 'custom-model': { inputPerMtok: 3, outputPerMtok: 4 } })
  expect(migrated.modelCatalog?.generic.overrides).toEqual([{ id: 'custom-model', label: 'Custom' }])
})

it('leaves a failed move unrecorded and retries without losing prices', async () => {
  await settings.mutateSettings((s) => {
    s.modelCatalog = {
      generic: {
        overrides: [{ id: 'custom-model', pricing: { inputPerMtok: 1, outputPerMtok: 2 } }],
      },
    }
  }, store)
  vi.spyOn(settings, 'mutateSettings').mockRejectedValueOnce(new Error('settings write failed'))
  await expect(runDataMigrations(handle.db, [globalModelPricing])).rejects.toThrow(
    'settings write failed',
  )
  expect(await handle.db.select().from(dataMigrations).all()).toEqual([])
  expect(await runDataMigrations(handle.db, [globalModelPricing])).toEqual([2])
  expect((await settings.loadSettingsStrict(store)).modelPricing?.['custom-model'].inputPerMtok).toBe(1)
})

it('fails, unrecorded, on unreadable stored settings instead of recording an empty move', async () => {
  await settings.mutateSettings((s) => {
    s.modelCatalog = {
      generic: { overrides: [{ id: 'custom-model', pricing: { inputPerMtok: 1, outputPerMtok: 2 } }] },
    }
  }, store)
  const intact = (await store.read(SETTINGS_RECORD_KEY))!
  expect(await store.compareAndSet(SETTINGS_RECORD_KEY, intact.revision, intact.value.slice(0, 20))).toBe(true)

  await expect(runDataMigrations(handle.db, [globalModelPricing])).rejects.toThrow()
  expect(await handle.db.select().from(dataMigrations).all()).toEqual([])

  // Once the record reads again the move happens.
  expect(await store.compareAndSet(SETTINGS_RECORD_KEY, intact.revision + 1, intact.value)).toBe(true)
  expect(await runDataMigrations(handle.db, [globalModelPricing])).toEqual([2])
  expect((await settings.loadSettingsStrict(store)).modelPricing).toEqual({
    'custom-model': { inputPerMtok: 1, outputPerMtok: 2 },
  })
})

it('strips a legacy price that only restates the built-in rate without making it an override', async () => {
  const { pricingFor } = await import('../../llm-provider/model-pricing-lookup')
  const builtin = pricingFor('claude-opus-4-8')!
  await settings.mutateSettings((s) => {
    s.modelCatalog = {
      anthropic: {
        overrides: [
          {
            id: 'claude-opus-4-8',
            disabled: true,
            pricing: { inputPerMtok: builtin.inputPerMtok, outputPerMtok: builtin.outputPerMtok },
          },
        ],
      },
    }
  }, store)
  expect(await runDataMigrations(handle.db, [globalModelPricing])).toEqual([2])
  const migrated = await settings.loadSettingsStrict(store)
  expect(migrated.modelPricing).toEqual({})
  expect(migrated.modelCatalog?.anthropic.overrides).toEqual([
    { id: 'claude-opus-4-8', disabled: true },
  ])
})

it('completes on an empty install without creating settings', async () => {
  expect(await runDataMigrations(handle.db, [globalModelPricing])).toEqual([2])
  expect(await store.read(SETTINGS_RECORD_KEY)).toBeNull()
})
