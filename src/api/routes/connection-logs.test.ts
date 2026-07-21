import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'

const mocks = vi.hoisted(() => ({
  resourceRows: [] as unknown[],
  auditRows: [] as unknown[],
  total: 0,
  selected: vi.fn(),
  limited: vi.fn(),
  offset: vi.fn(),
  viewerUserId: 'user-1' as string | null,
  ownerScope: vi.fn(),
}))

vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (_c: unknown, next: () => Promise<void>) => next(),
}))

vi.mock('@shared/lib/auth/ownership', () => ({
  ownerScope: (...args: unknown[]) => mocks.ownerScope(...args),
}))

vi.mock('@shared/lib/db/schema', () => ({
  connectedAccounts: { table: 'accounts', id: 'account_id', userId: 'account_user_id' },
  remoteMcpServers: { table: 'mcps', id: 'mcp_id', userId: 'mcp_user_id' },
  proxyAuditLog: { table: 'proxy_logs', accountId: 'account_id', createdAt: 'created_at' },
  mcpAuditLog: { table: 'mcp_logs', remoteMcpId: 'remote_mcp_id', createdAt: 'created_at' },
}))

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ and: conditions }),
  count: () => 'count',
  desc: (column: unknown) => ({ desc: column }),
  eq: (column: unknown, value: unknown) => ({ eq: [column, value] }),
}))

vi.mock('@shared/lib/db', () => ({
  db: {
    select: (selection?: unknown) => {
      mocks.selected(selection)
      return {
        from: (table: { table: string }) => {
          if (table.table === 'accounts' || table.table === 'mcps') {
            return {
              where: () => ({
                limit: () => Promise.resolve(mocks.resourceRows),
              }),
            }
          }
          if (selection) {
            return {
              where: () => Promise.resolve([{ count: mocks.total }]),
            }
          }
          return {
            where: () => ({
              orderBy: () => ({
                limit: (limit: number) => {
                  mocks.limited(limit)
                  return {
                    offset: (offset: number) => {
                      mocks.offset(offset)
                      return Promise.resolve(mocks.auditRows)
                    },
                  }
                },
              }),
            }),
          }
        },
      }
    },
  },
}))

import connectionLogsRouter from './connection-logs'

function createApp() {
  const app = new Hono()
  app.route('/api/connection-logs', connectionLogsRouter)
  return app
}

describe('connection request logs API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resourceRows = [{ id: 'connection-1' }]
    mocks.auditRows = []
    mocks.total = 0
    mocks.viewerUserId = 'user-1'
    mocks.ownerScope.mockImplementation((_context, column) => (
      mocks.viewerUserId === null ? undefined : { eq: [column, mocks.viewerUserId] }
    ))
  })

  it('returns normalized, paginated API requests for an owned account', async () => {
    mocks.auditRows = [{
      id: 'request-1',
      agentSlug: 'agent-1',
      accountId: 'connection-1',
      toolkit: 'github',
      targetHost: 'https://api.github.com',
      targetPath: 'repos/openai/codex',
      method: 'GET',
      statusCode: 200,
      errorMessage: null,
      durationMs: 42,
      policyDecision: 'allow',
      matchedScopes: '["repo.read"]',
      createdAt: new Date('2026-07-20T12:00:00.000Z'),
    }]
    mocks.total = 31

    const response = await createApp().request(
      'http://localhost/api/connection-logs/account/connection-1?offset=15&limit=15',
    )

    expect(response.status).toBe(200)
    expect(mocks.limited).toHaveBeenCalledWith(15)
    expect(mocks.offset).toHaveBeenCalledWith(15)
    expect(await response.json()).toEqual({
      entries: [{
        id: 'request-1',
        source: 'proxy',
        agentSlug: 'agent-1',
        label: 'github',
        targetUrl: 'https://api.github.com/repos/openai/codex',
        method: 'GET',
        statusCode: 200,
        errorMessage: null,
        durationMs: 42,
        policyDecision: 'allow',
        matchedScopes: '["repo.read"]',
        createdAt: '2026-07-20T12:00:00.000Z',
      }],
      total: 31,
    })
  })

  it('normalizes MCP tool calls for a server connection', async () => {
    mocks.auditRows = [{
      id: 'request-2',
      agentSlug: 'agent-2',
      remoteMcpId: 'connection-1',
      remoteMcpName: 'Docs',
      method: 'POST',
      requestPath: '/tools/call',
      statusCode: 500,
      errorMessage: 'upstream failed',
      durationMs: 90,
      policyDecision: null,
      matchedTool: 'search_docs',
      createdAt: new Date('2026-07-20T13:00:00.000Z'),
    }]
    mocks.total = 1

    const response = await createApp().request('http://localhost/api/connection-logs/mcp/connection-1')
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.entries[0]).toMatchObject({
      source: 'mcp',
      agentSlug: 'agent-2',
      targetUrl: '/tools/call',
      matchedScopes: '["search_docs"]',
    })
  })

  it('falls back to safe pagination defaults for invalid query values', async () => {
    const response = await createApp().request(
      'http://localhost/api/connection-logs/account/connection-1?offset=invalid&limit=invalid',
    )

    expect(response.status).toBe(200)
    expect(mocks.limited).toHaveBeenCalledWith(20)
    expect(mocks.offset).toHaveBeenCalledWith(0)
  })

  it('does not expose logs when the owned connection cannot be resolved', async () => {
    mocks.resourceRows = []

    const response = await createApp().request('http://localhost/api/connection-logs/account/other-user-account')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Connection not found' })
    expect(mocks.limited).not.toHaveBeenCalled()
  })

  it('rejects an unknown connection kind', async () => {
    const response = await createApp().request('http://localhost/api/connection-logs/unknown/connection-1')

    expect(response.status).toBe(400)
    expect(mocks.selected).not.toHaveBeenCalled()
  })
})
