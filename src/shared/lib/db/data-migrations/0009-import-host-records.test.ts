import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase, type TestDatabase } from '../testing/create-test-database'
import { dataMigrations } from '../schema'
import { runDataMigrations } from './index'
import { importHostRecords } from './0009-import-host-records'
import { globalModelPricing } from './0002-global-model-pricing'
import { listStoredRecords, readStoredRecord } from '@shared/lib/app-records/records'
import {
  AUTH_SECRET_RECORD_KEY,
  PLATFORM_CLIENT_INSTANCE_ID_RECORD_KEY,
  SETTINGS_RECORD_KEY,
  TENANT_ID_RECORD_KEY,
  browserContextKey,
  hostContainerTokenKey,
} from '@shared/lib/app-records/record-schemas'
import { getSettings, mutateSettings } from '@shared/lib/config/settings'
import { getTenantId } from '@shared/lib/analytics/tenant-id'
import { getOrCreateAuthSecret } from '@shared/lib/auth/secret'
import { getOrCreateHostToken } from '@shared/lib/container/host-token-store'

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException }))

const SECRET = 'a-legacy-auth-secret-that-is-long-enough='
const TENANT = '7d1f4c1e-6a55-4d55-9a0b-1f0f2a3b4c5d'

/** The migration's handle; its records are what the app reads once it boots. */
let handle: TestDatabase
let dir: string

beforeEach(async () => {
  // Nothing opens the app database here and `@shared/lib/db` is not mocked:
  // a migration that read it instead of its own handle would throw.
  dir = fs.mkdtempSync(join(tmpdir(), 'host-records-import-'))
  vi.stubEnv('SUPERAGENT_DATA_DIR', dir)
  vi.stubEnv('BETTER_AUTH_SECRET', '')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  handle = await createTestDatabase()
  captureException.mockClear()
})
afterEach(async () => {
  await handle.close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fs.rmSync(dir, { recursive: true, force: true })
})

function writeLegacy(file: string, content: string) {
  fs.mkdirSync(join(dir, file, '..'), { recursive: true })
  fs.writeFileSync(join(dir, file), content)
}

function writeAllLegacyFiles() {
  writeLegacy('settings.json', JSON.stringify({ app: { theme: 'dark' }, apiKeys: { anthropicApiKey: 'sk-legacy' } }, null, 2))
  writeLegacy('tenant-id', `${TENANT}\n`)
  writeLegacy('.auth-secret', SECRET)
  writeLegacy('host-container-tokens.json', JSON.stringify({ alpha: 'hostc_alpha', beta: 'hostc_beta' }))
  writeLegacy('.platform-auth/client-instance-id', 'client-instance-1\n')
  writeLegacy('browserbase-contexts.json', JSON.stringify({ 'instance-1': 'ctx-bb' }))
  writeLegacy('platform-browserbase-contexts.json', JSON.stringify({ 'org:agent': 'ctx-platform' }))
}

async function value(key: string): Promise<unknown> {
  const row = await readStoredRecord(key, handle.db)
  return row && JSON.parse(row.value)
}

describe('import-host-records', () => {
  it('a fresh install has nothing to import and is recorded', async () => {
    expect(await runDataMigrations(handle.db, [importHostRecords])).toEqual([9])
    expect(await listStoredRecords('', handle.db)).toEqual([])
  })

  it('imports every file of the manifest unchanged and leaves the files in place', async () => {
    writeAllLegacyFiles()
    const before = fs.readFileSync(join(dir, 'settings.json'), 'utf-8')

    expect(await runDataMigrations(handle.db, [importHostRecords])).toEqual([9])

    expect(await value(SETTINGS_RECORD_KEY)).toEqual({ app: { theme: 'dark' }, apiKeys: { anthropicApiKey: 'sk-legacy' } })
    expect(await value(TENANT_ID_RECORD_KEY)).toBe(TENANT)
    expect(await value(AUTH_SECRET_RECORD_KEY)).toBe(SECRET)
    expect(await value(hostContainerTokenKey('alpha'))).toBe('hostc_alpha')
    expect(await value(hostContainerTokenKey('beta'))).toBe('hostc_beta')
    expect(await value(PLATFORM_CLIENT_INSTANCE_ID_RECORD_KEY)).toBe('client-instance-1')
    expect(await value(browserContextKey('browserbase', 'instance-1'))).toBe('ctx-bb')
    expect(await value(browserContextKey('platform', 'org:agent'))).toBe('ctx-platform')
    expect(fs.readFileSync(join(dir, 'settings.json'), 'utf-8')).toBe(before)

    // The app reads the imported values, and the getters return them rather than new ones.
    expect((await getSettings(handle.db)).app?.theme).toBe('dark')
    expect(await getTenantId(handle.db)).toBe(TENANT)
    expect(await getOrCreateAuthSecret(handle.db)).toBe(SECRET)
    expect(await getOrCreateHostToken('alpha', handle.db)).toBe('hostc_alpha')
  })

  it('a retry never overwrites a value imported or edited since', async () => {
    writeAllLegacyFiles()
    await importHostRecords.run(handle.db)
    await mutateSettings((s) => { s.app = { ...s.app, theme: 'light' } }, handle.db)
    // The ledger row was never written (a crash after run()): the next boot runs it again.
    expect(await handle.db.select().from(dataMigrations).all()).toEqual([])
    expect(await runDataMigrations(handle.db, [importHostRecords])).toEqual([9])
    expect((await getSettings(handle.db)).app?.theme).toBe('light')
    expect(await value(TENANT_ID_RECORD_KEY)).toBe(TENANT)
  })

  it('a read error fails the migration unrecorded, and the next boot finishes it', async () => {
    writeAllLegacyFiles()
    const readFile = fs.promises.readFile
    vi.spyOn(fs.promises, 'readFile').mockImplementation(async (file, options) => {
      if (String(file).endsWith('host-container-tokens.json')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      return readFile(file, options)
    })
    await expect(runDataMigrations(handle.db, [importHostRecords])).rejects.toThrow('EACCES')
    expect(await handle.db.select().from(dataMigrations).all()).toEqual([])
    // What was imported before the failure is already there.
    expect(await value(TENANT_ID_RECORD_KEY)).toBe(TENANT)

    vi.mocked(fs.promises.readFile).mockRestore()
    expect(await runDataMigrations(handle.db, [importHostRecords])).toEqual([9])
    expect(await value(hostContainerTokenKey('alpha'))).toBe('hostc_alpha')
  })

  it('skips and reports a file it cannot parse, keeps it on disk, and imports the rest', async () => {
    writeAllLegacyFiles()
    writeLegacy('settings.json', '{"app": {"theme": "da')
    writeLegacy('host-container-tokens.json', '["not", "a", "map"]')
    writeLegacy('.auth-secret', 'short')
    writeLegacy('tenant-id', '   \n')

    expect(await runDataMigrations(handle.db, [importHostRecords])).toEqual([9])

    for (const key of [SETTINGS_RECORD_KEY, AUTH_SECRET_RECORD_KEY, TENANT_ID_RECORD_KEY, hostContainerTokenKey('alpha')]) {
      expect(await readStoredRecord(key, handle.db)).toBeNull()
    }
    expect(await value(PLATFORM_CLIENT_INSTANCE_ID_RECORD_KEY)).toBe('client-instance-1')
    expect(fs.readFileSync(join(dir, 'settings.json'), 'utf-8')).toBe('{"app": {"theme": "da')
    expect(captureException).toHaveBeenCalledTimes(4)
    // The old readers fell back for these files too: defaults, and new identities on first use.
    expect((await getSettings(handle.db)).app?.theme).toBeUndefined()
    expect((await getOrCreateAuthSecret(handle.db)).length).toBeGreaterThanOrEqual(32)
  })

  it('an install that skips versions: the pricing move works on the imported legacy settings', async () => {
    writeLegacy('settings.json', JSON.stringify({
      modelCatalog: { generic: { overrides: [{ id: 'custom-model', label: 'Custom', pricing: { inputPerMtok: 1, outputPerMtok: 2 } }] } },
    }))
    // Migration 2 runs before 9 and imports settings.json itself; 9 then finds it already there.
    expect(await runDataMigrations(handle.db, [globalModelPricing, importHostRecords])).toEqual([2, 9])
    const settings = await getSettings(handle.db)
    expect(settings.modelCatalog?.generic.overrides).toEqual([{ id: 'custom-model', label: 'Custom' }])
    expect(settings.modelPricing).toEqual({ 'custom-model': { inputPerMtok: 1, outputPerMtok: 2 } })
  })
})
