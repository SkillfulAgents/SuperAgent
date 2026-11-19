/**
 * What the agent already has, read from the mapping tables of a real database
 * and marked on the services its search returns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import type { AppDatabase } from '../db/drivers/types'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'

let testDb: AppDatabase
let handle: TestDatabase

vi.mock('@shared/lib/db', () => ({
  get db() { return testDb },
}))
vi.mock('../account-providers/provider-factory', () => ({ getDefaultAccountProvider: async () => ({ name: 'composio' }) }))
const platformComposio = vi.hoisted(() => ({ active: false }))
vi.mock('../composio/client', () => ({ isPlatformComposioActive: async () => platformComposio.active }))
vi.mock('../agent-integrations/agent-provider-listing', () => ({
  listAgentIntegrationProviders: async () => ({
    webhookRelay: false,
    providers: [
      { provider: 'slack', name: 'Slack', guide: 'Create the app.' },
      { provider: 'linear', name: 'Linear', unavailable: 'Needs a webhook relay, which this host does not have.' },
    ],
  }),
}))
const installations = vi.hoisted(() => ({ rows: [] as Array<{ provider: string; status: string }> }))
vi.mock('../services/agent-integration-service', () => ({ listAgentIntegrations: async () => installations.rows }))

import { agentConnectionCatalog } from './agent-catalog'

const now = new Date()

describe('agentConnectionCatalog', () => {
  beforeEach(async () => {
    handle = await createTestDatabase()
    testDb = handle.db
    platformComposio.active = false
    installations.rows = []
  })

  afterEach(() => {
    handle.close()
  })

  it('marks the accounts, MCPs and integrations assigned to this agent only', async () => {
    await testDb.insert(schema.connectedAccounts).values([
      { id: 'acct-1', providerConnectionId: 'p1', toolkitSlug: 'slack', displayName: 'Work', status: 'expired', createdAt: now, updatedAt: now },
      { id: 'acct-2', providerConnectionId: 'p2', toolkitSlug: 'slack', displayName: 'Personal', status: 'active', createdAt: now, updatedAt: now },
      { id: 'acct-3', providerConnectionId: 'p3', toolkitSlug: 'github', displayName: 'Other agent', createdAt: now, updatedAt: now },
    ])
    await testDb.insert(schema.agentConnectedAccounts).values([
      { id: 'c1', agentSlug: 'agent', connectedAccountId: 'acct-1', createdAt: now },
      { id: 'c2', agentSlug: 'agent', connectedAccountId: 'acct-2', createdAt: now },
      { id: 'c3', agentSlug: 'other', connectedAccountId: 'acct-3', createdAt: now },
    ])
    // Matched to the catalog by endpoint, so a trailing slash still counts.
    await testDb.insert(schema.remoteMcpServers).values([
      { id: 'mcp-1', name: 'My Linear', url: 'https://mcp.linear.app/mcp/', status: 'auth_required', createdAt: now, updatedAt: now },
    ])
    await testDb.insert(schema.agentRemoteMcps).values([{ id: 'm1', agentSlug: 'agent', remoteMcpId: 'mcp-1', createdAt: now }])
    installations.rows = [{ provider: 'slack', status: 'paused' }]

    const services = await agentConnectionCatalog('agent')
    const slack = services.find(({ service }) => service === 'slack')!
    const linear = services.find(({ service }) => service === 'linear')!
    const github = services.find(({ service }) => service === 'github')!

    // An active account wins over an expired one of the same toolkit.
    expect(slack.accounts.find(({ toolkit }) => toolkit === 'slack')?.assigned).toBe('active')
    expect(slack.accounts.find(({ toolkit }) => toolkit === 'slackbot')).not.toHaveProperty('assigned')
    expect(slack.integrations).toEqual([{ provider: 'slack', name: 'Slack', family: 'chat', guide: 'Create the app.', assigned: 'paused' }])
    expect(linear.mcps[0].assigned).toBe('auth_required')
    expect(linear.integrations[0]).toMatchObject({ unavailable: expect.stringContaining('webhook relay') })
    expect(github.accounts[0]).not.toHaveProperty('assigned')
  })

  it('offers platform-only accounts only on Gamut\'s Composio', async () => {
    expect((await agentConnectionCatalog('agent')).some(({ service }) => service === 'shopify')).toBe(false)
    platformComposio.active = true
    expect((await agentConnectionCatalog('agent')).some(({ service }) => service === 'shopify')).toBe(true)
  })
})
