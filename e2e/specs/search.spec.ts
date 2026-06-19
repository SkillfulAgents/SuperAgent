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
    const agentsRes = await request.get('/api/agents')
    expect(agentsRes.ok()).toBe(true)
    const agents = (await agentsRes.json()) as Array<{ slug: string; name: string }>
    const slug = agents.find((a) => a.name === agentName)?.slug
    expect(slug, `agent ${agentName} not found in API`).toBeDefined()

    // The auto-created session keeps its default name in mock mode (no real
    // LLM). Rename it via the API so we can match it by a distinctive substring.
    const sessionsRes = await request.get(`/api/agents/${slug}/sessions`)
    expect(sessionsRes.ok()).toBe(true)
    const sessions = (await sessionsRes.json()) as Array<{ id: string }>
    expect(sessions.length).toBeGreaterThan(0)
    const sessionId = sessions[0].id
    await expect(async () => {
      const patchRes = await request.patch(
        `/api/agents/${slug}/sessions/${sessionId}`,
        { data: { name: sessionName } }
      )
      expect(patchRes.ok()).toBe(true)
    }).toPass({ timeout: 5000 })

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

  test('Cmd-K → session is a durable URL route that survives a hard reload', async ({ page, request }) => {
    // The sibling above proves Cmd-K → filter → Enter LANDS in the session, but it
    // never reloads — so it would still pass if the palette only set transient
    // in-memory selection. Post-migration the palette navigate() must push a real
    // sessionRoute, so the landed session is reload-durable. This pins that gap:
    // assert the session path after Enter, then hard-reload and assert the path is
    // unchanged and the message list is restored from the URL.
    const stamp = Date.now()
    const agentName = `Search Durable ${stamp}`
    const sessionName = `Reload Durable ${stamp}`

    await agentPage.createAgent(agentName)

    // Agents are created as "Untitled" with a random slug, then renamed
    // asynchronously. Look up the actual slug from the API by name.
    const agentsRes = await request.get('/api/agents')
    expect(agentsRes.ok()).toBe(true)
    const agents = (await agentsRes.json()) as Array<{ slug: string; name: string }>
    const slug = agents.find((a) => a.name === agentName)?.slug
    expect(slug, `agent ${agentName} not found in API`).toBeDefined()

    // The auto-created session keeps its default name in mock mode. Rename it via
    // the API so we can match it by a distinctive substring. A freshly-created
    // session can briefly reject the PATCH while the backend's async name-
    // generation settles (the mock LLM retries then fails), so poll the whole
    // GET+rename until it sticks rather than racing a single attempt.
    await expect
      .poll(
        async () => {
          const sessionsRes = await request.get(`/api/agents/${slug}/sessions`)
          if (!sessionsRes.ok()) return false
          const sessions = (await sessionsRes.json()) as Array<{ id: string }>
          if (sessions.length === 0) return false
          const patchRes = await request.patch(
            `/api/agents/${slug}/sessions/${sessions[0].id}`,
            { data: { name: sessionName } },
          )
          return patchRes.ok()
        },
        { timeout: 10000 },
      )
      .toBe(true)

    // Sessions are cached by React Query — reload so the palette pulls fresh data.
    await appPage.reload()

    // Open the dialog with the keyboard shortcut
    await page.keyboard.press('ControlOrMeta+k')
    const searchInput = page.locator('[data-testid="search-input"]')
    await expect(searchInput).toBeVisible()
    await expect(searchInput).toBeFocused()

    // Filter case-insensitively by a substring of the session name
    await searchInput.fill('reload')
    const results = page.locator('[data-testid="search-results"]')
    await expect(results.getByTestId('search-agent-row').filter({ hasText: agentName })).toBeVisible()
    await expect(results.getByTestId('search-session-row').filter({ hasText: sessionName })).toBeVisible()

    // Active row is the agent (index 0) — ArrowDown moves to the session, Enter opens it
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')

    // The palette pushed a real session route — not just an in-memory selection.
    await expect(page).toHaveURL(/\/agents\/[^/]+\/sessions\/[^/]+$/)
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 10000 })

    // Hard reload — a transient selection would reset to home, but a durable route
    // restores the same session straight from the path.
    await appPage.reload()
    await expect(page).toHaveURL(/\/agents\/[^/]+\/sessions\/[^/]+$/)
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 15000 })
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agentName)

    // Cleanup — leave the session view (deleteAgent needs the agent-home settings button)
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

  test('Empty query shows recent agents with expand/collapse for sessions', async ({ page, request }) => {
    const stamp = Date.now()
    const agentName = `Recent Agent ${stamp}`
    const sessionName = `Deploy Pipeline ${stamp}`

    await agentPage.createAgent(agentName)

    // Look up the slug
    const agentsRes = await request.get('/api/agents')
    expect(agentsRes.ok()).toBe(true)
    const agents = (await agentsRes.json()) as Array<{ slug: string; name: string }>
    const slug = agents.find((a) => a.name === agentName)?.slug
    expect(slug, `agent ${agentName} not found in API`).toBeDefined()

    // Wait for the session to finish processing before renaming
    const sessionsRes = await request.get(`/api/agents/${slug}/sessions`)
    expect(sessionsRes.ok()).toBe(true)
    const sessions = (await sessionsRes.json()) as Array<{ id: string }>
    expect(sessions.length).toBeGreaterThan(0)
    const sessionId = sessions[0].id

    // Retry the PATCH in case the session is still being processed
    await expect(async () => {
      const res = await request.patch(
        `/api/agents/${slug}/sessions/${sessionId}`,
        { data: { name: sessionName } }
      )
      expect(res.ok()).toBe(true)
    }).toPass({ timeout: 5000 })

    await appPage.reload()

    // Open the search palette with empty query
    await page.keyboard.press('ControlOrMeta+k')
    const searchInput = page.locator('[data-testid="search-input"]')
    await expect(searchInput).toBeVisible()

    const results = page.locator('[data-testid="search-results"]')

    // The agent should appear in the recent list without typing anything
    const agentRow = results.getByTestId('search-agent-row').filter({ hasText: agentName })
    const sessionRow = results.getByTestId('search-session-row').filter({ hasText: sessionName })
    await expect(agentRow).toBeVisible()

    // Wait for sessions to load — the expand chevron only renders once sessions
    // are fetched, so its presence signals the async useQueries completed.
    await expect(agentRow.getByTestId('search-agent-expand')).toBeVisible()

    // Sessions should be collapsed (not visible yet)
    await expect(sessionRow).not.toBeVisible()

    // Hover over the agent to set keyboard focus to it (activeIndex).
    // Other agents from parallel tests may be more recent, so the agent
    // might not be at index 0.
    await agentRow.hover()

    // ArrowRight expands the agent's sessions
    await page.keyboard.press('ArrowRight')
    await expect(sessionRow).toBeVisible()

    // ArrowLeft collapses them
    await page.keyboard.press('ArrowLeft')
    await expect(sessionRow).not.toBeVisible()

    // Click the chevron to expand
    await agentRow.getByTestId('search-agent-expand').click()
    await expect(sessionRow).toBeVisible()

    // Enter on a session navigates to it (dialog closes, lands on the agent)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-testid="search-input"]')).not.toBeVisible()
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agentName)

    // Cleanup — navigate to agent home before deleting
    await page.locator('[data-testid="agent-breadcrumb"]').click()
    await agentPage.deleteAgent()
  })
})
