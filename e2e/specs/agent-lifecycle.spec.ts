import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'

// Run agent lifecycle tests serially to avoid conflicts
test.describe.configure({ mode: 'serial' })

test.describe('Agent Lifecycle', () => {
  let appPage: AppPage
  let agentPage: AgentPage

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  test('create a new agent', async ({ page }) => {
    const agentName = `Test Agent ${Date.now()}`

    // Create agent
    await agentPage.createAgent(agentName)

    // Verify agent appears in sidebar
    await expect(agentPage.getAgentItem(agentName)).toBeVisible()

    // Verify main content is visible
    await expect(appPage.getMainContent()).toBeVisible()

    // Clean up
    await agentPage.deleteAgent()
  })

  test('select an agent', async ({ page }) => {
    const agentName = `Selectable Agent ${Date.now()}`

    // Create agent first
    await agentPage.createAgent(agentName)

    // Click somewhere else (the sidebar header), then select the agent again
    await page.locator('text=Super Agent').click()
    await agentPage.selectAgent(agentName)

    // Verify main content shows the agent
    await expect(appPage.getMainContent()).toBeVisible()

    // Clean up
    await agentPage.deleteAgent()
  })

  test('delete an agent', async ({ page }) => {
    const agentName = `Deletable Agent ${Date.now()}`

    // Create agent first
    await agentPage.createAgent(agentName)

    // Verify it exists
    await expect(agentPage.getAgentItem(agentName)).toBeVisible()

    // Delete via settings
    await agentPage.deleteAgent()

    // Verify agent is removed from sidebar
    await expect(agentPage.getAgentItem(agentName)).not.toBeVisible()
  })

  test('create and delete agent end-to-end', async ({ page }) => {
    const agentName = `E2E Test Agent ${Date.now()}`

    // Create agent
    await agentPage.createAgent(agentName)
    await expect(agentPage.getAgentItem(agentName)).toBeVisible()

    // Delete via settings
    await agentPage.deleteAgent()

    // Verify agent is gone
    await expect(agentPage.getAgentItem(agentName)).not.toBeVisible()
  })
})
