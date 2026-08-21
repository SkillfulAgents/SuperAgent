import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

/**
 * Two tabs viewing the same session must stay in sync on pending user-input
 * requests. Each tab holds its request cards in EventSource-fed local state:
 * the tab that resolves a request removes its card via a local optimistic
 * update, and every OTHER tab must drop the card when the server broadcasts
 * that request's tool_result.
 *
 * Regression: the non-resolving tab kept showing the already-resolved card
 * until the whole turn ended (session_idle), because the renderer's
 * tool_result handler never removed entries from the pending-request lists.
 *
 * The `ask parallel` scenario (secret + question) is used deliberately:
 * resolving only one of the two requests keeps the session active, so the
 * session_idle turn boundary cannot mask a missing per-request sync.
 */
test.describe('Concurrent tabs: pending request sync', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage

  test.beforeEach(async ({ page }, testInfo) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await agentPage.createAgent(`Two Tab Agent ${testInfo.workerIndex}-${Date.now()}`)
  })

  /** Open the current session in a second tab of the same browser context. */
  async function openSecondTab(page: import('@playwright/test').Page) {
    await expect(page).toHaveURL(/\/agents\/[^/]+\/sessions\/[^/?#]+/)
    const pageB = await page.context().newPage()
    await pageB.goto(page.url())
    return pageB
  }

  test('providing a secret in one tab clears it in the other while the question stays pending', async ({ page }) => {
    await sessionPage.sendMessage('ask parallel')
    await sessionPage.waitForSecretRequest('DATABASE_URL')
    await sessionPage.waitForQuestionRequest()

    const pageB = await openSecondTab(page)
    const sessionB = new SessionPage(pageB)
    // The second tab joined after the one-shot request broadcasts; the server
    // replays pending requests on stream connect.
    await sessionB.waitForSecretRequest('DATABASE_URL')
    await sessionB.waitForQuestionRequest()

    // Resolve the secret in tab A — its card disappears locally.
    await sessionPage.provideSecret('postgres://localhost:5432/db', 'DATABASE_URL')
    await expect(sessionPage.getSecretRequests()).toHaveCount(0, { timeout: 10000 })

    // Tab B must drop the resolved secret card too, while the still-pending
    // question card stays. The session is still active here, so only a
    // per-request sync (not the turn boundary) can clear it.
    await expect(sessionB.getSecretRequests()).toHaveCount(0, { timeout: 10000 })
    await expect(sessionB.getQuestionRequests()).toHaveCount(1)
    await expect(sessionPage.getQuestionRequests()).toHaveCount(1)

    // Reverse direction: answer the question from tab B, tab A follows.
    await sessionB.answerQuestion('AWS')
    await expect(sessionB.getQuestionRequests()).toHaveCount(0, { timeout: 10000 })
    await expect(sessionPage.getQuestionRequests()).toHaveCount(0, { timeout: 10000 })

    // Both inputs resolved — the session completes in both tabs.
    await sessionPage.waitForInputEnabled(15000)
    await sessionB.waitForInputEnabled(15000)
    await pageB.close()
  })

  test('answering the question in one tab keeps the secret request pending in both tabs', async ({ page }) => {
    await sessionPage.sendMessage('ask parallel')
    await sessionPage.waitForSecretRequest('DATABASE_URL')
    await sessionPage.waitForQuestionRequest()

    const pageB = await openSecondTab(page)
    const sessionB = new SessionPage(pageB)
    await sessionB.waitForSecretRequest('DATABASE_URL')
    await sessionB.waitForQuestionRequest()

    // Resolve the question in tab A this time (reverse order of the tests
    // above) — only the question card may disappear, in both tabs.
    await sessionPage.answerQuestion('AWS')
    await expect(sessionPage.getQuestionRequests()).toHaveCount(0, { timeout: 10000 })
    await expect(sessionB.getQuestionRequests()).toHaveCount(0, { timeout: 10000 })

    // The unresolved secret request must survive in BOTH tabs.
    await expect(sessionPage.getSecretRequests()).toHaveCount(1)
    await expect(sessionB.getSecretRequests()).toHaveCount(1)

    // And it must still be functional cross-tab: provide it from tab B and
    // watch tab A clear and the session complete everywhere.
    await sessionB.provideSecret('postgres://localhost:5432/db', 'DATABASE_URL')
    await expect(sessionB.getSecretRequests()).toHaveCount(0, { timeout: 10000 })
    await expect(sessionPage.getSecretRequests()).toHaveCount(0, { timeout: 10000 })
    await sessionPage.waitForInputEnabled(15000)
    await sessionB.waitForInputEnabled(15000)
    await pageB.close()
  })

  test('declining a secret in one tab clears it in the other', async ({ page }) => {
    await sessionPage.sendMessage('ask parallel')
    await sessionPage.waitForSecretRequest('DATABASE_URL')
    await sessionPage.waitForQuestionRequest()

    const pageB = await openSecondTab(page)
    const sessionB = new SessionPage(pageB)
    await sessionB.waitForSecretRequest('DATABASE_URL')
    await sessionB.waitForQuestionRequest()

    // Decline (reject path) in tab A.
    await sessionPage.declineSecret('DATABASE_URL')
    await expect(sessionPage.getSecretRequests()).toHaveCount(0, { timeout: 10000 })

    // Tab B drops the declined card; the question remains pending in both.
    await expect(sessionB.getSecretRequests()).toHaveCount(0, { timeout: 10000 })
    await expect(sessionB.getQuestionRequests()).toHaveCount(1)
    await expect(sessionPage.getQuestionRequests()).toHaveCount(1)

    // Finish the turn so the session settles cleanly.
    await sessionB.answerQuestion('GCP')
    await expect(sessionPage.getQuestionRequests()).toHaveCount(0, { timeout: 10000 })
    await sessionPage.waitForInputEnabled(15000)
    await pageB.close()
  })
})
