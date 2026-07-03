import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

test.describe('Background Bash Task Tracking', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage
  let testAgentName: string

  test.beforeEach(async ({ page }, testInfo) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    testAgentName = `BgBash Agent ${testInfo.workerIndex}-${Date.now()}`
    await agentPage.createAgent(testAgentName)
  })

  test('agent stays working during background bash command', async () => {
    // "run background" triggers BackgroundBashScenario
    await sessionPage.sendMessage('run background command')

    // Agent should show working status while the background task runs
    await agentPage.waitForStatus('working', 15000)

    // Activity indicator should be visible
    const indicator = sessionPage.getActivityIndicator()
    await expect(indicator).toBeVisible({ timeout: 10000 })

    // Should show background process count
    await expect(indicator).toContainText('background process', { timeout: 10000 })

    // Wait for the background task to complete and agent to respond.
    // The BackgroundBashScenario has a 2s delay, then the agent processes the notification.
    await sessionPage.expectAssistantMessage('Background command completed', 1, 30000)
    await sessionPage.waitForInputEnabled(30000)

    // Agent should go back to idle after everything completes
    await agentPage.waitForStatus('idle', 15000)
  })

  test('background process indicator disappears after completion', async () => {
    await sessionPage.sendMessage('run background command')

    // Wait for background process indicator to appear
    const indicator = sessionPage.getActivityIndicator()
    await expect(indicator).toContainText('background process', { timeout: 10000 })

    // Activity indicator should be gone once the background task has completed.
    await expect(indicator).not.toBeVisible({ timeout: 30000 })
    await sessionPage.waitForInputEnabled(30000)
  })

  test('agent responds with final output after background task completes', async () => {
    await sessionPage.sendMessage('run background command')

    // Should have the final response mentioning the command output
    await sessionPage.expectAssistantMessage('Background command completed', 1, 30000)
    await sessionPage.waitForInputEnabled(30000)
  })

  test('swaps stop for send while waiting for background task as the user types', async ({ page }) => {
    await sessionPage.sendMessage('run background command')

    // Wait for the background process indicator (agent turn ended, bg task pending)
    const indicator = sessionPage.getActivityIndicator()
    await expect(indicator).toContainText('background process', { timeout: 10000 })

    // Empty composer: only the stop button occupies the action slot
    const stopButton = page.locator('[data-testid="stop-button"]')
    const sendButton = page.locator('[data-testid="send-button"]')
    await expect(stopButton).toBeVisible({ timeout: 5000 })
    await expect(sendButton).not.toBeVisible()

    // Typing swaps stop for send; clearing swaps back
    await sessionPage.typeMessage('follow up while waiting')
    await expect(sendButton).toBeVisible({ timeout: 5000 })
    await expect(stopButton).not.toBeVisible()
    await sessionPage.typeMessage('')
    await expect(stopButton).toBeVisible({ timeout: 5000 })
    await expect(sendButton).not.toBeVisible()

    // Wait for completion
    await expect(indicator).not.toBeVisible({ timeout: 30000 })
    await sessionPage.waitForInputEnabled(30000)
  })
})
