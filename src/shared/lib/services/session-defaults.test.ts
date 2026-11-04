import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import { installTestAppRecordStore } from '../app-records/testing/memory-record-store'
import type { AppSettings } from '../config/settings'

const state = vi.hoisted(() => ({
  db: null as TestDatabase['db'] | null,
  settings: {} as AppSettings,
  settingsReads: 0,
  preferences: {} as Record<string, unknown>,
}))
vi.mock('../db', () => ({ get db() { return state.db } }))
vi.mock('../config/settings', async original => ({
  ...(await original<typeof import('../config/settings')>()),
  getSettings: () => {
    state.settingsReads++
    return state.settings
  },
  mutateSettings: (change: (s: AppSettings) => void) => change(state.settings),
}))
vi.mock('@shared/lib/agent-actor', () => ({
  agentRegistry: { get: () => ({ config: { get: async () => state.preferences } }) },
}))

import { saveConnection, setGlobalSelection } from '../llm-provider/connections'
import { resolveSessionDefaults } from './session-defaults'

let handle: TestDatabase
let first: string
let second: string
const catalog = ['model-a', 'model-b'].map(id => ({ id, label: id, supportedEfforts: ['low', 'high'] }))

beforeEach(async () => {
  handle = await createTestDatabase()
  state.db = handle.db
  installTestAppRecordStore()
  state.settings = {} as AppSettings
  state.preferences = {}
  for (const name of ['first', 'second']) {
    const id = await saveConnection({ name, provider: 'generic', config: {
      apiKeys: { genericApiKey: `${name}-key`, genericBaseUrl: `https://${name}.example` },
    }, modelOverrides: catalog }, { userId: null, admin: true })
    if (name === 'first') first = id
    else second = id
  }
  await setGlobalSelection('default', { llmProviderId: first, model: 'model-a' })
})
afterEach(async () => { await handle.close() })

it('resolves a session start from the settings it is given, reading none of its own', async () => {
  state.settings = {
    ...state.settings,
    agentLimits: { maxTurns: 7 },
    customEnvVars: { TEAM: 'blue' },
    app: { maxBrowserTabs: 3 },
  } as AppSettings
  state.preferences = { defaultModel: 'model-b', defaultLlmProviderId: second, defaultEffort: 'high' }
  state.settingsReads = 0

  const launch = await resolveSessionDefaults(state.settings, 'agent')
  const picked = await launch.resolve({ model: 'model-a', llmProviderId: first })
  const prewarm = await launch.resolve({})

  expect(state.settingsReads).toBe(0)
  expect(launch.agentLimits).toEqual({ maxTurns: 7 })
  expect(launch.customEnvVars).toEqual({ TEAM: 'blue' })
  expect(launch.maxBrowserTabs).toBe(3)
  expect(launch.agentPrefs).toMatchObject({ defaultModel: 'model-b', defaultLlmProviderId: second })
  expect(picked).toMatchObject({ model: 'model-a', llmProviderId: first, effort: 'high' })
  expect(prewarm).toMatchObject({ model: 'model-b', llmProviderId: second })
})

it('leaves out an empty custom env, and each start sees the settings it was given', async () => {
  const before = await resolveSessionDefaults(state.settings, 'agent')
  expect(before.customEnvVars).toBeUndefined()
  expect(await before.resolve({})).toMatchObject({ model: 'model-a', llmProviderId: first })

  // A change committed before the next start is what that start resolves.
  await setGlobalSelection('default', { llmProviderId: second, model: 'model-b' })
  const after = await resolveSessionDefaults(state.settings, 'agent')
  expect(await after.resolve({})).toMatchObject({ model: 'model-b', llmProviderId: second })
})
