/**
 * Navigation invariants — exercises the discriminated-union AgentView model
 * (SUP-161). Verifies that switching between every kind of agent view (home,
 * session, connections, API logs, dashboard, scheduled task) leaves exactly
 * one view active and never flickers two views at once.
 *
 * The old parallel-boolean model produced "two views true at once" bugs when
 * a new selector forgot to clear an existing field. The discriminated union
 * makes that impossible by construction, but it's worth pinning the behavior
 * end-to-end so any regression in the consumer wiring (sidebar highlights,
 * breadcrumb crumbs, render switch) is caught.
 */
import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

// Serial: each test creates and deletes one agent — overlapping creates
// in mock mode share state on the server side and can flake.
test.describe.configure({ mode: 'serial' })

test.describe('Navigation — discriminated AgentView', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  test('Home → Agent → Home returns to global home (no agent breadcrumb)', async ({ page }) => {
    const agentName = `Nav Home ${Date.now()}`
    await agentPage.createAgent(agentName)
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toBeVisible()

    // Go back to global Home — should not render the agent breadcrumb anymore
    await page.locator('[data-testid="home-button"]').click()
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).not.toBeVisible()

    // Cleanup
    await agentPage.selectAgent(agentName)
    await agentPage.deleteAgent()
  })

  test('Agent → API Logs → back returns to agent home (and not to a session)', async ({ page }) => {
    const agentName = `Nav APILogs ${Date.now()}`
    await agentPage.createAgent(agentName)

    // Open API Logs from agent-home extras — now a real URL route
    await page.getByTestId('home-api-logs-open-page').click()
    await expect(page).toHaveURL(/\/api-logs$/)
    await expect(page.locator('[data-testid="api-logs-back-button"]')).toBeVisible()

    // Back → agent home (large composer visible, no message-list)
    await page.locator('[data-testid="api-logs-back-button"]').click()
    await expect(page).toHaveURL(/\/agents\/[^/]+$/)
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()
    await expect(page.locator('[data-testid="message-list"]')).not.toBeVisible()

    // Cleanup
    await agentPage.deleteAgent()
  })

  test('Agent → Connections → back returns to agent home', async ({ page }) => {
    const agentName = `Nav Conn ${Date.now()}`
    await agentPage.createAgent(agentName)

    // The "Manage Connections"/"Add Connection" button on agent home opens connections view
    const manageBtn = page.locator('[data-testid="home-connections-open-page"]')
    await expect(manageBtn).toBeVisible()
    await manageBtn.click()

    await expect(page).toHaveURL(/\/connections$/)
    await expect(page.locator('[data-testid="connections-back-button"]')).toBeVisible()

    // Back → agent home
    await page.locator('[data-testid="connections-back-button"]').click()
    await expect(page).toHaveURL(/\/agents\/[^/]+$/)
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()

    // Cleanup
    await agentPage.deleteAgent()
  })

  test('API Logs → Connections → API Logs: only one view at a time', async ({ page }) => {
    // Mutual exclusion: you should never see two end-views simultaneously.
    const agentName = `Nav Mutex ${Date.now()}`
    await agentPage.createAgent(agentName)

    // Open API Logs — the URL itself enforces mutual exclusion (one leaf path).
    await page.getByTestId('home-api-logs-open-page').click()
    await expect(page).toHaveURL(/\/api-logs$/)
    await expect(page.locator('[data-testid="api-logs-back-button"]')).toBeVisible()

    // Switch to Connections via the sidebar's agent-home (back first, then connections)
    await page.locator('[data-testid="api-logs-back-button"]').click()
    await page.locator('[data-testid="home-connections-open-page"]').click()
    await expect(page).toHaveURL(/\/connections$/)
    await expect(page.locator('[data-testid="connections-back-button"]')).toBeVisible()
    // API Logs back-button must not be present at the same time
    await expect(page.locator('[data-testid="api-logs-back-button"]')).not.toBeVisible()

    // Switch back to API Logs
    await page.locator('[data-testid="connections-back-button"]').click()
    await page.getByTestId('home-api-logs-open-page').click()
    await expect(page).toHaveURL(/\/api-logs$/)
    await expect(page.locator('[data-testid="api-logs-back-button"]')).toBeVisible()
    await expect(page.locator('[data-testid="connections-back-button"]')).not.toBeVisible()

    // Cleanup
    await page.locator('[data-testid="api-logs-back-button"]').click()
    await agentPage.deleteAgent()
  })

  test('Switching agents resets view to that agent\'s home', async ({ page }) => {
    // The view is per-(agent + view) — when the user switches agents while
    // looking at API Logs of agent A, they should land on agent B's home, not
    // see B's API Logs.
    const a = `Nav SwitchA ${Date.now()}`
    const b = `Nav SwitchB ${Date.now()}`
    await agentPage.createAgent(a)
    await agentPage.createAgent(b)

    // On agent B, open API Logs
    await agentPage.selectAgent(b)
    await page.getByTestId('home-api-logs-open-page').click()
    await expect(page).toHaveURL(/\/api-logs$/)
    await expect(page.locator('[data-testid="api-logs-back-button"]')).toBeVisible()

    // Switch to agent A — should land on A's home, not on API Logs
    await agentPage.selectAgent(a)
    await expect(page).toHaveURL(/\/agents\/[^/]+$/)
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()
    await expect(page.locator('[data-testid="api-logs-back-button"]')).not.toBeVisible()

    // Cleanup
    await agentPage.deleteAgent()
    await agentPage.selectAgent(b)
    await agentPage.deleteAgent()
  })

  test('Session → agent breadcrumb returns to agent home', async ({ page }) => {
    const agentName = `Nav Crumb ${Date.now()}`
    await agentPage.createAgent(agentName)

    // The createAgent flow creates a session, navigates to it, then goes back
    // to agent-home. Send a message to make sure we have a session row in the
    // sidebar.
    await sessionPage.sendMessage('hi')
    await sessionPage.waitForResponse(15000)

    // Click the agent breadcrumb → should return to agent home
    await page.locator('[data-testid="agent-breadcrumb"]').click()
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()
    await expect(page.locator('[data-testid="message-list"]')).not.toBeVisible()

    // Cleanup
    await agentPage.deleteAgent()
  })

  test('Session is a durable URL route — a hard reload restores it (R9)', async ({ page }) => {
    const agentName = `Nav Session Reload ${Date.now()}`
    await agentPage.createAgent(agentName)

    // Send from agent-home → creates a session and navigates to its OWN route
    // (R9: sessions are URL-durable now, not Selection-only).
    await sessionPage.sendMessage('hello session route')
    await expect(page).toHaveURL(/\/sessions\/[^/]+$/)
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 15000 })

    // Reload — the router restores the session straight from the path, no Selection.
    await appPage.reload()
    await expect(page).toHaveURL(/\/sessions\/[^/]+$/)
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 15000 })
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toBeVisible()

    // Cleanup
    await page.locator('[data-testid="agent-breadcrumb"]').click()
    await agentPage.deleteAgent()
  })

  test('Cold reload restores the Selection-driven session sub-crumb (bridge un-skip, R12)', async ({ page }) => {
    // R12 un-skips the URL→Selection bridge on the INITIAL mount, so a hard
    // reload on a sub-view route rehydrates `view` from the path. The header
    // crumbs are still Selection-driven (which crumb shows reads `view`), so
    // before the un-skip the session-name crumb was MISSING on a cold reload
    // (view snapped to the `home` default) even though the message list — which
    // is route-driven — still rendered. This pins the crumb back.
    const agentName = `Nav Crumb Restore ${Date.now()}`
    await agentPage.createAgent(agentName)

    await sessionPage.sendMessage('restore my crumb')
    await expect(page).toHaveURL(/\/sessions\/[^/]+$/)
    await expect(page.locator('[data-testid="session-breadcrumb"]')).toBeVisible({ timeout: 15000 })

    // Hard reload — the bridge restores view.kind='session' from the URL, so the
    // Selection-driven session crumb comes back (not just the route-driven body).
    await appPage.reload()
    await expect(page).toHaveURL(/\/sessions\/[^/]+$/)
    await expect(page.locator('[data-testid="session-breadcrumb"]')).toBeVisible({ timeout: 15000 })

    // Cleanup
    await page.locator('[data-testid="agent-breadcrumb"]').click()
    await agentPage.deleteAgent()
  })

  test('Session survives a sibling round-trip with the agent shell mounted (R9)', async ({ page }) => {
    // Mount-survival (§11.7): leaving the session leaf for a sibling (agent home)
    // and returning must NOT unmount AgentShell — it anchors the chat/SSE stream
    // and the optimistic pendingMessagesRef. The session re-renders its persisted
    // messages on return with no page crash.
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))

    const agentName = `Nav Session Survive ${Date.now()}`
    await agentPage.createAgent(agentName)

    await sessionPage.sendMessage('survive me')
    await expect(page).toHaveURL(/\/sessions\/[^/]+$/)
    await sessionPage.waitForResponse(15000)
    await sessionPage.expectUserMessage('survive me')

    // Leave for the agent-home sibling leaf…
    await page.locator('[data-testid="agent-breadcrumb"]').click()
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()
    await expect(page).toHaveURL(/\/agents\/[^/]+$/)

    // …then return to the same session via the sidebar.
    await agentPage.expandAgent(agentName)
    await sessionPage.selectFirstSessionInSidebar(agentPage.getAgentLi(agentName))
    await expect(page).toHaveURL(/\/sessions\/[^/]+$/)
    await sessionPage.expectUserMessage('survive me')
    expect(errors).toEqual([])

    // Cleanup
    await page.locator('[data-testid="agent-breadcrumb"]').click()
    await agentPage.deleteAgent()
  })

  test('Page reload retains the deep-linked sub-view (URL is the source of truth)', async ({ page }) => {
    // Every agent sub-view is its own route now (api-logs/connections R5,
    // task/webhook R6, dashboard R7, chat R8, session R9), so a hard reload
    // restores it from the path. Only the bridge un-skip + full reload contract
    // (sidebar highlight on cold reload, settings/notifications) remain for R12/R16.
    const agentName = `Nav Reload ${Date.now()}`
    await agentPage.createAgent(agentName)

    // Navigate into API Logs (now a real route → durable in the URL)
    await page.getByTestId('home-api-logs-open-page').click()
    await expect(page).toHaveURL(/\/api-logs$/)
    await expect(page.locator('[data-testid="api-logs-back-button"]')).toBeVisible()

    // Reload — the URL is durable, so API Logs is restored, not reset to home.
    await appPage.reload()
    await expect(page).toHaveURL(/\/api-logs$/)
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toBeVisible()
    await expect(page.locator('[data-testid="api-logs-back-button"]')).toBeVisible()

    // Cleanup
    await agentPage.selectAgent(agentName)
    await agentPage.deleteAgent()
  })

  test('Dashboard leaf route resolves on a cold deep-link without crashing (R7)', async ({ page }) => {
    // Mock mode has no real dashboards (artifacts=[]), so we can't click a card —
    // but we can verify the dashboard leaf route resolves into the shared agent
    // shell and renders DashboardView's fallback without a page crash.
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))

    const agentName = `Nav Dash ${Date.now()}`
    await agentPage.createAgent(agentName)
    const slug = page.url().match(/\/agents\/([^/?#]+)/)?.[1]
    expect(slug).toBeTruthy()

    await page.goto(`/agents/${slug}/dashboards/sample-dashboard`)
    await expect(page).toHaveURL(/\/dashboards\/sample-dashboard$/)
    // The shared agent header rendered → the route matched AgentShell, no crash.
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toBeVisible()
    expect(errors).toEqual([])

    // Cleanup
    await agentPage.selectAgent(agentName)
    await agentPage.deleteAgent()
  })

  test('Chat leaf route resolves on a cold deep-link with ?session= search (R8)', async ({ page }) => {
    // Mock mode has no chat integrations, so we can't click one — but we can
    // verify the chat leaf route (path param + ?session= search) resolves into
    // the shared agent shell and renders its fallback without a page crash.
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))

    const agentName = `Nav Chat ${Date.now()}`
    await agentPage.createAgent(agentName)
    const slug = page.url().match(/\/agents\/([^/?#]+)/)?.[1]
    expect(slug).toBeTruthy()

    await page.goto(`/agents/${slug}/chat/sample-integration?session=sample-session`)
    await expect(page).toHaveURL(/\/chat\/sample-integration\?session=sample-session$/)
    // The shared agent header rendered → the route matched AgentShell, no crash.
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toBeVisible()
    expect(errors).toEqual([])

    // Cleanup
    await agentPage.selectAgent(agentName)
    await agentPage.deleteAgent()
  })

  test('Sidebar highlights the agent on a cold reload (route-driven active, R11)', async ({ page }) => {
    // The sidebar active state is route-derived (useParams/pathname), so it
    // reflects the URL immediately on a hard reload — it never depended on the
    // Selection bridge, which is why it highlighted correctly even before R12
    // un-skipped the bridge's initial mount.
    const agentName = `Nav Sidebar Active ${Date.now()}`
    await agentPage.createAgent(agentName)
    const slug = page.url().match(/\/agents\/([^/?#]+)/)?.[1]
    expect(slug).toBeTruthy()

    await appPage.reload()
    await expect(page).toHaveURL(/\/agents\/[^/]+$/)
    await expect(page.locator(`[data-testid="agent-item-${slug}"]`)).toHaveAttribute('data-active', 'true')
    await expect(page.locator('[data-testid="home-button"]')).toHaveAttribute('data-active', 'false')

    // Cleanup
    await agentPage.deleteAgent()
  })

  test('Notifications route lights up only the Notifications nav item (R11)', async ({ page }) => {
    const agentName = `Nav Notif Active ${Date.now()}`
    await agentPage.createAgent(agentName)
    const slug = page.url().match(/\/agents\/([^/?#]+)/)?.[1]

    await page.locator('[data-testid="notifications-button"]').click()
    await expect(page).toHaveURL(/\/notifications$/)
    await expect(page.locator('[data-testid="notifications-button"]')).toHaveAttribute('data-active', 'true')
    await expect(page.locator('[data-testid="home-button"]')).toHaveAttribute('data-active', 'false')
    await expect(page.locator(`[data-testid="agent-item-${slug}"]`)).toHaveAttribute('data-active', 'false')

    // Cleanup
    await agentPage.selectAgent(agentName)
    await agentPage.deleteAgent()
  })

  test('Notifications is a durable top-level route — survives a hard reload (R13)', async ({ page }) => {
    // /notifications is its own top-level route (R4) and all entry points
    // navigate to it (sidebar R11, OS/tray R9). R13 pins the durability: a hard
    // reload restores the notifications page straight from the URL, and the
    // back button still navigates out (to global home — no agent scope after a
    // cold reload, since /notifications carries no slug).
    const agentName = `Nav Notif Reload ${Date.now()}`
    await agentPage.createAgent(agentName)

    await page.locator('[data-testid="notifications-button"]').click()
    await expect(page).toHaveURL(/\/notifications$/)
    await expect(page.locator('[data-testid="notifications-back-button"]')).toBeVisible()

    await appPage.reload()
    await expect(page).toHaveURL(/\/notifications$/)
    await expect(page.locator('[data-testid="notifications-back-button"]')).toBeVisible()

    // Back leaves the notifications route.
    await page.locator('[data-testid="notifications-back-button"]').click()
    await expect(page).not.toHaveURL(/\/notifications/)

    // Cleanup
    await agentPage.selectAgent(agentName)
    await agentPage.deleteAgent()
  })
})
