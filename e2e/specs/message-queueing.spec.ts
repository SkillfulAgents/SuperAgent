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

  test('a queued message can be cancelled before pickup', async ({ page }) => {
    await sessionPage.sendMessage('please work slowly for the cancel test')
    await expect(sessionPage.getStopButton()).toBeVisible({ timeout: 10000 })

    // Queue a message mid-turn, then cancel it inside the mock's pickup window
    await sessionPage.typeMessage('cancel me before pickup')
    await sessionPage.getSendButton().click()

    const ghost = page.locator('[data-testid="queued-user-message"]')
    await expect(ghost).toBeVisible({ timeout: 5000 })

    // Cancel becomes available once the POST response delivers the server uuid
    const cancelBtn = page.locator('[data-testid="cancel-queued-message"]')
    await expect(cancelBtn).toBeVisible({ timeout: 3000 })
    await cancelBtn.click()

    // Ghost disappears immediately; the cancelled message never materializes
    await expect(ghost).not.toBeAttached({ timeout: 5000 })

    // Turn completes normally with only the original user message persisted
    await expect(
      sessionPage.getAssistantMessages().filter({ hasText: 'Finished the slow work.' })
    ).toBeVisible({ timeout: 15000 })
    await sessionPage.waitForUserMessageCount(1, 15000)
    await expect(page.getByText('cancel me before pickup')).not.toBeVisible()
    // No steering acknowledgement for the cancelled message
    await expect(
      sessionPage.getAssistantMessages().filter({ hasText: 'Adjusting based on: cancel me before pickup' })
    ).toHaveCount(0)
  })

  test('cancel after pickup flips the ghost to "Picked up by the agent" and the message still lands', async ({ page }) => {
    await sessionPage.sendMessage('please work slowly for the pickup race')
    await expect(sessionPage.getStopButton()).toBeVisible({ timeout: 10000 })

    await sessionPage.typeMessage('cancel me too late')
    await sessionPage.getSendButton().click()

    const ghost = page.locator('[data-testid="queued-user-message"]')
    await expect(ghost).toBeVisible({ timeout: 5000 })
    const cancelBtn = page.locator('[data-testid="cancel-queued-message"]')
    await expect(cancelBtn).toBeVisible({ timeout: 3000 })

    // Hold transcript GETs so the picked-up ghost cannot materialize while we
    // stage the lost race. Send (POST) and cancel (DELETE …/queued-messages/:uuid)
    // use other method/URL shapes and pass through.
    let holdTranscript = true
    let pickupRefetchSeen = false
    await page.route('**/sessions/*/messages', async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      pickupRefetchSeen = true
      while (holdTranscript) await new Promise((r) => setTimeout(r, 100))
      await route.continue()
    })

    await expect.poll(() => pickupRefetchSeen, { timeout: 5000 }).toBe(true)

    // Cancel loses the race (cancelled: false): the ghost flips to the
    // picked-up state and its Cancel affordance disappears.
    await cancelBtn.click()
    await expect(ghost).toContainText('Picked up by the agent', { timeout: 5000 })
    await expect(page.locator('[data-testid="cancel-queued-message"]')).toHaveCount(0)

    // Release the transcript — the picked-up ghost materializes as a real
    // message and the steering ack confirms the agent used it.
    holdTranscript = false
    await expect(ghost).not.toBeAttached({ timeout: 15000 })
    await sessionPage.waitForUserMessageCount(2, 15000)
    await sessionPage.expectUserMessage('cancel me too late', 1)
    await expect(
      sessionPage.getAssistantMessages().filter({ hasText: 'Adjusting based on: cancel me too late' })
    ).toBeVisible({ timeout: 15000 })
  })

  test('a message queued near turn end keeps the session working until pickup, then settles', async ({ page }) => {
    await sessionPage.sendMessage('please work slowly until the end')
    await expect(sessionPage.getStopButton()).toBeVisible({ timeout: 10000 })

    // The 'pickup after turn' keyword makes the mock use a pickup delay longer
    // than the slow scenario's 5s turn, so pickup deterministically lands after
    // the turn's result. The runtime withholds idle across the gap — the
    // session must stay working until the queued message is picked up.
    await sessionPage.typeMessage('late instruction pickup after turn')
    await sessionPage.getSendButton().click()
    const ghost = page.locator('[data-testid="queued-user-message"]')
    await expect(ghost).toBeVisible({ timeout: 3000 })

    // The turn's output completes and renders while the session is still
    // working (turn_output_complete reconcile)...
    await expect(
      sessionPage.getAssistantMessages().filter({ hasText: 'Finished the slow work.' })
    ).toBeVisible({ timeout: 10000 })
    // ...and the queued message is still awaiting pickup, so the session has
    // not settled.
    await expect(ghost).toBeVisible()
    await expect(sessionPage.getStopButton()).toBeVisible()

    // Pickup: ghost materializes, the ack arrives, and only then does the
    // session settle.
    await expect(ghost).not.toBeAttached({ timeout: 15000 })
    await sessionPage.waitForUserMessageCount(2, 15000)
    await expect(
      sessionPage.getAssistantMessages().filter({ hasText: 'Adjusting based on: late instruction pickup after turn' })
    ).toBeVisible({ timeout: 15000 })
    // The completed turn's output survived the follow-up pickup turn — no
    // blink/loss from the stream-vs-transcript race.
    await expect(
      sessionPage.getAssistantMessages().filter({ hasText: 'Finished the slow work.' })
    ).toBeVisible()
    await sessionPage.waitForInputEnabled(15000)
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
