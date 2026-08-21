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
    await expect(request).toContainText('Allow the agent to list apps & windows (read-only)?')
    await expect(request).toContainText('List Apps & Windows (read-only)')

    // Approve once
    await sessionPage.approveComputerUseOnce()

    // Request should disappear
    await expect(sessionPage.getComputerUseRequests()).toHaveCount(0, { timeout: 10000 })

    // Session should complete
    await sessionPage.waitForInputEnabled(15000)
    await sessionPage.expectAssistantMessage('Thank you for providing the information.', 0, 15000)
  })

  test('an abandoned approval does not survive into the next turn', async ({ page }) => {
    // Park a computer-use approval, then stop the turn with the card unresolved.
    await sessionPage.sendMessage('use computer')
    await sessionPage.waitForComputerUseRequest()
    await sessionPage.stopSessionFromRequest()
    await sessionPage.waitForInputEnabled(15000)

    // A new message starts a fresh turn, which supersedes the abandoned
    // approval server-side. (The computer-use store deliberately survives an
    // IDLE boundary so a reconnect can replay a still-parked card — but a new
    // turn must wipe it, or the stale entry reads as a live wait.)
    await sessionPage.sendMessage('carry on without the computer')
    await sessionPage.waitForInputEnabled(15000)
    await sessionPage.expectAssistantMessage('This is a mock response from the E2E test container.', 0, 15000)

    // Reload: the /stream replay must NOT resurrect the abandoned approval
    // card, and the agent must read idle — not needing input.
    await page.reload()
    await sessionPage.expectAssistantMessage('This is a mock response from the E2E test container.', 0, 15000)
    await expect(sessionPage.getComputerUseRequests()).toHaveCount(0)
    await agentPage.waitForStatus('idle', 15000)
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
    await sessionPage.expectAssistantMessage('Thank you for providing the information.', 0, 15000)
  })
})
