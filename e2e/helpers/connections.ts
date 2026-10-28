import { expect, type APIRequestContext } from '@playwright/test'

export interface TestRemoteMcp {
  id: string
  name: string
  url: string
  authType: 'none' | 'oauth' | 'bearer'
  status: 'active' | 'error' | 'auth_required'
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>
}

export async function listRemoteMcps(request: APIRequestContext): Promise<TestRemoteMcp[]> {
  const response = await request.get('/api/remote-mcps')
  expect(response.ok()).toBeTruthy()

  const body = await response.json() as { servers: TestRemoteMcp[] }
  return body.servers
}

export async function findRemoteMcpByUrl(
  request: APIRequestContext,
  url: string,
  name?: string,
): Promise<TestRemoteMcp | undefined> {
  const servers = await listRemoteMcps(request)
  return servers.find((server) => (
    server.url === url && (name === undefined || server.name === name)
  ))
}

export async function expectRemoteMcpByUrl(
  request: APIRequestContext,
  url: string,
  name: string,
): Promise<TestRemoteMcp> {
  await expect.poll(async () => {
    const server = await findRemoteMcpByUrl(request, url, name)
    return server?.id
  }, { timeout: 15000 }).toBeTruthy()

  const server = await findRemoteMcpByUrl(request, url, name)
  expect(server, `remote MCP "${name}" (${url}) not found`).toBeDefined()
  return server!
}

export async function createRemoteMcp(
  request: APIRequestContext,
  data: { name: string; url: string; authType?: 'none' | 'bearer'; accessToken?: string },
): Promise<TestRemoteMcp> {
  const response = await request.post('/api/remote-mcps', {
    data,
  })

  expect(response.ok()).toBeTruthy()
  const body = await response.json() as { server: TestRemoteMcp }
  expect(body.server.id).toBeTruthy()
  expect(body.server.name).toBe(data.name)
  expect(body.server.url).toBe(data.url)
  expect(body.server.status).toBe('active')
  await expectRemoteMcpByUrl(request, data.url, data.name)

  return body.server
}

export async function getAgentRemoteMcpIds(
  request: APIRequestContext,
  agentSlug: string,
): Promise<string[]> {
  const response = await request.get(`/api/agents/${agentSlug}/remote-mcps`)
  expect(response.ok()).toBeTruthy()

  const body = await response.json() as { mcps: Array<{ id: string }> }
  return body.mcps.map((mcp) => mcp.id)
}

export async function expectAgentHasRemoteMcp(
  request: APIRequestContext,
  agentSlug: string,
  mcpId: string,
) {
  await expect.poll(
    async () => getAgentRemoteMcpIds(request, agentSlug),
    { timeout: 10000, message: `agent ${agentSlug} never received MCP ${mcpId}` },
  ).toContain(mcpId)
}

export async function expectAgentMissingRemoteMcp(
  request: APIRequestContext,
  agentSlug: string,
  mcpId: string,
) {
  await expect.poll(
    async () => getAgentRemoteMcpIds(request, agentSlug),
    { timeout: 10000, message: `agent ${agentSlug} still has MCP ${mcpId}` },
  ).not.toContain(mcpId)
}

export async function assignRemoteMcpToAgent(
  request: APIRequestContext,
  agentSlug: string,
  mcpId: string,
) {
  const response = await request.post(`/api/agents/${agentSlug}/remote-mcps`, {
    data: { mcpIds: [mcpId] },
  })

  expect(response.ok()).toBeTruthy()
  await expectAgentHasRemoteMcp(request, agentSlug, mcpId)
}
