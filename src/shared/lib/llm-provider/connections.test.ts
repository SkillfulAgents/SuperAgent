import { calculateCost } from '../services/usage-service'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import {
  llmConnections,
  user,
  scheduledTasks,
  webhookTriggers,
  chatIntegrations,
} from '../db/schema'
import type { AppSettings } from '../config/settings'
import { resolveSelection } from './connection-schema'
import { getLlmProvider } from './index'

const state = vi.hoisted(() => ({
  settings: {} as AppSettings,
  db: null as TestDatabase['db'] | null,
  platformToken: undefined as string | undefined,
}))
vi.mock('../db', () => ({
  get db() {
    return state.db
  },
}))
vi.mock('../config/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config/settings')>()),
  getSettings: () => state.settings,
  getModelCatalogSettings: () => state.settings.modelCatalog ?? {},
  getEffectiveModels: () => ({
    agentModel: 'opus',
    summarizerModel: 'haiku',
    browserModel: 'sonnet',
    dashboardBuilderModel: 'sonnet',
    ...state.settings.models,
  }),
  mutateSettings: (work: (s: AppSettings) => void) => work(state.settings),
}))
vi.mock('../services/platform-auth-service', () => ({
  getPlatformAccessToken: () => state.platformToken,
  getPlatformAuthStatus: () => ({ connected: false }),
}))
import {
  saveConnection,
  getConnection,
  providerForConnection,
  deleteConnection,
  setGlobalSelection,
  resolveExecutionSelection,
  resolveHelperSelection,
  resolveSelectionHierarchy,
  storedSelection,
  listConnections,
  connectionCatalog,
} from './connections'
import { importLlmConnections } from '../db/data-migrations/0003-import-llm-connections'
import { runDataMigrations } from '../db/data-migrations'
import { syncProviderSettings, ensureManagedPlatformConnection } from './connection-settings'
import { connectionRuntime, withSessionSelection } from './connection-runtime'

let handle: TestDatabase
const admin = { userId: null, admin: true }
const catalog = [
  { id: 'model-a', label: 'A', family: 'a', isLatest: true, supportedEfforts: ['low' as const] },
]
async function add(name = 'First', userId: string | null = null) {
  return saveConnection(
    {
      name,
      provider: 'generic',
      userId,
      config: {
        apiKeys: {
          genericApiKey: `key-${name}`,
          genericBaseUrl: `https://${name.toLowerCase()}.example`,
        },
      },
      modelOverrides: catalog,
    },
    { ...admin, userId }
  )
}
beforeEach(async () => {
  handle = await createTestDatabase()
  state.platformToken = undefined
  state.db = handle.db
  state.settings = {
    container: {
      containerRunner: 'docker',
      agentImage: 'test',
      resourceLimits: { cpu: 1, memory: '1g' },
    },
    llmLegacyProviderId: 'imported',
  }
  vi.stubEnv('AUTH_MODE', 'true')
})
afterEach(async () => {
  await handle.close()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('LLM connections', () => {
  it('stores no connection prices and reads one global rate across accounts and deletion', async () => {
    state.settings.modelPricing = { 'model-a': { inputPerMtok: 2, outputPerMtok: 3 } }
    const first = await add('First')
    const second = await add('Second')
    await saveConnection({ name: 'Second', provider: 'generic', config: {}, modelOverrides: [
      { ...catalog[0], pricing: { inputPerMtok: 99, outputPerMtok: 99 } },
    ] }, admin, second)
    const firstRow = (await getConnection(first))!
    const secondRow = (await getConnection(second))!
    expect(JSON.parse(secondRow.modelOverrides)[0]).not.toHaveProperty('pricing')
    expect(connectionCatalog(firstRow)[0].pricing).toEqual(connectionCatalog(secondRow)[0].pricing)
    expect(calculateCost('model-a', 1_000_000, 1_000_000, 0, 0)).toBe(5)
    state.settings.modelPricing['model-a'] = { inputPerMtok: 4, outputPerMtok: 6 }
    expect(connectionCatalog(firstRow)[0].pricing?.inputPerMtok).toBe(4)
    expect(connectionCatalog(secondRow)[0].pricing?.inputPerMtok).toBe(4)
    await deleteConnection(second, admin)
    expect(calculateCost('model-a', 1_000_000, 1_000_000, 0, 0)).toBe(10)
  })

  it('resolves aliases and clears the entire selection when either reference disappears', () => {
    expect(
      resolveSelection({ llmProviderId: 'one', model: 'a' }, [{ id: 'one', catalog }])?.wireModel
    ).toBe('model-a')
    expect(
      resolveSelection({ llmProviderId: 'missing', model: 'model-a' }, [{ id: 'one', catalog }])
    ).toBeNull()
    expect(
      resolveSelection({ llmProviderId: 'one', model: 'removed-4' }, [{ id: 'one', catalog }])
    ).toBeNull()
  })
  it('isolates two accounts of the same provider from ambient settings and each other', async () => {
    vi.stubEnv('GENERIC_API_KEY', 'ambient-secret')
    const [first, second] = [await add('First'), await add('Second')]
    const a = providerForConnection((await getConnection(first))!)
    const b = providerForConnection((await getConnection(second))!)
    expect(await a.getContainerEnvVars()).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: 'key-First',
      ANTHROPIC_BASE_URL: 'https://first.example',
    })
    expect(await b.getContainerEnvVars()).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: 'key-Second',
      ANTHROPIC_BASE_URL: 'https://second.example',
    })
    expect(a.getEffectiveApiKey()).toBe('key-First')
  })
  it('protects the global app default and its model, with ordinary missing overrides inheriting', async () => {
    const first = await add()
    await setGlobalSelection('default', { llmProviderId: first, model: 'a' })
    await expect(deleteConnection(first, admin)).rejects.toThrow('app default')
    await expect(
      saveConnection({ name: 'First', provider: 'generic', config: {}, modelOverrides: [] }, admin, first)
    ).rejects.toThrow('app default')
    expect(
      (await resolveExecutionSelection({ llmProviderId: 'gone', model: 'model-a' })).llmProviderId
    ).toBe(first)
    expect(storedSelection('a', null)).toBeNull()
    expect(storedSelection('a')).toEqual({ llmProviderId: 'imported', model: 'a' })
  })
  it('rejects personal defaults and only exposes another owner through the attached session', async () => {
    await state
      .db!.insert(user)
      .values({ id: 'alice', name: 'Alice', email: 'alice@example.com' })
      .run()
    const personal = await add('Personal', 'alice')
    await expect(
      setGlobalSelection('default', { llmProviderId: personal, model: 'a' })
    ).rejects.toThrow('global')
    await expect(
      setGlobalSelection('summarizer', { llmProviderId: personal, model: 'a' })
    ).rejects.toThrow('global')
    expect(await listConnections({ userId: 'bob', admin: false })).toEqual([])
    const attached = await listConnections({ userId: 'bob', admin: false }, personal)
    expect(attached[0]).toMatchObject({ ownerName: 'Alice', canManage: false })
    expect(JSON.stringify(attached)).not.toContain('key-Personal')
    await expect(deleteConnection(personal, { userId: 'bob', admin: true })).rejects.toThrow(
      'not found'
    )
  })
  it('cascades user deletion and SET NULL on all three automation references', async () => {
    await state
      .db!.insert(user)
      .values({ id: 'alice', name: 'Alice', email: 'alice@example.com' })
      .run()
    const personal = await add('Personal', 'alice')
    await state
      .db!.insert(scheduledTasks)
      .values({
        id: 'task',
        agentSlug: 'agent',
        scheduleType: 'at',
        scheduleExpression: 'tomorrow',
        prompt: 'hello',
        nextExecutionAt: new Date(),
        createdAt: new Date(),
        model: 'a',
        llmProviderId: personal,
      })
      .run()
    await state
      .db!.insert(webhookTriggers)
      .values({
        id: 'trigger',
        agentSlug: 'agent',
        kind: 'custom',
        triggerType: 'test',
        prompt: 'hello',
        createdAt: new Date(),
        model: 'a',
        llmProviderId: personal,
      })
      .run()
    await state
      .db!.insert(chatIntegrations)
      .values({
        id: 'chat',
        agentSlug: 'agent',
        provider: 'telegram',
        config: '{}',
        createdAt: new Date(),
        updatedAt: new Date(),
        model: 'a',
        llmProviderId: personal,
      })
      .run()
    await state.db!.delete(user).where(eq(user.id, 'alice')).run()
    expect(await getConnection(personal)).toBeNull()
    for (const table of [scheduledTasks, webhookTriggers, chatIntegrations]) {
      const row = await state
        .db!.select({ llmProviderId: table.llmProviderId, model: table.model })
        .from(table)
        .get()
      expect(row).toEqual({ llmProviderId: null, model: 'a' })
    }
  })
  it('imports legacy settings idempotently and preserves effective helper defaults and environment references', async () => {
    state.settings.llmLegacyProviderId = undefined
    state.settings.apiKeys = { anthropicApiKey: 'saved-key' }
    vi.stubEnv('ANTHROPIC_API_KEY', 'env-key')
    await runDataMigrations(handle.db, [importLlmConnections])
    await runDataMigrations(handle.db, [importLlmConnections])
    const rows = await state.db!.select().from(llmConnections).all()
    expect(rows).toHaveLength(1)
    expect(state.settings.llmDefault).toEqual({ llmProviderId: 'legacy-anthropic', model: 'opus' })
    expect(state.settings.llmSummarizer).toEqual({
      llmProviderId: 'legacy-anthropic',
      model: 'haiku',
    })
    expect(rows[0]).toMatchObject({ browserModel: 'sonnet', dashboardModel: 'sonnet' })
    expect(rows[0].config).not.toContain('env-key')
    expect(providerForConnection(rows[0]).getEffectiveApiKey()).toBe('saved-key')
  })
  it('does not recreate an imported connection after deletion', async () => {
    state.settings.llmLegacyProviderId = undefined
    state.settings.apiKeys = { anthropicApiKey: 'saved-key' }
    await runDataMigrations(handle.db, [importLlmConnections])
    const root = await add('Other')
    await setGlobalSelection('default', { llmProviderId: root, model: 'a' })
    await deleteConnection('legacy-anthropic', admin)
    await runDataMigrations(handle.db, [importLlmConnections])
    expect(await getConnection('legacy-anthropic')).toBeNull()
  })
})

it('uses session connection overrides and falls back to its main model when removed', async () => {
  const id = await add()
  await setGlobalSelection('default', { llmProviderId: id, model: 'a' })
  await state
    .db!.update(llmConnections)
    .set({ browserModel: 'gone', dashboardModel: 'a' })
    .where(eq(llmConnections.id, id))
    .run()
  const runtime = await connectionRuntime(await resolveExecutionSelection(), 'test-agent')
  expect(runtime).toMatchObject({
    llmProviderId: id,
    model: 'model-a',
    browserModel: 'model-a',
    dashboardBuilderModel: 'model-a',
  })
  expect(runtime.env).toMatchObject({
    ANTHROPIC_AUTH_TOKEN: 'key-First',
    CLAUDE_CODE_USE_BEDROCK: '',
  })
})

it('serializes edits for one session without serializing independent sessions', async () => {
  const order: string[] = []
  let release!: () => void
  const first = withSessionSelection('agent', 'session', async () => {
    order.push('first')
    await new Promise<void>((resolve) => {
      release = resolve
    })
    order.push('first-done')
  })
  const second = withSessionSelection('agent', 'session', async () => {
    order.push('second')
  })
  await withSessionSelection('agent', 'other-session', async () => {
    order.push('independent')
  })
  expect(order).toEqual(['first', 'independent'])
  release()
  await Promise.all([first, second])
  expect(order).toEqual(['first', 'independent', 'first-done', 'second'])
})

it('migrates version pins in SQL and old file selections before applying strict membership', async () => {
  state.settings.llmLegacyProviderId = undefined
  state.settings.apiKeys = { anthropicApiKey: 'key' }
  await state
    .db!.insert(scheduledTasks)
    .values({
      id: 'legacy-task',
      agentSlug: 'agent',
      scheduleType: 'at',
      scheduleExpression: 'tomorrow',
      prompt: 'hello',
      nextExecutionAt: new Date(),
      createdAt: new Date(),
      model: 'claude-previous-1',
    })
    .run()
  await runDataMigrations(handle.db, [importLlmConnections])
  const task = await state.db!.select().from(scheduledTasks).get()
  expect(task).toMatchObject({ model: 'claude-previous-1', llmProviderId: 'legacy-anthropic' })
  expect(
    (await resolveExecutionSelection(storedSelection(task!.model, task!.llmProviderId))).wireModel
  ).toBe('claude-previous-1')
  const before = await getConnection('legacy-anthropic')
  const file = await resolveExecutionSelection(storedSelection('claude-previous-2'))
  expect(file).toMatchObject({ llmProviderId: 'legacy-anthropic', model: 'claude-previous-2', wireModel: 'claude-previous-2' })
  expect(await connectionRuntime(file, 'agent')).toMatchObject({ model: 'claude-previous-2', modelPromptHints: [] })
  expect(await getConnection('legacy-anthropic')).toEqual(before)
  expect(connectionCatalog((await getConnection('legacy-anthropic'))!).some(m => m.id === file.model)).toBe(false)
  // Once a session is bound, subsequent turns must retain that legacy pin too.
  expect((await resolveExecutionSelection(storedSelection(file.model, file.llmProviderId))).wireModel).toBe('claude-previous-2')
})

it('keeps one managed Platform account and prevents deletion while logged in', async () => {
  state.platformToken = 'platform-test-token'
  await ensureManagedPlatformConnection()
  await ensureManagedPlatformConnection()
  const rows = await state
    .db!.select()
    .from(llmConnections)
    .where(eq(llmConnections.provider, 'platform'))
    .all()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ managed: true, userId: null })
  await expect(deleteConnection(rows[0].id, admin)).rejects.toThrow('while connected')
  await expect(
    saveConnection({ name: 'Duplicate', provider: 'platform', config: {} }, admin)
  ).rejects.toThrow('Platform login')
})

it('preserves legacy environment overrides only on the migrated account and honors later key removal', async () => {
  state.settings.llmLegacyProviderId = undefined
  state.settings.apiKeys = { anthropicApiKey: 'saved' }
  state.settings.customEnvVars = {
    ANTHROPIC_AUTH_TOKEN: 'legacy-custom',
    ANTHROPIC_BASE_URL: 'https://legacy.example',
    TOOL_SETTING: 'unrelated',
  }
  await runDataMigrations(handle.db, [importLlmConnections])
  const migrated = await connectionRuntime(await resolveExecutionSelection(), 'agent')
  expect(migrated.env).toMatchObject({
    ANTHROPIC_AUTH_TOKEN: 'legacy-custom',
    ANTHROPIC_BASE_URL: 'https://legacy.example',
  })
  const other = await add()
  expect(
    (await connectionRuntime(await resolveExecutionSelection({ llmProviderId: other, model: 'a' }), 'agent'))
      .env.ANTHROPIC_AUTH_TOKEN
  ).toBe('key-First')
  state.settings.apiKeys.anthropicApiKey = ''
  await syncProviderSettings({ providers: ['anthropic'], credentials: true })
  expect(
    providerForConnection((await getConnection('legacy-anthropic'))!).getEffectiveApiKey()
  ).toBeUndefined()
})

it('editing a migrated key replaces the custom bearer without losing its endpoint', async () => {
  state.settings.llmLegacyProviderId = undefined
  state.settings.apiKeys = { anthropicApiKey: 'saved' }
  state.settings.customEnvVars = {
    ANTHROPIC_AUTH_TOKEN: 'old-bearer',
    ANTHROPIC_BASE_URL: 'https://legacy.example',
  }
  await runDataMigrations(handle.db, [importLlmConnections])
  await saveConnection(
    { name: 'Updated', provider: 'anthropic', config: { apiKeys: { anthropicApiKey: 'new-key' } } },
    admin,
    'legacy-anthropic'
  )
  const runtime = await connectionRuntime(await resolveExecutionSelection(), 'agent')
  expect(runtime.env.ANTHROPIC_AUTH_TOKEN).toBe('')
  expect(runtime.env.ANTHROPIC_API_KEY).toBe('new-key')
  expect(runtime.env.ANTHROPIC_BASE_URL).toBe('https://legacy.example')
})

it('a legacy browser-only settings edit preserves the app and summarizer selections', async () => {
  state.settings.llmLegacyProviderId = undefined
  state.settings.apiKeys = { anthropicApiKey: 'saved' }
  await runDataMigrations(handle.db, [importLlmConnections])
  const root = state.settings.llmDefault
  const helper = await add('Helper')
  await setGlobalSelection('summarizer', { llmProviderId: helper, model: 'a' })
  await syncProviderSettings({ providers: ['anthropic'], models: ['browserModel'] })
  expect(state.settings.llmDefault).toEqual(root)
  expect(state.settings.llmSummarizer).toEqual({ llmProviderId: helper, model: 'a' })
})

it('legacy model updates preserve explicit pins without replacing connection-local catalog edits', async () => {
  state.settings.llmLegacyProviderId = undefined
  state.settings.apiKeys = { anthropicApiKey: 'saved' }
  await runDataMigrations(handle.db, [importLlmConnections])
  state.settings.models = {
    agentModel: 'claude-explicit-1',
    summarizerModel: 'haiku',
    browserModel: 'sonnet',
    dashboardBuilderModel: 'sonnet',
  }
  await syncProviderSettings({ providers: ['anthropic'], models: ['agentModel'] })
  expect((await resolveExecutionSelection()).wireModel).toBe('claude-explicit-1')
  expect((await resolveHelperSelection()).model).toBe('haiku')
})

it('keeps registry reads free of legacy import and Platform creation', async () => {
  state.settings.llmLegacyProviderId = undefined
  state.settings.apiKeys = { anthropicApiKey: 'saved' }
  state.platformToken = 'platform-test-token'
  expect(await listConnections(admin)).toEqual([])
  await expect(resolveSelectionHierarchy()).rejects.toThrow('Configure a global default')
  expect(await state.db!.select().from(llmConnections).all()).toEqual([])
  expect(state.settings.llmDefault).toBeUndefined()
})

it('onboarding configures the first account after the empty migration has completed', async () => {
  state.settings.llmLegacyProviderId = undefined
  await runDataMigrations(handle.db, [importLlmConnections])
  state.settings.apiKeys = { anthropicApiKey: 'onboarding-key' }
  await syncProviderSettings({ providers: ['anthropic'], credentials: true, selectDefault: true })
  expect((await resolveExecutionSelection()).llmProviderId).toBe('legacy-anthropic')
  expect(state.settings.llmSummarizer).toEqual({ llmProviderId: 'legacy-anthropic', model: 'haiku' })
  expect(state.settings.llmLegacyProviderId).toBeUndefined()
  expect(await runDataMigrations(handle.db, [importLlmConnections])).toEqual([])
})


describe('code-driven connection catalogs', () => {
  it.each(['anthropic', 'platform'] as const)('keeps %s built-ins and family aliases current after upgrades', async (providerId) => {
    const provider = getLlmProvider(providerId)
    let builtins = [{ id: 'version-1', label: 'Version 1', family: 'latest', isLatest: true, supportedEfforts: ['low' as const] }]
    vi.spyOn(provider, 'getBuiltinCatalog').mockImplementation(() => builtins)
    let id: string
    if (providerId === 'platform') {
      state.platformToken = 'platform-test-token'
      await ensureManagedPlatformConnection()
      id = 'legacy-platform'
    } else {
      id = await saveConnection({ name: 'API account', provider: providerId, config: { apiKeys: { anthropicApiKey: 'test-key' } } }, admin)
    }
    await setGlobalSelection('default', { llmProviderId: id, model: 'latest' })
    expect((await getConnection(id))!.modelOverrides).toBe('[]')
    expect((await resolveExecutionSelection()).wireModel).toBe('version-1')

    builtins = [
      { ...builtins[0], label: 'Updated metadata', isLatest: false },
      { ...builtins[0], id: 'version-2', label: 'Version 2' },
    ]
    expect((await resolveExecutionSelection()).wireModel).toBe('version-2')
    const info = (await listConnections(admin))[0]
    expect(info.catalog.map(model => model.label)).toEqual(['Updated metadata', 'Version 2'])
    expect(info.modelOverrides).toEqual([])
    expect((await getConnection(id))!.modelOverrides).toBe('[]')
  })

  it('stores only custom definitions and disabled IDs, retaining them across built-in changes', async () => {
    const provider = getLlmProvider('anthropic')
    const original = provider.getBuiltinCatalog()
    const disabled = original[0]
    const custom = { id: 'custom-private', label: 'Private', supportedEfforts: ['high' as const], contextWindow: 100_000, disabled: true }
    const id = await saveConnection({ name: 'Custom account', provider: 'anthropic', config: {}, modelOverrides: [
      { ...disabled, label: 'Must not override code', disabled: true },
      ...original.slice(1),
      { ...custom, pricing: { inputPerMtok: 3, outputPerMtok: 9 } },
    ] }, admin)
    expect(JSON.parse((await getConnection(id))!.modelOverrides)).toEqual([{ id: disabled.id, disabled: true }, custom])
    expect(connectionCatalog((await getConnection(id))!).some(model => model.id === custom.id)).toBe(false)
    vi.spyOn(provider, 'getBuiltinCatalog').mockReturnValue([...original, { id: 'brand-new', label: 'New', supportedEfforts: ['low'] }])
    const info = (await listConnections(admin))[0]
    expect(info.catalog.some(model => model.id === disabled.id)).toBe(false)
    expect(info.catalog.some(model => model.id === 'brand-new')).toBe(true)
    await saveConnection({ name: 'Custom account', provider: 'anthropic', config: {}, modelOverrides: [
      { id: disabled.id, disabled: true }, { ...custom, disabled: false },
    ] }, admin, id)
    expect(connectionCatalog((await getConnection(id))!).find(model => model.id === custom.id)).toMatchObject({ label: 'Private', contextWindow: 100_000 })
  })

  it('tolerates a saved disabled ID after the built-in is removed from code', async () => {
    const provider = getLlmProvider('anthropic')
    const builtins = provider.getBuiltinCatalog()
    const removed = builtins[0]
    const id = await saveConnection({ name: 'Account', provider: 'anthropic', config: {}, modelOverrides: [
      { id: removed.id, disabled: true },
    ] }, admin)
    vi.spyOn(provider, 'getBuiltinCatalog').mockReturnValue(builtins.slice(1))
    const info = (await listConnections(admin))[0]
    expect(info.catalog.some(model => model.id === removed.id)).toBe(false)
    expect(info.modelOverrides).toEqual([{ id: removed.id, disabled: true }])
    await expect(saveConnection({ name: 'Renamed', provider: 'anthropic', config: {} }, admin, id)).resolves.toBe(id)
  })

  it('uses the code definition when a formerly custom model becomes a built-in', async () => {
    const id = await add()
    vi.spyOn(getLlmProvider('generic'), 'getBuiltinCatalog').mockReturnValue([
      { ...catalog[0], label: 'Now maintained in code', contextWindow: 900_000 },
    ])
    const info = (await listConnections(admin))[0]
    expect(info.catalog[0]).toMatchObject({ label: 'Now maintained in code', contextWindow: 900_000 })
    expect(info.modelOverrides).toEqual([])
    await saveConnection({ name: 'Renamed', provider: 'generic', config: {} }, admin, id)
    expect((await getConnection(id))!.modelOverrides).toBe('[]')
  })
})


describe('review regressions', () => {
  it('falls back within the global provider when a pinned built-in is retired', async () => {
    const id = await add()
    state.settings.llmLegacyProviderId = id
    state.settings.llmDefault = { llmProviderId: id, model: 'removed-model' }
    const before = await getConnection(id)
    expect(await resolveSelectionHierarchy()).toMatchObject({ llmProviderId: id, model: 'model-a' })
    expect(await getConnection(id)).toEqual(before)
  })

  it('uses the migrated global provider when settings outlive a recreated database', async () => {
    state.settings.apiKeys = { anthropicApiKey: 'key' }
    state.settings.llmDefault = { llmProviderId: 'lost-database-row', model: 'retired-model' }
    await importLlmConnections.run(handle.db)
    expect(await resolveSelectionHierarchy()).toMatchObject({ llmProviderId: 'legacy-anthropic' })
  })

  it('selects a provider default when the caller switches only llmProviderId', async () => {
    const first = await add()
    const second = await add('Second')
    await setGlobalSelection('default', { llmProviderId: first, model: 'model-a' })
    expect(await resolveSelectionHierarchy(storedSelection(undefined, second), storedSelection('model-a', first)))
      .toMatchObject({ llmProviderId: second, model: 'model-a' })
  })

  it('preserves Anthropic proxy environment bindings on host helpers without leaking to new accounts', async () => {
    state.settings.apiKeys = { anthropicApiKey: 'key' }
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://env-proxy.example')
    await importLlmConnections.run(handle.db)
    const migrated = (await getConnection('legacy-anthropic'))!
    expect(providerForConnection(migrated).createClient().baseURL).toBe('https://env-proxy.example')
    expect((await connectionRuntime(await resolveSelectionHierarchy(), 'agent')).env.ANTHROPIC_BASE_URL).toBe('https://env-proxy.example')
    const other = await saveConnection({ name: 'Direct', provider: 'anthropic', config: { apiKeys: { anthropicApiKey: 'other-key' } } }, admin)
    expect(providerForConnection((await getConnection(other))!).createClient().baseURL).toBe('https://api.anthropic.com')
    state.settings.customEnvVars = { ANTHROPIC_BASE_URL: 'https://edited-proxy.example' }
    await syncProviderSettings({ providers: ['anthropic'], runtimeEnv: true })
    const edited = (await getConnection('legacy-anthropic'))!
    expect(providerForConnection(edited).createClient().baseURL).toBe('https://edited-proxy.example')
    expect((await connectionRuntime(await resolveSelectionHierarchy(), 'agent')).env.ANTHROPIC_BASE_URL).toBe('https://edited-proxy.example')
    expect(edited.generation).toBe(migrated.generation + 1)
    state.settings.customEnvVars = {}
    await syncProviderSettings({ providers: ['anthropic'], runtimeEnv: true })
    expect(providerForConnection((await getConnection('legacy-anthropic'))!).createClient().baseURL).toBe('https://env-proxy.example')
  })

  it('does not rotate generations for effort-only or identical model saves', async () => {
    state.settings.apiKeys = { anthropicApiKey: 'key' }
    await importLlmConnections.run(handle.db)
    const before = await getConnection('legacy-anthropic')
    state.settings.models = { agentEffort: 'high' }
    await syncProviderSettings({ providers: ['anthropic'], models: [] })
    await syncProviderSettings({ providers: ['anthropic'], models: ['agentModel', 'browserModel'] })
    expect(await getConnection('legacy-anthropic')).toEqual(before)
  })

  it('does not consume general AWS tool credentials for non-Bedrock providers', async () => {
    state.settings.apiKeys = { anthropicApiKey: 'key' }
    state.settings.customEnvVars = { AWS_REGION: 'eu-west-1', AWS_ACCESS_KEY_ID: 'tool-key', AWS_SECRET_ACCESS_KEY: 'tool-secret' }
    await importLlmConnections.run(handle.db)
    const runtime = await connectionRuntime(await resolveSelectionHierarchy(), 'agent')
    for (const key of Object.keys(state.settings.customEnvVars)) expect(runtime.env).not.toHaveProperty(key)
  })
})
