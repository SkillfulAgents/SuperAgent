import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { createTestDatabase, type TestDatabase } from '../testing/create-test-database'
import { getDb } from '../open-database'
import { dataMigrations, llmConnections, scheduledTasks, webhookTriggers, chatIntegrations } from '../schema'
import * as settings from '../../config/settings'
import { dbAppRecordStore, type AppRecordStore } from '../../app-records/record-store'
import { uninstallAppRecordStore } from '../../app-records/records'
import { DATA_MIGRATIONS, runDataMigrations } from './index'
import { importLlmConnections } from './0003-import-llm-connections'

let handle: TestDatabase
let dataDir: string
/** The settings on the migration's handle: what the app reads once it boots. */
let store: AppRecordStore
const migrations = [importLlmConnections]
beforeEach(async () => {
  // As at boot, no global record store (the test setup installs one): a
  // migration that read it instead of its own handle would throw.
  uninstallAppRecordStore()
  dataDir = mkdtempSync(join(tmpdir(), 'llm-migration-'))
  vi.stubEnv('SUPERAGENT_DATA_DIR', dataDir)
  vi.stubEnv('AUTH_MODE', 'false')
  for (const key of ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GENERIC_API_KEY', 'GENERIC_BASE_URL', 'PLATFORM_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION']) vi.stubEnv(key, '')
  handle = await createTestDatabase()
  store = dbAppRecordStore(handle.db)
})
afterEach(async () => {
  await handle.close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(dataDir, { recursive: true, force: true })
})

const legacyProviderSettings = {
  llmProvider: 'anthropic',
  apiKeys: { anthropicApiKey: 'saved-test-key' },
  models: {
    agentModel: 'claude-archived-1', summarizerModel: 'haiku',
    browserModel: 'sonnet', dashboardBuilderModel: 'sonnet',
  },
} as const

/** Provider settings already in the database (an install past the host-records import). */
async function configure() {
  await settings.mutateSettings((s) => {
    s.llmProvider = legacyProviderSettings.llmProvider
    s.apiKeys = { ...legacyProviderSettings.apiKeys }
    s.models = { ...legacyProviderSettings.models }
  }, store)
}

const read = () => settings.getSettings(store)

describe('import-llm-connections data migration', () => {
  it('is registered and imports a legacy settings file and all SQL references before the global database is published', async () => {
    expect(DATA_MIGRATIONS).toContain(importLlmConnections)
    expect(() => getDb()).toThrow()
    // An install that skips versions still has its settings in the data dir.
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(legacyProviderSettings))
    vi.stubEnv('OPENROUTER_API_KEY', 'environment-test-key')
    const now = new Date()
    await handle.db.insert(scheduledTasks).values({
      id: 'task', agentSlug: 'agent', scheduleType: 'at', scheduleExpression: 'tomorrow',
      prompt: 'hello', nextExecutionAt: now, createdAt: now, model: 'claude-task-1',
    }).run()
    await handle.db.insert(webhookTriggers).values({
      id: 'hook', agentSlug: 'agent', kind: 'custom', triggerType: 'test', prompt: 'hello',
      createdAt: now, model: 'claude-hook-1',
    }).run()
    await handle.db.insert(chatIntegrations).values({
      id: 'chat', agentSlug: 'agent', provider: 'telegram', config: '{}',
      createdAt: now, updatedAt: now, model: 'claude-chat-1',
    }).run()
    expect(await runDataMigrations(handle.db, migrations)).toEqual([3])
    const rows = await handle.db.select().from(llmConnections).all()
    expect(rows.map(row => row.id).sort()).toEqual(['legacy-anthropic'])
    // Ambient keys for unselected providers must not become member-selectable.
    expect(rows.find(row => row.id === 'legacy-openrouter')).toBeUndefined()
    expect(JSON.stringify(rows)).not.toContain('environment-test-key')
    expect(await read()).toMatchObject({
      llmLegacyProviderId: 'legacy-anthropic',
      llmDefault: { llmProviderId: 'legacy-anthropic', model: 'claude-archived-1' },
      llmSummarizer: { llmProviderId: 'legacy-anthropic', model: 'haiku' },
    })
    for (const table of [scheduledTasks, webhookTriggers, chatIntegrations]) {
      const row = await handle.db.select({ model: table.model, llmProviderId: table.llmProviderId }).from(table).get()
      expect(row?.llmProviderId).toBe('legacy-anthropic')
      expect(rows.find(row => row.id === 'legacy-anthropic')?.modelOverrides).toContain(row!.model)
    }
    expect(await handle.db.select().from(dataMigrations).all()).toMatchObject([{ id: 3, name: 'import-llm-connections' }])
  })

  it('imports provider settings already in the database', async () => {
    await configure()
    expect(await runDataMigrations(handle.db, migrations)).toEqual([3])
    expect(await handle.db.select({ id: llmConnections.id }).from(llmConnections).all()).toEqual([{ id: 'legacy-anthropic' }])
    expect(await read()).toMatchObject({
      apiKeys: { anthropicApiKey: 'saved-test-key' },
      llmLegacyProviderId: 'legacy-anthropic',
      llmDefault: { llmProviderId: 'legacy-anthropic', model: 'claude-archived-1' },
      llmSummarizer: { llmProviderId: 'legacy-anthropic', model: 'haiku' },
    })
  })

  it('imports custom definitions and disabled IDs without copying built-ins', async () => {
    const { getLlmProvider } = await import('../../llm-provider')
    await configure()
    const builtins = getLlmProvider('anthropic').getBuiltinCatalog()
    const disabled = builtins.find(model => !model.isLatest)!
    const custom = { id: 'private-model', label: 'Private', supportedEfforts: ['low' as const], disabled: true }
    await settings.mutateSettings(s => { s.modelCatalog = { anthropic: { overrides: [
      { id: disabled.id, disabled: true }, custom,
    ] } } }, store)
    await runDataMigrations(handle.db, migrations)
    const row = (await handle.db.select().from(llmConnections).get())!
    expect(JSON.parse(row.modelOverrides)).toEqual(expect.arrayContaining([
      { id: disabled.id, disabled: true }, custom,
      { id: 'claude-archived-1', label: 'claude-archived-1', supportedEfforts: ['low', 'medium', 'high'] },
    ]))
    for (const entry of JSON.parse(row.modelOverrides)) {
      if (builtins.some(model => model.id === entry.id)) expect(Object.keys(entry).sort()).toEqual(['disabled', 'id'])
    }
  })

  it('uses the ledger to skip subsequent imports, including after a connection is deleted', async () => {
    await configure()
    await runDataMigrations(handle.db, migrations)
    await handle.db.delete(llmConnections).run()
    expect(await runDataMigrations(handle.db, migrations)).toEqual([])
    expect(await handle.db.select().from(llmConnections).all()).toEqual([])
  })

  it('retries an interrupted import without overwriting existing rows', async () => {
    await configure()
    vi.spyOn(settings, 'mutateSettings').mockRejectedValueOnce(new Error('interrupted settings write'))
    await expect(runDataMigrations(handle.db, migrations)).rejects.toThrow('interrupted settings write')
    expect(await handle.db.select().from(dataMigrations).all()).toEqual([])
    const row = await handle.db.select().from(llmConnections).get()
    expect(row?.id).toBe('legacy-anthropic')
    await handle.db.update(llmConnections).set({ name: 'Retained name' }).where(eq(llmConnections.id, row!.id)).run()
    expect(await runDataMigrations(handle.db, migrations)).toEqual([3])
    expect(await handle.db.select().from(llmConnections).all()).toMatchObject([{ name: 'Retained name' }])
    expect((await read()).llmDefault?.model).toBe('claude-archived-1')
  })

  it('records completion on a fresh install with no configured provider', async () => {
    expect(await runDataMigrations(handle.db, migrations)).toEqual([3])
    expect(await handle.db.select().from(llmConnections).all()).toEqual([])
    expect((await read()).llmDefault).toBeUndefined()
    await configure()
    // Configuring an account later belongs to the explicit onboarding write.
    expect(await runDataMigrations(handle.db, migrations)).toEqual([])
    expect(await handle.db.select().from(llmConnections).all()).toEqual([])
  })

  it('tolerates a retry after settings were written, preserving explicit defaults', async () => {
    await configure()
    await importLlmConnections.run(handle.db)
    await settings.mutateSettings(s => {
      s.llmDefault = { llmProviderId: 'legacy-anthropic', model: 'haiku' }
      s.llmSummarizer = null
    }, store)
    await importLlmConnections.run(handle.db)
    expect(await handle.db.select().from(llmConnections).all()).toHaveLength(1)
    expect((await read()).llmDefault?.model).toBe('haiku')
    expect((await read()).llmSummarizer).toBeNull()
  })
})


it('moves provider overrides to the imported connection and retains shared tool variables', async () => {
  await configure()
  await settings.mutateSettings(s => { s.customEnvVars = {
    ANTHROPIC_BASE_URL: 'https://old-proxy.example', ANTHROPIC_AUTH_TOKEN: 'old-bearer',
    AWS_ACCESS_KEY_ID: 'tool-key', AWS_REGION: 'eu-west-1', TOOL_SETTING: 'keep',
  } }, store)
  await runDataMigrations(handle.db, migrations)
  const row = (await handle.db.select().from(llmConnections).get())!
  expect(JSON.parse(row.config).runtimeEnv).toEqual({ ANTHROPIC_BASE_URL: 'https://old-proxy.example', ANTHROPIC_AUTH_TOKEN: 'old-bearer' })
  expect((await read()).customEnvVars).toEqual({ AWS_ACCESS_KEY_ID: 'tool-key', AWS_REGION: 'eu-west-1', TOOL_SETTING: 'keep' })
  await runDataMigrations(handle.db, migrations)
  expect((await handle.db.select().from(llmConnections).get())!.config).toBe(row.config)
})
