import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

test.describe('Awaiting Input Status', () => {
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

    testAgentName = `Status Agent ${testInfo.workerIndex}-${Date.now()}`
    await agentPage.createAgent(testAgentName)
  })

  test('agent status shows awaiting_input during secret request', async () => {
    // "ask secret" triggers UserInputRequestScenario with mcp__user-input__request_secret
    await sessionPage.sendMessage('ask secret')

    // Wait for the secret request UI to appear
    await sessionPage.waitForSecretRequest('OPENAI_API_KEY')

    // Agent status in main content should show awaiting_input
    await agentPage.waitForStatus('awaiting_input', 15000)

    // Activity indicator should show "Waiting for input..."
    const indicator = sessionPage.getActivityIndicator()
    await expect(indicator).toContainText('Waiting for input...')

    // Provide the secret to resolve the awaiting_input state
    await sessionPage.provideSecret('sk-test-12345', 'OPENAI_API_KEY')

    // Secret request should disappear
    await expect(sessionPage.getSecretRequests()).toHaveCount(0, { timeout: 10000 })

    // Session should complete — status should no longer be awaiting_input
    await sessionPage.waitForInputEnabled(15000)
    await agentPage.waitForStatus('idle', 15000)
  })

  test('agent status shows awaiting_input during question request', async () => {
    await sessionPage.sendMessage('ask question')

    await sessionPage.waitForQuestionRequest()

    // Status should be awaiting_input
    await agentPage.waitForStatus('awaiting_input', 15000)

    // Answer the question
    await sessionPage.answerQuestion('PostgreSQL')

    await expect(sessionPage.getQuestionRequests()).toHaveCount(0, { timeout: 10000 })

    // Session should complete
    await sessionPage.waitForInputEnabled(15000)
    await agentPage.waitForStatus('idle', 15000)
  })

  test('parallel requests: status stays awaiting_input until all resolved', async () => {
    // "ask parallel" triggers secret + question simultaneously
    await sessionPage.sendMessage('ask parallel')

    // Wait for both requests to appear in the stack
    await sessionPage.waitForSecretRequest('DATABASE_URL')
    await sessionPage.waitForQuestionRequest()

    // Status should be awaiting_input
    await agentPage.waitForStatus('awaiting_input', 15000)

    // Secret is visible first in the stack — provide it (one input remains)
    await sessionPage.provideSecret('postgres://localhost:5432/db', 'DATABASE_URL')
    await expect(sessionPage.getSecretRequests()).toHaveCount(0, { timeout: 10000 })

    // Question should now be visible — still awaiting input
    await expect(sessionPage.getQuestionRequests().first()).toBeVisible()

    // Now answer the question
    await sessionPage.answerQuestion('AWS')
    await expect(sessionPage.getQuestionRequests()).toHaveCount(0, { timeout: 10000 })

    // Session should complete
    await sessionPage.waitForInputEnabled(15000)
    await agentPage.waitForStatus('idle', 15000)
  })

  test('declined input clears awaiting_input status', async () => {
    await sessionPage.sendMessage('ask secret')

    await sessionPage.waitForSecretRequest('OPENAI_API_KEY')
    await agentPage.waitForStatus('awaiting_input', 15000)

    // Decline the secret
    await sessionPage.declineSecret('OPENAI_API_KEY')

    await expect(sessionPage.getSecretRequests()).toHaveCount(0, { timeout: 10000 })

    // Session should complete — status should clear
    await sessionPage.waitForInputEnabled(15000)
    await agentPage.waitForStatus('idle', 15000)
  })

  test('sidebar session shows question mark icon when awaiting input', async ({ page }) => {
    await sessionPage.sendMessage('ask secret')

    await sessionPage.waitForSecretRequest('OPENAI_API_KEY')

    // The sidebar session sub-item should have a CircleHelp icon (question mark)
    const sidebar = page.locator('[data-testid="app-sidebar"]')
    const sessionItems = sidebar.locator('[data-testid^="session-item-"]')

    // At least one session item should exist
    await expect(sessionItems.first()).toBeVisible({ timeout: 10000 })

    // The session item should contain a CircleHelp SVG (orange question mark)
    // lucide-react renders SVGs with class "lucide lucide-circle-help"
    const questionIcon = sessionItems.first().locator('svg.lucide-circle-help')
    await expect(questionIcon).toBeVisible({ timeout: 10000 })
  })
})
