/**
 * Search palette — Cmd-K combo box that filters agents and sessions.
 * Covers both triggers (keyboard shortcut + sidebar button), substring
 * filtering, and arrow-key + Enter navigation into a session.
 */
import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'

test.describe.configure({ mode: 'serial' })

test.describe('Search palette', () => {
  let appPage: AppPage
  let agentPage: AgentPage

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  test('Cmd-K opens dialog, filters by session name, Enter navigates into session', async ({ page, request }) => {
    const stamp = Date.now()
    const agentName = `Search Agent ${stamp}`
    const sessionName = `Refactor Login ${stamp}`

    await agentPage.createAgent(agentName)

    // Agents are created as "Untitled" with a random slug, then renamed
    // asynchronously. The display name maps to the prompt; the slug does not.
    // Look up the actual slug from the API by name.
    const agentsRes = await request.get('http://localhost:3000/api/agents')
    expect(agentsRes.ok()).toBe(true)
    const agents = (await agentsRes.json()) as Array<{ slug: string; name: string }>
    const slug = agents.find((a) => a.name === agentName)?.slug
    expect(slug, `agent ${agentName} not found in API`).toBeDefined()

    // The auto-created session keeps its default name in mock mode (no real
    // LLM). Rename it via the API so we can match it by a distinctive substring.
    const sessionsRes = await request.get(`http://localhost:3000/api/agents/${slug}/sessions`)
    expect(sessionsRes.ok()).toBe(true)
    const sessions = (await sessionsRes.json()) as Array<{ id: string }>
    expect(sessions.length).toBeGreaterThan(0)
    const sessionId = sessions[0].id
    const patchRes = await request.patch(
      `http://localhost:3000/api/agents/${slug}/sessions/${sessionId}`,
      { data: { name: sessionName } }
    )
    expect(patchRes.ok()).toBe(true)

    // Sessions are cached by React Query — the renderer hasn't seen the rename
    // yet. Reload so the search palette pulls fresh data on first open.
    await appPage.reload()

    // Open the dialog with the keyboard shortcut
    await page.keyboard.press('ControlOrMeta+k')
    const searchInput = page.locator('[data-testid="search-input"]')
    await expect(searchInput).toBeVisible()
    await expect(searchInput).toBeFocused()

    // Filter case-insensitively by a substring of the session name
    await searchInput.fill('refactor')
    const results = page.locator('[data-testid="search-results"]')
    await expect(results.getByText(agentName)).toBeVisible()
    await expect(results.getByText(sessionName)).toBeVisible()

    // Active row should be the agent (index 0) — ArrowDown moves to the session
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')

    // Landed in the session view: breadcrumb shows the session name and the
    // message list mounts.
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agentName)
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 10000 })

    // Cleanup
    await page.locator('[data-testid="agent-breadcrumb"]').click()
    await agentPage.deleteAgent()
  })

  test('Sidebar Search button opens the dialog', async ({ page }) => {
    await page.locator('[data-testid="search-button"]').click()
    await expect(page.locator('[data-testid="search-input"]')).toBeVisible()
    await expect(page.locator('[data-testid="search-input"]')).toBeFocused()

    // Empty query: typing nothing shows the empty-state hint
    await expect(page.locator('[data-testid="search-results"]')).toContainText('Type to search')

    // Close with Escape
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid="search-input"]')).not.toBeVisible()
  })
})
