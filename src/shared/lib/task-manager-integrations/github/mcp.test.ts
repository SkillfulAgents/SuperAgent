import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../../db/testing/create-test-database'
import type { AppDatabase } from '../../db/drivers/types'
let handle: TestDatabase
let testDb: AppDatabase
vi.mock('../../db', () => ({ get db() { return testDb } }))
vi.mock('../../error-reporting', () => ({ captureException: vi.fn() }))
vi.mock('../../services/connection-sync-service', () => ({ syncRemoteMcpAgents: vi.fn(async () => {}) }))
vi.mock('../../mcp/discover-tools', async original => ({ ...await original<object>(), discoverTools: vi.fn() }))
import { discoverTools, McpDiscoveryError } from '../../mcp/discover-tools'
import { syncRemoteMcpAgents } from '../../services/connection-sync-service'
import { createAgentIntegration, getAgentIntegration, updateAgentIntegration } from '../../services/agent-integration-service'
import { configured } from './test-fixtures'
import { readGitHubIntegration, updateGitHubConfig } from './store'
import { checkGitHubMcp, githubMcpConnection, GITHUB_MCP_URL } from './mcp'
const tools = [{ name: 'create_issue', description: 'Create an issue', inputSchema: { type: 'object' } }]
let id: string
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
beforeEach(async () => {
  handle = await createTestDatabase(); testDb = handle.db; vi.resetAllMocks()
  id = await createAgentIntegration({ agentSlug: 'agent', provider: 'github', config: configured })
  vi.mocked(discoverTools).mockResolvedValue(tools)
  fetchMock = vi.fn<typeof fetch>(async () => Response.json({ token: 'app-token', expires_at: new Date(Date.now() + 3600000).toISOString() }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(async () => { await handle.close(); vi.unstubAllGlobals() })
const connection = async () => githubMcpConnection((await getAgentIntegration(id))!)!
it('discovers once with installation credentials and publishes tools through the common MCP projection', async () => {
  expect(await Promise.all([checkGitHubMcp(id), checkGitHubMcp(id)])).toEqual([true, true])
  expect(await checkGitHubMcp(id)).toBe(true)
  expect(discoverTools).toHaveBeenCalledExactlyOnceWith(GITHUB_MCP_URL, 'app-token', expect.any(AbortSignal))
  expect(syncRemoteMcpAgents).toHaveBeenCalledExactlyOnceWith(['agent'])
  expect((await connection()).identity).toMatchObject({ name: 'release-helper[bot]', workspace: 'team' })
  expect((await connection()).tools).toEqual(tools)
})
it('does not classify container refresh failures as upstream MCP outages', async () => {
  vi.mocked(syncRemoteMcpAgents).mockRejectedValueOnce(new Error('container offline'))
  expect(await checkGitHubMcp(id)).toBe(true)
  expect((await readGitHubIntegration(id)).config.mcp?.available).toBe(true)
})
it('rejects paused and stale projections without passing credentials to the proxy', async () => {
  const old = await connection()
  await updateAgentIntegration(id, { status: 'paused' })
  await expect(old.authorization()).rejects.toThrow('not active')
  expect((await connection()).status).toBe('auth_required')
  await updateAgentIntegration(id, { status: 'active' })
  await updateGitHubConfig(id, config => ({ ...config, authorizationVersion: 'replacement' }))
  await expect(old.authorization()).rejects.toThrow('changed')
  await old.reportHealth(false)
  expect((await readGitHubIntegration(id)).config.mcp).toBeUndefined()
  expect(fetchMock).not.toHaveBeenCalled()
})
it('renews rejected MCP tokens without mistaking a remote 401 for revoked app authorization', async () => {
  vi.mocked(discoverTools).mockRejectedValueOnce(new McpDiscoveryError('expired', 401))
  expect(await checkGitHubMcp(id)).toBe(false)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect((await readGitHubIntegration(id)).row.status).toBe('active')
  expect(await checkGitHubMcp(id)).toBe(true)
})
it('propagates conclusive revocation discovered through the proxy to reconnect-needed', async () => {
  const current = await connection()
  await current.authorization()
  fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }))
  await expect(current.authRequired()).rejects.toThrow()
  expect((await readGitHubIntegration(id)).row.status).toBe('disconnected')
})
it('lets replacement discovery proceed while old discovery finishes late', async () => {
  let finish!: (value: typeof tools) => void
  vi.mocked(discoverTools).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const pending = checkGitHubMcp(id)
  await vi.waitFor(() => expect(discoverTools).toHaveBeenCalledOnce())
  await updateGitHubConfig(id, config => ({ ...config, authorizationVersion: 'replacement' }))
  expect(await checkGitHubMcp(id)).toBe(true)
  expect(discoverTools).toHaveBeenCalledTimes(2)
  finish(tools)
  expect(await pending).toBe(false)
  expect((await readGitHubIntegration(id)).config.mcp?.tools).toEqual(tools)
})
