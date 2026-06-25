import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'

/**
 * SUP-309 / SUP-310 — session names are persisted to `session-metadata.json` via
 * the hardened (atomic + serialized + fail-closed) write path. The incident was
 * that custom session names silently vanished. This spec exercises the real
 * end-to-end rename flow against the real on-disk metadata store (E2E uses a real
 * SUPERAGENT_DATA_DIR), and — crucially — asserts the name survives a reload,
 * which is what regressed in production.
 */
test.describe('Session Rename (SUP-309 — names must persist)', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let agentName: string

  test.beforeEach(async ({ page }, testInfo) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    agentName = `Session Rename ${testInfo.workerIndex}-${Date.now()}`
    await agentPage.createAgent(agentName)
  })

  async function renameFirstSession(page: import('@playwright/test').Page, newName: string) {
    await agentPage.expandAgent(agentName)
    const sessionItem = page.locator('[data-testid^="session-item-"]').first()
    await expect(sessionItem).toBeVisible({ timeout: 15000 })

    await sessionItem.click({ button: 'right' })
    await page.locator('[data-testid="rename-session-item"]').click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByPlaceholder('Session name').fill(newName)
    await dialog.locator('button[type="submit"]').click()
    await expect(dialog).not.toBeVisible()
  }

  test('renames a session and the new name survives a reload', async ({ page }) => {
    const newName = `Renamed-${Date.now()}`

    await renameFirstSession(page, newName)

    // Immediately reflected in the sidebar.
    await expect(
      page.locator('[data-testid^="session-item-"]', { hasText: newName })
    ).toBeVisible({ timeout: 10000 })

    // Reload: the name must be read back from session-metadata.json. Before the
    // fix, a non-atomic write + swallow-to-{} read could wipe it here.
    await page.reload()
    await appPage.waitForAgentsLoaded()
    await agentPage.expandAgent(agentName)
    await expect(
      page.locator('[data-testid^="session-item-"]', { hasText: newName })
    ).toBeVisible({ timeout: 15000 })
  })

  test('a second rename overwrites the first and also persists', async ({ page }) => {
    // Two successive read-modify-write cycles on the same metadata file — the
    // second must not be lost and must not clobber the file.
    await renameFirstSession(page, `First-${Date.now()}`)
    const finalName = `Second-${Date.now()}`
    await renameFirstSession(page, finalName)

    await page.reload()
    await appPage.waitForAgentsLoaded()
    await agentPage.expandAgent(agentName)
    await expect(
      page.locator('[data-testid^="session-item-"]', { hasText: finalName })
    ).toBeVisible({ timeout: 15000 })
  })
})
