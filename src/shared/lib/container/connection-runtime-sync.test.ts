import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockWhere = vi.fn()
const mockFetch = vi.fn()
const mockGetHostApiBaseUrl = vi.fn()
const mockGetCachedInfo = vi.fn()

vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({ where: (...args: unknown[]) => mockWhere(...args) }),
        where: (...args: unknown[]) => mockWhere(...args),
      }),
    }),
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  connectedAccounts: { id: 'account_id' },
  agentConnectedAccounts: {
    agentSlug: 'account_agent_slug',
    connectedAccountId: 'connected_account_id',
  },
  remoteMcpServers: { id: 'mcp_id' },
  agentRemoteMcps: {
    agentSlug: 'mcp_agent_slug',
    remoteMcpId: 'remote_mcp_id',
  },
}))

vi.mock('drizzle-orm', () => ({
  eq: (column: string, value: string) => ({ column, value }),
}))

vi.mock('./container-manager', () => ({
  containerManager: {
    getCachedInfo: (...args: unknown[]) => mockGetCachedInfo(...args),
    getClient: () => ({
      fetch: (...args: unknown[]) => mockFetch(...args),
      getHostApiBaseUrl: (...args: unknown[]) => mockGetHostApiBaseUrl(...args),
    }),
  },
}))

import {
  syncAgentConnectionEnvironment,
  updateConnectedAccountsEnvironment,
  updateRemoteMcpEnvironment,
} from './connection-runtime-sync'

describe('connection runtime synchronization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCachedInfo.mockReturnValue({ status: 'running', port: 8080 })
    mockGetHostApiBaseUrl.mockResolvedValue('http://10.20.30.40:3000')
    mockFetch.mockResolvedValue(new Response(null, { status: 200 }))
  })

  it('writes active and auth-required MCPs with stable ordering', async () => {
    mockWhere.mockResolvedValue([
      {
        mcp: {
          id: 'mcp-z',
          name: 'Zed',
          status: 'active',
          toolsJson: JSON.stringify([{ name: 'search' }, { invalid: true }]),
        },
      },
      {
        mcp: {
          id: 'mcp-disabled',
          name: 'Disabled',
          status: 'auth_required',
          toolsJson: null,
        },
      },
      {
        mcp: {
          id: 'mcp-a',
          name: 'Alpha',
          status: 'active',
          toolsJson: JSON.stringify([{ name: 'list' }]),
        },
      },
      {
        mcp: {
          id: 'mcp-error',
          name: 'Broken',
          status: 'error',
          toolsJson: null,
        },
      },
    ])

    await updateRemoteMcpEnvironment('agent-1', {
      fetch: mockFetch,
      getHostApiBaseUrl: mockGetHostApiBaseUrl,
    } as never)

    const [, init] = mockFetch.mock.calls[0]
    const payload = JSON.parse(init.body as string)
    expect(payload.key).toBe('REMOTE_MCPS')
    expect(JSON.parse(payload.value)).toEqual([
      {
        id: 'mcp-a',
        name: 'Alpha',
        status: 'active',
        proxyUrl: 'http://10.20.30.40:3000/api/mcp-proxy/agent-1/mcp-a',
        tools: [{ name: 'list' }],
      },
      {
        id: 'mcp-disabled',
        name: 'Disabled',
        status: 'auth_required',
        proxyUrl: 'http://10.20.30.40:3000/api/mcp-proxy/agent-1/mcp-disabled',
        tools: [],
      },
      {
        id: 'mcp-z',
        name: 'Zed',
        status: 'active',
        proxyUrl: 'http://10.20.30.40:3000/api/mcp-proxy/agent-1/mcp-z',
        tools: [{ name: 'search' }],
      },
    ])
  })

  it('writes active and reconnectable connected-account metadata grouped by toolkit', async () => {
    mockWhere.mockResolvedValue([
      {
        account: {
          id: 'slack-1',
          toolkitSlug: 'slack',
          displayName: 'Work Slack',
          status: 'active',
        },
      },
      {
        account: {
          id: 'gmail-expired',
          toolkitSlug: 'gmail',
          displayName: 'Old Gmail',
          status: 'expired',
        },
      },
      {
        account: {
          id: 'gmail-1',
          toolkitSlug: 'gmail',
          displayName: 'Work Gmail',
          status: 'active',
        },
      },
    ])

    await updateConnectedAccountsEnvironment('agent-1', {
      fetch: mockFetch,
      getHostApiBaseUrl: mockGetHostApiBaseUrl,
    } as never)

    const [, init] = mockFetch.mock.calls[0]
    const payload = JSON.parse(init.body as string)
    expect(payload.key).toBe('CONNECTED_ACCOUNTS')
    expect(JSON.parse(payload.value)).toEqual({
      gmail: [
        { name: 'Work Gmail', id: 'gmail-1', status: 'active' },
        { name: 'Old Gmail', id: 'gmail-expired', status: 'expired' },
      ],
      slack: [{ name: 'Work Slack', id: 'slack-1', status: 'active' }],
    })
  })

  it('reports a live refresh failure without throwing or changing persistence semantics', async () => {
    mockGetHostApiBaseUrl.mockRejectedValue(new Error('container unavailable'))

    await expect(
      syncAgentConnectionEnvironment('agent-1', 'remote-mcps'),
    ).resolves.toBe(false)
  })

  it('reports a rejected env update without throwing', async () => {
    mockWhere.mockResolvedValue([])
    mockFetch.mockResolvedValue(
      new Response('container unavailable', { status: 502 }),
    )

    await expect(
      syncAgentConnectionEnvironment('agent-1', 'connected-accounts'),
    ).resolves.toBe(false)
  })

  it('does not contact a stopped container because startup rebuilds the projection', async () => {
    mockGetCachedInfo.mockReturnValue({ status: 'stopped', port: null })

    await expect(
      syncAgentConnectionEnvironment('agent-1', 'connected-accounts'),
    ).resolves.toBe(true)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
