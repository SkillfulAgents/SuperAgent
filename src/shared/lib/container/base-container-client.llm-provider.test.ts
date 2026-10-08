import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import type { AppSettings } from '../config/settings'

const state = vi.hoisted(() => ({
  db: null as TestDatabase['db'] | null,
  settings: {} as AppSettings,
  metadata: {} as { llmProviderId?: string; model?: string },
  signedOutConnection: null as string | null,
}))
vi.mock('@shared/lib/llm-provider/connection-runtime', async original => {
  const actual = await original<typeof import('@shared/lib/llm-provider/connection-runtime')>()
  const { CredentialRefreshError } = await import('../../../../agent-container/src/credential-refresh-error')
  return {
    ...actual,
    connectionRuntime: async (...args: Parameters<typeof actual.connectionRuntime>) => {
      if (args[0].llmProviderId === state.signedOutConnection) throw new CredentialRefreshError(401)
      return actual.connectionRuntime(...args)
    },
  }
})
vi.mock('../db', () => ({ get db() { return state.db } }))
vi.mock('../config/settings', async original => ({
  ...(await original<typeof import('../config/settings')>()),
  getSettings: () => state.settings,
  mutateSettings: (change: (s: AppSettings) => void) => change(state.settings),
}))
vi.mock('./host-token-store', () => ({ getOrCreateHostToken: () => 'host-test-token' }))
vi.mock('@shared/lib/agent-actor', () => ({
  agentRegistry: { get: () => ({
    sessions: {
      metadata: async () => state.metadata,
      updateMetadata: async (_id: string, patch: typeof state.metadata) => { Object.assign(state.metadata, patch) },
    },
    config: { get: async () => ({}) },
  }) },
}))
import { BaseContainerClient } from './base-container-client'
import { findAgentRuntimeError } from '../agent-runtime-errors/agent-runtime-error'
import { ProviderReconnectRequiredError } from '../agent-runtime-errors/provider-reconnect-required/provider-reconnect-required-error'
import { saveConnection, setGlobalSelection } from '../llm-provider/connections'

class Client extends BaseContainerClient {
  protected getRunnerCommand() { return 'docker' }
  async getInfo() { return { status: 'running' as const, port: 12345 } }
}
let handle: TestDatabase
let first: string
let second: string
let requests: Record<string, unknown>[]
const catalog = ['model-a', 'model-b'].map(id => ({ id, label: id, supportedEfforts: ['low'] }))
beforeEach(async () => {
  handle = await createTestDatabase()
  state.db = handle.db
  state.settings = {} as AppSettings
  state.metadata = {}
  state.signedOutConnection = null
  for (const name of ['first', 'second']) {
    const id = await saveConnection({ name, provider: 'generic', config: {
      apiKeys: { genericApiKey: `${name}-key`, genericBaseUrl: `https://${name}.example` },
    }, modelOverrides: catalog }, { userId: null, admin: true })
    if (name === 'first') first = id
    else second = id
  }
  await setGlobalSelection('default', { llmProviderId: first, model: 'model-a' })
  requests = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string))
    return new Response(JSON.stringify({ id: 'created-session' }))
  }))
})
afterEach(async () => { vi.unstubAllGlobals(); await handle.close() })

it('sends the default runtime for prewarming even when the session picks a different provider', async () => {
  await new Client({ agentId: 'agent' }).createSession({
    initialMessage: 'hello', model: 'model-b', llmProviderId: second,
    prewarmDefaults: { llmProviderId: first, model: 'model-a', effort: 'low' },
  })
  expect(requests[0]).toMatchObject({
    llmProviderId: second,
    llmRuntime: { llmProviderId: second, model: 'model-b', env: { ANTHROPIC_AUTH_TOKEN: 'second-key' } },
    prewarmDefaults: { llmProviderId: first, model: 'model-a', effort: 'low',
      llmRuntime: { llmProviderId: first, model: 'model-a', env: { ANTHROPIC_AUTH_TOKEN: 'first-key' } } },
  })
})

it('starts the session without prewarming when only the default provider is signed out', async () => {
  state.signedOutConnection = first
  await new Client({ agentId: 'agent' }).createSession({
    initialMessage: 'hello', model: 'model-b', llmProviderId: second,
    prewarmDefaults: { llmProviderId: first, model: 'model-a', effort: 'low' },
  })
  expect(requests[0]).toMatchObject({ llmRuntime: { llmProviderId: second, model: 'model-b' } })
  expect(requests[0].prewarmDefaults).toBeUndefined()
})

it('asks to reconnect when the selected provider itself is signed out', async () => {
  state.signedOutConnection = second
  await expect(new Client({ agentId: 'agent' }).createSession({
    initialMessage: 'hello', model: 'model-b', llmProviderId: second,
    prewarmDefaults: { llmProviderId: first, model: 'model-a', effort: 'low' },
  }).catch((error: unknown) => error)).resolves.toSatisfy((error) => findAgentRuntimeError(error) instanceof ProviderReconnectRequiredError)
  expect(requests).toEqual([])
})

it('honors a provider-only switch and persists the resolved provider/model pair', async () => {
  state.metadata = { llmProviderId: first, model: 'model-b' }
  await new Client({ agentId: 'agent' }).sendMessage('session', 'switch', undefined, { llmProviderId: second })
  expect(requests[0]).toMatchObject({ llmRuntime: { llmProviderId: second, model: 'model-a' } })
  expect(state.metadata).toEqual({ llmProviderId: second, model: 'model-a' })
})

it('keeps the current model when a follow-up supplies neither a provider nor a model', async () => {
  state.metadata = { llmProviderId: first, model: 'model-b' }
  await new Client({ agentId: 'agent' }).sendMessage('session', 'continue')
  expect(requests[0]).toMatchObject({ llmRuntime: { llmProviderId: first, model: 'model-b' } })
})
