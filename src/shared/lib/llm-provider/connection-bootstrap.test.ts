import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import { dataMigrations, llmConnections } from '../db/schema'
import { clearSettingsCache, getSettings, mutateSettings } from '../config/settings'
import { ensureManagedPlatformConnection, syncProviderSettings } from './connection-settings'
import { getConnection, listConnections, providerForConnection, resolveExecutionSelection, resolveHelperSelection, saveConnection, setGlobalSelection } from './connections'

const state = vi.hoisted(() => ({ db: null as TestDatabase['db'] | null }))
vi.mock('../db', () => ({ get db() { return state.db } }))

let handle: TestDatabase
let dataDir: string
beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'llm-bootstrap-'))
  vi.stubEnv('SUPERAGENT_DATA_DIR', dataDir)
  vi.stubEnv('AUTH_MODE', 'true')
  vi.stubEnv('PLATFORM_TOKEN', 'platform-bootstrap-test-token')
  // Provisioning is local and must not call a paid service.
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request') }))
  clearSettingsCache()
  // Schema only: deliberately never run legacy data migrations in this suite.
  handle = await createTestDatabase()
  state.db = handle.db
})
afterEach(async () => {
  await handle.close()
  clearSettingsCache()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(dataDir, { recursive: true, force: true })
})

function seedHostedSettings() {
  // Provider-related seed used by gamut-infra, before the first app boot.
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
    llmProvider: 'platform',
    app: { hostBrowserProvider: 'platform', setupCompleted: true },
    voice: { sttProvider: 'platform' },
    container: { containerRunner: 'lambda-microvm' },
  }))
}

it('provisions a hosted install without any legacy data migration', async () => {
  seedHostedSettings()
  await ensureManagedPlatformConnection()

  const rows = await handle.db.select().from(llmConnections).all()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ id: 'legacy-platform', userId: null, managed: true, modelOverrides: '[]' })
  expect(JSON.stringify(rows)).not.toContain('platform-bootstrap-test-token')
  expect(providerForConnection(rows[0]).getEffectiveApiKey()).toBe('platform-bootstrap-test-token')
  expect(getSettings()).toMatchObject({
    llmDefault: { llmProviderId: rows[0].id, model: 'grok' },
    llmSummarizer: { llmProviderId: rows[0].id, model: 'haiku' },
    app: { setupCompleted: true },
    container: { containerRunner: 'lambda-microvm' },
  })
  expect(await resolveExecutionSelection()).toMatchObject({ llmProviderId: rows[0].id, model: 'grok' })
  expect(await resolveHelperSelection()).toMatchObject({ llmProviderId: rows[0].id, model: 'haiku' })
  expect((await listConnections({ userId: null, admin: true }))[0].canDelete).toBe(false)
  expect(getSettings().llmLegacyProviderId).toBeUndefined()
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
  clearSettingsCache()
  vi.stubEnv('PLATFORM_TOKEN', 'rotated-bootstrap-test-token')
  await ensureManagedPlatformConnection()

  const rows = await handle.db.select().from(llmConnections).all()
  expect(rows).toEqual([before])
  expect(getSettings().llmDefault).toEqual({ llmProviderId: 'legacy-platform', model: 'opus' })
  expect(getSettings().llmSummarizer).toBeNull()
  expect(providerForConnection(rows[0]).getEffectiveApiKey()).toBe('rotated-bootstrap-test-token')
})

it('does not provision without credentials and supports credentials supplied after first boot', async () => {
  seedHostedSettings()
  vi.stubEnv('PLATFORM_TOKEN', '')
  await ensureManagedPlatformConnection()
  expect(await handle.db.select().from(llmConnections).all()).toEqual([])
  expect(getSettings().llmDefault).toBeUndefined()
  vi.stubEnv('PLATFORM_TOKEN', 'late-bootstrap-test-token')
  await ensureManagedPlatformConnection()
  expect(await resolveExecutionSelection()).toMatchObject({ llmProviderId: 'legacy-platform', model: 'grok' })
  expect(await resolveHelperSelection()).toMatchObject({ llmProviderId: 'legacy-platform', model: 'haiku' })
})

it('onboards a direct provider without migrations and preserves its defaults when Platform connects', async () => {
  mutateSettings(s => {
    s.llmProvider = 'anthropic'
    s.apiKeys = { anthropicApiKey: 'onboarding-test-key' }
  })
  await syncProviderSettings({ providers: ['anthropic'], apiKeys: getSettings().apiKeys, selectDefault: true })
  const before = { default: getSettings().llmDefault, summarizer: getSettings().llmSummarizer }
  await ensureManagedPlatformConnection()
  expect(getSettings().llmDefault).toEqual(before.default)
  expect(getSettings().llmSummarizer).toEqual(before.summarizer)
  expect(await resolveExecutionSelection()).toMatchObject({ llmProviderId: 'legacy-anthropic' })
  expect(await resolveHelperSelection()).toMatchObject({ llmProviderId: 'legacy-anthropic', model: 'haiku' })
  expect(await handle.db.select().from(llmConnections).all()).toHaveLength(2)
  expect(await handle.db.select().from(dataMigrations).all()).toEqual([])
})
