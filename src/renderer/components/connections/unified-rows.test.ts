import { describe, it, expect } from 'vitest'
import { buildUnifiedRows } from './unified-rows'
import { COMMON_MCP_SERVERS } from '@shared/lib/mcp/common-servers'
import type { ConnectedAccount } from '@renderer/hooks/use-connected-accounts'
import type { RemoteMcpServer } from '@renderer/hooks/use-remote-mcps'

function account(overrides: Partial<ConnectedAccount> = {}): ConnectedAccount {
  return {
    id: 'a1',
    providerConnectionId: 'comp-1',
    providerName: 'composio',
    toolkitSlug: 'slack',
    displayName: 'Slack',
    status: 'active',
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  }
}

function mcp(overrides: Partial<RemoteMcpServer> = {}): RemoteMcpServer {
  return {
    id: 'm1',
    name: 'Custom MCP',
    url: 'https://custom.example.com/mcp',
    authType: 'none',
    status: 'active',
    errorMessage: null,
    tools: [],
    toolsDiscoveredAt: null,
    createdAt: '2026-04-15T00:00:00.000Z',
    updatedAt: '2026-04-15T00:00:00.000Z',
    ...overrides,
  }
}

describe('buildUnifiedRows', () => {
  it('returns an empty list when both inputs are empty', () => {
    expect(buildUnifiedRows({ allAccounts: [], allMcps: [] })).toEqual([])
  })

  it('interleaves accounts and MCPs sorted by date desc', () => {
    const rows = buildUnifiedRows({
      allAccounts: [
        account({ id: 'a-old', displayName: 'Old account', createdAt: '2026-01-01T00:00:00.000Z' }),
        account({ id: 'a-new', displayName: 'New account', createdAt: '2026-05-01T00:00:00.000Z' }),
      ],
      allMcps: [
        mcp({ id: 'm-mid', name: 'Mid MCP', createdAt: '2026-03-01T00:00:00.000Z' }),
      ],
    })
    expect(rows.map((r) => r.name)).toEqual(['New account', 'Mid MCP', 'Old account'])
  })

  it('flags rows as granted based on agent id sets', () => {
    const rows = buildUnifiedRows({
      allAccounts: [account({ id: 'a1' }), account({ id: 'a2' })],
      allMcps: [mcp({ id: 'm1' })],
      agentAccountIds: new Set(['a1']),
      agentMcpIds: new Set(),
    })
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.granted]))
    expect(byId).toEqual({ a1: true, a2: false, m1: false })
  })

  it('defaults granted to false when no agent id sets are passed (global view)', () => {
    const rows = buildUnifiedRows({
      allAccounts: [account({ id: 'a1' })],
      allMcps: [mcp({ id: 'm1' })],
    })
    expect(rows.every((r) => r.granted === false)).toBe(true)
  })

  it('lets grantOverrides take precedence over server state', () => {
    const rows = buildUnifiedRows({
      allAccounts: [account({ id: 'a1' })],
      allMcps: [mcp({ id: 'm1' })],
      agentAccountIds: new Set(['a1']), // a1 currently granted on server
      agentMcpIds: new Set(),           // m1 currently not granted
      grantOverrides: {
        'account-a1': false, // optimistic revoke
        'mcp-m1': true,      // optimistic grant
      },
    })
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.granted]))
    expect(byKey).toEqual({ 'account-a1': false, 'mcp-m1': true })
  })

  it('resolves the MCP icon slug from COMMON_MCP_SERVERS by URL', () => {
    const known = COMMON_MCP_SERVERS[0]
    if (!known) return // sanity guard; test is meaningful only if catalog is non-empty
    const rows = buildUnifiedRows({
      allAccounts: [],
      allMcps: [mcp({ id: 'm-known', url: known.url, name: known.displayName })],
    })
    expect(rows[0].iconSlug).toBe(known.slug)
    expect(rows[0].iconFallback).toBe('blocks')
  })

  it('falls back to undefined iconSlug for custom (unknown) MCP URLs', () => {
    const rows = buildUnifiedRows({
      allAccounts: [],
      allMcps: [mcp({ url: 'https://nowhere.example.com/mcp' })],
    })
    expect(rows[0].iconSlug).toBeUndefined()
  })

  it('propagates accountStatus from connected account to unified row', () => {
    const rows = buildUnifiedRows({
      allAccounts: [
        account({ id: 'a-active', status: 'active' }),
        account({ id: 'a-expired', status: 'expired' }),
        account({ id: 'a-revoked', status: 'revoked' }),
      ],
      allMcps: [],
    })
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.accountStatus]))
    expect(byId).toEqual({
      'a-active': 'active',
      'a-expired': 'expired',
      'a-revoked': 'revoked',
    })
  })

  it('does not set accountStatus on MCP rows', () => {
    const rows = buildUnifiedRows({
      allAccounts: [],
      allMcps: [mcp({ id: 'm1' })],
    })
    expect(rows[0].accountStatus).toBeUndefined()
  })

  it('uses the toolkit slug as the OAuth row icon and exposes toolkit on the row', () => {
    const rows = buildUnifiedRows({
      allAccounts: [account({ id: 'a-slack', toolkitSlug: 'slack' })],
      allMcps: [],
    })
    expect(rows[0].iconSlug).toBe('slack')
    expect(rows[0].iconFallback).toBe('oauth')
    expect(rows[0].toolkit).toBe('slack')
    expect(rows[0].type).toBe('oauth')
  })
})
