import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

/**
 * Regression coverage for the SSE late-join / reconnect recovery of pending input
 * requests. The agent's `*_request` events are one-shot SSE broadcasts; the server
 * (MessagePersister) stores them and the /stream route replays them on (re)connect,
 * and the renderer dedupes by toolUseId. See the "pending request missing on
 * reconnect" fix and SUP-213.
 *
 * These exercise the reconnect path directly (toggle the network so the EventSource
 * drops and re-establishes while the agent is still awaiting input), which the
 * happy-path user-input-requests specs don't.
 */
test.describe('Pending request reconnect recovery', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage

  test.beforeEach(async ({ page }, testInfo) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await agentPage.createAgent(`Reconnect Agent ${testInfo.workerIndex}-${Date.now()}`)
  })

  // Drop and re-establish the SSE connection while staying on the session view.
  async function cycleConnection(page: import('@playwright/test').Page) {
    await page.context().setOffline(true)
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false)
    await page.context().setOffline(false)
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true)

    // Native EventSource reconnects are not consistently surfaced through
    // Playwright response events. Give the browser's reconnect loop one bounded
    // retry window, then let the card-count assertions below catch missing or
    // duplicate replay behavior.
    await page.waitForFunction(
      () => new Promise((resolve) => setTimeout(resolve, 4000)),
      undefined,
      { timeout: 5000 }
    )
  }

  test('secret request survives an SSE reconnect without duplicating', async ({ page }) => {
    await sessionPage.sendMessage('ask secret')
    await sessionPage.waitForSecretRequest('OPENAI_API_KEY')
    await expect(sessionPage.getSecretRequests()).toHaveCount(1)

    await cycleConnection(page)

    // Still present, still exactly one (replay must not double the card).
    await expect(sessionPage.getSecretRequests()).toHaveCount(1, { timeout: 10000 })

    // And it's still functional: providing it completes the session.
    await sessionPage.provideSecret('sk-test-123', 'OPENAI_API_KEY')
    await expect(sessionPage.getSecretRequests()).toHaveCount(0, { timeout: 10000 })
    await sessionPage.waitForInputEnabled(15000)
  })

  test('parallel requests survive reconnect — one of each, no duplicates', async ({ page }) => {
    await sessionPage.sendMessage('ask parallel')
    await sessionPage.waitForSecretRequest('DATABASE_URL')
    await sessionPage.waitForQuestionRequest()
    await expect(sessionPage.getSecretRequests()).toHaveCount(1)
    await expect(sessionPage.getQuestionRequests()).toHaveCount(1)

    await cycleConnection(page)

    await expect(sessionPage.getSecretRequests()).toHaveCount(1, { timeout: 10000 })
    await expect(sessionPage.getQuestionRequests()).toHaveCount(1, { timeout: 10000 })
  })

  test('interrupting while awaiting input clears the request and it stays gone after reconnect', async ({ page }) => {
    await sessionPage.sendMessage('ask secret')
    await sessionPage.waitForSecretRequest('OPENAI_API_KEY')

    // Interrupt the session from the request card (the X / stop button).
    await sessionPage.stopSessionFromRequest()
    await expect(sessionPage.getSecretRequests()).toHaveCount(0, { timeout: 10000 })

    // After an interrupt the server must have dropped the request from its replay
    // store (cleared on session_idle). If it hadn't, the reconnect below would
    // resurface the now-stale card — the renderer state was cleared by the interrupt,
    // so any card that reappears can only have come from the server replay.
    await cycleConnection(page)
    await expect(sessionPage.getSecretRequests()).toHaveCount(0)
  })
})
