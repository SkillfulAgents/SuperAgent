import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

// "ask integration setup" makes the mock agent call add_agent_integration for
// Linear, which only the owner may set up: the host parks it on a setup card.
test.describe('Integration setup request', () => {
  test.describe.configure({ timeout: 60_000 })

  let sessionPage: SessionPage

  test.beforeEach(async ({ page }, testInfo) => {
    const appPage = new AppPage(page)
    const agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await agentPage.createAgent(`Setup Agent ${testInfo.workerIndex}-${Date.now()}`, { waitForSidebarName: false })
  })

  test('opens the provider setup with the agent\'s suggestions, and a decline resumes the agent', async ({ page }) => {
    await sessionPage.sendMessage('ask integration setup')

    const card = page.getByTestId('integration-setup-request')
    await expect(card).toBeVisible({ timeout: 15000 })
    await expect(card).toContainText('Set up Linear for this agent?')
    await expect(card).toContainText('So the team can delegate support issues to me in Linear')

    await card.getByTestId('integration-setup-open-btn').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Set up integration with Linear')
    await expect(dialog.getByLabel('Integration name')).toHaveValue('Support Triage')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    // Closing the form leaves the ask open.
    await expect(card).toBeVisible()

    await card.getByTestId('integration-setup-decline-btn').click()
    await expect(card).toBeHidden({ timeout: 10000 })
    await sessionPage.waitForInputEnabled(15000)
  })
})
