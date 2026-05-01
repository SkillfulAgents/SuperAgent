import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { startMockMcpServer, type MockMcpServer } from '../helpers/mock-mcp-server'

// Serial: tests cross-check DB state via the API, sensitive to concurrent writes.
test.describe.configure({ mode: 'serial' })

const API = 'http://localhost:3000'

test.describe('Connections Management - Manual Add Flow', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let mockMcp: MockMcpServer
  // 9877 avoids colliding with connected-accounts.spec.ts which uses 9876.
  const MCP_PORT = 9877

  test.beforeAll(async () => {
    mockMcp = await startMockMcpServer(MCP_PORT)
  })

  test.afterAll(async () => {
    await mockMcp.close()
  })

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  test('user adds an MCP from the directory and toggles it on for the agent', async ({ page, request }) => {
    const agentName = `Connections Manual ${Date.now()}`
    const mcpName = `Manual MCP ${Date.now()}`

    await agentPage.createAgent(agentName)

    // Resolve agent slug from the API rather than guessing — server-side slug
    // generation may diverge from a naive lowercase-hyphenate.
    const agentsRes = await request.get(`${API}/api/agents`)
    expect(agentsRes.ok()).toBeTruthy()
    const agents = await agentsRes.json()
    const agent = agents.find((a: { name: string }) => a.name === agentName)
    expect(agent, `agent "${agentName}" not found via /api/agents`).toBeDefined()
    const agentSlug: string = agent.slug

    // 1. From agent home, open the connections page.
    await page.locator('[data-testid="home-connections-open-page"]').click()
    await expect(page.locator('[data-testid="connections-add-button"]')).toBeVisible()

    // 2. Open the "New connection" directory dialog and switch to MCPs.
    await page.locator('[data-testid="connections-add-button"]').click()
    await page.locator('[data-testid="directory-tab-mcps"]').click()

    // 3. Expand the Custom MCP tile and fill the form (no-auth path).
    await page.locator('[data-testid="directory-connect-mcp-custom"]').click()
    await page.locator('[data-testid="mcp-form-name"]').fill(mcpName)
    await page.locator('[data-testid="mcp-form-url"]').fill(mockMcp.url)
    // authType defaults to "No Authentication" — no need to change.

    // 4. Submit. The dialog closes and the row appears in the list.
    await page.locator('[data-testid="mcp-form-submit"]').click()

    // The mcp row's testid uses the server-assigned id, so match by prefix.
    const switchLocator = page.locator('[data-testid^="connection-switch-mcp-"]')
    await expect(switchLocator).toBeVisible({ timeout: 10000 })

    // 5. Cross-check that the global MCP record landed in the DB.
    const allMcpsRes = await request.get(`${API}/api/remote-mcps`)
    expect(allMcpsRes.ok()).toBeTruthy()
    const allMcps = await allMcpsRes.json()
    const created = (allMcps.servers as Array<{ id: string; name: string; url: string }>).find(
      (m) => m.url === mockMcp.url,
    )
    expect(created, 'newly added MCP missing from /api/remote-mcps').toBeDefined()
    expect(created!.name).toBe(mcpName)

    // 6. Initially the agent does not have access — verify before toggling.
    const beforeRes = await request.get(`${API}/api/agents/${agentSlug}/remote-mcps`)
    expect(beforeRes.ok()).toBeTruthy()
    const before = await beforeRes.json()
    const beforeIds = (before.mcps as Array<{ id: string }>).map((m) => m.id)
    expect(beforeIds).not.toContain(created!.id)

    // 7. Toggle the row on.
    await switchLocator.click()

    // The toggle is async (optimistic + server roundtrip). Wait for the API to
    // reflect the assignment rather than relying solely on UI state, since the
    // local override clears once the server catches up — by then the DB is the
    // source of truth.
    await expect.poll(
      async () => {
        const r = await request.get(`${API}/api/agents/${agentSlug}/remote-mcps`)
        if (!r.ok()) return []
        const j = (await r.json()) as { mcps: Array<{ id: string }> }
        return j.mcps.map((m) => m.id)
      },
      { timeout: 10000, message: 'agent never received the MCP mapping' },
    ).toContain(created!.id)

    // UI also reflects the granted state.
    await expect(switchLocator).toHaveAttribute('data-state', 'checked')
  })

  test('toggling off removes the agent mapping but keeps the global MCP', async ({ page, request }) => {
    const agentName = `Connections Toggle Off ${Date.now()}`
    const mcpName = `Toggle MCP ${Date.now()}`

    await agentPage.createAgent(agentName)

    const agentsRes = await request.get(`${API}/api/agents`)
    const agents = await agentsRes.json()
    const agent = agents.find((a: { name: string }) => a.name === agentName)
    expect(agent).toBeDefined()
    const agentSlug: string = agent.slug

    // Add the MCP and turn the toggle on (compressed version of the first test).
    await page.locator('[data-testid="home-connections-open-page"]').click()
    await page.locator('[data-testid="connections-add-button"]').click()
    await page.locator('[data-testid="directory-tab-mcps"]').click()
    await page.locator('[data-testid="directory-connect-mcp-custom"]').click()
    await page.locator('[data-testid="mcp-form-name"]').fill(mcpName)
    await page.locator('[data-testid="mcp-form-url"]').fill(mockMcp.url)
    await page.locator('[data-testid="mcp-form-submit"]').click()

    const switchLocator = page.locator('[data-testid^="connection-switch-mcp-"]').first()
    await expect(switchLocator).toBeVisible({ timeout: 10000 })
    await switchLocator.click()
    await expect(switchLocator).toHaveAttribute('data-state', 'checked', { timeout: 10000 })

    // Look up the MCP id once for the assertions below.
    const allMcps = await (await request.get(`${API}/api/remote-mcps`)).json()
    const target = (allMcps.servers as Array<{ id: string; url: string }>).find(
      (m) => m.url === mockMcp.url,
    )!

    // Toggle off.
    await switchLocator.click()

    // Mapping disappears from the agent list...
    await expect.poll(
      async () => {
        const r = await request.get(`${API}/api/agents/${agentSlug}/remote-mcps`)
        const j = (await r.json()) as { mcps: Array<{ id: string }> }
        return j.mcps.map((m) => m.id)
      },
      { timeout: 10000, message: 'mapping not removed from agent' },
    ).not.toContain(target.id)

    // ...but the global server is still registered.
    const allAfter = await (await request.get(`${API}/api/remote-mcps`)).json()
    const stillThere = (allAfter.servers as Array<{ id: string }>).some((m) => m.id === target.id)
    expect(stillThere, 'toggling off must not delete the global MCP').toBe(true)
  })
})
