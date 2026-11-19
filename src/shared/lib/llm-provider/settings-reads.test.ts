/**
 * SUP-1507: the LLM paths read the settings once per operation (one listing,
 * one send, one helper call, one provider sync), however many connections,
 * candidates or models they go through, and never carry what they read into
 * the next operation.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import * as records from '../app-records/records'
import { SETTINGS_RECORD_KEY } from '../app-records/record-schemas'

const state = vi.hoisted(() => ({ db: null as TestDatabase['db'] | null }))
vi.mock('../db', () => ({
  get db() {
    return state.db
  },
}))
// The plan policy comes from the platform; offline here, an account reads as unrestricted.
vi.mock('../services/platform-auth-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/platform-auth-service')>()),
  fetchActingPlatformAccount: async () => {
    throw new Error('offline')
  },
}))

import { getSettings, mutateSettings } from '../config/settings'
import {
  listConnections,
  listConnectionsWithSelection,
  resolveSelectionHierarchyFrom,
  saveConnection,
  setGlobalSelection,
} from './connections'
import { sessionConnectionRuntime } from './session-connection-runtime'
import { getConfiguredLlmClientAndModel } from './helpers'
import { ensureManagedPlatformConnection, syncProviderSettings } from './connection-settings'

const admin = { userId: null, admin: true }
const PLATFORM_TOKEN = 'plat_sa_settings_reads'
const platformAuth = {
  token: PLATFORM_TOKEN,
  tokenPreview: 'plat_s...eads',
  email: 'owner@example.com',
  label: 'Gamut',
  orgId: 'org_reads',
  orgName: 'Reads',
  role: 'owner',
  userId: 'user_reads',
  memberId: 'sub_reads',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
}

let handle: TestDatabase
/** Every read of a stored record; the settings ones are counted, apart from the other host records. */
let reads: MockInstance<typeof records.readStoredRecord>

beforeEach(async () => {
  handle = await createTestDatabase()
  state.db = handle.db
  reads = vi.spyOn(records, 'readStoredRecord')
  await mutateSettings((s) => {
    s.llmProvider = 'platform'
    s.platformAuth = platformAuth
  })
  // The managed Platform connection, made the app default and summarizer.
  await ensureManagedPlatformConnection()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await handle.close()
})

async function readsDuring(work: () => Promise<unknown>): Promise<number> {
  reads.mockClear()
  await work()
  return reads.mock.calls.filter(([key]) => key === SETTINGS_RECORD_KEY).length
}

let added = 0
async function addGeneric(): Promise<string> {
  added += 1
  return saveConnection({
    name: `Generic ${added}`,
    provider: 'generic',
    userId: null,
    config: { apiKeys: { genericApiKey: `key-${added}`, genericBaseUrl: `https://generic-${added}.example` } },
    modelOverrides: [{ id: 'model-a', label: 'A', family: 'a', isLatest: true, supportedEfforts: ['low' as const] }],
  }, admin)
}

describe('connection listings', () => {
  // Every listing here includes the managed Platform row, whose availability
  // revision used to read the platform status again (SUP-1507 G1).
  it('read the settings once, however many connections they list, the Platform row included', async () => {
    expect((await listConnections(admin)).map(c => c.provider)).toEqual(['platform'])
    const small = await readsDuring(() => listConnections(admin))
    const smallWithSelection = await readsDuring(() => listConnectionsWithSelection(admin))
    for (let i = 0; i < 5; i++) await addGeneric()
    expect((await listConnections(admin)).length).toBe(6)
    const large = await readsDuring(() => listConnections(admin))
    const largeWithSelection = await readsDuring(() => listConnectionsWithSelection(admin))
    expect(small).toBe(1)
    expect(large).toBe(small)
    expect(smallWithSelection).toBe(1)
    expect(largeWithSelection).toBe(smallWithSelection)
    // A request that already read them passes them in: no read at all.
    const settings = await getSettings()
    expect(await readsDuring(() => listConnectionsWithSelection(admin, settings))).toBe(0)
  })

  it('see a change committed between two listings', async () => {
    const before = await listConnections(admin)
    expect(before.find(c => c.id === 'legacy-platform')).toMatchObject({ isConfigured: true, modelAvailabilityRevision: expect.any(String) })

    // Another process disconnects Platform and prices a model.
    await mutateSettings((s) => {
      s.platformAuth = undefined
      s.modelPricing = { 'model-a': { inputPerMtok: 7, outputPerMtok: 9 } }
    })
    const generic = await addGeneric()
    const after = await listConnections(admin)
    expect(after.find(c => c.id === 'legacy-platform')).toMatchObject({ isConfigured: false, modelAvailabilityRevision: null })
    expect(after.find(c => c.id === generic)?.catalog.find(m => m.id === 'model-a')?.pricing).toMatchObject({ inputPerMtok: 7 })
  })
})

describe('one message send', () => {
  it('resolves the selection and builds the Platform runtime without reading the settings it is given', async () => {
    const generic = await addGeneric()
    const settings = await getSettings()
    const reads = await readsDuring(async () => {
      // A retired session model falls through to the agent default, then the app default.
      const selected = await resolveSelectionHierarchyFrom(
        settings,
        { llmProviderId: generic, model: 'retired' },
        { llmProviderId: 'missing-connection', model: 'model-a' },
      )
      expect(selected.llmProviderId).toBe('legacy-platform')
      const runtime = await sessionConnectionRuntime(selected, 'agent-reads', settings)
      expect(runtime).toMatchObject({ provider: 'platform', llmProviderId: 'legacy-platform' })
      expect(runtime.env.ANTHROPIC_AUTH_TOKEN).toBe(PLATFORM_TOKEN)
    })
    expect(reads).toBe(0)
  })

  it('reads once when the caller has not read the settings', async () => {
    const settings = await getSettings()
    const selected = await resolveSelectionHierarchyFrom(settings)
    expect(await readsDuring(() => sessionConnectionRuntime(selected, 'agent-reads'))).toBe(1)
  })

  it('builds the next send from the settings as they are then', async () => {
    const first = await getSettings()
    const runtime = await sessionConnectionRuntime(await resolveSelectionHierarchyFrom(first), 'agent-reads', first)
    expect(runtime.env.ENABLE_TOOL_SEARCH).toBe('true')
    await mutateSettings((s) => { s.enableToolSearch = false })
    const next = await getSettings()
    const nextRuntime = await sessionConnectionRuntime(await resolveSelectionHierarchyFrom(next), 'agent-reads', next)
    expect(nextRuntime.env.ENABLE_TOOL_SEARCH).toBe('false')
  })
})

describe('summarizer setup', () => {
  it('reads the settings once with a Platform helper selection', async () => {
    let setup: Awaited<ReturnType<typeof getConfiguredLlmClientAndModel>> | undefined
    expect(await readsDuring(async () => { setup = await getConfiguredLlmClientAndModel() })).toBe(1)
    expect(setup?.model).toEqual(expect.any(String))
  })

  it('reads the settings once with a BYO helper selection, and uses its model', async () => {
    const generic = await addGeneric()
    await setGlobalSelection('summarizer', { llmProviderId: generic, model: 'model-a' })
    let setup: Awaited<ReturnType<typeof getConfiguredLlmClientAndModel>> | undefined
    expect(await readsDuring(async () => { setup = await getConfiguredLlmClientAndModel() })).toBe(1)
    expect(setup?.model).toBe('model-a')
  })
})

describe('provider sync', () => {
  beforeEach(async () => {
    await mutateSettings((s) => {
      s.llmProvider = 'anthropic'
      s.apiKeys = { ...s.apiKeys, anthropicApiKey: 'sk-ant-reads' }
    })
    // The first sync imports the provider's connection.
    await syncProviderSettings({ providers: ['anthropic'], apiKeys: { anthropicApiKey: 'sk-ant-reads' } })
  })

  it('reads the settings the same number of times however many models it syncs', async () => {
    const one = await readsDuring(() => syncProviderSettings({ providers: ['anthropic'], models: ['agentModel'], selectDefault: true }))
    const four = await readsDuring(() => syncProviderSettings({
      providers: ['anthropic'],
      models: ['agentModel', 'summarizerModel', 'browserModel', 'dashboardBuilderModel'],
      selectDefault: true,
    }))
    expect(four).toBe(one)
    // Its own read, and the compare-and-set write of the app default.
    expect(one).toBe(2)
  })

  it('returns the settings as it left them', async () => {
    const synced = await syncProviderSettings({ providers: ['anthropic'], models: ['agentModel'], selectDefault: true })
    expect(synced.llmDefault).toMatchObject({ llmProviderId: 'legacy-anthropic' })
    expect(synced).toEqual(await getSettings())
  })
})
