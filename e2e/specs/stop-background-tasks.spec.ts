import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

/**
 * Stop and background tasks.
 *
 * Stop used to kill every background task along with the turn. Now a running
 * background task gets its own stop control in the activity card, and the
 * composer's Stop asks before taking the tasks down with the response. Uses
 * the mock's BackgroundBashScenario ("run background slowly": a 6s task
 * launched by a turn that ends at once, and "run background and keep working":
 * a 6s task launched by a turn that keeps streaming for 8s).
 *
 * A stopped task must never wake the agent with its output. To prove the
 * tail stayed dead without clock-based waits, the tests chain "slow response"
 * turns (3s each) after the stop: by the time they land, the task's own
 * completion would already have arrived if it were coming.
 */
test.describe('Stop with background tasks', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage

  test.beforeEach(async ({ page }, testInfo) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    await agentPage.createAgent(`Stop BG Agent ${testInfo.workerIndex}-${Date.now()}`)
  })

  /**
   * Two chained 3s turns after a stop: together they outlast the 6s the
   * stopped task would have needed to complete, so by the time they land its
   * wake-up ("Background command completed") would already have arrived if
   * the stop had not taken.
   */
  async function proveStoppedTaskStayedDead() {
    const delayedResponses = sessionPage.getAssistantMessages()
      .filter({ hasText: 'This is a delayed mock response.' })
    await sessionPage.sendMessage('slow response please, first check')
    await expect(delayedResponses).toHaveCount(1, { timeout: 15000 })
    await expect(sessionPage.getStopButton()).not.toBeVisible({ timeout: 10000 })
    await sessionPage.sendMessage('slow response please, second check')
    await expect(delayedResponses).toHaveCount(2, { timeout: 15000 })
    await expect(sessionPage.getAssistantMessages().filter({ hasText: 'Background command completed' })).toHaveCount(0)
  }

  test('a background task can be stopped from its own row', async ({ page }) => {
    test.slow()
    await sessionPage.sendMessage('run background slowly')

    const row = page.getByTestId('background-task-row')
    await expect(row).toBeVisible({ timeout: 10000 })
    // Named after the Bash call that launched it, once the transcript has it.
    await expect(row).toContainText('sleep 10 && echo done', { timeout: 10000 })

    await page.getByTestId('stop-task-button').click()

    // The runtime reports the task stopped: its row goes, and with nothing
    // left running the session settles.
    await expect(row).not.toBeVisible({ timeout: 10000 })
    await expect(sessionPage.getActivityIndicator()).not.toBeVisible({ timeout: 10000 })
    await sessionPage.waitForInputEnabled(10000)
    await agentPage.waitForStatus('idle', 15000)

    await proveStoppedTaskStayedDead()
  })

  test('Stop while waiting on a background task asks before ending it', async ({ page }) => {
    test.slow()
    await sessionPage.sendMessage('run background slowly')

    const row = page.getByTestId('background-task-row')
    await expect(row).toBeVisible({ timeout: 10000 })
    // The response already ended; the composer's Stop is now about the task.
    await expect(sessionPage.getStopButton()).toHaveAttribute('aria-label', 'Stop background processes', { timeout: 10000 })

    await sessionPage.getStopButton().click()
    const dialog = page.getByTestId('stop-session-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Stop the background task?')
    await expect(page.getByTestId('stop-session-dialog-tasks')).toContainText('sleep 10 && echo done')
    // No response is running, so there is nothing to stop while keeping the task.
    await expect(page.getByTestId('stop-session-keep-tasks')).toHaveCount(0)

    // Cancel changes nothing.
    await page.getByTestId('stop-session-cancel').click()
    await expect(dialog).not.toBeVisible()
    await expect(row).toBeVisible()

    await sessionPage.getStopButton().click()
    await page.getByTestId('stop-session-everything').click()

    await expect(sessionPage.getActivityIndicator()).not.toBeVisible({ timeout: 10000 })
    await sessionPage.waitForInputEnabled(10000)

    await proveStoppedTaskStayedDead()
  })

  test('the Stop dialog closes on its own once the last task finishes', async ({ page }) => {
    test.slow()
    await sessionPage.sendMessage('run background slowly')
    await expect(page.getByTestId('background-task-row')).toBeVisible({ timeout: 10000 })
    await expect(sessionPage.getStopButton()).toHaveAttribute('aria-label', 'Stop background processes', { timeout: 10000 })

    await sessionPage.getStopButton().click()
    const dialog = page.getByTestId('stop-session-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Stop the background task?')

    // Left open, the dialog outlives the task: once the task finishes and the
    // agent reports its output there is nothing left to stop.
    await expect(
      sessionPage.getAssistantMessages().filter({ hasText: 'Background command completed' })
    ).toBeVisible({ timeout: 30000 })
    await expect(dialog).not.toBeVisible({ timeout: 5000 })
    await sessionPage.waitForInputEnabled(15000)
  })

  test('Stop still offers to keep the task after a reload mid-response', async ({ page }) => {
    // A client that connects while the turn is still streaming (a reload, or
    // a fresh session page that attaches after the launch) learns about the
    // task from the connect snapshot. That snapshot must not read as "only
    // background work remains", or Stop would skip the response.
    test.slow()
    await sessionPage.sendMessage('run background and keep working')
    await expect(page.getByTestId('background-task-row')).toBeVisible({ timeout: 10000 })

    await page.reload()
    const row = page.getByTestId('background-task-row')
    await expect(row).toBeVisible({ timeout: 10000 })

    await sessionPage.getStopButton().click()
    const dialog = page.getByTestId('stop-session-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Stop the background task too?')
    await page.getByTestId('stop-session-keep-tasks').click()
    await expect(dialog).not.toBeVisible()

    await expect(sessionPage.getStopButton()).toHaveAttribute('aria-label', 'Stop background processes', { timeout: 10000 })
    await expect(
      sessionPage.getAssistantMessages().filter({ hasText: 'Background command completed' })
    ).toBeVisible({ timeout: 30000 })
    await sessionPage.waitForInputEnabled(15000)
  })

  test('Stop mid-response can keep the task, which then finishes and wakes the agent', async ({ page }) => {
    // The task runs 6s past its launch and the test waits for it to land.
    test.slow()
    await sessionPage.sendMessage('run background and keep working')

    // The row proves the launch landed; the button's label proves the turn is
    // still in progress. (The mock streams its "still working" text once,
    // right after the launch — a session page whose stream attaches after
    // that delta only sees the text once it is persisted at turn end, so
    // waiting for it would wait for the turn to be over.)
    const row = page.getByTestId('background-task-row')
    await expect(row).toBeVisible({ timeout: 10000 })
    await expect(sessionPage.getStopButton()).toHaveAttribute('aria-label', 'Stop the agent')

    await sessionPage.getStopButton().click()
    const dialog = page.getByTestId('stop-session-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Stop the background task too?')
    await page.getByTestId('stop-session-keep-tasks').click()
    await expect(dialog).not.toBeVisible()

    // The response stopped; the task stayed and the composer now waits on it.
    await expect(sessionPage.getStopButton()).toHaveAttribute('aria-label', 'Stop background processes', { timeout: 10000 })
    await expect(row).toBeVisible()
    await expect(sessionPage.getUserMessages().getByTestId('interrupt-marker')).toBeVisible({ timeout: 10000 })

    // The task finishes on its own schedule and wakes the agent, which
    // reports the output — the work Stop used to throw away.
    await expect(
      sessionPage.getAssistantMessages().filter({ hasText: 'Background command completed' })
    ).toBeVisible({ timeout: 30000 })
    await expect(sessionPage.getActivityIndicator()).not.toBeVisible({ timeout: 15000 })
    await sessionPage.waitForInputEnabled(15000)
    await agentPage.waitForStatus('idle', 15000)
  })
})
