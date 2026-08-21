import { test, expect } from '@playwright/test'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'
import {
  createAgent,
  expectPendingProxyReviewResolved,
  gotoAgentHome,
  uniqueName,
  uniqueSuffix,
  waitForCurrentSessionId,
  waitForPendingProxyReview,
  type TestAgent,
} from '../helpers/agents'

/**
 * Mixed pending requests across BOTH stores in one turn: two container-side
 * input asks (secret + question, persister pendingInputRequests) plus an
 * agent-scoped proxy review (ReviewManager). No single-store spec can catch a
 * regression where resolving a wait in one store drops the other store's
 * cards or the awaiting status — the exact class of bug behind the recent
 * "Working…" vs parked-review inconsistencies.
 */
test.describe('Mixed Pending Requests (cross-store)', () => {
  let agentPage: AgentPage
  let sessionPage: SessionPage
  let agent: TestAgent

  test.describe.configure({ timeout: 60000 })

  test.beforeEach(async ({ page, request }, testInfo) => {
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    agent = await createAgent(request, uniqueName(testInfo, 'Mixed Agent'))
    await gotoAgentHome(page, agent)
  })

  test('stack shows all three requests; awaiting survives until the last store empties', async ({
    page,
    request,
  }, testInfo) => {
    await sessionPage.sendMessage(`mixed pending ${uniqueSuffix(testInfo)}`)
    await waitForCurrentSessionId(page)

    // All three cards must be reachable in the pending-request stack —
    // the two container inputs and the ReviewManager review.
    const review = await waitForPendingProxyReview(request, agent, {
      xAgent: false,
      toolkit: 'slack',
      targetPath: 'api/chat.postMessage',
      matchedScope: 'chat:write',
    })
    await sessionPage.waitForSecretRequest('MIXED_SECRET_KEY')
    await sessionPage.waitForQuestionRequest()
    await sessionPage.waitForProxyReviewRequestById(review.id, 20000)

    await agentPage.waitForStatus('awaiting_input', 15000)

    // Resolve the ReviewManager wait FIRST. The container inputs are still
    // parked, so the input cards must survive and the status must not drop.
    await sessionPage.waitForProxyReviewRequestById(review.id, 20000)
    await sessionPage.allowProxyReview(review.id)
    await expectPendingProxyReviewResolved(request, agent, review)

    await sessionPage.waitForSecretRequest('MIXED_SECRET_KEY')
    await agentPage.waitForStatus('awaiting_input', 15000)

    // Resolve the secret. The question is still parked — status holds.
    await sessionPage.provideSecret('sk-mixed-test-123', 'MIXED_SECRET_KEY')
    await expect(sessionPage.getSecretRequests()).toHaveCount(0, { timeout: 10000 })

    await sessionPage.waitForQuestionRequest()
    await agentPage.waitForStatus('awaiting_input', 15000)

    // Resolve the last wait — only now may the session leave awaiting.
    await sessionPage.answerQuestion('PostgreSQL')
    await expect(sessionPage.getQuestionRequests()).toHaveCount(0, { timeout: 10000 })

    await expect(
      page.getByText('Thank you for providing the information.')
    ).toBeVisible({ timeout: 15000 })
    await expect(agentPage.getStatus()).not.toHaveAttribute('data-status', 'awaiting_input', {
      timeout: 15000,
    })
  })

  test('denying the review does not disturb the parked container inputs', async ({
    page,
    request,
  }, testInfo) => {
    await sessionPage.sendMessage(`mixed pending ${uniqueSuffix(testInfo)}`)
    await waitForCurrentSessionId(page)

    const review = await waitForPendingProxyReview(request, agent, {
      xAgent: false,
      toolkit: 'slack',
      targetPath: 'api/chat.postMessage',
      matchedScope: 'chat:write',
    })
    await sessionPage.waitForSecretRequest('MIXED_SECRET_KEY')
    await sessionPage.waitForProxyReviewRequestById(review.id, 20000)

    await sessionPage.denyProxyReview(review.id)
    await expectPendingProxyReviewResolved(request, agent, review)

    // Both container inputs remain answerable after the deny.
    await sessionPage.waitForSecretRequest('MIXED_SECRET_KEY')
    await sessionPage.provideSecret('sk-mixed-test-456', 'MIXED_SECRET_KEY')
    await expect(sessionPage.getSecretRequests()).toHaveCount(0, { timeout: 10000 })

    await sessionPage.waitForQuestionRequest()
    await sessionPage.answerQuestion('MongoDB')
    await expect(sessionPage.getQuestionRequests()).toHaveCount(0, { timeout: 10000 })

    await expect(
      page.getByText('Thank you for providing the information.')
    ).toBeVisible({ timeout: 15000 })
  })
})
