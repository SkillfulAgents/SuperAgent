import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { createAgent } from '../helpers/agents'


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

    // Verify the created agent is selected
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agentName)

    // Verify main content is visible
    await expect(appPage.getMainContent()).toBeVisible()

    // Clean up
    await agentPage.deleteAgent()
  })

  test('select an agent', async ({ page, request }) => {
    const agentName = `Selectable Agent ${Date.now()}`

    // Seed the target through the API so selection coverage is isolated from
    // the slower create-agent/session-start workflow.
    const agent = await createAgent(request, agentName)
    agentPage.rememberAgent(agent)
    await page.reload()
    await appPage.waitForAgentsLoaded()

    // Click somewhere else (the sidebar header), then select the agent again
    await page.locator('[data-testid="home-button"]').click()
    await agentPage.selectAgent(agentName)

    // Verify main content shows the agent
    await expect(appPage.getMainContent()).toBeVisible()

    // Clean up
    await agentPage.deleteAgentByNameFromApi(agentName)
  })

  test('delete an agent', async ({ page }) => {
    const agentName = `Deletable Agent ${Date.now()}`

    // Create agent first
    await agentPage.createAgent(agentName)

    // Delete via settings
    await agentPage.deleteAgent()

    // Verify agent is removed server-side
    await agentPage.waitForAgentDeletedFromApi(agentName)
  })

  test('create and delete agent end-to-end', async ({ page }) => {
    const agentName = `E2E Test Agent ${Date.now()}`

    // Create agent
    await agentPage.createAgent(agentName)
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agentName)

    // Delete via settings
    await agentPage.deleteAgent()

    // Verify agent is gone
    await agentPage.waitForAgentDeletedFromApi(agentName)
  })
})
