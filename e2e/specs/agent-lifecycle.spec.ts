import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import {
  createAgent,
  expectAgentDeleted,
  expectAgentNamed,
  findAgentByName,
  getAgentItem,
  gotoAgentHome,
  uniqueName,
} from '../helpers/agents'

test.describe('Agent Lifecycle', () => {
  let appPage: AppPage
  let agentPage: AgentPage

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  test('creates a new agent through the UI', async ({ page, request }, testInfo) => {
    const agentName = uniqueName(testInfo, 'Lifecycle Create')
    await agentPage.createAgent(agentName)

    const agent = await findAgentByName(request, agentName)
    await expect(getAgentItem(page, agent)).toBeVisible()
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agentName)
    await expect(appPage.getMainContent()).toBeVisible()
    await expectAgentNamed(request, agent, agentName)
  })

  test('selects an existing agent from the sidebar', async ({ page, request }, testInfo) => {
    const agent = await createAgent(request, uniqueName(testInfo, 'Lifecycle Select'))

    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await page.locator('[data-testid="home-button"]').click()
    await getAgentItem(page, agent).click()

    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agent.name)
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()
    await expect(appPage.getMainContent()).toBeVisible()
  })

  test('deletes an existing agent from settings', async ({ page, request }, testInfo) => {
    const agent = await createAgent(request, uniqueName(testInfo, 'Lifecycle Delete'))

    await gotoAgentHome(page, agent)
    await expect(getAgentItem(page, agent)).toBeVisible()
    await agentPage.deleteAgent()

    await expectAgentDeleted(request, agent)
    await expect(getAgentItem(page, agent)).not.toBeVisible()
  })

  test('creates and deletes an agent end-to-end through the UI', async ({ page, request }, testInfo) => {
    const agentName = uniqueName(testInfo, 'Lifecycle E2E')
    await agentPage.createAgent(agentName)

    const agent = await findAgentByName(request, agentName)
    await expect(getAgentItem(page, agent)).toBeVisible()
    await agentPage.deleteAgent()

    await expectAgentDeleted(request, agent)
    await expect(getAgentItem(page, agent)).not.toBeVisible()
  })
})
