import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { SessionPage } from '../pages/session.page'
import {
  createAgent,
  createSession,
  expectSessionNamed,
  listSessions,
  openAgentSession,
  gotoAgentHome,
  renameSessionViaApi,
  uniqueName,
  waitForSessionIdle,
  type TestAgent,
  type TestSession,
} from '../helpers/agents'

/**
 * Session deletion — the only destructive session operation — must remove the
 * session everywhere, durably, and navigate correctly:
 *
 * - deleting the session you are currently VIEWING up-navigates to the agent
 *   home (the `strict:false` params.sessionId guard in session-context-menu);
 * - deleting a session you are NOT viewing must NOT navigate;
 * - the deletion is durable: gone from the sessions API after reload, and a
 *   deep-link to the dead id renders the SessionNotFound leaf (after TanStack
 *   Query's default 404 retries, so those assertions get generous timeouts);
 * - the agent-home list exposes the same delete via its kebab menu, guarded by
 *   the same confirm dialog, and Cancel leaves the session untouched.
 *
 * Each test owns its agent and sessions (created via API), so the spec is
 * fully parallel-safe.
 */
test.describe('Session deletion', () => {
  async function createTwoSessionFixture(
    page: Page,
    request: APIRequestContext,
    testInfo: TestInfo,
    label: string,
  ): Promise<{ agent: TestAgent; sessionA: TestSession; sessionB: TestSession }> {
    const agent = await createAgent(request, uniqueName(testInfo, label))
    const createdA = await createSession(request, agent, `First ${uniqueName(testInfo, 'delete-target')}`)
    const createdB = await createSession(request, agent, `Second ${uniqueName(testInfo, 'delete-target')}`)
    // Let both mock turns finish so deletion never races an in-flight
    // transcript write
    await waitForSessionIdle(request, agent, createdA)
    await waitForSessionIdle(request, agent, createdB)

    // Fresh sessions all display the default "New Session" name, which makes
    // every name-based assertion (confirm-dialog copy, kebab aria-labels)
    // ambiguous — give each session a unique name before the UI loads
    const nameA = uniqueName(testInfo, 'Alpha Session')
    const nameB = uniqueName(testInfo, 'Beta Session')
    await renameSessionViaApi(request, agent, createdA, nameA)
    await renameSessionViaApi(request, agent, createdB, nameB)
    const sessionA = await expectSessionNamed(request, agent, createdA, nameA)
    const sessionB = await expectSessionNamed(request, agent, createdB, nameB)

    const appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    return { agent, sessionA, sessionB }
  }

  test('sidebar delete: no nav when deleting another session, up-nav to home when deleting the viewed one, durably gone', async ({ page, request }, testInfo) => {
    const { agent, sessionA, sessionB } = await createTwoSessionFixture(
      page, request, testInfo, 'Session Delete Sidebar',
    )
    const sessionPage = new SessionPage(page)

    await openAgentSession(page, agent, sessionA)

    // Delete session B while viewing session A: the confirm dialog names B,
    // and after deletion we must still be on session A (no up-nav — the guard
    // only fires for the session being viewed)
    await sessionPage.deleteSessionViaContextMenu(sessionB.id, sessionB.name)
    await expect(page).toHaveURL(new RegExp(`/agents/${agent.slug}/sessions/${sessionA.id}$`))
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible()
    await expect(page.locator(`[data-testid="session-item-${sessionB.id}"]`)).toHaveCount(0)

    let remaining = await listSessions(request, agent)
    expect(remaining.map((s) => s.id)).toEqual([sessionA.id])

    // Now delete session A — the one being viewed — and land on agent home
    await sessionPage.deleteSessionViaContextMenu(sessionA.id, sessionA.name)
    await expect(page).toHaveURL(new RegExp(`/agents/${agent.slug}/?$`))
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()
    await expect(page.locator(`[data-testid="session-item-${sessionA.id}"]`)).toHaveCount(0)

    // Durable: still gone from the sessions API after a reload
    await page.reload()
    const appPage = new AppPage(page)
    await appPage.waitForAgentsLoaded()
    remaining = await listSessions(request, agent)
    expect(remaining).toEqual([])

    // Deep-linking the deleted id renders the not-found leaf (after the
    // session query exhausts its default retries), not a stuck loader or a
    // resurrected session
    await page.goto(`/agents/${agent.slug}/sessions/${sessionA.id}`)
    const notFound = page.locator('[data-testid="session-not-found"]')
    await expect(notFound).toBeVisible({ timeout: 20000 })
    await expect(notFound).toContainText('Session not available')

    // ...and its escape hatch leads back to the agent home
    await notFound.getByRole('link', { name: 'Back to agent' }).click()
    await expect(page).toHaveURL(new RegExp(`/agents/${agent.slug}/?$`))
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()
  })

  test('agent-home kebab delete: cancel keeps the session, confirm removes only that session without navigating', async ({ page, request }, testInfo) => {
    const { agent, sessionA, sessionB } = await createTwoSessionFixture(
      page, request, testInfo, 'Session Delete Home',
    )

    await gotoAgentHome(page, agent)

    // exact:true — role-name matching is substring by default, and the row
    // button's accessible name embeds the kebab's label, so a substring match
    // resolves to both the row and its kebab
    const kebabFor = (session: TestSession) =>
      page.getByRole('button', { name: `Actions for ${session.name}`, exact: true })
    const deleteDialog = page.getByRole('alertdialog')

    // Cancel path: open the kebab, choose Delete Session, then back out — the
    // session must survive
    await kebabFor(sessionB).click()
    await page.getByRole('button', { name: 'Delete Session', exact: true }).click()
    await expect(deleteDialog).toBeVisible()
    await deleteDialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(deleteDialog).not.toBeVisible()
    await expect(kebabFor(sessionB)).toBeVisible()
    expect((await listSessions(request, agent)).map((s) => s.id).sort())
      .toEqual([sessionA.id, sessionB.id].sort())

    // Confirm path: the dialog names the session, and confirming deletes it
    // without navigating away from the agent home
    await kebabFor(sessionB).click()
    await page.getByRole('button', { name: 'Delete Session', exact: true }).click()
    await expect(deleteDialog).toBeVisible()
    await expect(deleteDialog).toContainText(sessionB.name)
    await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(deleteDialog).not.toBeVisible()

    await expect(page).toHaveURL(new RegExp(`/agents/${agent.slug}/?$`))
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()

    // Only session B is gone — from the agent-home list and from the API
    await expect(kebabFor(sessionB)).toHaveCount(0)
    await expect(kebabFor(sessionA)).toBeVisible()
    expect((await listSessions(request, agent)).map((s) => s.id)).toEqual([sessionA.id])

    // And it stays gone across a reload
    await page.reload()
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible({ timeout: 15000 })
    await expect(kebabFor(sessionA)).toBeVisible({ timeout: 15000 })
    await expect(kebabFor(sessionB)).toHaveCount(0)
  })
})
