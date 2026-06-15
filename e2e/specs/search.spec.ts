/**
 * Search palette — Cmd-K combo box that filters agents and sessions.
 * Covers both triggers (keyboard shortcut + sidebar button), substring
 * filtering, and arrow-key + Enter navigation into a session.
 */
import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { getE2EBaseUrl } from '../helpers/base-url'

test.describe.configure({ mode: 'serial' })

const API = getE2EBaseUrl()

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
    const agentsRes = await request.get(`${API}/api/agents`)
    expect(agentsRes.ok()).toBe(true)
    const agents = (await agentsRes.json()) as Array<{ slug: string; name: string }>
    const slug = agents.find((a) => a.name === agentName)?.slug
    expect(slug, `agent ${agentName} not found in API`).toBeDefined()

    // The auto-created session keeps its default name in mock mode (no real
    // LLM). Rename it via the API so we can match it by a distinctive substring.
    const sessionsRes = await request.get(`${API}/api/agents/${slug}/sessions`)
    expect(sessionsRes.ok()).toBe(true)
    const sessions = (await sessionsRes.json()) as Array<{ id: string }>
    expect(sessions.length).toBeGreaterThan(0)
    const sessionId = sessions[0].id
    const patchRes = await request.patch(
      `${API}/api/agents/${slug}/sessions/${sessionId}`,
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
    await expect(results.getByTestId('search-agent-row').filter({ hasText: agentName })).toBeVisible()
    await expect(results.getByTestId('search-session-row').filter({ hasText: sessionName })).toBeVisible()

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

    // Empty query shows recent agents or a "No recent agents" hint
    const results = page.locator('[data-testid="search-results"]')
    await expect(results).toBeVisible()

    // Close with Escape
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid="search-input"]')).not.toBeVisible()
  })

  test('Recent-list supports expanding sessions and keyboard navigation', async ({ page, request }, testInfo) => {
    const stamp = `${testInfo.workerIndex}-${Date.now()}`
    const agentName = `Search Expand Agent ${stamp}`
    const sessionName = `Expand Session ${stamp}`

    const createdAgent = await agentPage.createAgent(agentName)
    const slug = createdAgent.slug

    const lastActivityAt = new Date().toISOString()
    await page.route('**/api/agents', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback()
        return
      }

      await route.fulfill({
        json: [{
          slug,
          name: agentName,
          createdAt: lastActivityAt,
          status: 'running',
          containerPort: null,
          lastActivityAt,
        }],
      })
    })

    const sessionsRes = await request.get(`${API}/api/agents/${slug}/sessions`)
    expect(sessionsRes.ok()).toBe(true)
    const sessions = (await sessionsRes.json()) as Array<{ id: string }>
    expect(sessions.length).toBeGreaterThan(0)
    const sessionId = sessions[0].id

    await expect(async () => {
      const res = await request.patch(
        `${API}/api/agents/${slug}/sessions/${sessionId}`,
        { data: { name: sessionName } }
      )
      expect(res.ok()).toBe(true)
    }).toPass({ timeout: 5000 })

    await appPage.reload()

    await page.keyboard.press('ControlOrMeta+k')
    const searchInput = page.locator('[data-testid="search-input"]')
    await expect(searchInput).toBeVisible()

    const results = page.locator('[data-testid="search-results"]')
    const agentRow = results.getByTestId('search-agent-row').filter({ hasText: agentName })
    const sessionRow = results.getByTestId('search-session-row').filter({ hasText: sessionName })
    const expandToggle = agentRow.getByTestId('search-agent-expand')

    await expect(agentRow).toBeVisible()
    await expect(expandToggle).toBeVisible()
    await expect(sessionRow).not.toBeVisible()

    await agentRow.hover()
    await page.keyboard.press('ArrowRight')
    await expect(sessionRow).toBeVisible()

    await page.keyboard.press('ArrowLeft')
    await expect(sessionRow).not.toBeVisible()

    await expandToggle.click()
    await expect(sessionRow).toBeVisible()

    await sessionRow.hover()
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-testid="search-input"]')).not.toBeVisible()
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agentName)
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 10000 })

    await page.locator('[data-testid="agent-breadcrumb"]').click()
    await agentPage.deleteAgent()
  })

  test('Search query shows matching session with its agent', async ({ page, request }) => {
    const stamp = Date.now()
    const agentName = `Recent Agent ${stamp}`
    const sessionName = `Deploy Pipeline ${stamp}`

    await agentPage.createAgent(agentName)

    // Look up the slug
    const agentsRes = await request.get(`${API}/api/agents`)
    expect(agentsRes.ok()).toBe(true)
    const agents = (await agentsRes.json()) as Array<{ slug: string; name: string }>
    const slug = agents.find((a) => a.name === agentName)?.slug
    expect(slug, `agent ${agentName} not found in API`).toBeDefined()

    // Wait for the session to finish processing before renaming
    const sessionsRes = await request.get(`${API}/api/agents/${slug}/sessions`)
    expect(sessionsRes.ok()).toBe(true)
    const sessions = (await sessionsRes.json()) as Array<{ id: string }>
    expect(sessions.length).toBeGreaterThan(0)
    const sessionId = sessions[0].id

    // Retry the PATCH in case the session is still being processed
    await expect(async () => {
      const res = await request.patch(
        `${API}/api/agents/${slug}/sessions/${sessionId}`,
        { data: { name: sessionName } }
      )
      expect(res.ok()).toBe(true)
    }).toPass({ timeout: 5000 })

    await appPage.reload()

    // Open the search palette and filter by this test's unique session. The
    // empty recent list is global and can legitimately be displaced by other
    // workers creating newer agents.
    await page.keyboard.press('ControlOrMeta+k')
    const searchInput = page.locator('[data-testid="search-input"]')
    await expect(searchInput).toBeVisible()
    await searchInput.fill(sessionName)

    const results = page.locator('[data-testid="search-results"]')

    const agentRow = results.getByTestId('search-agent-row').filter({ hasText: agentName })
    const sessionRow = results.getByTestId('search-session-row').filter({ hasText: sessionName })
    await expect(agentRow).toBeVisible()
    await expect(sessionRow).toBeVisible()

    // Click the target session row so this test does not depend on the global
    // activeIndex in a list that can contain agents from parallel specs.
    await sessionRow.click()
    await expect(page.locator('[data-testid="search-input"]')).not.toBeVisible()
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agentName)

    // Cleanup — navigate to agent home before deleting
    await page.locator('[data-testid="agent-breadcrumb"]').click()
    await agentPage.deleteAgent()
  })
})
