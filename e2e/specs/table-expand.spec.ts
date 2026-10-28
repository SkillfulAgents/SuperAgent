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

type Box = { x: number; y: number; width: number; height: number }

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

    // The wide-table response is the only assistant message containing a table,
    // so anchor directly on the table (and the unique intro text) rather than
    // getAssistantMessages().last(): during a finalization re-mount ".last()" can
    // transiently resolve to an empty trailing bubble, which flaked the header
    // count to 0. The intro paragraph stays inside the constrained reading column
    // and is our reference for "the narrow column".
    const table = page.getByTestId('markdown-table')
    const intro = page.getByText('Here is the quarterly breakdown:')
    const contentArea = page.locator('[data-message-content-area]')

    // All 10 header cells render — confirms the wide table is fully present.
    // (A web-first assertion, so it auto-retries through the finalization re-mount.)
    await expect(table.locator('th')).toHaveCount(10, { timeout: 20000 })

    // Read all three boxes atomically once the DOM has settled. After the turn
    // goes idle, a finalization reconcile (the persisted-messages refetch racing
    // the JSONL write) can re-mount the assistant message node — so a bare
    // boundingBox()/toBeVisible() here intermittently sees a detached node (it
    // returns null, or throws strict-mode when the old and new nodes briefly
    // co-exist). Poll the whole locate-and-measure so a mid-swap detach just
    // retries, capturing all three boxes in the same tick before asserting.
    let tableBox!: Box
    let introBox!: Box
    let areaBox!: Box
    await expect.poll(async () => {
      const [t, i, a] = await Promise.all([
        table.boundingBox().catch(() => null),
        intro.boundingBox().catch(() => null),
        contentArea.boundingBox().catch(() => null),
      ])
      if (t && i && a) {
        tableBox = t
        introBox = i
        areaBox = a
        return true
      }
      return false
    }, { timeout: 25000 }).toBe(true)

    // The table is wider than the readable column...
    expect(tableBox.width).toBeGreaterThan(introBox.width + 40)
    // ...and breaks out past the column's left edge (it didn't just scroll in place).
    expect(tableBox.x).toBeLessThan(introBox.x - 8)
    // ...and extends past the column's right edge too.
    expect(tableBox.x + tableBox.width).toBeGreaterThan(introBox.x + introBox.width + 8)

    // The breakout stays inside the chat content area (no full-page horizontal scroll).
    expect(tableBox.x).toBeGreaterThanOrEqual(areaBox.x - 1)
    expect(tableBox.x + tableBox.width).toBeLessThanOrEqual(areaBox.x + areaBox.width + 1)
  })
})
