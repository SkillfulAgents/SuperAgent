import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

test.describe('Skill subagent visibility', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage

  test.describe.configure({ timeout: 45000 })

  test.beforeEach(async ({ page }, testInfo) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await agentPage.createAgent(
      `Skill Subagent Agent ${testInfo.workerIndex}-${Date.now()}`,
      { waitForSidebarName: false },
    )
  })

  test('shows status for an Agent launched inside a Skill sidechain', async ({ page }) => {
    await sessionPage.sendMessage('skill launches nested subagent')

    const running = page.getByRole('button', {
      name: 'Show full activity: code-reviewer Review the changes · Inspecting tests',
    })
    await expect(running).toBeVisible({ timeout: 15000 })

    await page.reload()
    await expect(running).toBeVisible({ timeout: 5000 })

    const completed = page.getByRole('button', {
      name: 'Show full activity: code-reviewer Review the changes',
    })
    const completedRow = page.getByTestId('subagent-activity-row').filter({ has: completed })
    await expect(completedRow).toBeVisible({ timeout: 7000 })
    await expect(completedRow).toContainText('✓')

    await page.reload()
    await expect(completedRow).toBeVisible({ timeout: 5000 })
    await expect(completedRow).toContainText('✓')
    await agentPage.waitForStatus('idle', 15000)
  })
})
