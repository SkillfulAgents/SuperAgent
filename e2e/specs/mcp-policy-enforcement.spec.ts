import { test, expect, type APIRequestContext, type TestInfo } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'
import { AppPage } from '../pages/app.page'
import { SessionPage } from '../pages/session.page'
import {
  createAgent,
  createSession,
  openAgentSession,
  uniqueName,
  waitForPendingProxyReview,
  expectPendingProxyReviewResolved,
  type TestAgent,
  type TestSession,
} from '../helpers/agents'
import { createRemoteMcp, assignRemoteMcpToAgent, type TestRemoteMcp } from '../helpers/connections'
import { startMockMcpServer, type MockMcpServer } from '../helpers/mock-mcp-server'

/**
 * MCP tool-policy enforcement — the product's main MCP safety mechanism, which
 * had zero E2E coverage at every layer. These tests drive the real proxy
 * (src/api/routes/mcp-proxy.ts) the way an agent container does: a JSON-RPC
 * tools/call with the agent's Bearer proxy token, against a real (mock) remote
 * MCP server whose received calls are recorded so we can prove a blocked call
 * never reaches upstream — not merely that the proxy returned 403.
 *
 * Two harness unlocks make this reachable (both in this batch):
 * - MockContainerClient.start now writes the agent's PROXY_TOKEN to the E2E
 *   recorder (there is deliberately no HTTP endpoint that returns it), so a
 *   spec can authenticate to the proxy as the container would;
 * - the mock MCP server now answers tools/call and records what it received.
 *
 * The proxy path is an ordinary API route (no auth-mode / real-container gate),
 * so each test owns its agent, session, mock MCP server, and policies, keeping
 * the whole file parallel-safe.
 */

const E2E_DATA_DIR = path.resolve(process.cwd(), process.env.SUPERAGENT_DATA_DIR ?? '.e2e-data')
const RECORDER_FILE = path.join(E2E_DATA_DIR, '.e2e-mock-recorder.jsonl')

interface MockRecord {
  type: string
  agentSlug: string
  proxyToken?: string
  timestamp: string
}

function readRecords(): MockRecord[] {
  if (!fs.existsSync(RECORDER_FILE)) return []
  return fs
    .readFileSync(RECORDER_FILE, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as MockRecord)
}

// The recorder file is shared across workers, so the predicate MUST filter by
// a test-unique attribute (the agent slug) — never assume it starts empty.
async function waitForRecord(predicate: (r: MockRecord) => boolean, timeoutMs = 12000): Promise<MockRecord> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const found = readRecords().find(predicate)
    if (found) return found
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('Timed out waiting for container_start recorder record')
}

type PolicyDecision = 'allow' | 'review' | 'block'

interface McpAuditEntry {
  matchedTool?: string
  policyDecision?: string
  requestPath?: string
  statusCode?: number
  remoteMcpName?: string
}

test.describe('MCP tool-policy enforcement', () => {
  const openServers: MockMcpServer[] = []

  test.afterEach(async () => {
    for (const server of openServers.splice(0)) {
      await server.close()
    }
  })

  async function setupMcpAgent(
    request: APIRequestContext,
    testInfo: TestInfo,
    label: string,
  ): Promise<{ agent: TestAgent; session: TestSession; mcp: TestRemoteMcp; mockMcp: MockMcpServer; proxyToken: string }> {
    const agent = await createAgent(request, uniqueName(testInfo, label))

    // Creating a session wakes the (mock) container, which writes its
    // PROXY_TOKEN to the recorder — the credential the proxy expects.
    const session = await createSession(request, agent, `wake ${uniqueName(testInfo, 'mcp')}`)
    const record = await waitForRecord((r) => r.type === 'container_start' && r.agentSlug === agent.slug)
    const proxyToken = record.proxyToken
    expect(proxyToken, 'proxy token exposed to the container').toBeTruthy()

    const mockMcp = await startMockMcpServer(0)
    openServers.push(mockMcp)

    // Connecting verifies the server + discovers its tools (initialize +
    // tools/list) before saving; then map it onto the agent.
    const mcp = await createRemoteMcp(request, { name: uniqueName(testInfo, 'Mock MCP'), url: mockMcp.url, authType: 'none' })
    await assignRemoteMcpToAgent(request, agent.slug, mcp.id)

    return { agent, session, mcp, mockMcp, proxyToken: proxyToken! }
  }

  async function setPolicies(
    request: APIRequestContext,
    mcpId: string,
    policies: Array<{ toolName: string; decision: PolicyDecision }>,
  ) {
    const res = await request.put(`/api/policies/tool/${mcpId}`, { data: { policies } })
    expect(res.ok(), `set policies ${res.status()}`).toBeTruthy()
  }

  function callTool(
    request: APIRequestContext,
    agentSlug: string,
    mcpId: string,
    proxyToken: string,
    toolName: string,
    args: Record<string, unknown> = {},
  ) {
    return request.post(`/api/mcp-proxy/${agentSlug}/${mcpId}`, {
      headers: { Authorization: `Bearer ${proxyToken}`, 'Content-Type': 'application/json' },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: args } },
      timeout: 30000,
      failOnStatusCode: false,
    })
  }

  async function getMcpAuditLog(request: APIRequestContext, agentSlug: string): Promise<McpAuditEntry[]> {
    const res = await request.get(`/api/agents/${agentSlug}/mcp-audit-log?limit=100`)
    expect(res.ok()).toBeTruthy()
    const body = await res.json() as { entries: McpAuditEntry[] }
    return body.entries
  }

  test('a blocked tool returns 403 and never reaches upstream, while an allowed tool forwards', async ({ request }, testInfo) => {
    const { agent, mcp, mockMcp, proxyToken } = await setupMcpAgent(request, testInfo, 'MCP Block Allow')

    // hello_world is explicitly blocked; everything else (the '*' default) is
    // allowed. Enforcement must happen at the proxy, before the upstream call.
    await setPolicies(request, mcp.id, [
      { toolName: 'hello_world', decision: 'block' },
      { toolName: '*', decision: 'allow' },
    ])

    const blocked = await callTool(request, agent.slug, mcp.id, proxyToken, 'hello_world', { name: 'e2e' })
    expect(blocked.status()).toBe(403)
    expect((await blocked.json()).error).toBe('blocked_by_policy')
    // The upstream server never saw it — the security contract, not just the status
    expect(mockMcp.toolCalls.map((c) => c.name)).not.toContain('hello_world')

    const allowed = await callTool(request, agent.slug, mcp.id, proxyToken, 'get_weather', { city: 'Denver' })
    expect(allowed.status()).toBe(200)
    // This one forwarded, with its arguments intact
    await expect.poll(() => mockMcp.toolCalls.map((c) => c.name)).toContain('get_weather')
    expect(mockMcp.toolCalls.find((c) => c.name === 'get_weather')?.arguments).toEqual({ city: 'Denver' })

    // Both decisions are audited with their tool + outcome
    await expect.poll(async () => {
      const entries = await getMcpAuditLog(request, agent.slug)
      return entries.some((e) => e.matchedTool === 'hello_world' && e.policyDecision === 'block')
        && entries.some((e) => e.matchedTool === 'get_weather' && e.policyDecision === 'allow')
    }, { timeout: 10000 }).toBe(true)
  })

  test('a review-default tool raises the review card: approve forwards, deny returns denied_by_user', async ({ page, request }, testInfo) => {
    const { agent, session, mcp, mockMcp, proxyToken } = await setupMcpAgent(request, testInfo, 'MCP Review')
    await setPolicies(request, mcp.id, [{ toolName: '*', decision: 'review' }])

    const appPage = new AppPage(page)
    const sessionPage = new SessionPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await openAgentSession(page, agent, session)

    // APPROVE — fire the call (held open server-side awaiting the decision),
    // let the review surface, click Allow on the real card; the held request
    // then forwards upstream and returns 200. We assert the durable outcome
    // (held response + review resolved) rather than the completed-card visual,
    // which is a local 2s state that races the list's resolve-driven refetch.
    const approvePromise = callTool(request, agent.slug, mcp.id, proxyToken, 'hello_world', { name: 'e2e' })
    const review = await waitForPendingProxyReview(request, agent, {
      toolkit: mcp.name,
      targetPath: 'tools/call: hello_world',
    })
    await sessionPage.waitForProxyReviewRequestById(review.id)
    await sessionPage.allowProxyReview(review.id)

    const approved = await approvePromise
    expect(approved.status()).toBe(200)
    expect(mockMcp.toolCalls.map((c) => c.name)).toContain('hello_world')
    await expectPendingProxyReviewResolved(request, agent, review)

    // DENY — a second call, held the same way, denied via the card, returns
    // 403 denied_by_user and never forwards.
    const denyPromise = callTool(request, agent.slug, mcp.id, proxyToken, 'get_weather', { city: 'Denver' })
    const review2 = await waitForPendingProxyReview(request, agent, {
      toolkit: mcp.name,
      targetPath: 'tools/call: get_weather',
    })
    await sessionPage.waitForProxyReviewRequestById(review2.id)
    await sessionPage.denyProxyReview(review2.id)

    const denied = await denyPromise
    expect(denied.status()).toBe(403)
    expect((await denied.json()).error).toBe('denied_by_user')
    expect(mockMcp.toolCalls.map((c) => c.name)).not.toContain('get_weather')
    await expectPendingProxyReviewResolved(request, agent, review2)
  })

  test('the API Logs page shows MCP-sourced rows with their policy decisions', async ({ page, request }, testInfo) => {
    const { agent, mcp, proxyToken } = await setupMcpAgent(request, testInfo, 'MCP Logs')
    await setPolicies(request, mcp.id, [
      { toolName: 'hello_world', decision: 'block' },
      { toolName: '*', decision: 'allow' },
    ])

    // Generate one auto-blocked and one auto-allowed MCP audit row
    await callTool(request, agent.slug, mcp.id, proxyToken, 'hello_world', { name: 'e2e' })
    await callTool(request, agent.slug, mcp.id, proxyToken, 'get_weather', { city: 'Denver' })
    await expect.poll(async () => (await getMcpAuditLog(request, agent.slug)).length, { timeout: 10000 })
      .toBeGreaterThanOrEqual(2)

    await page.goto(`/agents/${agent.slug}/api-logs`)

    // MCP rows are badged distinctly from HTTP-proxy rows and carry a
    // human-readable policy-decision label
    await expect(page.getByText('MCP', { exact: true }).first()).toBeVisible({ timeout: 15000 })
    await expect(page.getByText('auto-blocked', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('auto-allowed', { exact: true }).first()).toBeVisible()
  })
})
