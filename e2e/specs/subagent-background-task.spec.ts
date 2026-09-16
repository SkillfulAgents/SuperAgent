import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

/**
 * Background tasks launched by a subagent.
 *
 * A subagent's Bash call and its result travel the sidechain, so the main
 * transcript never sees the launch. The host used to track nothing for it:
 * the runtime's snapshot kept the session in waiting-background, the task
 * list stayed empty, and Stop (scope 'turn') did nothing — the session read
 * "Working…" until the task happened to exit. Uses the mock's
 * SubagentBackgroundBashScenario ("run background from a subagent": a 6s
 * command launched by a subagent, whose turn ends at once).
 */
test.describe('Background tasks launched by a subagent', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage

  test.beforeEach(async ({ page }, testInfo) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    await agentPage.createAgent(`Subagent BG Agent ${testInfo.workerIndex}-${Date.now()}`)
  })

  /** Two chained 3s turns outlast the 6s the stopped task would have needed. */
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

  test('gets its own row, named after the command, and can be stopped from it', async ({ page }) => {
    test.slow()
    await sessionPage.sendMessage('run background from a subagent')

    const row = page.getByTestId('background-task-row')
    await expect(row).toBeVisible({ timeout: 10000 })
    // Named by the host from the subagent's call — the transcript cannot.
    await expect(row).toContainText('python3 -m http.server 8080')

    await page.getByTestId('stop-task-button').click()

    await expect(row).not.toBeVisible({ timeout: 10000 })
    await expect(sessionPage.getActivityIndicator()).not.toBeVisible({ timeout: 10000 })
    await sessionPage.waitForInputEnabled(10000)
    await agentPage.waitForStatus('idle', 15000)

    await proveStoppedTaskStayedDead()
  })

  test('Stop offers the task instead of stopping nothing', async ({ page }) => {
    test.slow()
    await sessionPage.sendMessage('run background from a subagent')

    const row = page.getByTestId('background-task-row')
    await expect(row).toBeVisible({ timeout: 10000 })
    await expect(sessionPage.getStopButton()).toHaveAttribute('aria-label', 'Stop background processes', { timeout: 10000 })

    await sessionPage.getStopButton().click()
    const dialog = page.getByTestId('stop-session-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Stop the background task?')
    await expect(page.getByTestId('stop-session-dialog-tasks')).toContainText('python3 -m http.server 8080')

    await page.getByTestId('stop-session-everything').click()

    await expect(sessionPage.getActivityIndicator()).not.toBeVisible({ timeout: 10000 })
    await sessionPage.waitForInputEnabled(10000)

    await proveStoppedTaskStayedDead()
  })

  test('the row survives a reload', async ({ page }) => {
    // A client that attaches later learns the task, and its name, from the
    // connect snapshot rather than from the stream.
    test.slow()
    await sessionPage.sendMessage('run background from a subagent')
    await expect(page.getByTestId('background-task-row')).toBeVisible({ timeout: 10000 })

    await page.reload()
    const row = page.getByTestId('background-task-row')
    await expect(row).toBeVisible({ timeout: 10000 })
    await expect(row).toContainText('python3 -m http.server 8080')

    await expect(
      sessionPage.getAssistantMessages().filter({ hasText: 'Background command completed' })
    ).toBeVisible({ timeout: 30000 })
    await sessionPage.waitForInputEnabled(15000)
  })
})
