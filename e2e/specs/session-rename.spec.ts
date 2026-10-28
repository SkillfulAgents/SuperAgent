import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import {
  createAgent,
  createSession,
  expectSessionNamed,
  openAgentSession,
  uniqueName,
  waitForSessionIdle,
  type TestAgent,
  type TestSession,
} from '../helpers/agents'

/**
 * Session names are persisted to `session-metadata.json` via
 * the hardened (atomic + serialized + fail-closed) write path. The incident was
 * that custom session names silently vanished. This spec exercises the real
 * end-to-end rename flow against the real on-disk metadata store (E2E uses a real
 * SUPERAGENT_DATA_DIR), and — crucially — asserts the name survives a reload,
 * which is what regressed in production.
 */
test.describe('Session Rename (names must persist)', () => {
  async function createSessionFixture(
    page: Page,
    request: APIRequestContext,
    testInfo: TestInfo,
    label: string,
  ): Promise<{ agent: TestAgent; session: TestSession }> {
    const agent = await createAgent(request, uniqueName(testInfo, label))
    const session = await createSession(
      request,
      agent,
      `Create a renameable session for ${uniqueName(testInfo, 'Session Message')}`,
    )
    await waitForSessionIdle(request, agent, session)

    const appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await openAgentSession(page, agent, session)

    return { agent, session }
  }

  async function renameSessionInSidebar(page: Page, session: Pick<TestSession, 'id'>, newName: string) {
    const sessionItem = page.locator(`[data-testid="session-item-${session.id}"]`)
    await expect(sessionItem).toBeVisible({ timeout: 15000 })

    await sessionItem.click({ button: 'right' })
    await page.locator('[data-testid="rename-session-item"]').click()

    const dialog = page.getByRole('dialog', { name: 'Rename Session' })
    await expect(dialog).toBeVisible()
    await dialog.getByPlaceholder('Session name').fill(newName)
    await dialog.getByRole('button', { name: /^Rename$/ }).click()
    await expect(dialog).not.toBeVisible()
    await expect(sessionItem).toContainText(newName, { timeout: 10000 })
  }

  test('renames a session and the new name survives a reload', async ({ page, request }, testInfo) => {
    const { agent, session } = await createSessionFixture(page, request, testInfo, 'Session Rename Once')
    const newName = uniqueName(testInfo, 'Renamed Session')

    await renameSessionInSidebar(page, session, newName)
    await expectSessionNamed(request, agent, session, newName)

    // Reload: the name must be read back from session-metadata.json for the
    // exact session, not whichever session happens to render first.
    await page.reload()
    const appPage = new AppPage(page)
    await appPage.waitForAgentsLoaded()
    await openAgentSession(page, agent, session)
    await expect(page.locator(`[data-testid="session-item-${session.id}"]`)).toContainText(newName, { timeout: 15000 })
    await expectSessionNamed(request, agent, session, newName)
  })

  test('a second rename overwrites the first and also persists', async ({ page, request }, testInfo) => {
    const { agent, session } = await createSessionFixture(page, request, testInfo, 'Session Rename Twice')

    // Two successive read-modify-write cycles on the same metadata file — the
    // second must not be lost and must not clobber the file.
    await renameSessionInSidebar(page, session, uniqueName(testInfo, 'First Session Name'))
    const finalName = uniqueName(testInfo, 'Second Session Name')
    await renameSessionInSidebar(page, session, finalName)
    await expectSessionNamed(request, agent, session, finalName)

    await page.reload()
    const appPage = new AppPage(page)
    await appPage.waitForAgentsLoaded()
    await openAgentSession(page, agent, session)
    await expect(page.locator(`[data-testid="session-item-${session.id}"]`)).toContainText(finalName, { timeout: 15000 })
    await expectSessionNamed(request, agent, session, finalName)
  })
})
