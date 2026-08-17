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
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
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

    // Sample while the response streams. The new-turn reserve phase holds the
    // viewport at the reading line (distance ≈ 0 by construction), and once
    // following takes over the spring may trail the live edge transiently —
    // but it must never disengage and let content run away below the fold.
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(400)
      const metrics = await scrollMetrics(page)
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

    // Let the stream overflow the viewport before escaping.
    await expect
      .poll(async () => {
        const metrics = await scrollMetrics(page)
        return metrics.scrollHeight - metrics.clientHeight
      }, { timeout: 10000 })
      .toBeGreaterThan(300)

    const box = (await page.getByTestId('message-list').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -400)

    // Following is paused: the viewport holds still while content keeps
    // streaming in below.
    await page.waitForTimeout(200)
    const before = await scrollMetrics(page)
    await page.waitForTimeout(700)
    const after = await scrollMetrics(page)
    expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(1)
    expect(after.scrollHeight).toBeGreaterThan(before.scrollHeight)

    // The escape surfaced the scroll-to-bottom affordance; taking it returns
    // to the live edge and re-engages following.
    const pill = page.getByRole('button', { name: 'Scroll to bottom' })
    await expect(pill).toBeVisible()
    await pill.click()
    await expect
      .poll(async () => (await scrollMetrics(page)).distanceFromBottom, { timeout: 15000 })
      .toBeLessThan(90)
    await expect(pill).toBeHidden()
  })
})
