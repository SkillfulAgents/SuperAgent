import { test, expect, type Page, type TestInfo } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { createAgent, openAgentHome, type TestAgent } from '../helpers/agents'
import {
  assignRemoteMcpToAgent,
  createRemoteMcp,
  expectAgentHasRemoteMcp,
  expectAgentMissingRemoteMcp,
  expectRemoteMcpByUrl,
  listRemoteMcps,
} from '../helpers/connections'
import { startMockMcpServer, type MockMcpServer } from '../helpers/mock-mcp-server'

async function withMockMcp<T>(run: (mockMcp: MockMcpServer) => Promise<T>): Promise<T> {
  const mockMcp = await startMockMcpServer(0)
  try {
    return await run(mockMcp)
  } finally {
    await mockMcp.close()
  }
}

async function openAgentConnectionsPage(
  page: Page,
  agent: Pick<TestAgent, 'slug' | 'name'>,
) {
  const appPage = new AppPage(page)
  await appPage.goto()
  await appPage.waitForAgentsLoaded()
  await openAgentHome(page, agent)
  await page.locator('[data-testid="home-connections-open-page"]').click()
  await expect(page.locator('[data-testid="connections-add-button"]')).toBeVisible()
}

function uniqueName(testInfo: TestInfo, label: string) {
  const suffix = [
    testInfo.workerIndex,
    testInfo.repeatEachIndex,
    Date.now(),
    Math.random().toString(36).slice(2, 8),
  ].join('-')

  return `${label} ${suffix}`
}

test.describe('Connections Management - Manual Add Flow', () => {
  test('user adds an MCP from the directory and toggles it on for the agent', async ({ page, request }, testInfo) => {
    await withMockMcp(async (mockMcp) => {
      const agentName = uniqueName(testInfo, 'Connections Manual')
      const mcpName = uniqueName(testInfo, 'Manual MCP')
      const agent = await createAgent(request, agentName)

      // 1. From agent home, open the connections page.
      await openAgentConnectionsPage(page, agent)

      // 2. Open the "New connection" directory dialog and switch to MCPs.
      await page.locator('[data-testid="connections-add-button"]').click()
      await page.locator('[data-testid="directory-tab-mcps"]').click()

      // 3. Expand the Custom MCP tile and fill the form (no-auth path).
      await page.locator('[data-testid="directory-connect-mcp-custom"]').click()
      await page.locator('[data-testid="mcp-form-name"]').fill(mcpName)
      await page.locator('[data-testid="mcp-form-url"]').fill(mockMcp.url)
      // authType defaults to "No Authentication" — no need to change.

      // 4. Submit. The dialog closes and the Tool Policy editor opens.
      await page.locator('[data-testid="mcp-form-submit"]').click()

      // Dismiss the Tool Policy editor that opens for the new MCP.
      const policyDialog = page.getByText('Tool Policies')
      await expect(policyDialog).toBeVisible({ timeout: 10000 })
      await page.getByRole('button', { name: 'Cancel' }).click()
      await expect(policyDialog).not.toBeVisible({ timeout: 5000 })

      // 5. Cross-check that the global MCP record landed in the DB.
      const created = await expectRemoteMcpByUrl(request, mockMcp.url, mcpName)
      expect(created.name).toBe(mcpName)

      const switchLocator = page.locator(`[data-testid="connection-switch-mcp-${created.id}"]`)
      await expect(switchLocator).toBeVisible({ timeout: 10000 })

      // 6. Initially the agent does not have access — verify before toggling.
      await expectAgentMissingRemoteMcp(request, agent.slug, created.id)

      // 7. Toggle the row on.
      await switchLocator.click()

      // The toggle is async (optimistic + server roundtrip). Wait for the API to
      // reflect the assignment rather than relying solely on UI state, since the
      // local override clears once the server catches up — by then the DB is the
      // source of truth.
      await expectAgentHasRemoteMcp(request, agent.slug, created.id)

      // UI also reflects the granted state.
      await expect(switchLocator).toHaveAttribute('data-state', 'checked')
    })
  })

  test('toggling off removes the agent mapping but keeps the global MCP', async ({ page, request }, testInfo) => {
    await withMockMcp(async (mockMcp) => {
      const agentName = uniqueName(testInfo, 'Connections Toggle Off')
      const mcpName = uniqueName(testInfo, 'Toggle MCP')
      const agent = await createAgent(request, agentName)
      const mcp = await createRemoteMcp(request, { name: mcpName, url: mockMcp.url })
      await assignRemoteMcpToAgent(request, agent.slug, mcp.id)

      await openAgentConnectionsPage(page, agent)

      const switchLocator = page.locator(`[data-testid="connection-switch-mcp-${mcp.id}"]`)
      await expect(switchLocator).toBeVisible({ timeout: 10000 })
      await expect(switchLocator).toHaveAttribute('data-state', 'checked', { timeout: 10000 })

      // Toggle off through the UI.
      await switchLocator.click()

      // Mapping disappears from the agent list...
      await expectAgentMissingRemoteMcp(request, agent.slug, mcp.id)
      await expect(switchLocator).toHaveAttribute('data-state', 'unchecked')

      // ...but the global server is still registered.
      const allAfter = await listRemoteMcps(request)
      const stillThere = allAfter.some((server) => server.id === mcp.id)
      expect(stillThere, 'toggling off must not delete the global MCP').toBe(true)
    })
  })
})
