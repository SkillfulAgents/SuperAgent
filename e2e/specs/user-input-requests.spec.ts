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

    // Verify the reason is shown (secret name is in data-secret-name attribute, not visible text)
    const request = sessionPage.getSecretRequests().first()
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

  test('composer is replaced by the request card while a question is pending', async ({ page }) => {
    // Composer should be visible before the request arrives
    await expect(sessionPage.getMessageInput()).toBeVisible()
    await expect(page.locator('[data-testid="pending-request-slot"]')).toHaveCount(0)

    await sessionPage.sendMessage('ask question')
    await sessionPage.waitForQuestionRequest()

    // While the question is pending, the composer is unmounted and the
    // pending-request slot occupies its position.
    await expect(sessionPage.getMessageInput()).toHaveCount(0)
    await expect(page.locator('[data-testid="pending-request-slot"]')).toBeVisible()

    // Answer the question and verify the composer returns and the slot is gone.
    await sessionPage.answerQuestion('PostgreSQL')

    await expect(sessionPage.getMessageInput()).toBeVisible({ timeout: 15000 })
    await expect(page.locator('[data-testid="pending-request-slot"]')).toHaveCount(0)
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

  test('multi-question request: header chevrons flatten across all sub-questions', async ({ page }) => {
    // "ask multi" triggers a single AskUserQuestion containing 3 questions.
    // The header chevrons should advance through every question, not jump to
    // the (non-existent) next card.
    await sessionPage.sendMessage('ask multi')
    await sessionPage.waitForQuestionRequest()

    // 1 card × 3 sub-pages = 3 flat positions.
    await expect(
      page.locator('[data-testid="request-stack-pagination"]:visible').first()
    ).toHaveAttribute('data-count', '3')

    const container = sessionPage.getQuestionRequests().first()
    await expect(container).toContainText('Which database should we use?')

    await sessionPage.clickStackNext()
    await expect(container).toContainText('Which cloud provider do you prefer?')
    expect(await sessionPage.getStackPagination()).toEqual({ index: 1, total: 3 })

    await sessionPage.clickStackNext()
    await expect(container).toContainText('Preferred language?')
    expect(await sessionPage.getStackPagination()).toEqual({ index: 2, total: 3 })

    // Walking back returns to the prior question with the chevron index in sync.
    await sessionPage.clickStackPrev()
    await expect(container).toContainText('Which cloud provider do you prefer?')
    expect(await sessionPage.getStackPagination()).toEqual({ index: 1, total: 3 })
  })

  test('multi-question request: bottom Next button stays in sync with header chevrons', async ({ page }) => {
    await sessionPage.sendMessage('ask multi')
    await sessionPage.waitForQuestionRequest()

    const container = sessionPage.getQuestionRequests().first()
    const pagination = page.locator('[data-testid="request-stack-pagination"]:visible').first()

    // Pick an option and advance via the bottom Next button.
    await container.locator('label').filter({ hasText: 'PostgreSQL' }).click()
    await container.locator('[data-testid="question-next-btn"]').click()

    // Header chevrons should reflect the same sub-page move.
    await expect(pagination).toHaveAttribute('data-current-index', '1')
    await expect(container).toContainText('Which cloud provider do you prefer?')

    // And the reverse: clicking header prev rewinds the bottom flow too.
    await sessionPage.clickStackPrev()
    await expect(pagination).toHaveAttribute('data-current-index', '0')
    await expect(container).toContainText('Which database should we use?')
  })

  test('multi-question request: submit button only renders on the last sub-page', async ({ page }) => {
    await sessionPage.sendMessage('ask multi')
    await sessionPage.waitForQuestionRequest()

    const container = sessionPage.getQuestionRequests().first()
    // On Q1 of 3, the bottom action is Next (not Submit).
    await expect(container.locator('[data-testid="question-next-btn"]')).toBeVisible()
    await expect(container.locator('[data-testid="question-submit-btn"]')).toHaveCount(0)

    // Walk to the last sub-page via the header.
    await sessionPage.clickStackNext()
    await sessionPage.clickStackNext()

    // Now the bottom action is Submit (not Next).
    await expect(container.locator('[data-testid="question-submit-btn"]')).toBeVisible()
    await expect(container.locator('[data-testid="question-next-btn"]')).toHaveCount(0)
  })

  test('multi-question request: answer all questions and complete', async ({ page }) => {
    await sessionPage.sendMessage('ask multi')
    await sessionPage.waitForQuestionRequest()

    await sessionPage.answerMultiQuestion(['PostgreSQL', 'AWS', 'TypeScript'])

    await expect(sessionPage.getQuestionRequests()).toHaveCount(0, { timeout: 10000 })
    await sessionPage.waitForInputEnabled(15000)
  })

  test('multi-question + secret: header pagination flattens across the card boundary', async ({ page }) => {
    // 1 secret + 1 AskUserQuestion (3 questions) = 4 flat positions.
    await sessionPage.sendMessage('ask multi parallel')
    await sessionPage.waitForSecretRequest('DATABASE_URL')
    await sessionPage.waitForQuestionRequest()

    await expect(
      page.locator('[data-testid="request-stack-pagination"]:visible').first()
    ).toHaveAttribute('data-count', '4')
  })

  test('parallel requests: secret + question appear simultaneously', async ({ page }) => {
    // "ask parallel" triggers UserInputRequestScenario with both a secret and a question
    await sessionPage.sendMessage('ask parallel')

    // Both requests should be in the DOM (in a paginated stack — only one visible at a time).
    // Arrival order is non-deterministic in mock SSE, so we don't assume which is on top.
    await sessionPage.waitForSecretRequest('DATABASE_URL')
    await sessionPage.waitForQuestionRequest()

    const secretRequests = sessionPage.getSecretRequests()
    const questionRequests = sessionPage.getQuestionRequests()
    await expect(secretRequests).toHaveCount(1)
    await expect(questionRequests).toHaveCount(1)

    // Content assertions don't care about visibility — toContainText reads hidden DOM too.
    await expect(secretRequests.first()).toContainText('Connection string for the database')
    await expect(questionRequests.first()).toContainText('Which cloud provider do you prefer?')
    await expect(questionRequests.first()).toContainText('AWS')
    await expect(questionRequests.first()).toContainText('GCP')

    // Pagination control should show "1 of 2" since two cards are stacked.
    await expect(
      page.locator('[data-testid="request-stack-pagination"]:visible').first()
    ).toHaveAttribute('data-count', '2')
  })

  test('parallel requests: answer both independently', async ({ page }) => {
    await sessionPage.sendMessage('ask parallel')

    // Wait for both to appear in the stack (order is non-deterministic).
    await sessionPage.waitForSecretRequest('DATABASE_URL')
    await sessionPage.waitForQuestionRequest()

    // Resolve whichever card is on top first, then the other. After each
    // resolution we wait for that card type to drain to zero before asking
    // for the next active card — otherwise we can race the optimistic
    // "disabled-input" state that briefly keeps the same testid attached.
    for (let i = 0; i < 2; i++) {
      const active = await sessionPage.getActiveRequestType()
      if (active === 'secret') {
        await sessionPage.provideSecret('postgres://localhost:5432/db', 'DATABASE_URL')
        await expect(sessionPage.getSecretRequests()).toHaveCount(0, { timeout: 10000 })
      } else if (active === 'question') {
        await sessionPage.answerQuestion('AWS')
        await expect(sessionPage.getQuestionRequests()).toHaveCount(0, { timeout: 10000 })
      } else {
        throw new Error(`Expected an active request card on iteration ${i}, found none`)
      }
    }

    // Session should complete after both inputs are resolved.
    await sessionPage.waitForInputEnabled(15000)
  })

  test('parallel requests: decline secret, answer question', async ({ page }) => {
    await sessionPage.sendMessage('ask parallel')

    await sessionPage.waitForSecretRequest('DATABASE_URL')
    await sessionPage.waitForQuestionRequest()

    // Decline the secret and answer the question, in whatever order they're stacked.
    for (let i = 0; i < 2; i++) {
      const active = await sessionPage.getActiveRequestType()
      if (active === 'secret') {
        await sessionPage.declineSecret('DATABASE_URL')
        await expect(sessionPage.getSecretRequests()).toHaveCount(0, { timeout: 10000 })
      } else if (active === 'question') {
        await sessionPage.answerQuestion('GCP')
        await expect(sessionPage.getQuestionRequests()).toHaveCount(0, { timeout: 10000 })
      } else {
        throw new Error(`Expected an active request card on iteration ${i}, found none`)
      }
    }

    // Session should complete.
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
