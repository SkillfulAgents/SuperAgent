import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'
import {
  createAgent,
  findSessionWithUserMessage,
  getAgentItem,
  gotoAgentHome,
  uniqueName,
  uniqueSuffix,
  waitForCurrentSessionId,
  waitForPendingProxyReview,
  type TestAgent,
  type TestSession,
} from '../helpers/agents'

test.describe('Awaiting Input Status', () => {
  let agentPage: AgentPage
  let sessionPage: SessionPage
  let agent: TestAgent

  test.describe.configure({ timeout: 45000 })

  test.beforeEach(async ({ page, request }, testInfo) => {
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    agent = await createAgent(request, uniqueName(testInfo, 'Status Agent'))
    await gotoAgentHome(page, agent)
  })

  async function sendScenarioMessage(
    page: Page,
    request: APIRequestContext,
    testInfo: TestInfo,
    trigger: string,
  ): Promise<TestSession> {
    const message = `${trigger} ${uniqueSuffix(testInfo)}`
    await sessionPage.sendMessage(message)
    const session = await findSessionWithUserMessage(request, agent, message)

    await expect.poll(() => page.url().includes(session.id), { timeout: 15000 }).toBe(true)

    return session
  }

  async function resolveActiveParallelRequest() {
    const active = await sessionPage.getActiveRequestType()

    if (active === 'secret') {
      await sessionPage.provideSecret('postgres://localhost:5432/db', 'DATABASE_URL')
      await expect(sessionPage.getSecretRequests()).toHaveCount(0, { timeout: 10000 })
      return 'secret' as const
    }

    if (active === 'question') {
      await sessionPage.answerQuestion('AWS')
      await expect(sessionPage.getQuestionRequests()).toHaveCount(0, { timeout: 10000 })
      return 'question' as const
    }

    throw new Error(`Expected an active request card, found ${active}`)
  }

  test('agent status shows awaiting_input during secret request', async ({ page, request }, testInfo) => {
    // "ask secret" triggers UserInputRequestScenario with mcp__user-input__request_secret
    await sendScenarioMessage(page, request, testInfo, 'ask secret')

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

  test('agent status shows awaiting_input during question request', async ({ page, request }, testInfo) => {
    await sendScenarioMessage(page, request, testInfo, 'ask question')

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

  test('parallel requests: status stays awaiting_input until all resolved', async ({ page, request }, testInfo) => {
    // "ask parallel" triggers secret + question simultaneously
    await sendScenarioMessage(page, request, testInfo, 'ask parallel')

    // Both requests end up stacked (only one visible at a time). Wait for both to exist.
    await sessionPage.waitForSecretRequest('DATABASE_URL', 20000)
    await sessionPage.waitForQuestionRequest(20000)

    // Status should be awaiting_input
    await agentPage.waitForStatus('awaiting_input', 15000)

    // Resolve whichever card is visible first. The agent must still be awaiting
    // input until the second card is also resolved.
    const firstResolved = await resolveActiveParallelRequest()
    if (firstResolved === 'secret') {
      await expect(sessionPage.getQuestionRequests()).toHaveCount(1, { timeout: 10000 })
      await expect(sessionPage.getQuestionRequests().first()).toBeVisible()
    } else {
      await expect(sessionPage.getSecretRequests()).toHaveCount(1, { timeout: 10000 })
      await expect(sessionPage.getSecretRequests().first()).toBeVisible()
    }
    await agentPage.waitForStatus('awaiting_input', 15000)

    await resolveActiveParallelRequest()

    await expect(sessionPage.getSecretRequests()).toHaveCount(0, { timeout: 10000 })
    await expect(sessionPage.getQuestionRequests()).toHaveCount(0, { timeout: 10000 })

    // Session should complete
    await sessionPage.waitForInputEnabled(15000)
    await agentPage.waitForStatus('idle', 15000)
  })

  test('declined input clears awaiting_input status', async ({ page, request }, testInfo) => {
    await sendScenarioMessage(page, request, testInfo, 'ask secret')

    await sessionPage.waitForSecretRequest('OPENAI_API_KEY')
    await agentPage.waitForStatus('awaiting_input', 15000)

    // Decline the secret
    await sessionPage.declineSecret('OPENAI_API_KEY')

    await expect(sessionPage.getSecretRequests()).toHaveCount(0, { timeout: 10000 })

    // Session should complete — status should clear
    await sessionPage.waitForInputEnabled(15000)
    await agentPage.waitForStatus('idle', 15000)
  })

  test('a parked proxy review flags a session that starts after it', async ({ page, request }, testInfo) => {
    // Session 1 parks an agent-scoped proxy review (real ReviewManager).
    // The review scenario persists its user message only after the decision,
    // so wait on the session id from the URL, not on the transcript.
    await sessionPage.sendMessage(`proxy review ${uniqueSuffix(testInfo)}`)
    await waitForCurrentSessionId(page)
    const review = await waitForPendingProxyReview(request, agent, {
      xAgent: false,
      toolkit: 'slack',
      targetPath: 'api/chat.postMessage',
    })
    await agentPage.waitForStatus('awaiting_input', 15000)

    // Start a NEW session while the review is still parked. The review is
    // agent-scoped, so the fresh session must read as waiting on the human
    // from its first moment — the waiting status derives from the open
    // request, not from which sessions happened to be active when the review
    // was raised. Assert via the sessions route (the status source for the
    // sidebar and header): the slow-work turn holds the session active for
    // ~5s, so the poll must land inside that window.
    await gotoAgentHome(page, agent)
    const session2 = await sendScenarioMessage(page, request, testInfo, 'work slowly')
    await expect
      .poll(async () => {
        const res = await request.get(`/api/agents/${agent.slug}/sessions`)
        if (!res.ok()) return undefined
        const sessions = (await res.json()) as Array<{ id: string; isAwaitingInput: boolean }>
        return sessions.find((s) => s.id === session2.id)?.isAwaitingInput
      }, { timeout: 4000 })
      .toBe(true)

    // The agent keeps reading awaiting — session 1 is still parked on the
    // review, whose card renders here too (it is agent-scoped). The composer
    // stays gated behind the card, so allow FIRST, then expect the settle.
    await agentPage.waitForStatus('awaiting_input', 15000)
    await sessionPage.waitForProxyReviewRequestById(review.id, 35000)
    await sessionPage.allowProxyReview(review.id)

    // Session 1 unwinds and the whole agent settles.
    await sessionPage.waitForInputEnabled(20000)
    await agentPage.waitForStatus('idle', 20000)
  })

  test('sidebar session shows question mark icon when awaiting input', async ({ page, request }, testInfo) => {
    const session = await sendScenarioMessage(page, request, testInfo, 'ask secret')

    await sessionPage.waitForSecretRequest('OPENAI_API_KEY')

    const agentItem = getAgentItem(page, agent)
    await expect(agentItem).toBeVisible({ timeout: 10000 })

    const agentLi = agentItem.locator('xpath=ancestor::li[1]')
    const expandChevron = agentLi.locator('button[aria-label="Expand"]').first()
    if (await expandChevron.isVisible({ timeout: 500 }).catch(() => false)) {
      await expandChevron.click()
    }

    const sessionItem = page.locator(`[data-testid="session-item-${session.id}"]`)
    await expect(sessionItem).toBeVisible({ timeout: 15000 })

    // The exact session item should contain the "needs input" indicator.
    const awaitingIndicator = sessionItem.getByRole('img', { name: 'needs input' })
    await expect(awaitingIndicator).toBeVisible({ timeout: 10000 })
  })
})
