import { test, expect } from '@playwright/test'
import { SessionPage } from '../pages/session.page'
import {
  createAgent,
  gotoAgentHome,
  uniqueName,
  uniqueSuffix,
  type TestAgent,
} from '../helpers/agents'

// The live activity card sits in the chat column's pinned bottom strip, beside
// the composer. It renders one row per subagent launched during the turn and
// never drops a finished one, so the card grows for the whole turn. The strip
// is sized to its content and the message list takes what is left — so past
// enough rows the history has nothing left to take.
//
// Reported by a dogfooder as "can't scroll into the chat history when the
// action list gets long". Asserted on geometry, not classes: a component test
// cannot see this at all, because jsdom has no layout engine and reports every
// height as 0 whether or not the bug is present.
test.describe('Activity card must not squeeze out the chat history', () => {
  let sessionPage: SessionPage
  let agent: TestAgent

  // The history must stay usable while a turn runs — enough for a few lines of
  // transcript, not a sliver.
  const MIN_HISTORY_HEIGHT = 160

  test.describe.configure({ timeout: 45000 })

  test.beforeEach(async ({ page, request }, testInfo) => {
    sessionPage = new SessionPage(page)
    agent = await createAgent(request, uniqueName(testInfo, 'Fanout Agent'))
    await gotoAgentHome(page, agent)
  })

  test('a long action list leaves the history scrollable and the composer on screen', async ({ page }, testInfo) => {
    await sessionPage.sendMessage(`subagent fanout ${uniqueSuffix(testInfo)}`)

    const card = page.getByTestId('activity-indicator')
    await expect(card).toBeVisible({ timeout: 15000 })
    // Wait for the card to reach full height: every launched subagent has a row.
    await expect(card.locator('li').filter({ hasText: 'general-purpose' })).toHaveCount(24, {
      timeout: 15000,
    })

    const history = await page.locator('[data-testid="message-list"]').boundingBox()
    const column = await page.locator('[data-testid="session-thread-main"]').boundingBox()
    const cardBox = await card.boundingBox()
    const viewport = page.viewportSize()
    console.log(
      `[repro] history ${history?.height}px of a ${column?.height}px column; ` +
      `card ${cardBox?.height}px; viewport ${viewport?.height}px`
    )

    // THE BUG: the card takes the column and the history collapses to nothing.
    expect(history!.height).toBeGreaterThanOrEqual(MIN_HISTORY_HEIGHT)

    // Same collapse pushes the composer past the bottom edge of the window.
    const composer = page.locator('[data-composer-footer]')
    const composerBox = await composer.boundingBox()
    expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(viewport!.height)
  })
})
