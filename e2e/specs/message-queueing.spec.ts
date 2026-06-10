import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

/**
 * Message queueing while the agent is working.
 *
 * Uses the mock's SlowWorkScenario ("work slowly" pattern) to hold the session
 * in the working state. Messages sent mid-turn take the mock's busy path,
 * which mirrors the real CLI's steering behavior: no user JSONL entry, then a
 * queued_command attachment (with a CLI-generated source_uuid, NOT the client
 * uuid) at pickup, followed by assistant output.
 *
 * This covers the full loop: send mid-turn → queued ghost → attachment
 * conversion (session-service) → text-fallback materialization (message-list).
 */
test.describe('Message queueing while agent is working', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage

  test.beforeEach(async ({ page }, testInfo) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    const testAgentName = `Queue Agent ${testInfo.workerIndex}-${Date.now()}`
    await agentPage.createAgent(testAgentName)
  })

  test('mid-turn message shows a queued ghost, then materializes on pickup', async ({ page }) => {
    // Start a slow turn (~5s working window)
    await sessionPage.sendMessage('please work slowly on this task')

    // Agent goes busy — stop button appears, and the send button is still
    // available alongside it (queueing enabled)
    await expect(sessionPage.getStopButton()).toBeVisible({ timeout: 10000 })
    await expect(sessionPage.getSendButton()).toBeVisible()

    // Send a second message mid-turn
    await sessionPage.typeMessage('queued follow up instruction')
    await sessionPage.getSendButton().click()

    // The queued ghost appears at reduced opacity with a "Queued" label
    const ghost = page.locator('[data-testid="queued-user-message"]')
    await expect(ghost).toBeVisible({ timeout: 5000 })
    await expect(ghost).toContainText('queued follow up instruction')
    await expect(ghost).toContainText('Queued')

    // Pickup: the mock writes the queued_command attachment + assistant output;
    // the ghost materializes into a regular persisted user message
    await expect(ghost).not.toBeAttached({ timeout: 15000 })
    await sessionPage.waitForUserMessageCount(2, 15000)
    await sessionPage.expectUserMessage('please work slowly on this task', 0)
    await sessionPage.expectUserMessage('queued follow up instruction', 1)

    // The steering acknowledgement referenced the queued content
    await expect(
      sessionPage.getAssistantMessages().filter({ hasText: 'Adjusting based on: queued follow up instruction' })
    ).toBeVisible({ timeout: 15000 })

    // The turn eventually completes normally
    await expect(
      sessionPage.getAssistantMessages().filter({ hasText: 'Finished the slow work.' })
    ).toBeVisible({ timeout: 15000 })
  })

  test('multiple queued messages drain in send order', async ({ page }) => {
    await sessionPage.sendMessage('please work slowly again')
    await expect(sessionPage.getStopButton()).toBeVisible({ timeout: 10000 })

    // Queue two messages back to back
    await sessionPage.typeMessage('first queued message')
    await sessionPage.getSendButton().click()
    await sessionPage.typeMessage('second queued message')
    await sessionPage.getSendButton().click()

    // Both ghosts stack with Queued labels
    const ghosts = page.locator('[data-testid="queued-user-message"]')
    await expect(ghosts).toHaveCount(2, { timeout: 5000 })

    // Both materialize; final transcript has all three user messages in order
    await expect(ghosts).toHaveCount(0, { timeout: 15000 })
    await sessionPage.waitForUserMessageCount(3, 15000)
    await sessionPage.expectUserMessage('please work slowly again', 0)
    await sessionPage.expectUserMessage('first queued message', 1)
    await sessionPage.expectUserMessage('second queued message', 2)
  })
})
