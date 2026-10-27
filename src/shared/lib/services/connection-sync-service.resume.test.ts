/**
 * Resuming the calls parked on a reconnected connection, over a real
 * database: the mapping tables decide which agents are told.
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

const completeConnection = vi.fn(async (_slug: string, _mcpId: string) => 1)
const completeAccount = vi.fn(async (_slug: string, _accountId: string) => 1)
vi.mock('@shared/lib/agent-actor', () => ({
  agentRegistry: {
    get: (slug: string) => ({
      inputs: {
        mcpReauth: { completeConnection: (mcpId: string) => completeConnection(slug, mcpId) },
        accountReauth: { completeAccount: (accountId: string) => completeAccount(slug, accountId) },
      },
    }),
  },
}))

import { resumeAccountReauthWaits, resumeMcpReauthWaits } from './connection-sync-service'

const now = new Date()

describe('resuming the calls parked on a reconnected connection', () => {
  beforeEach(async () => {
    handle = await createTestDatabase()
    testDb = handle.db
    vi.clearAllMocks()
  })

  afterEach(() => {
    handle.close()
  })

  it('resumes them for an MCP in exactly the agents it is assigned to', async () => {
    await testDb.insert(schema.remoteMcpServers).values([
      { id: 'mcp-1', name: 'One', url: 'https://one.example', createdAt: now, updatedAt: now },
      { id: 'mcp-2', name: 'Two', url: 'https://two.example', createdAt: now, updatedAt: now },
    ])
    await testDb.insert(schema.agentRemoteMcps).values([
      { id: 'm1', agentSlug: 'a', remoteMcpId: 'mcp-1', createdAt: now },
      { id: 'm2', agentSlug: 'b', remoteMcpId: 'mcp-1', createdAt: now },
      { id: 'm3', agentSlug: 'c', remoteMcpId: 'mcp-2', createdAt: now },
    ])

    await resumeMcpReauthWaits('mcp-1')

    expect(completeConnection.mock.calls.map(([slug, mcpId]) => `${slug}:${mcpId}`).sort()).toEqual(['a:mcp-1', 'b:mcp-1'])
    expect(completeAccount).not.toHaveBeenCalled()
  })

  it('resumes them for an account in exactly the agents it is assigned to', async () => {
    await testDb.insert(schema.connectedAccounts).values([
      { id: 'acct-1', providerConnectionId: 'p1', toolkitSlug: 'gmail', displayName: 'Mail', createdAt: now, updatedAt: now },
      { id: 'acct-2', providerConnectionId: 'p2', toolkitSlug: 'slack', displayName: 'Chat', createdAt: now, updatedAt: now },
    ])
    await testDb.insert(schema.agentConnectedAccounts).values([
      { id: 'c1', agentSlug: 'a', connectedAccountId: 'acct-1', createdAt: now },
      { id: 'c2', agentSlug: 'b', connectedAccountId: 'acct-2', createdAt: now },
    ])

    await resumeAccountReauthWaits('acct-1')

    expect(completeAccount.mock.calls).toEqual([['a', 'acct-1']])
    expect(completeConnection).not.toHaveBeenCalled()
  })
})
