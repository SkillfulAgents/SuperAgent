import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import { dataMigrations, llmConnections } from '../db/schema'
import { getSettings, mutateSettings } from '../config/settings'
import { SETTINGS_RECORD_KEY } from '../app-records/record-schemas'
import { installTestAppRecordStore, MemoryAppRecordStore } from '../app-records/testing/memory-record-store'
import { uninstallAppRecordStore } from '../app-records/records'
import { ensureManagedPlatformConnection, syncProviderSettings } from './connection-settings'
import { getConnection, listConnections, providerForConnection, resolveExecutionSelection, resolveHelperSelection, saveConnection, setGlobalSelection } from './connections'

const state = vi.hoisted(() => ({ db: null as TestDatabase['db'] | null }))
vi.mock('../db', () => ({ get db() { return state.db } }))

let handle: TestDatabase
let records: MemoryAppRecordStore
beforeEach(async () => {
  vi.stubEnv('AUTH_MODE', 'true')
  vi.stubEnv('PLATFORM_TOKEN', 'platform-bootstrap-test-token')
  // Provisioning is local and must not call a paid service.
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request') }))
  records = new MemoryAppRecordStore()
  installTestAppRecordStore(records)
  // Schema only: deliberately never run legacy data migrations in this suite.
  handle = await createTestDatabase()
  state.db = handle.db
})
afterEach(async () => {
  await handle.close()
  uninstallAppRecordStore()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function seedHostedSettings() {
  // Provider-related seed used by gamut-infra, before the first app boot.
  records.rows.set(SETTINGS_RECORD_KEY, { revision: 1, value: JSON.stringify({
    llmProvider: 'platform',
    app: { hostBrowserProvider: 'platform', setupCompleted: true },
    voice: { sttProvider: 'platform' },
    container: { containerRunner: 'lambda-microvm' },
  }) })
}

it('provisions a hosted install without any legacy data migration', async () => {
  seedHostedSettings()
  await ensureManagedPlatformConnection()

  const rows = await handle.db.select().from(llmConnections).all()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ id: 'legacy-platform', userId: null, managed: true, modelOverrides: '[]' })
  expect(JSON.stringify(rows)).not.toContain('platform-bootstrap-test-token')
  expect(await providerForConnection(rows[0]).getEffectiveApiKey()).toBe('platform-bootstrap-test-token')
  expect(await getSettings()).toMatchObject({
    llmDefault: { llmProviderId: rows[0].id, model: 'sonnet' },
    llmSummarizer: { llmProviderId: rows[0].id, model: 'haiku' },
    app: { setupCompleted: true },
    container: { containerRunner: 'lambda-microvm' },
  })
  expect(await resolveExecutionSelection()).toMatchObject({ llmProviderId: rows[0].id, model: 'sonnet' })
  expect(await resolveHelperSelection()).toMatchObject({ llmProviderId: rows[0].id, model: 'haiku' })
  expect((await listConnections({ userId: null, admin: true }))[0].canDelete).toBe(false)
  expect((await getSettings()).llmLegacyProviderId).toBeUndefined()
  expect(await handle.db.select().from(dataMigrations).all()).toEqual([])
})

it('preserves edited providers and defaults on subsequent startup and picks up rotated tokens', async () => {
  seedHostedSettings()
  await ensureManagedPlatformConnection()
  await saveConnection({ name: 'Our Platform', provider: 'platform', config: {}, browserModel: 'opus' },
    { userId: null, admin: true }, 'legacy-platform')
  await setGlobalSelection('default', { llmProviderId: 'legacy-platform', model: 'opus' })
  await setGlobalSelection('summarizer', null)
  const before = await getConnection('legacy-platform')
  vi.stubEnv('PLATFORM_TOKEN', 'rotated-bootstrap-test-token')
  await ensureManagedPlatformConnection()

  const rows = await handle.db.select().from(llmConnections).all()
  expect(rows).toEqual([before])
  expect((await getSettings()).llmDefault).toEqual({ llmProviderId: 'legacy-platform', model: 'opus' })
  expect((await getSettings()).llmSummarizer).toBeNull()
  expect(await providerForConnection(rows[0]).getEffectiveApiKey()).toBe('rotated-bootstrap-test-token')
})

it('does not provision without credentials and supports credentials supplied after first boot', async () => {
  seedHostedSettings()
  vi.stubEnv('PLATFORM_TOKEN', '')
  await ensureManagedPlatformConnection()
  expect(await handle.db.select().from(llmConnections).all()).toEqual([])
  expect((await getSettings()).llmDefault).toBeUndefined()
  vi.stubEnv('PLATFORM_TOKEN', 'late-bootstrap-test-token')
  await ensureManagedPlatformConnection()
  expect(await resolveExecutionSelection()).toMatchObject({ llmProviderId: 'legacy-platform', model: 'sonnet' })
  expect(await resolveHelperSelection()).toMatchObject({ llmProviderId: 'legacy-platform', model: 'haiku' })
})

it('onboards a direct provider without migrations and preserves its defaults when Platform connects', async () => {
  await mutateSettings(s => {
    s.llmProvider = 'anthropic'
    s.apiKeys = { anthropicApiKey: 'onboarding-test-key' }
  })
  await syncProviderSettings({ providers: ['anthropic'], apiKeys: (await getSettings()).apiKeys, selectDefault: true })
  const settled = await getSettings()
  const before = { default: settled.llmDefault, summarizer: settled.llmSummarizer }
  await ensureManagedPlatformConnection()
  expect((await getSettings()).llmDefault).toEqual(before.default)
  expect((await getSettings()).llmSummarizer).toEqual(before.summarizer)
  expect(await resolveExecutionSelection()).toMatchObject({ llmProviderId: 'legacy-anthropic' })
  expect(await resolveHelperSelection()).toMatchObject({ llmProviderId: 'legacy-anthropic', model: 'haiku' })
  expect(await handle.db.select().from(llmConnections).all()).toHaveLength(2)
  expect(await handle.db.select().from(dataMigrations).all()).toEqual([])
})
