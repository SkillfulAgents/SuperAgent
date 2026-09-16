import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

/**
 * Background tasks the host only knows from the runtime's snapshot.
 *
 * When a launch is missed (a lost frame, a launcher shape the host does not
 * know), the runtime's background_tasks_changed snapshot is all that names the
 * task. It still keeps the session from settling, so it must be listed — from
 * the snapshot's description — and stoppable, or the session reads "Working…"
 * with nothing to act on. Uses the mock's UnseenBackgroundTaskScenario ("run
 * background unseen": a 6s task announced by snapshot only).
 */
test.describe('Background tasks known only from the runtime snapshot', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage

  test.beforeEach(async ({ page }, testInfo) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    await agentPage.createAgent(`Unseen BG Agent ${testInfo.workerIndex}-${Date.now()}`)
  })

  test('is listed from the snapshot and can be stopped from its row', async ({ page }) => {
    test.slow()
    await sessionPage.sendMessage('run background unseen')

    const row = page.getByTestId('background-task-row')
    await expect(row).toBeVisible({ timeout: 10000 })
    await expect(row).toContainText('Warm the render cache')

    await page.getByTestId('stop-task-button').click()

    await expect(row).not.toBeVisible({ timeout: 10000 })
    await expect(sessionPage.getActivityIndicator()).not.toBeVisible({ timeout: 10000 })
    await sessionPage.waitForInputEnabled(10000)
    await agentPage.waitForStatus('idle', 15000)

    // Two chained 3s turns outlast the 6s the stopped task would have needed.
    const delayedResponses = sessionPage.getAssistantMessages()
      .filter({ hasText: 'This is a delayed mock response.' })
    await sessionPage.sendMessage('slow response please, first check')
    await expect(delayedResponses).toHaveCount(1, { timeout: 15000 })
    await sessionPage.sendMessage('slow response please, second check')
    await expect(delayedResponses).toHaveCount(2, { timeout: 15000 })
    await expect(sessionPage.getAssistantMessages().filter({ hasText: 'Background command completed' })).toHaveCount(0)
  })

  test('Stop offers the task, and the row survives a reload', async ({ page }) => {
    test.slow()
    await sessionPage.sendMessage('run background unseen')
    await expect(page.getByTestId('background-task-row')).toBeVisible({ timeout: 10000 })

    await page.reload()
    const row = page.getByTestId('background-task-row')
    await expect(row).toBeVisible({ timeout: 10000 })
    await expect(row).toContainText('Warm the render cache')

    await sessionPage.getStopButton().click()
    const dialog = page.getByTestId('stop-session-dialog')
    await expect(dialog).toBeVisible()
    await expect(page.getByTestId('stop-session-dialog-tasks')).toContainText('Warm the render cache')
    await page.getByTestId('stop-session-cancel').click()

    await expect(
      sessionPage.getAssistantMessages().filter({ hasText: 'Background command completed' })
    ).toBeVisible({ timeout: 30000 })
    await sessionPage.waitForInputEnabled(15000)
  })
})
