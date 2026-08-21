import { test, expect, type Page } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

// Matches the MockContainerClient 'stream a long story' scenario: ~700 words
// streamed word-by-word over roughly four seconds — enough to overflow the
// viewport several times while the response is still being written.
const SAGA_PROMPT = 'stream a long story please'

function scrollMetrics(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="message-list"]')!
    // The transcript body's own height grows monotonically with streamed
    // content. scrollHeight does not: during the new-turn reserve phase the
    // spacer absorbs growth 1:1 (net-zero by design), so pacing on it stalls.
    const body = el.querySelector<HTMLElement>('[role="log"]')!
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      contentHeight: body.offsetHeight,
      distanceFromBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
    }
  })
}

test.describe('Transcript live-edge follow', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage

  test.beforeEach(async ({ page }, testInfo) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await agentPage.createAgent(`Follow Agent ${testInfo.workerIndex}-${Date.now()}`)
  })

  test('stays pinned to the live edge while a long response streams', async ({ page }) => {
    await sessionPage.sendMessage(SAGA_PROMPT)
    await sessionPage.waitForUserMessageCount(1)
    await sessionPage.waitForResponse(15000)

    // Sample while the response streams, pacing on content growth rather than
    // wall time: after each additional ~200px of streamed content, the
    // viewport must still be within reach of the live edge. The new-turn
    // reserve phase holds distance ≈ 0 by construction, and once following
    // takes over the spring may trail transiently — but it must never
    // disengage and let content run away below the fold.
    let lastHeight = (await scrollMetrics(page)).contentHeight
    for (let i = 0; i < 4; i++) {
      await expect
        .poll(async () => (await scrollMetrics(page)).contentHeight, { timeout: 10000 })
        .toBeGreaterThan(lastHeight + 200)
      const metrics = await scrollMetrics(page)
      lastHeight = metrics.contentHeight
      expect(metrics.distanceFromBottom).toBeLessThan(500)
    }

    // After the stream ends the viewport settles at the live edge, with no
    // scroll-to-bottom affordance (following stayed engaged throughout).
    await expect
      .poll(async () => (await scrollMetrics(page)).distanceFromBottom, { timeout: 15000 })
      .toBeLessThan(90)
    await expect(page.getByRole('button', { name: 'Scroll to bottom' })).toBeHidden()

    // Sanity: the response actually overflowed the viewport, otherwise this
    // test asserts nothing about following.
    const final = await scrollMetrics(page)
    expect(final.scrollHeight).toBeGreaterThan(final.clientHeight * 1.5)
  })

  test('wheel-up pauses following; the pill returns to the live edge and re-engages', async ({ page }) => {
    await sessionPage.sendMessage(SAGA_PROMPT)
    await sessionPage.waitForResponse(15000)

    // Escape only after the new-turn reserve is spent (the spacer retires
    // once streamed content fills the reserved room) — from here on, growth
    // and scroll positions are free of reserve-eating interactions.
    await expect(page.getByTestId('turn-anchor-spacer')).toBeHidden({ timeout: 20000 })

    const box = (await page.getByTestId('message-list').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -400)

    // The pill appearing is the user-visible proof the escape registered.
    const pill = page.getByRole('button', { name: 'Scroll to bottom' })
    await expect(pill).toBeVisible()

    // Following is paused: wait for the stream to add ≥150px more content,
    // then the viewport must not have moved.
    const before = await scrollMetrics(page)
    await expect
      .poll(async () => (await scrollMetrics(page)).contentHeight, { timeout: 10000 })
      .toBeGreaterThan(before.contentHeight + 150)
    const after = await scrollMetrics(page)
    expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(1)

    // Taking the affordance returns to the live edge and re-engages following.
    await pill.click()
    await expect
      .poll(async () => (await scrollMetrics(page)).distanceFromBottom, { timeout: 15000 })
      .toBeLessThan(90)
    await expect(pill).toBeHidden()
  })

  test('holds the reading line steady while the agent works', async ({ page }) => {
    // The slow-work scenario streams a working indicator, then (~5s in) swaps
    // it for its shorter persisted copy — a content shrink under the held
    // reserve. The browser clamps scrollTop against the momentarily smaller
    // scroll range; the transcript must restore the reading line in the same
    // pass, not leave the held turn visibly sagging until content grows again.
    await sessionPage.sendMessage('work slowly please')
    await expect(page.getByTestId('turn-anchor-spacer')).toBeVisible({ timeout: 15000 })
    await expect
      .poll(async () => (await scrollMetrics(page)).distanceFromBottom, { timeout: 15000 })
      .toBeLessThan(5)

    // Ride through the swap: the persisted copy appearing means the clamp has
    // already happened. The follow spring may trail transiently after content
    // changes (by design), but the clamp's sag has no growth to recover it —
    // only the same-pass restore can. So the discriminating assertion is that
    // the viewport re-converges to the reading line and the reserve is still
    // holding; without the restore the sag freezes ~40px deep and never comes
    // back.
    await expect(page.getByText('Finished the slow work.')).toBeVisible({ timeout: 20000 })
    await expect(page.getByTestId('turn-anchor-spacer')).toBeVisible()
    await expect
      .poll(async () => (await scrollMetrics(page)).distanceFromBottom, { timeout: 3000 })
      .toBeLessThan(5)
    await expect(page.getByRole('button', { name: 'Scroll to bottom' })).toBeHidden()
  })

  test('keeps the live edge pinned through vertical window resizes', async ({ page }) => {
    await sessionPage.sendMessage(SAGA_PROMPT)
    await sessionPage.waitForResponse(15000)
    // Get past the new-turn reserve, whose spacer handles resizes on its own.
    await expect(page.getByTestId('turn-anchor-spacer')).toBeHidden({ timeout: 20000 })
    await expect
      .poll(async () => (await scrollMetrics(page)).distanceFromBottom, { timeout: 15000 })
      .toBeLessThan(90)

    // Browsers anchor the top edge on a viewport shrink, which would slide
    // the newest content behind the fold — the transcript must re-pin so
    // content leaves from the top, not the bottom.
    const viewport = page.viewportSize()!
    await page.setViewportSize({ width: viewport.width, height: viewport.height - 250 })
    await expect
      .poll(async () => (await scrollMetrics(page)).distanceFromBottom, { timeout: 5000 })
      .toBeLessThan(90)

    // Growing back stays pinned too — the browser's own clamp scroll must
    // not be misread as the reader escaping.
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await expect
      .poll(async () => (await scrollMetrics(page)).distanceFromBottom, { timeout: 5000 })
      .toBeLessThan(90)

    // Following survived both resizes: as the stream continues, the viewport
    // keeps up and the escape affordance never appears.
    const mark = (await scrollMetrics(page)).contentHeight
    await expect
      .poll(async () => (await scrollMetrics(page)).contentHeight, { timeout: 10000 })
      .toBeGreaterThan(mark + 150)
    await expect
      .poll(async () => (await scrollMetrics(page)).distanceFromBottom, { timeout: 15000 })
      .toBeLessThan(90)
    await expect(page.getByRole('button', { name: 'Scroll to bottom' })).toBeHidden()
  })
})
