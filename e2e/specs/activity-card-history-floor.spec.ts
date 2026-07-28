import { test, expect, type Page, type TestInfo } from '@playwright/test'
import { SessionPage } from '../pages/session.page'
import {
  createAgent,
  gotoAgentHome,
  uniqueName,
  uniqueSuffix,
  type TestAgent,
} from '../helpers/agents'

// Layout needs a real browser; jsdom reports zero heights for both broken and fixed states.
test.describe('Activity card must not squeeze out the chat history', () => {
  let sessionPage: SessionPage
  let agent: TestAgent

  // Preserve enough space for usable transcript context, not only a visible sliver.
  const MIN_HISTORY_HEIGHT = 160

  test.describe.configure({ timeout: 45000 })

  test.beforeEach(async ({ page, request }, testInfo) => {
    sessionPage = new SessionPage(page)
    agent = await createAgent(request, uniqueName(testInfo, 'Fanout Agent'))
    await gotoAgentHome(page, agent)
  })

  async function launchFanout(page: Page, testInfo: TestInfo, trigger = 'subagent fanout') {
    await sessionPage.sendMessage(`${trigger} ${uniqueSuffix(testInfo)}`)
    const card = page.getByTestId('activity-indicator')
    await expect(card).toBeVisible({ timeout: 15000 })
    const rows = card.locator('li').filter({ hasText: 'general-purpose' })
    await expect(rows).toHaveCount(24, {
      timeout: 15000,
    })
    return rows
  }

  // Which element owns the overflow, not just how tall things are: the card's own
  // list absorbs a long action list, so the footer never scrolls as a single unit.
  async function scrollOwnership(page: Page) {
    return page.evaluate(() => {
      const overflows = (el: Element | null | undefined) =>
        el ? el.scrollHeight > el.clientHeight + 1 : null
      const card = document.querySelector('[data-testid="activity-indicator"]')
      return {
        cardList: overflows(card?.querySelector('.overflow-y-auto')),
        footer: overflows(document.querySelector('[data-composer-footer]')),
      }
    })
  }

  test('a long action list leaves the history scrollable and the composer on screen', async ({ page }, testInfo) => {
    const rows = await launchFanout(page, testInfo)
    for (let i = 0; i < 4; i++) {
      await expect(rows.nth(i)).not.toContainText('✓')
    }
    await expect(rows.nth(4)).toContainText('✓')

    const history = await page.locator('[data-testid="message-list"]').boundingBox()
    const viewport = page.viewportSize()
    expect(history!.height).toBeGreaterThanOrEqual(MIN_HISTORY_HEIGHT)

    const composer = page.locator('[data-composer-footer]')
    const composerBox = await composer.boundingBox()
    expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(viewport!.height)

    expect(await scrollOwnership(page)).toEqual({ cardList: true, footer: false })
  })

  test('a pending request stays whole on screen and the card gives way instead', async ({ page }, testInfo) => {
    await launchFanout(page, testInfo, 'subagent fanout with question')
    const request = sessionPage.getQuestionRequests().first()
    await expect(request).toBeVisible({ timeout: 15000 })

    const history = await page.locator('[data-testid="message-list"]').boundingBox()
    const viewport = page.viewportSize()
    const requestBox = await request.boundingBox()
    expect(history!.height).toBeGreaterThanOrEqual(MIN_HISTORY_HEIGHT)

    // The card the user has to act on is never the thing that gets scrolled away.
    expect(requestBox!.y).toBeGreaterThanOrEqual(0)
    expect(requestBox!.y + requestBox!.height).toBeLessThanOrEqual(viewport!.height)

    expect(await scrollOwnership(page)).toEqual({ cardList: true, footer: false })
  })
})
