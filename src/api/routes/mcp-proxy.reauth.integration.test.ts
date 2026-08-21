import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'

const mocks = vi.hoisted(() => ({
  currentMcp: null as Record<string, unknown> | null,
  safeFetch: vi.fn(),
  syncAwaiting: vi.fn(),
}))

vi.mock('@shared/lib/proxy/token-store', () => ({
  validateProxyToken: vi.fn().mockResolvedValue('agent-1'),
}))

vi.mock('@shared/lib/proxy/policy-resolver', () => ({
  resolveMcpPolicy: vi.fn().mockResolvedValue({
    decision: 'allow',
    matchedScopes: [],
    scopeDescriptions: {},
    resolvedFrom: 'global_default',
  }),
}))

vi.mock('@shared/lib/proxy/review-manager', () => ({
  reviewManager: { requestReview: vi.fn() },
}))

vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    syncAgentSessionsAwaiting: (...args: unknown[]) => mocks.syncAwaiting(...args),
  },
}))

vi.mock('@shared/lib/mcp/mcp-safe-fetch', () => ({
  mcpSafeFetch: (...args: unknown[]) => mocks.safeFetch(...args),
}))

vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => mocks.currentMcp ? [{ mcp: mocks.currentMcp }] : [],
          }),
        }),
      }),
    }),
    insert: () => ({ values: vi.fn().mockResolvedValue(undefined) }),
    update: () => ({
      set: () => ({ where: vi.fn().mockResolvedValue(undefined) }),
    }),
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  remoteMcpServers: { id: 'id' },
  agentRemoteMcps: { agentSlug: 'agent_slug', remoteMcpId: 'remote_mcp_id' },
  mcpAuditLog: {},
}))

vi.mock('drizzle-orm', () => ({
  eq: (column: string, value: string) => ({ column, value }),
  and: (...conditions: unknown[]) => conditions,
}))

import mcpProxy from './mcp-proxy'
import { mcpReauthManager } from '@shared/lib/proxy/mcp-reauth-manager'
import { userInputRequestManager } from '@shared/lib/user-input/request-manager'

function mcp(status: 'active' | 'auth_required', accessToken: string) {
  return {
    id: 'mcp-1',
    name: 'Stateful MCP',
    url: 'https://mcp.example.com',
    authType: 'oauth',
    accessToken,
    refreshToken: null,
    tokenExpiresAt: null,
    oauthTokenEndpoint: null,
    oauthClientId: null,
    oauthClientSecret: null,
    oauthResource: null,
    status,
    errorMessage: status === 'auth_required' ? 'Reconnect required' : null,
    toolsJson: JSON.stringify([{ name: 'search', inputSchema: { type: 'object' } }]),
    userId: 'owner-1',
  }
}

function rpcHeaders(sessionId?: string): Record<string, string> {
  return {
    Authorization: 'Bearer proxy-token',
    'Content-Type': 'application/json',
    ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
  }
}

function rpcBody(init: RequestInit): { id?: number; method: string } {
  const raw = init.body instanceof ArrayBuffer
    ? new TextDecoder().decode(init.body)
    : String(init.body)
  return JSON.parse(raw) as { id?: number; method: string }
}

describe('MCP re-auth park → reconnect → resume integration', () => {
  let app: Hono

  beforeEach(() => {
    userInputRequestManager.reset()
    mcpReauthManager.rejectAll()
    mocks.safeFetch.mockReset()
    mocks.syncAwaiting.mockReset()
    mocks.currentMcp = mcp('auth_required', 'stale-token')
    app = new Hono().route('/api/mcp-proxy', mcpProxy)
  })

  afterEach(() => {
    mcpReauthManager.rejectAll()
    userInputRequestManager.reset()
  })

  it('deduplicates the card and resumes concurrent calls on one real upstream session', async () => {
    const initialize = await app.request('http://localhost/api/mcp-proxy/agent-1/mcp-1', {
      method: 'POST',
      headers: rpcHeaders(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      }),
    })
    const clientSessionId = initialize.headers.get('Mcp-Session-Id')
    expect(clientSessionId).toBeTruthy()

    mocks.safeFetch.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = rpcBody(init)
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            serverInfo: { name: 'Stateful MCP', version: '1.0.0' },
          },
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Mcp-Session-Id': 'upstream-session-1',
          },
        })
      }
      if (body.method === 'notifications/initialized') {
        return new Response(null, { status: 202 })
      }
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: { content: [{ type: 'text', text: `result-${body.id}` }] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    const call = (id: number) => app.request(
      'http://localhost/api/mcp-proxy/agent-1/mcp-1',
      {
        method: 'POST',
        headers: rpcHeaders(clientSessionId!),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name: 'search', arguments: { query: `query-${id}` } },
        }),
      },
    )

    const first = call(2)
    const second = call(3)

    await vi.waitFor(() => {
      expect(userInputRequestManager.getAgentScopedRequests('agent-1')).toHaveLength(1)
    })
    expect(mocks.safeFetch).not.toHaveBeenCalled()

    mocks.currentMcp = mcp('active', 'fresh-token')
    expect(mcpReauthManager.completeMcp('mcp-1')).toBe(2)

    const responses = await Promise.all([first, second])
    const responseBodies = await Promise.all(responses.map((response) => response.clone().json()))
    expect(
      responses.map((response) => response.status),
      JSON.stringify(responseBodies),
    ).toEqual([200, 200])
    expect(userInputRequestManager.getAgentScopedRequests('agent-1')).toHaveLength(0)

    const forwardedMethods = mocks.safeFetch.mock.calls.map(([, init]) =>
      rpcBody(init as RequestInit).method)
    expect(forwardedMethods.filter((method) => method === 'initialize')).toHaveLength(1)
    expect(forwardedMethods.filter((method) => method === 'notifications/initialized')).toHaveLength(1)
    expect(forwardedMethods.filter((method) => method === 'tools/call')).toHaveLength(2)

    const toolCalls = mocks.safeFetch.mock.calls.filter(([, init]) =>
      rpcBody(init as RequestInit).method === 'tools/call')
    for (const [, init] of toolCalls) {
      const headers = (init as RequestInit).headers as Headers
      expect(headers.get('Authorization')).toBe('Bearer fresh-token')
      expect(headers.get('Mcp-Session-Id')).toBe('upstream-session-1')
    }
  })
})
