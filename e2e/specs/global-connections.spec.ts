import { test, expect, type Page, type TestInfo } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { startMockMcpServer, type MockMcpServer } from '../helpers/mock-mcp-server'
import { expectRemoteMcpByUrl, type TestRemoteMcp } from '../helpers/connections'

const API = ''

async function withMockMcp<T>(run: (mockMcp: MockMcpServer) => Promise<T>): Promise<T> {
  const mockMcp = await startMockMcpServer(0)
  try {
    return await run(mockMcp)
  } finally {
    await mockMcp.close()
  }
}

function uniqueName(testInfo: TestInfo, label: string) {
  const suffix = [
    testInfo.workerIndex,
    testInfo.repeatEachIndex,
    testInfo.retry,
    Date.now(),
    Math.random().toString(36).slice(2, 8),
  ].join('-')

  return `${label} ${suffix}`
}

function connectionRow(page: Page, name: string) {
  return page.getByRole('button', {
    name: `Open ${name} connection details`,
    exact: true,
  })
}

test.describe('Global Settings → Connections — Add MCP flow', () => {
  test.beforeEach(async ({ page }) => {
    const appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  test('adding a custom MCP from the global Connections tab closes the dialog and shows the row', async ({ page, request }, testInfo) => {
    await withMockMcp(async (mockMcp) => {
      const mcpName = uniqueName(testInfo, 'Global Add MCP')
      let created: TestRemoteMcp | undefined

      try {
        // 1. Open Global Settings → Connections.
        await page.locator('[data-testid="settings-button"]').click()
        await expect(page.locator('[data-testid="global-settings-page"]')).toBeVisible()
        await page.locator('[data-testid="settings-nav-connections"]').click()

        // The "+ New connection" button is hoisted into the page-level title row
        // via SettingsPageSection.headerActions. Same component as the agent-page
        // button, so it shares the `connections-add-button` test-id.
        const addButton = page.locator('[data-testid="connections-add-button"]').first()
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

        // 5. Cross-check that the global MCP record landed in the DB with
        // the tool metadata discovered from this test's mock server.
        created = await expectRemoteMcpByUrl(request, mockMcp.url, mcpName)
        expect(created.name).toBe(mcpName)
        expect(created.status).toBe('active')
        expect(created.authType).toBe('none')
        expect(created.tools.map((tool) => tool.name).sort()).toEqual(['get_weather', 'hello_world'])
        expect(created.tools.find((tool) => tool.name === 'hello_world')).toMatchObject({
          description: 'Returns a greeting message',
          inputSchema: { properties: { name: { type: 'string' } } },
        })

        // Dismiss the Tool Policy editor that opens for the new MCP.
        const policyDialog = page.getByRole('dialog', { name: `${mcpName} Tool Policies` })
        await expect(policyDialog).toBeVisible({ timeout: 10000 })
        await policyDialog.getByRole('button', { name: 'Cancel' }).click()
        await expect(policyDialog).not.toBeVisible({ timeout: 5000 })

        // 6. The new row shows up in the global Connections list. Scope to the
        // interactive row so other tests' connections cannot satisfy this check.
        const newRow = connectionRow(page, mcpName)
        await expect(newRow).toBeVisible({ timeout: 10000 })
        await expect(newRow).toContainText(mcpName)
        await expect(newRow).toContainText('MCP')
        await expect(newRow).toContainText(mockMcp.url)

        // 7. The row subtitle shows the agent-count snippet and reads "Not in
        // use" — the server has the MCP but it's not mapped to anyone yet.
        const agentCount = page.locator(`[data-testid="connection-agent-count-mcp-${created.id}"]`)
        await expect(agentCount).toBeVisible()
        await expect(agentCount).toContainText('Not in use')
        await expect(newRow).toContainText('Not in use')

        // 8. Backend cross-check: the new /:id/agents endpoint returns an empty list.
        const agentsRes = await request.get(`${API}/api/remote-mcps/${created.id}/agents`)
        expect(agentsRes.ok()).toBeTruthy()
        expect(await agentsRes.json()).toEqual({ agentSlugs: [] })
      } finally {
        if (created) {
          await request.delete(`${API}/api/remote-mcps/${created.id}`).catch(() => {})
        }
      }
    })
  })
})
