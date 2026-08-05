import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

/**
 * Stopping the agent from the composer stop button.
 *
 * Uses the mock's SlowWorkScenario ("work slowly", ~5s turn) so there is a
 * live streaming turn to interrupt. The composer stop button POSTs
 * .../interrupt, which aborts the in-flight turn: streaming halts, the
 * session settles, and the next send starts a fresh turn (not the mid-turn
 * steering path). The mock mirrors the real CLI's abort semantics — the
 * interrupted scenario's remaining scheduled output is dropped and queued
 * steering messages are never picked up — so these tests also pin that the
 * aborted turn's tail can never land later.
 *
 * To prove the tail stayed dead without clock-based waits, the tests chain
 * "slow response" turns (3s each) after the stop: each completed turn is a
 * user-visible event a known distance past the interrupt, so by the time the
 * chain finishes, the aborted turn's 5s completion (and the queued message's
 * 8s pickup) would already have landed if it were going to.
 *
 * This is a different code path from the request-card X button
 * (request-stop-session), which pending-request-reconnect.spec covers.
 */
test.describe('Stop button interrupts the working agent', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage

  test.beforeEach(async ({ page }, testInfo) => {
    // These tests chain an interrupted turn plus three scripted mock turns
    // (~15s of scheduled delays before any UI overhead), which doesn't fit the
    // default test timeout on a loaded CI runner — both tests have timed out
    // there with a fully correct end state in the failure snapshot.
    test.slow()

    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    const testAgentName = `Stop Agent ${testInfo.workerIndex}-${Date.now()}`
    await agentPage.createAgent(testAgentName)
  })

  test('stop mid-stream halts the turn and the next send starts a fresh turn', async ({ page }) => {
    // Warm-up turn: a fresh agent's first turn races the SSE join (the stream
    // can start before the EventSource attaches, dropping early deltas), so
    // establish the stream on a quick turn first — the slow turn below then
    // streams over a connected socket and its partial text is reliably visible.
    await sessionPage.sendMessage('hello before the stop test')
    await expect(
      sessionPage.getAssistantMessages().filter({ hasText: 'This is a mock response from the E2E test container.' })
    ).toBeVisible({ timeout: 15000 })

    await sessionPage.sendMessage('please work slowly for the stop test')

    // The turn is live: stop button up, partial text streaming
    await expect(sessionPage.getStopButton()).toBeVisible({ timeout: 10000 })
    await expect(page.getByText('Working on the slow task...')).toBeVisible({ timeout: 10000 })

    await sessionPage.getStopButton().click()

    // The session settles: the stop button leaves. The interrupted turn's
    // partial stream text is deliberately KEPT on idle (use-message-stream
    // preserves streamingMessage until persisted data or a new turn replaces
    // it) — it must not vanish the moment the user stops the agent.
    await expect(sessionPage.getStopButton()).not.toBeVisible({ timeout: 10000 })
    await expect(page.getByText('Working on the slow task...')).toBeVisible()

    // Follow-up sends start fresh turns. If the interrupt had left the mock
    // session on the busy path, these would take the steering route and answer
    // with "Adjusting based on: ..." instead of completing normally. Two
    // chained 3s turns also put us provably past the aborted turn's 5s tail.
    const delayedResponses = sessionPage.getAssistantMessages()
      .filter({ hasText: 'This is a delayed mock response.' })
    await sessionPage.sendMessage('slow response please, first check')
    await expect(delayedResponses).toHaveCount(1, { timeout: 15000 })

    // The new turn's stream replaced the interrupted partial text
    await expect(page.getByText('Working on the slow task...')).not.toBeVisible({ timeout: 10000 })

    // Gate the next send on the composer leaving the working state: the mock
    // emits the response text a few ms before its result/idle, so a send fired
    // the instant the text renders can still hit the mid-turn steering path
    // (which answers "Adjusting based on: ..." instead of running a fresh turn).
    await expect(sessionPage.getStopButton()).not.toBeVisible({ timeout: 10000 })
    await sessionPage.sendMessage('slow response please, second check')
    await expect(delayedResponses).toHaveCount(2, { timeout: 15000 })

    // The aborted turn's tail never landed: no completion text, no steering
    // acknowledgements, no phantom reactivation, and the transcript holds
    // exactly the warm-up turn, the interrupted turn (its user message plus
    // the "[Request interrupted by user]" marker the abort appended), and the
    // two fresh follow-up turns.
    await expect(sessionPage.getAssistantMessages().filter({ hasText: 'Finished the slow work.' })).toHaveCount(0)
    await expect(sessionPage.getAssistantMessages().filter({ hasText: 'Adjusting based on:' })).toHaveCount(0)
    await expect(sessionPage.getAssistantMessages()).toHaveCount(3)
    await expect(sessionPage.getStopButton()).not.toBeVisible()
    await sessionPage.waitForUserMessageCount(5)
    await sessionPage.expectUserMessage('please work slowly for the stop test', 1)
    await sessionPage.expectUserMessage('[Request interrupted by user]', 2)
  })

  test('stopping with a queued message rescues its text into the composer for resend', async ({ page }) => {
    await sessionPage.sendMessage('please work slowly for the draft rescue test')
    await expect(sessionPage.getStopButton()).toBeVisible({ timeout: 10000 })

    // Queue a message mid-turn. The 'pickup after turn' keyword gives the
    // mock's steering pickup an 8s delay, so the stop below deterministically
    // lands while the message is still queued. The text also contains 'slow
    // response' so that, once rescued and resent as a fresh message, it runs
    // a 3s turn usable as a clock for the tail-stayed-dead proof.
    const queuedText = 'slow response please pickup after turn'
    await sessionPage.typeMessage(queuedText)
    await sessionPage.getSendButton().click()

    const ghost = page.locator('[data-testid="queued-user-message"]')
    await expect(ghost).toBeVisible({ timeout: 5000 })
    await expect(ghost).toContainText('Queued')

    await sessionPage.getStopButton().click()
    await expect(sessionPage.getStopButton()).not.toBeVisible({ timeout: 10000 })

    // The queued message was never picked up — after the idle grace period its
    // ghost is removed and its text is restored into the composer draft
    await expect(ghost).not.toBeAttached({ timeout: 10000 })
    await expect(sessionPage.getMessageInput()).toHaveText(queuedText, { timeout: 10000 })

    // Resend the rescued text — it goes out as a fresh turn and persists as a
    // real user message
    const delayedResponses = sessionPage.getAssistantMessages()
      .filter({ hasText: 'This is a delayed mock response.' })
    await sessionPage.getSendButton().click()
    await expect(delayedResponses).toHaveCount(1, { timeout: 15000 })
    // The abort appended the interrupt marker after the slow-work user message
    await sessionPage.waitForUserMessageCount(3, 15000)
    await sessionPage.expectUserMessage('please work slowly for the draft rescue test', 0)
    await sessionPage.expectUserMessage('[Request interrupted by user]', 1)
    await sessionPage.expectUserMessage(queuedText, 2)

    // Chain two more 3s turns: with the resend gated on the 1.5s rescue grace,
    // finishing three chained turns is provably past both cancelled timers
    // (the turn's 5s tail and the queued message's 8s steering pickup). Each
    // send is gated on the composer leaving the working state — the mock emits
    // the response text a few ms before its result/idle, and a send in that
    // window would take the mid-turn steering path instead of a fresh turn.
    await expect(sessionPage.getStopButton()).not.toBeVisible({ timeout: 10000 })
    await sessionPage.sendMessage('slow response please, first check')
    await expect(delayedResponses).toHaveCount(2, { timeout: 15000 })
    await expect(sessionPage.getStopButton()).not.toBeVisible({ timeout: 10000 })
    await sessionPage.sendMessage('slow response please, second check')
    await expect(delayedResponses).toHaveCount(3, { timeout: 15000 })

    // Neither cancelled timer fired: no steering acknowledgement, no
    // completion text, no duplicate of the rescued message. (5 = slow-work
    // message + interrupt marker + rescued resend + the two check turns.)
    await expect(sessionPage.getAssistantMessages().filter({ hasText: 'Adjusting based on:' })).toHaveCount(0)
    await expect(sessionPage.getAssistantMessages().filter({ hasText: 'Finished the slow work.' })).toHaveCount(0)
    await expect(sessionPage.getUserMessages()).toHaveCount(5)
    await expect(sessionPage.getStopButton()).not.toBeVisible()
  })

  test('stopping with two queued messages rescues both texts into the composer', async ({ page }) => {
    await sessionPage.sendMessage('please work slowly for the double rescue test')
    await expect(sessionPage.getStopButton()).toBeVisible({ timeout: 10000 })

    // Queue two messages mid-turn ('pickup after turn' = 8s steering delay, so
    // the stop lands while both are still queued). The runtime names each dead
    // uuid with a command_lifecycle 'discarded' frame; both ghosts must rescue.
    const firstQueued = 'first rescue candidate pickup after turn'
    const secondQueued = 'second rescue candidate pickup after turn'
    await sessionPage.typeMessage(firstQueued)
    await sessionPage.getSendButton().click()
    await sessionPage.typeMessage(secondQueued)
    await sessionPage.getSendButton().click()

    const ghosts = page.locator('[data-testid="queued-user-message"]')
    await expect(ghosts).toHaveCount(2, { timeout: 5000 })

    await sessionPage.getStopButton().click()
    await expect(sessionPage.getStopButton()).not.toBeVisible({ timeout: 10000 })

    // Both ghosts detach and both texts land in the composer draft (rescue
    // batching may merge them in either order — assert presence, not order).
    await expect(ghosts).toHaveCount(0, { timeout: 10000 })
    const composer = sessionPage.getMessageInput()
    await expect(composer).toHaveText(new RegExp('first rescue candidate'), { timeout: 10000 })
    await expect(composer).toHaveText(new RegExp('second rescue candidate'))

    // Neither queued message ever reached the transcript — only the original
    // send and the interrupt marker the abort appended.
    await expect(sessionPage.getUserMessages()).toHaveCount(2)
  })
})
