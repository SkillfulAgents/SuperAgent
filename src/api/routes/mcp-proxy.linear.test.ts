import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { z } from 'zod'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import type { AppDatabase } from '@shared/lib/db/drivers/types'
import { mcpAuditLog, remoteMcpServers } from '@shared/lib/db/schema'
import { createAgentIntegration, deleteAgentIntegration, updateAgentIntegrationStatus } from '@shared/lib/services/agent-integration-service'
import { getLinearConfig, updateLinearConfig } from '@shared/lib/task-manager-integrations/linear/store'
import { LinearClient } from '@shared/lib/task-manager-integrations/linear/client'
import { integrationMcpProjection, resolveIntegrationMcp } from '@shared/lib/agent-integrations/mcp'
import mcpProxy from './mcp-proxy'

let handle: TestDatabase
let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]) }))
vi.mock('@shared/lib/proxy/token-store', () => ({ validateProxyToken: vi.fn(async () => 'agent') }))
vi.mock('@shared/lib/services/connection-sync-service', () => ({ syncRemoteMcpAgents: vi.fn(async () => true) }))
const policy = vi.hoisted(() => ({ resolve: vi.fn(() => ({ action: 'block' })), review: vi.fn(), reauth: vi.fn() }))
vi.mock('@shared/lib/proxy/policy-resolver', () => ({ resolveMcpPolicy: policy.resolve }))
vi.mock('@shared/lib/agent-actor', () => ({ agentRegistry: { get: () => ({ inputs: { reviews: { request: policy.review }, mcpReauth: { request: policy.reauth } } }) } }))
const fetchMock = vi.fn<typeof fetch>()
let id: string
let app: Hono
beforeEach(async () => {
  handle = await createTestDatabase(); testDb = handle.db
  vi.clearAllMocks(); vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockResolvedValue(Response.json({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'created TES-1' }] } }))
  id = await createAgentIntegration({ agentSlug: 'agent', provider: 'linear', config: {
    redirectUri: 'http://localhost/callback', clientId: 'client', clientSecret: 'client-secret', authorizationVersion: 'v1',
    identity: { workspaceId: 'workspace', workspaceName: 'Test', appUserId: 'app-user', appName: 'Agent Identity' },
    tokens: { accessToken: 'agent-secret', refreshToken: 'refresh-secret', expiresAt: Date.now() + 3600000, scope: 'read write app:mentionable app:assignable' },
    mcp: { available: true, checkedAt: Date.now(), tools: [{ name: 'save_issue', inputSchema: { type: 'object' } }] },
  } })
  app = new Hono().route('/api/mcp-proxy', mcpProxy)
})
afterEach(async () => { await handle.close(); vi.unstubAllGlobals() })
function call(connectionId = `integration:${id}`, method = 'tools/call') {
  return app.request(`/api/mcp-proxy/agent/${connectionId}`, { method: 'POST', headers: {
    Authorization: 'Bearer container-token', 'Content-Type': 'application/json',
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { name: 'save_issue', arguments: { title: 'Test' } } }) })
}

describe('integration-owned MCP through the shared proxy', () => {
  it('exposes a token-free connection in general sessions without a user MCP record', async () => {
    const projected = await integrationMcpProjection('agent', 'http://host')
    expect(projected).toMatchObject([{ id: `integration:${id}`, integration: { id, provider: 'Linear', name: 'Agent Identity', workspace: 'Test' }, tools: [{ name: 'save_issue' }] }])
    expect(JSON.stringify(projected)).not.toContain('secret')
    expect(await testDb.select().from(remoteMcpServers)).toEqual([])
    expect(await integrationMcpProjection('other-agent', 'http://host')).toEqual([])
  })
  it('authenticates as the parent identity without user policy/review and attributes the audit', async () => {
    const response = await call()
    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://mcp.linear.app/mcp')
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer agent-secret')
    expect(policy.resolve).not.toHaveBeenCalled(); expect(policy.review).not.toHaveBeenCalled()
    expect(await testDb.select().from(mcpAuditLog)).toMatchObject([{ remoteMcpId: `integration:${id}`, agentSlug: 'agent', policyDecision: 'integration_identity', matchedTool: 'save_issue', statusCode: 200 }])
  })
  it('shares one rotating credential store with concurrent inbound API work', async () => {
    await updateLinearConfig(id, config => ({ ...config, tokens: { ...config.tokens!, expiresAt: 1 } }))
    fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith('/oauth/token')) return Response.json({ access_token: 'rotated-secret', refresh_token: 'next-refresh', expires_in: 3600, scope: 'read write app:mentionable app:assignable' })
      return Response.json(String(url).endsWith('/graphql') ? { data: { ok: true } } : { result: {} })
    })
    const [response] = await Promise.all([call(), new LinearClient(id).request('query{ok}', {}, z.object({ ok: z.boolean() }))])
    expect(response.status).toBe(200)
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/oauth/token'))).toHaveLength(1)
    expect(new Headers(fetchMock.mock.calls.find(([url]) => String(url).includes('mcp.linear.app'))![1]?.headers).get('Authorization')).toBe('Bearer rotated-secret')
    expect((await getLinearConfig(id)).tokens?.refreshToken).toBe('next-refresh')
  })
  it.each(['paused', 'deleted', 'foreign'] as const)('rejects a %s integration even from an existing session', async state => {
    const connection = await resolveIntegrationMcp('agent', `integration:${id}`)
    if (state === 'paused') await updateAgentIntegrationStatus(id, 'paused')
    if (state === 'deleted') await deleteAgentIntegration(id)
    if (state === 'foreign') {
      id = await createAgentIntegration({ agentSlug: 'other-agent', provider: 'linear', config: {} })
    }
    expect((await call()).status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
    if (state !== 'foreign') await expect(connection!.authorization()).rejects.toThrow()
    if (state === 'paused') expect(await integrationMcpProjection('agent', 'http://host')).toEqual([])
  })
  it('requires parent reconnect after revocation, without opening a separate MCP reauth flow', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }))
    const response = await call()
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'integration_reconnect_required', integrationId: id })
    expect((await getLinearConfig(id)).tokens).toBeUndefined()
    expect(policy.reauth).not.toHaveBeenCalled()
    expect(await testDb.select().from(remoteMcpServers)).toEqual([])
  })
  it('retains credentials on an outage and records the degraded outbound health', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }))
    expect((await call()).status).toBe(503)
    expect(await getLinearConfig(id)).toMatchObject({ tokens: { accessToken: 'agent-secret' }, mcp: { available: false } })
  })
  it('does not let a late 401 erase a newer authorization', async () => {
    fetchMock.mockImplementation(async () => {
      await updateLinearConfig(id, config => ({ ...config, authorizationVersion: 'v2', tokens: { ...config.tokens!, accessToken: 'new-secret' } }))
      return new Response(null, { status: 401 })
    })
    await call()
    expect((await getLinearConfig(id)).tokens?.accessToken).toBe('new-secret')
  })
  it('does not forward if the parent is paused while its token refresh is in flight', async () => {
    await updateLinearConfig(id, config => ({ ...config, tokens: { ...config.tokens!, expiresAt: 1 } }))
    fetchMock.mockImplementation(async () => {
      await updateAgentIntegrationStatus(id, 'paused')
      return Response.json({ access_token: 'rotated', refresh_token: 'rotated-refresh', expires_in: 3600, scope: 'read write app:mentionable app:assignable' })
    })
    expect((await call()).status).toBe(502)
    expect(fetchMock.mock.calls.every(([url]) => String(url).endsWith('/oauth/token'))).toBe(true)
  })
})
