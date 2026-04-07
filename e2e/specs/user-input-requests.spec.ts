import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'


test.describe('User Input Requests', () => {
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

    // Use unique agent name per test
    testAgentName = `Input Agent ${testInfo.workerIndex}-${Date.now()}`
    await agentPage.createAgent(testAgentName)
  })

  test('secret request: provide a secret', async ({ page }) => {
    // "ask secret" triggers UserInputRequestScenario with mcp__user-input__request_secret
    await sessionPage.sendMessage('ask secret')

    // Wait for the secret request UI to appear
    await sessionPage.waitForSecretRequest('OPENAI_API_KEY')

    // Verify the secret name and reason are shown
    const request = sessionPage.getSecretRequests().first()
    await expect(request).toContainText('OPENAI_API_KEY')
    await expect(request).toContainText('Needed for API access')

    // Fill in and provide the secret
    await sessionPage.provideSecret('sk-test-12345', 'OPENAI_API_KEY')

    // Secret request form should disappear after providing
    await expect(sessionPage.getSecretRequests()).toHaveCount(0, { timeout: 10000 })

    // Session should complete
    await sessionPage.waitForInputEnabled(15000)
  })

  test('secret request: decline a secret', async ({ page }) => {
    await sessionPage.sendMessage('ask secret')

    await sessionPage.waitForSecretRequest('OPENAI_API_KEY')

    // Decline the secret
    await sessionPage.declineSecret('OPENAI_API_KEY')

    // Secret request form should disappear after declining
    await expect(sessionPage.getSecretRequests()).toHaveCount(0, { timeout: 10000 })

    // Session should complete
    await sessionPage.waitForInputEnabled(15000)
  })

  test('question request: answer a question', async ({ page }) => {
    // "ask question" triggers UserInputRequestScenario with AskUserQuestion
    await sessionPage.sendMessage('ask question')

    // Wait for the question request UI to appear
    await sessionPage.waitForQuestionRequest()

    // Verify the question content is shown
    const request = sessionPage.getQuestionRequests().first()
    await expect(request).toContainText('Which database should we use?')
    await expect(request).toContainText('PostgreSQL')
    await expect(request).toContainText('MongoDB')
    await expect(request).toContainText('SQLite')

    // Select an option and submit
    await sessionPage.answerQuestion('PostgreSQL')

    // Question request form should disappear after answering
    await expect(sessionPage.getQuestionRequests()).toHaveCount(0, { timeout: 10000 })

    // Session should complete
    await sessionPage.waitForInputEnabled(15000)
  })

  test('question request: decline a question', async ({ page }) => {
    await sessionPage.sendMessage('ask question')

    await sessionPage.waitForQuestionRequest()

    // Decline the question
    await sessionPage.declineQuestion()

    // Question request form should disappear after declining
    await expect(sessionPage.getQuestionRequests()).toHaveCount(0, { timeout: 10000 })

    // Session should complete
    await sessionPage.waitForInputEnabled(15000)
  })

  test('parallel requests: secret + question appear simultaneously', async ({ page }) => {
    // "ask parallel" triggers UserInputRequestScenario with both a secret and a question
    await sessionPage.sendMessage('ask parallel')

    // Both requests should appear (in a paginated stack — only one visible at a time)
    await sessionPage.waitForSecretRequest('DATABASE_URL')
    await sessionPage.waitForQuestionRequest()

    // Verify both are in the DOM
    const secretRequests = sessionPage.getSecretRequests()
    const questionRequests = sessionPage.getQuestionRequests()
    await expect(secretRequests).toHaveCount(1)
    await expect(questionRequests).toHaveCount(1)

    // Verify content (toContainText works on hidden elements in the stack)
    await expect(secretRequests.first()).toContainText('DATABASE_URL')
    await expect(secretRequests.first()).toContainText('Connection string for the database')
    await expect(questionRequests.first()).toContainText('Which cloud provider do you prefer?')
    await expect(questionRequests.first()).toContainText('AWS')
    await expect(questionRequests.first()).toContainText('GCP')
  })

  test('parallel requests: answer both independently', async ({ page }) => {
    await sessionPage.sendMessage('ask parallel')

    // Wait for both to appear in the stack
    await sessionPage.waitForSecretRequest('DATABASE_URL')
    await sessionPage.waitForQuestionRequest()

    // Secret is visible first in the stack — provide it
    await sessionPage.provideSecret('postgres://localhost:5432/db', 'DATABASE_URL')
    await expect(sessionPage.getSecretRequests()).toHaveCount(0, { timeout: 10000 })

    // Question should now be visible (only remaining card in stack)
    await expect(sessionPage.getQuestionRequests().first()).toBeVisible()

    // Answer the question
    await sessionPage.answerQuestion('AWS')
    await expect(sessionPage.getQuestionRequests()).toHaveCount(0, { timeout: 10000 })

    // Session should complete after both inputs are resolved
    await sessionPage.waitForInputEnabled(15000)
  })

  test('parallel requests: decline secret, answer question', async ({ page }) => {
    await sessionPage.sendMessage('ask parallel')

    // Wait for both to appear in the stack
    await sessionPage.waitForSecretRequest('DATABASE_URL')
    await sessionPage.waitForQuestionRequest()

    // Secret is visible first in the stack — decline it
    await sessionPage.declineSecret('DATABASE_URL')
    await expect(sessionPage.getSecretRequests()).toHaveCount(0, { timeout: 10000 })

    // Question should now be visible (only remaining card in stack)
    await expect(sessionPage.getQuestionRequests().first()).toBeVisible()

    // Answer the question
    await sessionPage.answerQuestion('GCP')
    await expect(sessionPage.getQuestionRequests()).toHaveCount(0, { timeout: 10000 })

    // Session should complete
    await sessionPage.waitForInputEnabled(15000)
  })

  test('script run request: approve execution', async ({ page }) => {
    // No global toggle needed — permissions are now per-agent via ComputerUsePermissionManager
    // With no cached permission, the request will be shown to the user for approval

    // "ask script" triggers UserInputRequestScenario with mcp__user-input__request_script_run
    await sessionPage.sendMessage('ask script')

    // Wait for the script run request UI to appear
    await sessionPage.waitForScriptRunRequest()

    // Verify content is shown
    const request = sessionPage.getScriptRunRequests().first()
    await expect(request).toContainText('sw_vers')
    await expect(request).toContainText('Check macOS version')

    // Approve execution
    await sessionPage.approveScriptRun()

    // Request should disappear
    await expect(sessionPage.getScriptRunRequests()).toHaveCount(0, { timeout: 10000 })

    // Session should complete
    await sessionPage.waitForInputEnabled(15000)
  })

  test('script run request: deny execution', async ({ page }) => {
    // No global toggle needed — permissions are now per-agent via ComputerUsePermissionManager

    await sessionPage.sendMessage('ask script')

    await sessionPage.waitForScriptRunRequest()

    // Deny execution
    await sessionPage.denyScriptRun()

    // Request should disappear
    await expect(sessionPage.getScriptRunRequests()).toHaveCount(0, { timeout: 10000 })

    // Session should complete
    await sessionPage.waitForInputEnabled(15000)
  })
})
