import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { startMockMcpServer, type MockMcpServer } from '../helpers/mock-mcp-server'

// Serial: cross-checks DB state via the API; sensitive to concurrent writes.
test.describe.configure({ mode: 'serial' })

const API = 'http://localhost:3000'

test.describe('Global Settings → Connections — Add MCP flow', () => {
  let appPage: AppPage
  let mockMcp: MockMcpServer
  // 9878 avoids colliding with connected-accounts.spec.ts (9876) and
  // connections-management.spec.ts (9877).
  const MCP_PORT = 9878

  test.beforeAll(async () => {
    mockMcp = await startMockMcpServer(MCP_PORT)
  })

  test.afterAll(async () => {
    await mockMcp.close()
  })

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  test('adding a custom MCP from the global Connections tab closes the dialog and shows the row', async ({ page, request }) => {
    const mcpName = `Global Add MCP ${Date.now()}`

    // 1. Open Global Settings → Connections.
    await page.locator('[data-testid="settings-button"]').click()
    await expect(page.locator('[data-testid="global-settings-page"]')).toBeVisible()
    await page.locator('[data-testid="settings-nav-connections"]').click()

    // The "+ New connection" button is hoisted into the page-level title row
    // via SettingsPageSection.headerActions. Same component as the agent-page
    // button, so it shares the `connections-add-button` test-id.
    const addButton = page.locator('[data-testid="connections-add-button"]')
    await expect(addButton).toBeVisible()

    // 2. Open the directory dialog and switch to the MCPs tab.
    await addButton.click()
    const dialog = page.getByRole('dialog', { name: 'Add New Connection' })
    await expect(dialog).toBeVisible()
    await page.locator('[data-testid="directory-tab-mcps"]').click()

    // 3. Expand the Custom MCP tile and fill in the no-auth form.
    await page.locator('[data-testid="directory-connect-mcp-custom"]').click()
    await page.locator('[data-testid="mcp-form-name"]').fill(mcpName)
    await page.locator('[data-testid="mcp-form-url"]').fill(mockMcp.url)
    // authType defaults to "No Authentication" — leave it.

    // 4. Submit. The directory dialog closes and the Tool Policy editor opens.
    await page.locator('[data-testid="mcp-form-submit"]').click()
    await expect(dialog).toBeHidden({ timeout: 10000 })

    // Dismiss the Tool Policy editor that opens for the new MCP.
    const policyDialog = page.getByText('Tool Policies')
    await expect(policyDialog).toBeVisible({ timeout: 10000 })
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(policyDialog).not.toBeVisible({ timeout: 5000 })

    // 5. The new row shows up in the global Connections list.
    //    The unified row has no per-agent Switch — match by name instead.
    const newRow = page.getByText(mcpName, { exact: true }).first()
    await expect(newRow).toBeVisible({ timeout: 10000 })

    // 6. The agents pill is rendered for the row and reads "0 agents" — the
    //    server has the MCP but it's not mapped to anyone yet.
    const allMcps = await (await request.get(`${API}/api/remote-mcps`)).json()
    const created = (allMcps.servers as Array<{ id: string; name: string; url: string }>).find(
      (m) => m.url === mockMcp.url,
    )
    expect(created, 'newly added MCP missing from /api/remote-mcps').toBeDefined()
    expect(created!.name).toBe(mcpName)

    const agentsPill = page.locator(`[data-testid="connection-agents-pill-mcp-${created!.id}"]`)
    await expect(agentsPill).toBeVisible()
    await expect(agentsPill).toContainText('0 agents')

    // 7. Backend cross-check: the new /:id/agents endpoint returns an empty list.
    const agentsRes = await request.get(`${API}/api/remote-mcps/${created!.id}/agents`)
    expect(agentsRes.ok()).toBeTruthy()
    expect(await agentsRes.json()).toEqual({ agentSlugs: [] })
  })
})
