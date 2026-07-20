import { describe, expect, it } from 'vitest'
import type {
  AgentConnectedAccount,
  AgentRemoteMcp,
  ConnectedAccount,
  RemoteMcpServer,
} from '@shared/lib/db/schema'
import {
  toAgentConnectedAccountDto,
  toAgentRemoteMcpDto,
} from './public'

const createdAt = new Date('2026-07-18T10:00:00Z')
const updatedAt = new Date('2026-07-18T11:00:00Z')
const mappedAt = new Date('2026-07-18T12:00:00Z')

function account(overrides: Partial<ConnectedAccount> = {}): ConnectedAccount {
  return {
    id: 'account-1',
    providerConnectionId: 'provider-connection-1',
    providerName: 'composio',
    toolkitSlug: 'github',
    displayName: 'My GitHub',
    status: 'active',
    userId: 'owner-1',
    createdAt,
    updatedAt,
    ...overrides,
  }
}

function accountMapping(overrides: Partial<AgentConnectedAccount> = {}): AgentConnectedAccount {
  return {
    id: 'account-mapping-1',
    agentSlug: 'shared-agent',
    connectedAccountId: 'account-1',
    createdAt: mappedAt,
    ...overrides,
  }
}

function mcp(overrides: Partial<RemoteMcpServer> = {}): RemoteMcpServer {
  return {
    id: 'mcp-1',
    name: 'Private MCP',
    url: 'https://private.example.test/mcp',
    userId: 'owner-1',
    authType: 'bearer',
    accessToken: 'secret-access-token',
    refreshToken: 'secret-refresh-token',
    tokenExpiresAt: updatedAt,
    oauthTokenEndpoint: 'https://private.example.test/token',
    oauthClientId: 'secret-client-id',
    oauthClientSecret: 'secret-client-secret',
    oauthResource: 'private-resource',
    toolsJson: JSON.stringify([{ name: 'search', inputSchema: { type: 'object' } }]),
    toolsDiscoveredAt: updatedAt,
    status: 'active',
    errorMessage: null,
    createdAt,
    updatedAt,
    ...overrides,
  }
}

function mcpMapping(overrides: Partial<AgentRemoteMcp> = {}): AgentRemoteMcp {
  return {
    id: 'mcp-mapping-1',
    agentSlug: 'shared-agent',
    remoteMcpId: 'mcp-1',
    createdAt: mappedAt,
    ...overrides,
  }
}

describe('agent connection DTOs', () => {
  it('keeps a foreign account marker free of row, owner, and provider identifiers', () => {
    const result = toAgentConnectedAccountDto(accountMapping(), account(), 'viewer-2')

    expect(result).toEqual({ kind: 'connected-account', toolkitSlug: 'github' })
    expect(JSON.stringify(result)).not.toContain('account-1')
    expect(JSON.stringify(result)).not.toContain('owner-1')
    expect(JSON.stringify(result)).not.toContain('provider-connection-1')
  })

  it('returns safe owned account details without the owner id', () => {
    const result = toAgentConnectedAccountDto(accountMapping(), account(), 'owner-1')

    expect(result).toMatchObject({
      id: 'account-1',
      providerConnectionId: 'provider-connection-1',
      mappingId: 'account-mapping-1',
      createdAt: createdAt.toISOString(),
      mappedAt: mappedAt.toISOString(),
    })
    expect(result).not.toHaveProperty('userId')
  })

  it('preserves account details in single-user local mode', () => {
    const result = toAgentConnectedAccountDto(
      accountMapping(),
      account({ userId: null }),
      null,
    )

    expect(result).toMatchObject({ id: 'account-1', displayName: 'My GitHub' })
  })

  it('uses a fully opaque marker for a foreign MCP', () => {
    const result = toAgentRemoteMcpDto(mcpMapping(), mcp(), 'viewer-2')

    expect(result).toEqual({ kind: 'remote-mcp' })
    expect(JSON.stringify(result)).not.toContain('mcp-1')
    expect(JSON.stringify(result)).not.toContain('private.example.test')
    expect(JSON.stringify(result)).not.toContain('search')
  })

  it('returns safe owned MCP details without credentials or owner metadata', () => {
    const result = toAgentRemoteMcpDto(mcpMapping(), mcp(), 'owner-1')

    expect(result).toMatchObject({
      id: 'mcp-1',
      name: 'Private MCP',
      tools: [{ name: 'search', inputSchema: { type: 'object' } }],
      mappingId: 'mcp-mapping-1',
      mappedAt: mappedAt.toISOString(),
    })
    expect(result).not.toHaveProperty('userId')
    expect(result).not.toHaveProperty('accessToken')
    expect(result).not.toHaveProperty('refreshToken')
    expect(result).not.toHaveProperty('oauthClientSecret')
  })
})
