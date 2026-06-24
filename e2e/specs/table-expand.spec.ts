/**
 * Table breakout (SUP-319) — wide, many-column tables in agent responses should
 * expand beyond the narrow readable text column (Notion-style) instead of being
 * crammed into it, while ordinary prose keeps its constrained reading width.
 *
 * The 'wide table' mock scenario streams a 10-column markdown table preceded by
 * an intro paragraph. The intro stays inside the readable column; the table is
 * expected to break out wider than (and to the left of) that column.
 */
import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { SessionPage } from '../pages/session.page'
import { createAgent, createSession, openAgentSession, waitForSessionIdle } from '../helpers/agents'

async function setupSessionView(page: Page, request: APIRequestContext, testInfo: TestInfo) {
  const appPage = new AppPage(page)
  const sessionPage = new SessionPage(page)
  const agentName = `Table Agent ${testInfo.workerIndex}-${testInfo.repeatEachIndex}-${Date.now()}`
  const agent = await createAgent(request, agentName)
  const session = await createSession(
    request,
    agent,
    `setup table ${testInfo.workerIndex}-${testInfo.repeatEachIndex}`,
  )
  await waitForSessionIdle(request, agent, session)

  await appPage.goto()
  await appPage.waitForAgentsLoaded()
  await openAgentSession(page, agent, session)
  await sessionPage.waitForInputEnabled(15000)

  return { sessionPage }
}

test.describe('Agent response table breakout (SUP-319)', () => {
  test('wide table expands beyond the readable column', async ({ page, request }, testInfo) => {
    const { sessionPage } = await setupSessionView(page, request, testInfo)

    await sessionPage.sendMessage('wide table')
    await sessionPage.waitForInputEnabled(20000)

    const lastAssistant = sessionPage.getAssistantMessages().last()
    const table = lastAssistant.getByTestId('markdown-table')
    await expect(table).toBeVisible({ timeout: 20000 })
    // All 10 header cells render — confirms the wide table is fully present.
    await expect(lastAssistant.locator('th')).toHaveCount(10)

    // The intro paragraph stays inside the constrained reading column; it is our
    // reference for "the narrow column".
    const intro = lastAssistant.getByText('Here is the quarterly breakdown:')
    await expect(intro).toBeVisible()

    const tableBox = await table.boundingBox()
    const introBox = await intro.boundingBox()
    expect(tableBox).not.toBeNull()
    expect(introBox).not.toBeNull()

    // The table is wider than the readable column...
    expect(tableBox!.width).toBeGreaterThan(introBox!.width + 40)
    // ...and breaks out past the column's left edge (it didn't just scroll in place).
    expect(tableBox!.x).toBeLessThan(introBox!.x - 8)
    // ...and extends past the column's right edge too.
    expect(tableBox!.x + tableBox!.width).toBeGreaterThan(introBox!.x + introBox!.width + 8)

    // The breakout stays inside the chat content area (no full-page horizontal scroll).
    const contentArea = page.locator('[data-message-content-area]')
    const areaBox = await contentArea.boundingBox()
    expect(areaBox).not.toBeNull()
    expect(tableBox!.x).toBeGreaterThanOrEqual(areaBox!.x - 1)
    expect(tableBox!.x + tableBox!.width).toBeLessThanOrEqual(areaBox!.x + areaBox!.width + 1)
  })
})
