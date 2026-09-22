import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import type { AppDatabase } from '@shared/lib/db/drivers/types'
import { agentRemoteMcps, mcpAuditLog, remoteMcpServers } from '@shared/lib/db/schema'
import { createAgentIntegration, deleteAgentIntegration, getAgentIntegration, updateAgentIntegrationStatus } from '@shared/lib/services/agent-integration-service'
import { agentIntegrationRegistry, AgentIntegrationRegistry } from '@shared/lib/agent-integrations/registry'
import { integrationMcpName, integrationMcpProjection, resolveIntegrationMcp } from '@shared/lib/agent-integrations/mcp'
import { listAgentMcpConnections } from '@shared/lib/container/connection-runtime-projections'
import mcpProxy from './mcp-proxy'

let handle: TestDatabase
let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]) }))
vi.mock('@shared/lib/proxy/token-store', () => ({ validateProxyToken: vi.fn(async () => 'agent') }))
const policy = vi.hoisted(() => ({ resolve: vi.fn(), review: vi.fn(), reauth: vi.fn() }))
vi.mock('@shared/lib/proxy/policy-resolver', () => ({ resolveMcpPolicy: policy.resolve }))
vi.mock('@shared/lib/agent-actor', () => ({ agentRegistry: { get: () => ({ inputs: { reviews: { request: policy.review }, mcpReauth: { request: policy.reauth } } }) } }))
const fetchMock = vi.fn<typeof fetch>()
const authRequired = vi.fn<() => Promise<void>>()
const reportHealth = vi.fn<(available: boolean) => Promise<void>>()
const beforeAuthorization = vi.fn<() => Promise<void>>()
let id: string
let app: Hono
let connectionStatus: 'active' | 'auth_required'

beforeEach(async () => {
  handle = await createTestDatabase(); testDb = handle.db
  connectionStatus = 'active'
  vi.clearAllMocks(); vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockResolvedValue(Response.json({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'done' }] } }))
  authRequired.mockResolvedValue(undefined); reportHealth.mockResolvedValue(undefined); beforeAuthorization.mockResolvedValue(undefined)
  // An opt-in test provider exercises the contract without a Linear dependency.
  const registry = new AgentIntegrationRegistry([{
    definition: { provider: 'telegram', name: 'Test identity', family: 'test', capabilities: ['mcp'], settings: [], setup: { kind: 'test', credentialFields: [] } },
    policy: { isAllowed: async () => true, sessionPolicy: () => ({ name: 'Test', metadata: {} }) },
    create: async () => { throw new Error('Outbound discovery must not start inbound connectors') },
    mcp: async record => {
      if (record.name === 'Broken') throw new Error('Invalid provider configuration')
      return {
        integrationId: record.id, agentSlug: record.agentSlug, name: 'test_identity', url: 'https://mcp.example.com/mcp',
        identity: { provider: 'Test', name: 'Agent Identity', workspace: 'Test workspace' }, status: connectionStatus,
        tools: [{ name: 'send_message', inputSchema: { type: 'object' } }],
        async authorization() {
          await beforeAuthorization()
          const current = await getAgentIntegration(record.id)
          if (!current || current.agentSlug !== record.agentSlug || current.status === 'paused') throw new Error('Parent unavailable')
          return 'agent-secret'
        },
        authRequired, reportHealth,
      }
    },
  }])
  vi.spyOn(agentIntegrationRegistry, 'getMcpConnection').mockImplementation(record => registry.getMcpConnection(record))
  id = await createAgentIntegration({ agentSlug: 'agent', provider: 'telegram', config: { botToken: 'test-token' } })
  app = new Hono().route('/api/mcp-proxy', mcpProxy)
})
afterEach(async () => { await handle.close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function call(connectionId = `integration:${id}`, signal?: AbortSignal, sessionId?: string) {
  return app.request(`/api/mcp-proxy/agent/${connectionId}`, { method: 'POST', signal, headers: {
    ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    Authorization: 'Bearer container-token', 'Content-Type': 'application/json',
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message', arguments: { text: 'Test' } } }) })
}

describe('integration-owned MCP through the shared proxy', () => {
  it('exposes a token-free connection to the owning agent without a user MCP record', async () => {
    const projected = await integrationMcpProjection('agent', 'http://host')
    expect(projected).toMatchObject([{ id: `integration:${id}`, integration: { id, provider: 'Test', name: 'Agent Identity', workspace: 'Test workspace' }, tools: [{ name: 'send_message' }] }])
    expect(JSON.stringify(projected)).not.toContain('secret')
    expect(await testDb.select().from(remoteMcpServers)).toEqual([])
    expect(await integrationMcpProjection('other-agent', 'http://host')).toEqual([])
  })
  it('uses parent authorization without user policy/review and attributes the existing audit record', async () => {
    expect((await call()).status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(beforeAuthorization).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://mcp.example.com/mcp')
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer agent-secret')
    expect(policy.resolve).not.toHaveBeenCalled(); expect(policy.review).not.toHaveBeenCalled()
    expect(await testDb.select().from(mcpAuditLog)).toMatchObject([{ remoteMcpId: `integration:${id}`, agentSlug: 'agent', policyDecision: 'integration_identity', matchedTool: 'send_message', statusCode: 200 }])
  })
  it.each(['paused', 'deleted', 'foreign'] as const)('rejects a %s integration even from an existing session', async state => {
    const connection = await resolveIntegrationMcp('agent', `integration:${id}`)
    if (state === 'paused') await updateAgentIntegrationStatus(id, 'paused')
    if (state === 'deleted') await deleteAgentIntegration(id)
    if (state === 'foreign') id = await createAgentIntegration({ agentSlug: 'other-agent', provider: 'telegram', config: { botToken: 'other-token' } })
    expect((await call()).status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
    if (state !== 'foreign') await expect(connection!.authorization()).rejects.toThrow()
    if (state === 'paused') expect(await integrationMcpProjection('agent', 'http://host')).toEqual([])
  })
  it('delegates revocation to the parent without opening a separate MCP reauth flow', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }))
    const response = await call()
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'integration_reconnect_required', integrationId: id })
    expect(authRequired).toHaveBeenCalledOnce()
    expect(policy.reauth).not.toHaveBeenCalled()
    expect(await testDb.select().from(remoteMcpServers)).toEqual([])
  })
  it('reports an outage without revoking credentials', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }))
    expect((await call()).status).toBe(503)
    expect(reportHealth).toHaveBeenCalledWith(false)
    expect(authRequired).not.toHaveBeenCalled()
  })
  it('does not forward if parent authorization rejects after an asynchronous pause', async () => {
    beforeAuthorization.mockImplementation(async () => { await updateAgentIntegrationStatus(id, 'paused') })
    expect((await call()).status).toBe(502)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(reportHealth).not.toHaveBeenCalled()
  })
  it('isolates damaged and unsupported providers while projecting healthy connections', async () => {
    await createAgentIntegration({ agentSlug: 'agent', provider: 'telegram', name: 'Broken', config: { botToken: 'broken-token' } })
    const unsupported = await createAgentIntegration({ agentSlug: 'agent', provider: 'slack', config: { botToken: 'slack-token', appToken: 'app-token' } })
    expect(await integrationMcpProjection('agent', 'http://host')).toHaveLength(1)
    expect(await resolveIntegrationMcp('agent', `integration:${unsupported}`)).toBeNull()
  })
})


it('assigns distinct stable namespaces to two installations with the same provider name', async () => {
  const second = await createAgentIntegration({ agentSlug: 'agent', provider: 'telegram', config: { botToken: 'second-token' } })
  const projected = await integrationMcpProjection('agent', 'http://host')
  expect(new Set(projected.map(connection => connection.name))).toEqual(new Set([integrationMcpName(id), integrationMcpName(second)]))
  expect(projected.map(connection => connection.name)).not.toContain('test_identity')
})

it('reports a network failure as an outage', async () => {
  fetchMock.mockRejectedValue(new TypeError('fetch failed'))
  expect((await call()).status).toBe(502)
  expect(reportHealth).toHaveBeenCalledExactlyOnceWith(false)
})

it('does not report a cancelled request as an upstream outage', async () => {
  const abort = new AbortController()
  fetchMock.mockImplementation(async () => { abort.abort(); throw new DOMException('Cancelled', 'AbortError') })
  expect((await call(undefined, abort.signal)).status).toBe(502)
  expect(reportHealth).not.toHaveBeenCalled()
})

async function syntheticSession(): Promise<string> {
  connectionStatus = 'auth_required'
  const response = await app.request(`/api/mcp-proxy/agent/integration:${id}`, {
    method: 'POST', headers: { Authorization: 'Bearer container-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }),
  })
  expect(response.status).toBe(200)
  connectionStatus = 'active'
  return response.headers.get('Mcp-Session-Id')!
}

it('revalidates after a real handshake and authorizes established calls only once', async () => {
  const sessionId = await syntheticSession()
  fetchMock.mockResolvedValueOnce(Response.json({ result: {} }, { headers: { 'Mcp-Session-Id': 'upstream' } }))
    .mockResolvedValueOnce(new Response(null, { status: 202 }))
  expect((await call(undefined, undefined, sessionId)).status).toBe(200)
  expect(beforeAuthorization).toHaveBeenCalledTimes(2)
  expect(fetchMock).toHaveBeenCalledTimes(3)
  beforeAuthorization.mockClear(); fetchMock.mockClear()
  expect((await call(undefined, undefined, sessionId)).status).toBe(200)
  expect(beforeAuthorization).toHaveBeenCalledTimes(1)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('does not forward or report an outage when paused during an upstream handshake', async () => {
  const sessionId = await syntheticSession()
  fetchMock.mockResolvedValueOnce(Response.json({ result: {} }, { headers: { 'Mcp-Session-Id': 'upstream' } }))
    .mockImplementationOnce(async () => {
      await updateAgentIntegrationStatus(id, 'paused')
      return new Response(null, { status: 202 })
    })
  expect((await call(undefined, undefined, sessionId)).status).toBe(502)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(reportHealth).not.toHaveBeenCalled()
})

it.each([401, 503])('classifies handshake HTTP %i separately from cancellation and lifecycle rejection', async status => {
  const sessionId = await syntheticSession()
  fetchMock.mockResolvedValue(new Response(null, { status }))
  expect((await call(undefined, undefined, sessionId)).status).toBe(502)
  if (status === 503) expect(reportHealth).toHaveBeenCalledExactlyOnceWith(false)
  else { expect(reportHealth).not.toHaveBeenCalled(); expect(authRequired).toHaveBeenCalledOnce() }
})


it('discovers both ownership types together and keeps their credentials and permissions separate', async () => {
  const now = new Date()
  await testDb.insert(remoteMcpServers).values([
    { id: 'account', name: 'Personal account', url: 'https://mcp.example.com/personal',
      authType: 'bearer', accessToken: 'personal-secret', createdAt: now, updatedAt: now,
      toolsJson: JSON.stringify([{ name: 'send_message' }, { invalid: true }]) },
    { id: 'foreign', name: 'Unassigned account', url: 'https://mcp.example.com/foreign', createdAt: now, updatedAt: now },
  ])
  await testDb.insert(agentRemoteMcps).values({ id: 'mapping', agentSlug: 'agent', remoteMcpId: 'account', createdAt: now })
  const projected = await listAgentMcpConnections('agent', 'http://host')
  expect(projected.map(connection => connection.id)).toEqual(['account', `integration:${id}`])
  expect(projected[0]).toMatchObject({ name: 'Personal account', tools: [{ name: 'send_message' }] })
  expect(JSON.stringify(projected)).not.toContain('secret')

  policy.resolve.mockResolvedValue({ decision: 'block', matchedScopes: [], scopeDescriptions: {} })
  expect((await call('account')).status).toBe(403)
  expect(fetchMock).not.toHaveBeenCalled()
  expect((await call()).status).toBe(200)
  expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer agent-secret')

  policy.resolve.mockResolvedValue({ decision: 'allow', matchedScopes: [], scopeDescriptions: {} })
  expect((await call('account')).status).toBe(200)
  expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('Authorization')).toBe('Bearer personal-secret')
  expect(fetchMock.mock.calls[1][0]).toBe('https://mcp.example.com/personal')
  expect(beforeAuthorization).toHaveBeenCalledTimes(1)
  expect((await call('foreign')).status).toBe(404)
  expect(await testDb.select().from(mcpAuditLog)).toMatchObject([
    { remoteMcpId: 'account', policyDecision: 'block' },
    { remoteMcpId: `integration:${id}`, policyDecision: 'integration_identity' },
    { remoteMcpId: 'account', policyDecision: 'allow' },
  ])

  await updateAgentIntegrationStatus(id, 'paused')
  expect((await listAgentMcpConnections('agent', 'http://host')).map(connection => connection.id)).toEqual(['account'])
})
