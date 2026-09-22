import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../../db/testing/create-test-database'
import type { AppDatabase } from '../../db/drivers/types'
import { createAgentIntegration, updateAgentIntegrationStatus, getAgentIntegration, listStartupAgentIntegrations } from '../../services/agent-integration-service'
import { checkLinearMcp } from './mcp'
import { getLinearConfig, updateLinearConfig } from './store'
import { McpDiscoveryError } from '../../mcp/discover-tools'
let handle: TestDatabase
let testDb: AppDatabase
let id: string
const mocks = vi.hoisted(() => ({ discover: vi.fn(), sync: vi.fn() }))
vi.mock('../../db', () => ({ get db() { return testDb } }))
vi.mock('../../mcp/discover-tools', async importOriginal => ({ ...await importOriginal<typeof import('../../mcp/discover-tools')>(), discoverTools: mocks.discover }))
vi.mock('../../services/connection-sync-service', () => ({ syncRemoteMcpAgents: mocks.sync }))
vi.mock('../../error-reporting', () => ({ captureException: vi.fn() }))
beforeEach(async () => {
  handle = await createTestDatabase(); testDb = handle.db
  mocks.discover.mockReset().mockResolvedValue([{ name: 'save_comment', inputSchema: { type: 'object' } }])
  mocks.sync.mockReset().mockResolvedValue(true)
  id = await createAgentIntegration({ agentSlug: 'agent', provider: 'linear', config: {
    redirectUri: 'http://localhost/callback', clientId: 'client', clientSecret: 'secret', authorizationVersion: 'v1',
    identity: { workspaceId: 'workspace', workspaceName: 'Test', appUserId: 'app', appName: 'Agent' },
    tokens: { accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3600000, scope: 'read write app:mentionable app:assignable' },
  } })
})
afterEach(async () => { await handle.close() })
describe('Linear MCP discovery and recovery', () => {
  it('coalesces probes, caches tools with the integration, and pushes runtime discovery', async () => {
    expect(await Promise.all([checkLinearMcp(id), checkLinearMcp(id)])).toEqual([true, true])
    expect(mocks.discover).toHaveBeenCalledTimes(1)
    expect(mocks.discover).toHaveBeenCalledWith('https://mcp.linear.app/mcp', 'access', expect.any(AbortSignal))
    expect((await getLinearConfig(id)).mcp).toMatchObject({ available: true, tools: [{ name: 'save_comment' }] })
    expect(mocks.sync).toHaveBeenCalledWith(['agent'])
    expect(await checkLinearMcp(id)).toBe(true)
    expect(mocks.discover).toHaveBeenCalledTimes(1)
  })
  it('retries transient failures without discarding authorization', async () => {
    mocks.discover.mockRejectedValueOnce(new McpDiscoveryError('unavailable', 503))
    expect(await checkLinearMcp(id)).toBe(false)
    expect(await getLinearConfig(id)).toMatchObject({ tokens: { accessToken: 'access' }, mcp: { available: false } })
    expect(await checkLinearMcp(id)).toBe(true)
  })
  it('marks the parent as reconnect needed if its token is rejected', async () => {
    mocks.discover.mockRejectedValue(new McpDiscoveryError('unauthorized', 401))
    expect(await checkLinearMcp(id)).toBe(false)
    expect((await getLinearConfig(id)).tokens).toBeUndefined()
    expect((await getLinearConfig(id)).authorizationError).toContain('Reconnect')
    expect((await getAgentIntegration(id))?.status).toBe('disconnected')
    expect((await listStartupAgentIntegrations()).some(row => row.id === id)).toBe(false)
  })
  it('does not overwrite a newer authorization with stale discovery', async () => {
    mocks.discover.mockImplementation(async () => {
      await updateLinearConfig(id, config => ({ ...config, authorizationVersion: 'v2', mcp: undefined }))
      return [{ name: 'stale_tool' }]
    })
    expect(await checkLinearMcp(id)).toBe(false)
    expect((await getLinearConfig(id)).mcp).toBeUndefined()
  })
  it('does not turn a runtime push failure into an MCP outage', async () => {
    mocks.sync.mockRejectedValue(new Error('container unavailable'))
    expect(await checkLinearMcp(id)).toBe(true)
    expect((await getLinearConfig(id)).mcp?.available).toBe(true)
  })
  it('does not probe paused parents', async () => {
    await updateAgentIntegrationStatus(id, 'paused')
    expect(await checkLinearMcp(id)).toBe(false)
    expect(mocks.discover).not.toHaveBeenCalled()
  })
})

it('does not revoke newer credentials or overwrite a pause after an MCP request starts', async () => {
  const { linearMcpConnection } = await import('./mcp')
  const connection = (await linearMcpConnection((await getAgentIntegration(id))!))!
  await connection.authorization()
  await updateLinearConfig(id, config => ({ ...config, authorizationVersion: 'v2', tokens: { ...config.tokens!, accessToken: 'new-access' } }))
  await connection.authRequired()
  expect((await getLinearConfig(id)).tokens?.accessToken).toBe('new-access')
  expect((await getAgentIntegration(id))?.status).toBe('active')
  const current = (await linearMcpConnection((await getAgentIntegration(id))!))!
  await current.authorization()
  await updateAgentIntegrationStatus(id, 'paused')
  await current.authRequired()
  expect((await getLinearConfig(id)).tokens).toBeUndefined()
  expect((await getAgentIntegration(id))?.status).toBe('paused')
})
