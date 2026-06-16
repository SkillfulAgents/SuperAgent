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

  test('Page reload retains the deep-linked sub-view (URL is the source of truth)', async ({ page }) => {
    // R5: api-logs and connections are real URL routes now, so a hard reload
    // restores them from the path (deep-linkable). The Selection-only sub-views
    // (session/task/webhook/chat/dashboard) still reset on reload until they
    // migrate to their own routes (R6–R10) and the full reload contract lands (R16).
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
})
