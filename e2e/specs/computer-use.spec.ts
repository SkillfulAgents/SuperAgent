import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

test.describe('Computer Use requests', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage

  test.beforeEach(async ({ page }, testInfo) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    const testAgentName = `CU Agent ${testInfo.workerIndex}-${Date.now()}`
    await agentPage.createAgent(testAgentName)
  })

  test('computer use request: allow once', async () => {
    // "use computer" triggers UserInputRequestScenario with mcp__computer-use__computer_apps
    await sessionPage.sendMessage('use computer')

    // Wait for the computer use request UI to appear
    await sessionPage.waitForComputerUseRequest()

    // Verify content is shown
    const request = sessionPage.getComputerUseRequests().first()
    await expect(request).toContainText('Computer Use Request')
    await expect(request).toContainText('List Apps & Windows')

    // Approve once
    await sessionPage.approveComputerUseOnce()

    // Request should disappear
    await expect(sessionPage.getComputerUseRequests()).toHaveCount(0, { timeout: 10000 })

    // Session should complete
    await sessionPage.waitForInputEnabled(15000)
  })

  test('computer use request: deny', async () => {
    await sessionPage.sendMessage('use computer')

    await sessionPage.waitForComputerUseRequest()

    // Deny
    await sessionPage.denyComputerUse()

    // Request should disappear
    await expect(sessionPage.getComputerUseRequests()).toHaveCount(0, { timeout: 10000 })

    // Session should complete
    await sessionPage.waitForInputEnabled(15000)
  })
})
