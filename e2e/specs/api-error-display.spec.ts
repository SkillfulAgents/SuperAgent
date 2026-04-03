import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

test.describe('API Error Display', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage

  test.beforeEach(async ({ page }, testInfo) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    const agentName = `Error Test ${testInfo.workerIndex}-${Date.now()}`
    await agentPage.createAgent(agentName)
  })

  test('shows LLM Provider Error card for authentication failure', async ({ page }) => {
    // "auth error" triggers the ApiErrorScenario with authentication_failed
    await sessionPage.sendMessage('auth error')
    await sessionPage.waitForUserMessageCount(1)

    // The assistant message should render as a provider error card
    const errorCard = page.locator('[data-testid="provider-error-card"]')
    await expect(errorCard.first()).toBeVisible({ timeout: 15000 })
    await expect(errorCard.first()).toContainText('LLM Provider Error')
    await expect(errorCard.first()).toContainText('Invalid API key')
    await expect(errorCard.first()).toContainText('external LLM provider API')
  })

  test('shows LLM Provider Error card for rate limit', async ({ page }) => {
    await sessionPage.sendMessage('rate limit error')
    await sessionPage.waitForUserMessageCount(1)

    const errorCard = page.locator('[data-testid="provider-error-card"]')
    await expect(errorCard.first()).toBeVisible({ timeout: 15000 })
    await expect(errorCard.first()).toContainText('Rate limit exceeded')
  })

  test('input is re-enabled after API error', async ({ page }) => {
    await sessionPage.sendMessage('auth error')

    // Input should be re-enabled after the error
    await sessionPage.waitForInputEnabled(15000)
  })
})
