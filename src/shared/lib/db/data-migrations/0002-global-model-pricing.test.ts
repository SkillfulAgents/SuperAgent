import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase, type TestDatabase } from '../testing/create-test-database'
import * as settings from '../../config/settings'
import { dataMigrations } from '../schema'
import { runDataMigrations } from './index'
import { globalModelPricing } from './0002-global-model-pricing'
let handle: TestDatabase
let dir: string
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'global-prices-'))
  vi.stubEnv('SUPERAGENT_DATA_DIR', dir)
  settings.clearSettingsCache()
  handle = await createTestDatabase()
})
afterEach(async () => {
  await handle.close()
  settings.clearSettingsCache()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})
it('imports once, preserves existing global rates, and removes provider-owned prices', async () => {
  settings.mutateSettings((s) => {
    s.modelCatalog = {
      generic: {
        overrides: [
          { id: 'custom-model', label: 'Custom', pricing: { inputPerMtok: 1, outputPerMtok: 2 } },
        ],
      },
    }
    s.modelPricing = { 'custom-model': { inputPerMtok: 3, outputPerMtok: 4 } }
  })
  expect(await runDataMigrations(handle.db, [globalModelPricing])).toEqual([2])
  expect(settings.getSettings().modelPricing).toEqual({
    'custom-model': { inputPerMtok: 3, outputPerMtok: 4 },
  })
  expect(settings.getSettings().modelCatalog?.generic.overrides).toEqual([
    { id: 'custom-model', label: 'Custom' },
  ])
  expect(await runDataMigrations(handle.db, [globalModelPricing])).toEqual([])
})
it('leaves a failed move unrecorded and retries without losing prices', async () => {
  settings.mutateSettings((s) => {
    s.modelCatalog = {
      generic: {
        overrides: [{ id: 'custom-model', pricing: { inputPerMtok: 1, outputPerMtok: 2 } }],
      },
    }
  })
  vi.spyOn(settings, 'mutateSettings').mockImplementationOnce(() => {
    throw new Error('disk write failed')
  })
  await expect(runDataMigrations(handle.db, [globalModelPricing])).rejects.toThrow(
    'disk write failed',
  )
  expect(await handle.db.select().from(dataMigrations).all()).toEqual([])
  expect(await runDataMigrations(handle.db, [globalModelPricing])).toEqual([2])
  expect(settings.getSettings().modelPricing?.['custom-model'].inputPerMtok).toBe(1)
})
it('completes on an empty install without creating settings', async () => {
  expect(await runDataMigrations(handle.db, [globalModelPricing])).toEqual([2])
  expect(settings.getSettings().modelPricing ?? {}).toEqual({})
})
