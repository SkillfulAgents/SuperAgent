import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { SessionPage } from '../pages/session.page'
import { createAgent, createSession, openAgentSession, waitForSessionIdle } from '../helpers/agents'
import type { ApiMessageOrBoundary } from '../../src/shared/lib/types/api'

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
  test('a follow-up during a background wait does not resurrect prior thinking', async ({ page, request }, testInfo) => {
    test.slow()
    const { sessionPage, agent, setupSession } = await setupThinkingTest(page, request, testInfo, 'BackgroundFollowup')
    const sessionUrl = `/api/agents/${agent.slug}/sessions/${setupSession.id}`

    try {
      await sessionPage.sendMessage('please think then wait for background')
      await expect(page.getByText('Thinking finished; waiting for the background job.')).toBeVisible()
      await expect(sessionPage.getActivityIndicator()).toContainText('Background command')
      await expect(page.getByTestId('thinking-block')).toHaveCount(3)
      await page.screenshot({ path: testInfo.outputPath('before-followup.png'), fullPage: true })

      // A new foreground turn can start while background work keeps the
      // app Working. Its old thinking must stay retired across that boundary.
      await sessionPage.sendMessage('status ?')
      await expect(sessionPage.getUserMessages().filter({ hasText: 'status ?' })).toBeVisible()
      await expect(page.getByTestId('turn-summary').last()).toBeVisible()

      const messagesResponse = await request.get(`${sessionUrl}/messages`)
      expect(messagesResponse.ok()).toBeTruthy()
      const transcript = await messagesResponse.json() as ApiMessageOrBoundary[]
      const thinking = transcript.flatMap(message => message.type === 'assistant' ? message.thinking ?? [] : [])
      expect(thinking).toHaveLength(3)
      expect(new Set(thinking.map(block => block.id)).size).toBe(3)
      for (const block of thinking) expect(block.id).toEqual(expect.stringMatching(/:0$/))
      const followup = transcript.find(message =>
        message.type === 'user' && (message.content as { text?: string }).text === 'status ?',
      )
      expect(followup).toBeDefined()
      expect(followup).not.toHaveProperty('queued', true)
      await testInfo.attach('transcript-after-followup', {
        body: JSON.stringify(transcript, null, 2), contentType: 'application/json',
      })
      await page.screenshot({ path: testInfo.outputPath('after-followup.png'), fullPage: true })

      // These three cards were already persisted. After their turn folds,
      // none should be resurrected below the user's new message.
      const cardsBelowFollowup = page.locator(
        'xpath=//*[@data-testid="message-user" and contains(., "status ?")]/following::*[@data-testid="thinking-block"]',
      )
      await expect(cardsBelowFollowup).toHaveCount(0)
      await expect(sessionPage.getActivityIndicator()).toContainText('Background command')
    } finally {
      await request.post(`${sessionUrl}/interrupt`, { data: { scope: 'all' } })
    }
  })

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
    await page.getByTestId('turn-summary').last().click()
    await expect(page.getByTestId('thinking-block')).toHaveCount(1, { timeout: 15000 })
    await expect(toggle).toContainText('Thought for', { timeout: 10000 })
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

  test('interrupting mid-turn does not clump thinking cards below the interrupt marker', async ({ page, request }, testInfo) => {
    // Chains a multi-pass thinking turn (~7s of scheduled streaming) with an
    // interrupt landing mid-turn — needs headroom on a loaded CI runner.
    test.slow()
    const { sessionPage } = await setupThinkingTest(page, request, testInfo, 'Interrupt')

    // Multi-pass mock scenario: three thinking blocks, each persisted to the
    // transcript as its own assistant entry the moment it completes — so an
    // interrupt leaves earlier passes persisted while later ones die.
    await sessionPage.sendMessage('please think in passes about this')

    // Wait for the second pass to start streaming: the first pass is then
    // already persisted in the JSONL, giving the post-interrupt transcript
    // both persisted thinking AND live blocks still held by the stream store.
    await expect(page.getByTestId('thinking-block')).toHaveCount(2, { timeout: 15000 })

    await sessionPage.getStopButton().click()
    await expect(sessionPage.getStopButton()).not.toBeVisible({ timeout: 10000 })

    // The CLI appends the interrupt marker as a user message ending the turn;
    // it renders as a bare "Stopped" chip.
    const marker = sessionPage.getInterruptMarkers()
    await expect(marker).toBeVisible({ timeout: 10000 })
    await page.getByTestId('turn-summary').last().click()

    // The persisted passes stay inline above the marker...
    await expect(page.getByTestId('thinking-block').first()).toBeVisible()
    // ...and nothing renders below it: the interrupted turn's live blocks must
    // not re-render clumped at the end of the transcript (the marker is a user
    // message, so the dedup scan must not mistake it for a new turn's start).
    const cardsBelowMarker = page.locator(
      'xpath=//*[@data-testid="message-user" and .//*[@data-testid="interrupt-marker"]]/following::*[@data-testid="thinking-block"]'
    )
    await expect(cardsBelowMarker).toHaveCount(0)

    // The interrupted turn's tail stays dead: the final answer never lands.
    await sessionPage.waitForInputEnabled(15000)
    await expect(page.getByText('Done with all thinking passes')).not.toBeVisible()
  })

  test('thinking persists in the transcript across a reopen', async ({ page, request }, testInfo) => {
    // Setup, a streamed thinking turn, and a second sidebar navigation exceed
    // the default 30s budget on a loaded CI runner.
    test.slow()
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
    await page.getByTestId('turn-summary').last().click()

    const card = page.getByTestId('thinking-block').last()
    const toggle = card.getByTestId('thinking-block-toggle')
    const body = card.getByTestId('thinking-block-body')
    await expect(card).toBeVisible({ timeout: 15000 })
    // Duration comes from transcript timestamps, so it survives the reopen
    await expect(toggle).toContainText('Thought for')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(body).toContainText('Let me reason about this')
    await expect(page.getByTestId('thinking-block')).toHaveCount(1)
  })

  test('divergent live text hands off while the session remains active', async ({ page, request }, testInfo) => {
    const { sessionPage } = await setupThinkingTest(page, request, testInfo, 'ActiveMismatch')

    await sessionPage.sendMessage('please think with missing deltas')

    // The mock persists the full thinking block but delays the terminal result,
    // reproducing a long-running turn whose live stream only retained a suffix.
    await expect(page.getByText('Persisted divergent-thinking checkpoint.')).toBeVisible({ timeout: 10000 })
    await expect(sessionPage.getStopButton()).toBeVisible()

    // String-prefix matching would leave both the persisted card and the
    // divergent completed live card visible. Stable identity leaves one.
    await expect(page.getByTestId('thinking-block')).toHaveCount(1)

    await sessionPage.waitForInputEnabled(20000)
  })
})
