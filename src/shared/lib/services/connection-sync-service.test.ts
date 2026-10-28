import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockWhere = vi.fn()
const mockSync = vi.fn()
const mockCompleteConnection = vi.fn()
const mockCompleteAccount = vi.fn()

vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (...args: unknown[]) => mockWhere(...args),
      }),
    }),
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  agentConnectedAccounts: { agentSlug: 'account_agent_slug', connectedAccountId: 'connected_account_id' },
  agentRemoteMcps: { agentSlug: 'mcp_agent_slug', remoteMcpId: 'remote_mcp_id' },
}))

vi.mock('drizzle-orm', () => ({
  eq: (column: string, value: string) => ({ column, value }),
}))

vi.mock('@shared/lib/agent-actor', () => ({
  agentRegistry: {
    get: (slug: string) => ({
      container: { syncConnectionEnvironment: (kind: string) => mockSync(slug, kind) },
      inputs: {
        mcpReauth: { completeConnection: (mcpId: string) => mockCompleteConnection(slug, mcpId) },
        accountReauth: { completeAccount: (accountId: string) => mockCompleteAccount(slug, accountId) },
      },
    }),
  },
}))

import {
  resumeAccountReauthWaits,
  resumeMcpReauthWaits,
  syncAgentsAssignedConnectedAccount,
  syncAgentsAssignedRemoteMcp,
  syncRemoteMcpAgents,
} from './connection-sync-service'

describe('connection sync fan-out', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSync.mockResolvedValue(true)
  })

  it('pushes the projection once per distinct assigned agent, through that agent\'s actor', async () => {
    mockWhere.mockResolvedValue([{ agentSlug: 'a' }, { agentSlug: 'b' }, { agentSlug: 'a' }])

    await expect(syncAgentsAssignedRemoteMcp('mcp-1')).resolves.toBe(true)

    expect(mockWhere).toHaveBeenCalledWith({ column: 'remote_mcp_id', value: 'mcp-1' })
    expect(mockSync.mock.calls).toEqual([
      ['a', 'remote-mcps'],
      ['b', 'remote-mcps'],
    ])
  })

  it('reports false when any agent\'s push fails, without stopping the others', async () => {
    mockWhere.mockResolvedValue([{ agentSlug: 'a' }, { agentSlug: 'b' }])
    mockSync.mockImplementation(async (slug: string) => slug !== 'a')

    await expect(syncAgentsAssignedConnectedAccount('acct-1')).resolves.toBe(false)

    expect(mockWhere).toHaveBeenCalledWith({ column: 'connected_account_id', value: 'acct-1' })
    expect(mockSync).toHaveBeenCalledTimes(2)
  })

  it('reports false when the mapping lookup itself fails', async () => {
    mockWhere.mockRejectedValue(new Error('db down'))
    await expect(syncAgentsAssignedRemoteMcp('mcp-1')).resolves.toBe(false)
    expect(mockSync).not.toHaveBeenCalled()
  })

  it('syncs an explicit slug list without consulting the mapping tables', async () => {
    await expect(syncRemoteMcpAgents(['x', 'y'])).resolves.toBe(true)
    expect(mockWhere).not.toHaveBeenCalled()
    expect(mockSync.mock.calls).toEqual([
      ['x', 'remote-mcps'],
      ['y', 'remote-mcps'],
    ])
  })
})

// Which agents are resumed is tested over a real database (connection-sync-service.resume.test.ts).
describe('resuming the calls parked on a reconnected connection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('never fails the reconnect it follows: a failed lookup or resume is logged, and the calls time out', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockWhere.mockRejectedValueOnce(new Error('db down'))
    await expect(resumeMcpReauthWaits('mcp-1')).resolves.toBeUndefined()

    mockWhere.mockResolvedValue([{ agentSlug: 'a' }])
    mockCompleteAccount.mockRejectedValueOnce(new Error('actor gone'))
    await expect(resumeAccountReauthWaits('acct-1')).resolves.toBeUndefined()

    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})
