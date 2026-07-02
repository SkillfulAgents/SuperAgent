import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { SessionPage } from '../pages/session.page'
import { createAgent, createSession, openAgentSession, waitForSessionIdle } from '../helpers/agents'

async function setupThinkingTest(
  page: Page,
  request: APIRequestContext,
  testInfo: TestInfo,
  label: string,
) {
  const appPage = new AppPage(page)
  const sessionPage = new SessionPage(page)
  const agentName = `Thinking Agent ${label} ${testInfo.workerIndex}-${testInfo.repeatEachIndex}-${Date.now()}`
  const agent = await createAgent(request, agentName)
  const setupSession = await createSession(
    request,
    agent,
    `setup thinking display ${label} ${testInfo.workerIndex}-${testInfo.repeatEachIndex}`,
  )
  await waitForSessionIdle(request, agent, setupSession)

  await appPage.goto()
  await appPage.waitForAgentsLoaded()
  await openAgentSession(page, agent, setupSession)
  await sessionPage.waitForInputEnabled(15000)

  return { appPage, sessionPage, agent, setupSession }
}

test.describe('Thinking Display', () => {
  test('thinking streams into an expanded transcript card, then collapses', async ({ page, request }, testInfo) => {
    const { sessionPage } = await setupThinkingTest(page, request, testInfo, 'Card')

    // Triggers the "think out loud" mock scenario: ~5s of thinking_delta
    // chunks, then a text response (thinking persisted in the JSONL).
    await sessionPage.sendMessage('please think out loud about this')

    // While thinking: the card is in the transcript, expanded, and shows the
    // streamed reasoning text in its scrollable body.
    const card = page.getByTestId('thinking-block').last()
    const toggle = card.getByTestId('thinking-block-toggle')
    const body = card.getByTestId('thinking-block-body')
    await expect(card).toBeVisible({ timeout: 10000 })
    await expect(toggle).toContainText('Thinking')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(body).toBeVisible()
    await expect(body).toContainText('Let me reason about this', { timeout: 10000 })

    // Turn finishes: the live card hands off to the persisted one (carried on
    // the refetched message) with no duplication, collapsed to a summary header.
    await sessionPage.waitForInputEnabled(30000)
    await expect(page.getByText('Done thinking — here is the answer.')).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId('thinking-block')).toHaveCount(1, { timeout: 15000 })
    await expect(toggle).toContainText('Thought', { timeout: 10000 })
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(body).not.toBeVisible()

    // The trace stays readable: expanding shows the full text. The card can
    // remount on a post-turn refetch (resetting local expansion state), so
    // re-drive the toggle until the body agrees — mirrors tool-rendering.spec.
    await expect(async () => {
      if (await toggle.getAttribute('aria-expanded') !== 'true') {
        await toggle.click()
      }
      await expect(body).toBeVisible({ timeout: 1000 })
    }).toPass({ timeout: 20000 })
    await expect(body).toContainText('stream a few sentences of summarized reasoning')
  })

  test('collapsing the card mid-stream sticks', async ({ page, request }, testInfo) => {
    const { sessionPage } = await setupThinkingTest(page, request, testInfo, 'Collapse')

    await sessionPage.sendMessage('please think out loud about this')

    const card = page.getByTestId('thinking-block').last()
    const toggle = card.getByTestId('thinking-block-toggle')
    const body = card.getByTestId('thinking-block-body')
    await expect(card).toBeVisible({ timeout: 10000 })
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')

    // User collapses while the trace is still streaming — the card must stay
    // collapsed (their choice wins over the streaming default).
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(body).not.toBeVisible()
    // Wait for the header to change (token count/elapsed grow as deltas keep
    // arriving) and confirm the card is still collapsed.
    const headerBefore = (await toggle.textContent()) ?? ''
    await expect(toggle).not.toHaveText(headerBefore, { timeout: 10000 })
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await sessionPage.waitForInputEnabled(30000)
  })

  test('thinking persists in the transcript across a reopen', async ({ page, request }, testInfo) => {
    const { appPage, sessionPage, agent, setupSession } = await setupThinkingTest(page, request, testInfo, 'Persist')

    await sessionPage.sendMessage('please think out loud about this')
    await sessionPage.waitForInputEnabled(30000)
    await expect(page.getByText('Done thinking — here is the answer.')).toBeVisible({ timeout: 10000 })

    // Re-open the session from scratch — the card now comes purely from the
    // persisted transcript (stream state is gone).
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await openAgentSession(page, agent, setupSession)
    await sessionPage.waitForInputEnabled(15000)

    const card = page.getByTestId('thinking-block').last()
    const toggle = card.getByTestId('thinking-block-toggle')
    const body = card.getByTestId('thinking-block-body')
    await expect(card).toBeVisible({ timeout: 15000 })
    await expect(toggle).toContainText('Thought')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(body).toContainText('Let me reason about this')
    await expect(page.getByTestId('thinking-block')).toHaveCount(1)
  })
})
